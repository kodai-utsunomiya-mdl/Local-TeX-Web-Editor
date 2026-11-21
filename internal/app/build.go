package app

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

const maxLogBytes = 2 << 20
const buildRelative = ".local-tex-editor/build"

type Build struct {
	ID                string   `json:"id"`
	Main              string   `json:"main"`
	Status            string   `json:"status"`
	Command           string   `json:"command"`
	Log               string   `json:"log"`
	ExitCode          *int     `json:"exitCode"`
	Error             string   `json:"error"`
	StartedAt         string   `json:"startedAt"`
	FinishedAt        string   `json:"finishedAt"`
	PDFReady          bool     `json:"pdfReady"`
	PDFBuildID        string   `json:"pdfBuildId"`
	PDFMain           string   `json:"pdfMain"`
	PDFSourceChanged  bool     `json:"pdfSourceChanged"`
	PDFMarkdownInputs []string `json:"pdfMarkdownInputs"`
	SyncTeXReady      bool     `json:"synctexReady"`
	ElapsedMS         int64    `json:"elapsedMs"`
	SourceChanged     bool     `json:"sourceChanged"`
	Restored          bool     `json:"restored"`
}

type buildRun struct {
	result          Build
	project         Project
	started         time.Time
	finished        time.Time
	process         *os.Process
	cancelRequested bool
	log             []byte
	logMessages     []buildLogMessage
	err             error
	truncated       bool
	synctex         *synctexVersion
	sources         map[string]string
	markdownInputs  map[string]bool
	changedMarkdown map[string]bool
	pdfName         string
}

type buildLogMessage struct {
	start, end int
	message    *messages.Message
}

type commandOutput struct {
	app *App
	run *buildRun
}

func (output *commandOutput) Write(data []byte) (int, error) {
	output.app.mu.Lock()
	output.app.appendLogLocked(output.run, data)
	output.app.mu.Unlock()
	return len(data), nil
}

func (a *App) appendLogLocked(run *buildRun, data []byte) {
	run.log = append(run.log, data...)
	if len(run.log) > maxLogBytes {
		removed := len(run.log) - maxLogBytes
		run.log = append([]byte(nil), run.log[removed:]...)
		remaining := run.logMessages[:0]
		for _, entry := range run.logMessages {
			entry.start -= removed
			entry.end -= removed
			if entry.start >= 0 {
				remaining = append(remaining, entry)
			}
		}
		run.logMessages = remaining
		run.truncated = true
	}
}

func (a *App) appendMessageLocked(run *buildRun, format string, args ...any) {
	message := messages.Errorf(format, args...)
	data := []byte(message.Error())
	a.appendLogLocked(run, data)
	if start := len(run.log) - len(data); start >= 0 {
		run.logMessages = append(run.logMessages, buildLogMessage{start, len(run.log), message})
	}
}

func (a *App) appendMessage(run *buildRun, format string, args ...any) {
	a.mu.Lock()
	a.appendMessageLocked(run, format, args...)
	a.mu.Unlock()
}

func localizedBuildLog(run *buildRun, language string) string {
	complete := run.result.Status != "running"
	if language != "en" || len(run.logMessages) == 0 {
		return readableLog(run.log, complete)
	}
	var text strings.Builder
	position := 0
	for _, entry := range run.logMessages {
		text.WriteString(readableLog(run.log[position:entry.start], true))
		text.WriteString(entry.message.LocalizedMessage(language))
		position = entry.end
	}
	text.WriteString(readableLog(run.log[position:], complete))
	return text.String()
}

func readableLog(data []byte, complete bool) string {
	if utf8.Valid(data) {
		return string(data)
	}
	var text strings.Builder
	lines := bytes.SplitAfter(data, []byte("\n"))
	for index, line := range lines {
		if utf8.Valid(line) {
			text.Write(line)
			continue
		}
		if !complete && index == len(lines)-1 {
			// A pipe read may end in the middle of one UTF-8 character.
			foundPrefix := false
			for removed := 1; removed < 4 && removed <= len(line); removed++ {
				prefix := line[:len(line)-removed]
				if utf8.Valid(prefix) {
					text.Write(prefix)
					foundPrefix = true
					break
				}
			}
			if foundPrefix {
				continue
			}
		}
		// An external Windows tool can use its local encoding even when TeX
		// and this application's messages use UTF-8 on adjacent lines.
		text.WriteString(platform.DecodeOutput(line))
	}
	return text.String()
}

func (a *App) buildSnapshotLocked(language ...string) *Build {
	if a.build == nil {
		return nil
	}
	run := a.build
	result := run.result
	selected := "ja"
	if len(language) > 0 {
		selected = language[0]
	}
	result.Log = localizedBuildLog(run, selected)
	if run.err != nil {
		result.Error = messages.ErrorText(selected, run.err)
	}
	if run.truncated {
		result.Log = messages.Text(selected, "[ログが長いため，末尾の 2 MiB を表示しています．]\n") + result.Log
	}
	result.PDFReady = a.lastPDF != ""
	result.PDFBuildID = a.lastPDFID
	result.PDFMain = a.lastPDFMain
	result.PDFSourceChanged = a.lastPDFChanged
	result.PDFMarkdownInputs = markdownInputList(a.lastPDFMarkdownInputs)
	result.SyncTeXReady = a.synctexVersions[a.lastPDFID] != nil
	end := run.finished
	if end.IsZero() {
		end = time.Now()
	}
	result.ElapsedMS = end.Sub(run.started).Milliseconds()
	return &result
}

func (a *App) isRunningLocked() bool { return a.build != nil && a.build.result.Status == "running" }

func randomID() (string, error) {
	var data [8]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", err
	}
	return time.Now().UTC().Format("20060102T150405.000000000") + "-" + hex.EncodeToString(data[:]), nil
}

func (a *App) startBuild(expectedProject string, requestedMain ...string) (*Build, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.checkProjectLocked(expectedProject); err != nil {
		return nil, err
	}
	if a.closed {
		return nil, fail(http.StatusServiceUnavailable, "アプリは終了しています．")
	}
	if a.isRunningLocked() {
		return nil, fail(http.StatusConflict, "コンパイルが実行中です．完了を待つか停止してください．")
	}
	if a.isTeXSetupRunningLocked() {
		return nil, fail(http.StatusConflict, "TeX の導入が終了してからコンパイルしてください．")
	}
	if a.project == nil {
		return nil, fail(http.StatusBadRequest, "原稿フォルダーを開いてください．")
	}
	project, texBin := *a.project, a.config.TexBin
	if len(requestedMain) > 0 && requestedMain[0] != "" {
		project.Main = requestedMain[0]
	}
	if project.Main == "" {
		return nil, fail(http.StatusBadRequest, "メインの .tex ファイルを選んでください．")
	}
	main, _, err := projectFilePath(project.Root, project.Main, false)
	if err != nil {
		return nil, err
	}
	if !strings.EqualFold(filepath.Ext(main), ".tex") {
		return nil, fail(http.StatusBadRequest, "コンパイルする文書には .tex ファイルを選んでください．")
	}
	project.Main = main
	id, err := randomID()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	run := &buildRun{started: now, project: project, result: Build{ID: id, Main: main, Status: "running", StartedAt: now.UTC().Format(time.RFC3339Nano)}}
	a.build = run
	a.workers.Add(1)
	go a.compile(run, project, texBin)
	return a.buildSnapshotLocked(), nil
}

func (a *App) finishBuild(run *buildRun, code *int, err error, pdf, pdfID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for path := range run.changedMarkdown {
		if markdownSourceAffectsPDF(path, run.markdownInputs) {
			run.result.SourceChanged = true
			break
		}
	}
	run.finished = time.Now()
	run.result.FinishedAt = run.finished.UTC().Format(time.RFC3339Nano)
	run.result.ExitCode = code
	run.process = nil
	if run.cancelRequested {
		run.result.Status = "cancelled"
		run.err = messages.Errorf("コンパイルを停止しました．")
		run.result.Error = run.err.Error()
	} else if err != nil {
		run.result.Status = "failed"
		run.err = err
		run.result.Error = err.Error()
	} else {
		run.result.Status = "success"
		run.err = nil
		run.result.Error = ""
		project := run.project
		if project.Root == "" && a.project != nil {
			project = *a.project
		}
		run.result.Main = project.Main
		a.lastPDF, a.lastPDFID = pdf, pdfID
		a.lastPDFMain, a.lastPDFChanged = project.Main, run.result.SourceChanged
		a.lastPDFMarkdownInputs = run.markdownInputs
		a.pdfVersions[pdfID] = pdf
		if a.pdfMains == nil {
			a.pdfMains = make(map[string]string)
		}
		a.pdfMains[pdfID] = project.Main
		if run.synctex != nil {
			run.synctex.ChangedDuringBuild = run.result.SourceChanged
			a.synctexVersions[pdfID] = run.synctex
		}
		a.recordCompiledPDFLocked(project.Main, run.pdfName, pdfID, pdf, run.result.SourceChanged, run.markdownInputs)
		a.pdfOrder = append(a.pdfOrder, pdfID)
		a.trimPDFVersionsLocked()
		if project.Root != "" {
			if err := a.saveCachedBuild(project, run, pdf); err != nil {
				a.appendMessageLocked(run, "\n[前回の PDF] 次の起動時に読み込む情報を保存できません: %v\n", err)
			}
		}
	}
	if run.result.Error != "" {
		a.appendMessageLocked(run, "\n[Local TeX Web Editor] %v\n", run.err)
	}
	if pdf != "" {
		a.trimPDFCacheLocked(filepath.Dir(pdf))
	}
	if code != nil {
		a.appendMessageLocked(run, "\n[終了コード: %d]\n", *code)
	}
}

func (a *App) compile(run *buildRun, project Project, texBin string) {
	defer a.workers.Done()
	tool, bin, err := findLatexmk(texBin)
	if err != nil {
		a.finishBuild(run, nil, err, "", "")
		return
	}
	outputDirectory, err := ensureBuildDirectory(project.Root, project.Main)
	if err != nil {
		a.finishBuild(run, nil, err, "", "")
		return
	}
	release, err := platform.AcquireProjectLock(project.Root)
	if err != nil {
		a.finishBuild(run, nil, messages.Errorf("コンパイルを開始できません: %w", err), "", "")
		return
	}
	defer release()
	sources := snapshotSourceRevisions(project.Root)
	run.sources = sources
	args := latexmkArguments(project)
	cmd, cleanup, err := latexmkCommand(tool, bin, args, project.Root, a.options.ConfigDir)
	if err != nil {
		a.finishBuild(run, nil, err, "", "")
		return
	}
	defer cleanup()
	cmd.Dir = project.Root
	platform.PrepareCommand(cmd)
	writer := &commandOutput{app: a, run: run}
	cmd.Stdout, cmd.Stderr = writer, writer
	a.mu.Lock()
	run.result.Command = displayCommand(cmd.Path, cmd.Args[1:])
	a.appendMessageLocked(run, "[作業フォルダー] %s\n[実行] %s\n\n", project.Root, run.result.Command)
	cancelled := run.cancelRequested || a.closed
	a.mu.Unlock()
	if cancelled {
		a.finishBuild(run, nil, messages.Errorf("コンパイルを停止しました．"), "", "")
		return
	}
	if err := cmd.Start(); err != nil {
		a.finishBuild(run, nil, messages.Errorf("latexmk を起動できません: %w", err), "", "")
		return
	}
	a.mu.Lock()
	run.process = cmd.Process
	cancelled = run.cancelRequested || a.closed
	a.mu.Unlock()
	if cancelled {
		_ = platform.StopProcess(cmd.Process)
	}
	waitErr := cmd.Wait()
	code := cmd.ProcessState.ExitCode()
	a.mu.Lock()
	cancelled = run.cancelRequested
	a.mu.Unlock()
	if cancelled || waitErr != nil {
		if !cancelled {
			waitErr = messages.Errorf("latexmk が終了コード %d で終了しました．上のログを確認してください．", code)
		}
		a.finishBuild(run, &code, waitErr, "", "")
		return
	}
	pdfSource, err := findOutputPDF(project.Root, project.Main, outputDirectory)
	if err != nil {
		a.finishBuild(run, &code, err, "", "")
		return
	}
	run.pdfName = filepath.Base(pdfSource)
	pdf, err := a.copySuccessfulPDF(project.Root, pdfSource, run.result.ID)
	if err != nil {
		a.finishBuild(run, &code, messages.Errorf("PDF を表示用にコピーできません: %w", err), "", "")
		return
	}
	a.appendMessage(run, "\n[PDF] %s\n", pdfSource)
	run.sources, run.markdownInputs = sourcesForPDF(project.Root, project.Main, pdfSource, sources)
	run.synctex, err = a.cacheSyncTeX(project.Root, pdfSource, pdf, run.result.ID, bin, sources)
	if err != nil {
		a.appendMessage(run, "[SyncTeX] 原稿と PDF の位置を照合できません: %v\n", err)
	} else {
		a.appendMessage(run, "[SyncTeX] この PDF に対応するデータを保存しました．\n")
	}
	a.finishBuild(run, &code, nil, pdf, run.result.ID)
}

func (a *App) stopBuild(expectedProject ...string) error {
	a.mu.Lock()
	if len(expectedProject) > 0 {
		if err := a.checkProjectLocked(expectedProject[0], true); err != nil {
			a.mu.Unlock()
			return err
		}
	}
	if !a.isRunningLocked() {
		a.mu.Unlock()
		return nil
	}
	run := a.build
	run.cancelRequested = true
	process := run.process
	a.mu.Unlock()
	if process != nil {
		if err := platform.StopProcess(process); err != nil && !errors.Is(err, os.ErrProcessDone) {
			a.mu.Lock()
			a.appendMessageLocked(run, "\n[停止要求] %v\n", err)
			a.mu.Unlock()
			return messages.Errorf("停止処理を完了できません: %w", err)
		}
	}
	return nil
}

func latexmkArguments(project Project) []string {
	directory := buildDirectoryRelative(project.Main)
	args := []string{"-interaction=nonstopmode", "-file-line-error", "-halt-on-error", "-synctex=1", "-recorder",
		"-outdir=" + directory, "-auxdir=" + directory}
	if runtime.GOOS == "windows" {
		// Keep BibTeX in the source directory. upBibTeX resolves absolute
		// BIBINPUTS paths through Windows' legacy code page, which can lose
		// characters in the project's parent directories. The auxiliary
		// files are still addressed relative to the source directory.
		args = append(args, "-bibtexfudge-")
	}
	switch project.Mode {
	case "pdflatex":
		args = append(args, "-pdf")
	case "xelatex":
		args = append(args, "-xelatex")
	case "lualatex":
		args = append(args, "-lualatex")
	case "uplatex":
		args = append(args, "-pdfdvi", "-e", `$latex='uplatex %O %S'; $bibtex='upbibtex %O %B'; $dvipdf='dvipdfmx %O -o %D %S';`)
	}
	return append(args, "./"+project.Main)
}

func commandEnvironment(bin string) []string {
	environment := managedTeXEnvironmentForBin(os.Environ(), bin)
	if bin == "" {
		return environment
	}
	for index, item := range environment {
		key, value, ok := strings.Cut(item, "=")
		if ok && strings.EqualFold(key, "PATH") {
			environment[index] = key + "=" + bin + string(os.PathListSeparator) + value
			return environment
		}
	}
	return append(environment, "PATH="+bin)
}

func displayCommand(executable string, arguments []string) string {
	words := append([]string{executable}, arguments...)
	for index, word := range words {
		if strings.ContainsAny(word, " \t\r\n\"") {
			words[index] = strconv.Quote(word)
		}
	}
	return strings.Join(words, " ")
}

func findLatexmk(texBin string) (string, string, error) {
	name := "latexmk"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if texBin != "" {
		path := filepath.Join(texBin, name)
		if info, err := os.Stat(path); err == nil {
			if regular, err := platform.IsRegularFile(path, info); err == nil && regular {
				absolute, err := filepath.Abs(path)
				return absolute, filepath.Dir(absolute), err
			}
		}
		return "", texBin, messages.Errorf("%s が見つかりません．設定で latexmk が入っている TeX Live のフォルダーを指定してください．", path)
	}
	if path, err := exec.LookPath(name); err == nil {
		absolute, err := filepath.Abs(path)
		return absolute, filepath.Dir(absolute), err
	}
	if runtime.GOOS == "windows" {
		drive := os.Getenv("SystemDrive")
		if drive == "" {
			drive = "C:"
		}
		candidates, _ := filepath.Glob(filepath.Join(drive+`\`, "texlive", "*", "bin", "windows", name))
		sort.Sort(sort.Reverse(sort.StringSlice(candidates)))
		for _, candidate := range candidates {
			if info, err := os.Stat(candidate); err == nil {
				if regular, err := platform.IsRegularFile(candidate, info); err == nil && regular {
					return candidate, filepath.Dir(candidate), nil
				}
			}
		}
	}
	return "", "", messages.Errorf("latexmk が見つかりません．設定で TeX Live の bin フォルダーを指定してください．")
}

func buildDirectoryRelative(main string) string {
	if main == "" || samePath(main, "main.tex") {
		return buildRelative
	}
	name := filepath.ToSlash(main)
	if runtime.GOOS == "windows" {
		name = strings.ToLower(name)
	}
	key := sha256.Sum256([]byte(name))
	return buildRelative + "/doc-" + hex.EncodeToString(key[:16])
}

func ensureBuildDirectory(root string, main ...string) (string, error) {
	relative := buildRelative
	if len(main) > 0 {
		relative = buildDirectoryRelative(main[0])
	}
	path := root
	for _, part := range strings.Split(relative, "/") {
		path = filepath.Join(path, part)
		if err := os.Mkdir(path, 0700); err != nil && !errors.Is(err, os.ErrExist) {
			return "", messages.Errorf("コンパイル用のフォルダーを作れません: %w", err)
		}
		info, err := os.Lstat(path)
		if err != nil {
			return "", err
		}
		linked, err := platform.IsReparsePoint(path)
		if err != nil {
			return "", err
		}
		if linked || !info.IsDir() {
			return "", messages.Errorf("%s が通常のフォルダーではありません．", path)
		}
	}
	return path, nil
}

var quotedFDBValue = regexp.MustCompile(`"((?:[^"\\]|\\.)*)"`)

type fdbRecord struct {
	modified time.Time
	outputs  []string
}

func fdbValues(line string) []string {
	items := quotedFDBValue.FindAllString(line, -1)
	values := make([]string, 0, len(items))
	for _, item := range items {
		value, err := strconv.Unquote(item)
		if err != nil {
			value = strings.Trim(item, `"`)
		}
		values = append(values, value)
	}
	return values
}

func absoluteFrom(root, path string) string {
	path = filepath.FromSlash(path)
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	return filepath.Clean(filepath.Join(root, path))
}

// latexmk records a separate rule for DVI-to-PDF, including a custom job name.
func findOutputPDF(root, main, directory string) (string, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return "", err
	}
	mainPath := absoluteFrom(root, main)
	records := []fdbRecord{}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".fdb_latexmk") {
			continue
		}
		relative, err := filepath.Rel(root, filepath.Join(directory, entry.Name()))
		if err != nil {
			continue
		}
		path, err := safePath(root, filepath.ToSlash(relative), false)
		if err != nil {
			continue
		}
		data, err := readBytes(path)
		if err != nil {
			continue
		}
		matchesMain := false
		outputs := []string{}
		for _, line := range strings.Split(string(data), "\n") {
			if !strings.HasPrefix(line, "[\"") {
				continue
			}
			values := fdbValues(line)
			if len(values) < 3 {
				continue
			}
			if strings.EqualFold(filepath.Ext(values[1]), ".tex") && samePath(absoluteFrom(root, values[1]), mainPath) {
				matchesMain = true
			}
			if strings.EqualFold(filepath.Ext(values[2]), ".pdf") {
				outputs = append(outputs, absoluteFrom(root, values[2]))
			}
		}
		if matchesMain {
			info, err := entry.Info()
			if err != nil {
				continue
			}
			records = append(records, fdbRecord{modified: info.ModTime(), outputs: outputs})
		}
	}
	sort.Slice(records, func(i, j int) bool { return records[i].modified.After(records[j].modified) })
	if len(records) > 0 {
		for _, path := range records[0].outputs {
			if checked, err := validatePDF(root, directory, path); err == nil {
				return checked, nil
			}
		}
		return "", messages.Errorf("latexmk は終了しましたが，%s の処理に対応する PDF がありません．設定のコンパイル方法と latexmkrc の PDF 出力設定を確認してください．出力先: %s", main, directory)
	}
	// Versions without an fdb record can still use the conventional job name.
	stem := strings.TrimSuffix(filepath.Base(main), filepath.Ext(main))
	fallback := filepath.Join(directory, stem+".pdf")
	if checked, err := validatePDF(root, directory, fallback); err == nil {
		return checked, nil
	}
	return "", messages.Errorf("latexmk は終了しましたが，PDF が見つかりません．メインの文書と latexmkrc の出力設定を確認してください．検索先: %s", directory)
}

func validatePDF(root, directory, path string) (string, error) {
	within, err := filepath.Rel(directory, path)
	if err != nil || within == ".." || strings.HasPrefix(within, ".."+string(filepath.Separator)) || filepath.IsAbs(within) {
		return "", errors.New("PDF is outside the build directory")
	}
	relative, err := filepath.Rel(root, path)
	if err != nil {
		return "", err
	}
	path, err = safePath(root, filepath.ToSlash(relative), false)
	if err != nil {
		return "", err
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	var header [5]byte
	if _, err := io.ReadFull(file, header[:]); err != nil || !bytes.Equal(header[:], []byte("%PDF-")) {
		return "", messages.Errorf("生成されたファイルは PDF の形式ではありません．")
	}
	return path, nil
}

func (a *App) copySuccessfulPDF(root, source, id string) (string, error) {
	a.cacheMu.Lock()
	defer a.cacheMu.Unlock()
	directory := a.projectCacheDirectory(root)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	in, err := os.Open(source)
	if err != nil {
		return "", err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return "", err
	}
	if info.Size() > 512<<20 {
		return "", messages.Errorf("PDF が 512 MiB を超えています．画像のサイズを確認してください．")
	}
	out, err := os.CreateTemp(directory, ".pdf-*")
	if err != nil {
		return "", err
	}
	temp := out.Name()
	defer os.Remove(temp)
	_, copyErr := io.Copy(out, io.LimitReader(in, (512<<20)+1))
	if copyErr == nil {
		copyErr = out.Sync()
	}
	closeErr := out.Close()
	if copyErr != nil {
		return "", copyErr
	}
	if closeErr != nil {
		return "", closeErr
	}
	destination := filepath.Join(directory, "pdf-"+id+".pdf")
	if err := platform.ReplaceFile(temp, destination); err != nil {
		return "", err
	}
	return destination, nil
}

func minimum(a, b int) int {
	if a < b {
		return a
	}
	return b
}
