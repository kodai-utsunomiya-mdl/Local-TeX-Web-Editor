package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

type cachedBuild struct {
	Format         int               `json:"format"`
	ID             string            `json:"id"`
	Main           string            `json:"main"`
	Name           string            `json:"name,omitempty"`
	Mode           string            `json:"mode"`
	StartedAt      string            `json:"startedAt"`
	FinishedAt     string            `json:"finishedAt"`
	Changed        bool              `json:"sourceChanged"`
	Sources        map[string]string `json:"sources"`
	MarkdownInputs []string          `json:"markdownInputs"`
	SyncTeX        *synctexVersion   `json:"synctex,omitempty"`
}

func (a *App) projectCacheDirectory(root string) string {
	key := sha256.Sum256([]byte(root))
	return filepath.Join(a.options.ConfigDir, "cache", hex.EncodeToString(key[:16]))
}

// The caller holds a.mu. The PDF and SyncTeX data have already been copied.
func (a *App) saveCachedBuild(project Project, run *buildRun, pdf string) error {
	a.cacheMu.Lock()
	defer a.cacheMu.Unlock()
	value := cachedBuild{Format: 1, ID: run.result.ID, Main: project.Main, Name: compiledPDFName(run.pdfName), Mode: project.Mode,
		StartedAt: run.result.StartedAt, FinishedAt: run.result.FinishedAt,
		Changed: run.result.SourceChanged, Sources: run.sources, MarkdownInputs: markdownInputList(run.markdownInputs), SyncTeX: run.synctex}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(data) > maxTextSize {
		return messages.Errorf("PDF に対応する原稿の一覧が 8 MiB を超えています．")
	}
	file, err := os.CreateTemp(filepath.Dir(pdf), ".pdf-state-*")
	if err != nil {
		return err
	}
	temp := file.Name()
	defer os.Remove(temp)
	_, writeErr := file.Write(data)
	if writeErr == nil {
		writeErr = file.Sync()
	}
	if err := file.Close(); writeErr == nil {
		writeErr = err
	}
	if writeErr != nil {
		return writeErr
	}
	return platform.ReplaceFile(temp, strings.TrimSuffix(pdf, ".pdf")+".json")
}

// The caller holds a.mu. Pruning happens after a successful version is made
// current, so cancelling while copying cannot remove the PDF still on screen.
func (a *App) trimPDFCacheLocked(directory string) {
	a.cacheMu.Lock()
	defer a.cacheMu.Unlock()
	keep := make(map[string]bool)
	for _, pdf := range a.pdfVersions {
		if samePath(filepath.Dir(pdf), directory) {
			stem := strings.TrimSuffix(filepath.Base(pdf), ".pdf")
			for _, extension := range []string{".pdf", ".synctex.gz", ".synctex", ".json"} {
				keep[stem+extension] = true
			}
		}
	}
	entries, _ := os.ReadDir(directory)
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || keep[name] || !strings.HasPrefix(name, "pdf-") {
			continue
		}
		for _, extension := range []string{".pdf", ".synctex.gz", ".synctex", ".json"} {
			if strings.HasSuffix(name, extension) {
				_ = os.Remove(filepath.Join(directory, name))
				break
			}
		}
	}
}

// Reopening a project can display its last successful result immediately.
// A damaged or unavailable cache leaves the project ready to compile again.
func (a *App) restoreCachedBuildLocked(project Project) {
	a.cacheMu.RLock()
	defer a.cacheMu.RUnlock()
	directory := a.projectCacheDirectory(project.Root)
	entries, err := os.ReadDir(directory)
	if err != nil {
		return
	}
	names := []string{}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "pdf-") || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if regular, err := platform.IsRegularFile(filepath.Join(directory, entry.Name()), info); err == nil && regular {
			names = append(names, entry.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	sourceRevisions := make(map[string]cachedSourceRevision)
	for _, name := range names {
		data, err := readCacheFile(filepath.Join(directory, name), maxTextSize)
		if err != nil {
			continue
		}
		var value cachedBuild
		if json.Unmarshal(data, &value) != nil || value.Format != 1 || value.ID == "" || name != "pdf-"+value.ID+".json" || !validMode(value.Mode) {
			continue
		}
		if main, err := cleanRelative(value.Main); err != nil || main != value.Main || !strings.EqualFold(filepath.Ext(main), ".tex") {
			continue
		}
		_, listed := a.compiledPDFs[compiledPDFKey(value.Main)]
		if listed && len(a.pdfOrder) >= 2 {
			continue
		}
		pdf := strings.TrimSuffix(filepath.Join(directory, name), ".json") + ".pdf"
		if !validCachedPDF(pdf) {
			continue
		}
		a.pdfVersions[value.ID] = pdf
		if a.pdfMains == nil {
			a.pdfMains = make(map[string]string)
		}
		a.pdfMains[value.ID] = value.Main
		if len(a.pdfOrder) < 2 {
			a.pdfOrder = append([]string{value.ID}, a.pdfOrder...)
		}
		if sync := value.SyncTeX; sync != nil && sync.ID == value.ID {
			syncPath := strings.TrimSuffix(pdf, ".pdf") + ".synctex.gz"
			info, err := os.Lstat(syncPath)
			regular := false
			if err == nil {
				regular, err = platform.IsRegularFile(syncPath, info)
			}
			if err == nil && regular {
				sync.Root, sync.PDF = project.Root, pdf
				valid := len(sync.Inputs) <= 50_000
				for _, input := range sync.Inputs {
					if input.Path != "" {
						if _, err := cleanRelative(input.Path); err != nil {
							valid = false
						}
					}
					if input.Alias == "" || strings.ContainsAny(input.Alias, ":/\\\x00\r\n") {
						valid = false
					}
				}
				if valid {
					a.synctexVersions[value.ID] = sync
				}
			}
		}
		changed := value.Changed || value.Mode != project.Mode || cachedSourcesChanged(project.Root, value.Sources, sourceRevisions)
		inputs := markdownInputSet(value.MarkdownInputs)
		if !listed {
			a.recordCompiledPDFLocked(value.Main, value.Name, value.ID, pdf, changed, inputs)
		}
		if a.lastPDF != "" {
			continue
		}
		a.lastPDF, a.lastPDFID = pdf, value.ID
		started, _ := time.Parse(time.RFC3339Nano, value.StartedAt)
		finished, _ := time.Parse(time.RFC3339Nano, value.FinishedAt)
		if started.IsZero() {
			started = time.Now()
		}
		if finished.IsZero() || finished.Before(started) {
			finished = started
		}
		a.lastPDFMain, a.lastPDFChanged = value.Main, changed
		a.lastPDFMarkdownInputs = inputs
		compiledProject := project
		compiledProject.Main, compiledProject.Mode = value.Main, value.Mode
		code := 0
		a.build = &buildRun{started: started, finished: finished, project: compiledProject, sources: value.Sources, markdownInputs: a.lastPDFMarkdownInputs, synctex: a.synctexVersions[value.ID], pdfName: compiledPDFName(value.Name),
			result: Build{ID: value.ID, Main: value.Main, Status: "success", ExitCode: &code, StartedAt: started.UTC().Format(time.RFC3339Nano),
				FinishedAt: finished.UTC().Format(time.RFC3339Nano), SourceChanged: changed, Restored: true}}
		a.appendMessageLocked(a.build, "[前回の PDF] このプロジェクトで最後に成功した PDF を読み込みました．\n")
	}
}

type cachedSourceRevision struct {
	revision string
	size     int64
	valid    bool
}

func cachedSourcesChanged(root string, sources map[string]string, checked map[string]cachedSourceRevision) bool {
	if len(sources) == 0 {
		return true
	}
	remaining := int64(128 << 20)
	for relative, previous := range sources {
		current, exists := checked[relative]
		if !exists {
			_, path, err := projectFilePath(root, relative, false)
			if err == nil {
				if data, err := readBytes(path); err == nil {
					current = cachedSourceRevision{revision: revision(data), size: int64(len(data)), valid: true}
				}
			}
			checked[relative] = current
		}
		if !current.valid || current.size > remaining || current.revision != previous {
			return true
		}
		remaining -= current.size
	}
	return false
}

func readCacheFile(path string, limit int64) ([]byte, error) {
	linked, err := platform.IsReparsePoint(path)
	if err != nil || linked {
		return nil, messages.Errorf("キャッシュのファイルを開けません．")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Size() > limit {
		return nil, messages.Errorf("キャッシュのファイルを読めません．")
	}
	regular, err := platform.IsRegularFile(path, info)
	if err != nil || !regular {
		return nil, messages.Errorf("キャッシュのファイルを読めません．")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if int64(len(data)) > limit {
		return nil, messages.Errorf("キャッシュのファイルが %d byte を超えています．", limit)
	}
	return data, err
}

func validCachedPDF(path string) bool {
	linked, err := platform.IsReparsePoint(path)
	if err != nil || linked {
		return false
	}
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return false
	}
	if regular, err := platform.IsRegularFile(path, info); err != nil || !regular {
		return false
	}
	var header [5]byte
	_, err = io.ReadFull(file, header[:])
	return err == nil && bytes.Equal(header[:], []byte("%PDF-"))
}
