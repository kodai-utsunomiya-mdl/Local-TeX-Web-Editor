package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

const texSetupRelease = "v2026.11"
const texSetupTimeout = 4 * time.Hour
const texSetupCTANRepository = "https://mirror.ctan.org/systems/texlive/tlnet"

type TeXSetupState struct {
	Supported       bool            `json:"supported"`
	Status          string          `json:"status"`
	Operation       string          `json:"operation"`
	ID              string          `json:"id"`
	Stage           string          `json:"stage"`
	Release         string          `json:"release"`
	Parent          string          `json:"parent"`
	Directory       string          `json:"directory"`
	Source          string          `json:"source"`
	ArchiveBytes    int64           `json:"archiveBytes"`
	DownloadedBytes int64           `json:"downloadedBytes"`
	DownloadTotal   int64           `json:"downloadTotal"`
	Packages        []string        `json:"packages"`
	Log             string          `json:"log"`
	Error           string          `json:"error"`
	Bin             string          `json:"bin"`
	Managed         bool            `json:"managed"`
	Cancelable      bool            `json:"cancelable"`
	Install         TeXSetupPlan    `json:"install"`
	Environment     *TeXEnvironment `json:"environment,omitempty"`
}

type TeXSetupPlan struct {
	Release      string   `json:"release"`
	Parent       string   `json:"parent"`
	Source       string   `json:"source"`
	ArchiveBytes int64    `json:"archiveBytes"`
	Packages     []string `json:"packages"`
}

type texSetupArchive struct {
	URL, SHA256, Filename string
	Bytes                 int64
}

type texSetupRun struct {
	state            TeXSetupState
	cancel           context.CancelFunc
	ctx              context.Context
	err              error
	log              []byte
	archive          texSetupArchive
	configuredBin    string
	reinstall        bool
	reused           *managedTeXInstallation
	job              *texSetupDirectory
	bin              string
	root             string
	rootInfo         os.FileInfo
	unknownFiles     []string
	inventoryStarted bool
	external         *TeXEnvironment
	removalRevision  string
	removalPlan      *texPackageRemovalPreview
	deletion         *texSetupDeletionInspection
	done             chan struct{}
}

// These dependencies also let unit tests exercise downloads and transactions
// with a local server and small files instead of installing a distribution.
type texSetupHooks struct {
	archive        texSetupArchive
	client         *http.Client
	extract        func(context.Context, *texSetupRun, string) error
	packages       func(context.Context, *texSetupRun) error
	check          func(context.Context, *texSetupRun) error
	removalPreview func(context.Context, TeXEnvironment, []string, bool) ([]texPackageRemoval, string, error)
	removePackages func(context.Context, *texSetupRun, []string) error
	uninstall      func(context.Context, TeXEnvironment, io.Writer) error
}

type texSetupInput struct {
	Consent     bool     `json:"consent"`
	Operation   string   `json:"operation"`
	Parent      string   `json:"parent"`
	Packages    []string `json:"packages"`
	Reinstall   bool     `json:"reinstall"`
	Directory   string   `json:"directory"`
	Revision    string   `json:"revision"`
	environment *TeXEnvironment
	removalPlan *texPackageRemovalPreview
}

func defaultTeXSetupArchive() (texSetupArchive, bool) {
	const base = "https://github.com/rstudio/tinytex-releases/releases/download/" + texSetupRelease + "/"
	switch {
	case runtime.GOOS == "windows" && runtime.GOARCH == "amd64":
		name := "TinyTeX-1-windows-v2026.11.exe"
		return texSetupArchive{URL: base + name, Filename: name, Bytes: 73710178, SHA256: "375e8adec0177cd9ec6a1f8c76efe0c22b1a0c260e76a00386bcea52d88e5354"}, true
	case runtime.GOOS == "darwin" && (runtime.GOARCH == "amd64" || runtime.GOARCH == "arm64"):
		name := "TinyTeX-1-darwin-v2026.11.tar.xz"
		return texSetupArchive{URL: base + name, Filename: name, Bytes: 67211812, SHA256: "9416a257c4caea2f82351fa2f89252b8bd75dceeb0ce6e442d25530b1922a02d"}, true
	}
	return texSetupArchive{}, false
}

func (a *App) texSetupDistributionLocked() (texSetupArchive, bool) {
	if a.texSetupHooks != nil && a.texSetupHooks.archive.URL != "" {
		return a.texSetupHooks.archive, true
	}
	return defaultTeXSetupArchive()
}

func baseTeXSetupPackages() []string {
	packages := strings.Fields("latexmk synctex latex-bin pdftex luahbtex luaotfload xetex collection-langjapanese bibtex biblatex biber upmendex amsmath amsfonts amscls tools graphics float geometry booktabs url natbib hyperref lm mathtools jknapltx rsfs doublestroke placeins enumitem tcolorbox pgf algorithms algorithmicx aliascnt cleveref fancyhdr needspace tikzfill pdfcol listings listingsutf8 haranoaji ptex-fontmaps adobemapping")
	if runtime.GOOS == "windows" {
		packages = append(packages, "synctex.windows")
	}
	sort.Strings(packages)
	return packages
}

func (a *App) isTeXSetupRunningLocked() bool {
	return a.texSetup != nil && (a.texSetup.state.Status == "running" || a.texSetup.state.Status == "cancelling")
}

func (a *App) texSetupSnapshotLocked(language string) TeXSetupState {
	archive, supported := a.texSetupDistributionLocked()
	parent, parentErr := platform.DefaultTeXSetupParent(a.options.ConfigDir)
	plan := TeXSetupPlan{Release: texSetupRelease, Parent: parent, Source: archive.URL, ArchiveBytes: archive.Bytes, Packages: baseTeXSetupPackages()}
	if run := a.texSetup; run != nil {
		result := run.state
		result.Install = plan
		if !a.isTeXSetupRunningLocked() {
			result.Environment = a.texEnvironment
			if record, ok := a.selectedManagedTeXLocked(); ok {
				environment := managedTeXEnvironment(record)
				result.Environment = &environment
			}
			result.Managed = result.Environment != nil && result.Environment.Managed
		} else if result.Environment == nil {
			result.Environment = a.texEnvironment
		}
		result.Packages = append([]string{}, result.Packages...)
		result.Log = readableLog(run.log, !a.isTeXSetupRunningLocked())
		result.Error = messages.ErrorText(language, run.err)
		return result
	}
	result := TeXSetupState{Supported: supported, Status: "idle", Release: texSetupRelease,
		Parent: parent, Source: archive.URL, ArchiveBytes: archive.Bytes, Packages: baseTeXSetupPackages(), Install: plan, Error: messages.ErrorText(language, parentErr)}
	if managed, ok := a.selectedManagedTeXLocked(); ok {
		result.Parent, result.Directory, result.Bin, result.Managed = managed.Parent, managed.Directory, managed.Bin, true
		environment := managedTeXEnvironment(managed)
		result.Environment = &environment
	} else {
		result.Environment = a.texEnvironment
	}
	return result
}

var texSetupPackageName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$`)

func cleanTeXSetupPackages(packages []string) ([]string, error) {
	if len(packages) == 0 || len(packages) > 128 {
		return nil, fail(http.StatusBadRequest, "導入する TeX パッケージを 1～128 個指定してください．")
	}
	seen := make(map[string]bool)
	result := []string{}
	for _, name := range packages {
		if !texSetupPackageName.MatchString(name) {
			return nil, fail(http.StatusBadRequest, "TeX パッケージの名前を確認してください: %s", name)
		}
		if !seen[name] {
			seen[name] = true
			result = append(result, name)
		}
	}
	sort.Strings(result)
	return result, nil
}

func (a *App) startTeXSetupLocked(input texSetupInput) error {
	if !input.Consent {
		return fail(http.StatusBadRequest, "取得元と導入先を確認し，TeX の導入を選んでください．")
	}
	if a.closed {
		return fail(http.StatusServiceUnavailable, "アプリは終了しています．")
	}
	if a.isTeXSetupRunningLocked() {
		return fail(http.StatusConflict, "TeX の導入が進行中です．完了を待つか停止してください．")
	}
	if a.isRunningLocked() {
		return fail(http.StatusConflict, "コンパイルが終了してから TeX を導入してください．")
	}
	archive, supported := a.texSetupDistributionLocked()
	if !supported && input.Operation == "install" {
		return fail(http.StatusBadRequest, "この OS と CPU ではアプリ内からの TeX 導入を利用できません．")
	}
	parent := strings.TrimSpace(input.Parent)
	if parent != "" && !filepath.IsAbs(parent) {
		return fail(http.StatusBadRequest, "導入先の親フォルダーには絶対パスを指定してください．")
	}
	var reused *managedTeXInstallation
	packages := baseTeXSetupPackages()
	source := archive.URL
	if input.Operation == "packages" || input.Operation == "remove-packages" {
		managed, ok := a.selectedManagedTeXLocked()
		if !ok && input.environment == nil {
			return fail(http.StatusForbidden, "アプリから導入した TeX を選んでから，パッケージを追加してください．")
		}
		var err error
		packages, err = cleanTeXSetupPackages(input.Packages)
		if err != nil {
			return err
		}
		if ok {
			reused, parent = &managed, managed.Parent
			source = texSetupCTANRepository
		} else {
			if input.Operation == "packages" && !input.environment.CanInstallPackages || input.Operation == "remove-packages" && !input.environment.CanRemovePackages {
				return fail(http.StatusForbidden, "この TeX のパッケージは公式の管理画面から変更してください．")
			}
			if input.Directory == "" || !samePath(input.Directory, input.environment.Directory) || input.Revision == "" {
				return fail(http.StatusConflict, "TeX の環境とパッケージの一覧を確認してから操作してください．")
			}
			parent = filepath.Dir(input.environment.Directory)
			source = ""
		}
	} else if input.Operation == "install" {
		for index := len(a.config.TeXInstallations) - 1; index >= 0; index-- {
			managed := a.config.TeXInstallations[index]
			if managed.Release == texSetupRelease && (parent == "" || sameTeXSetupLocation(parent, managed.Parent)) && validateManagedTeX(managed) == nil && managedTeXProgramsAvailable(managed.Bin) {
				reused, parent = &managed, managed.Parent
				break
			}
		}
	} else {
		return fail(http.StatusBadRequest, "TeX の導入方法を選び直してください．")
	}
	if parent == "" {
		var err error
		parent, err = platform.DefaultTeXSetupParent(a.options.ConfigDir)
		if err != nil {
			return err
		}
	}
	id, err := randomID()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), texSetupTimeout)
	if input.environment != nil && !sameTeXSetupLocation(texPackageBin(a.config.TexBin), input.environment.Bin) {
		cancel()
		return fail(http.StatusConflict, "TeX の設定が変更されました．選択した環境を確認してください．")
	}
	run := &texSetupRun{ctx: ctx, cancel: cancel, archive: archive, configuredBin: a.config.TexBin, reinstall: input.Reinstall, reused: reused, removalRevision: input.Revision, removalPlan: input.removalPlan, done: make(chan struct{}),
		state: TeXSetupState{Supported: true, Status: "running", Cancelable: true, Operation: input.Operation, ID: id, Stage: "downloading", Release: texSetupRelease,
			Parent: parent, Source: source, ArchiveBytes: archive.Bytes, Packages: packages}}
	if reused != nil {
		run.root, run.bin = reused.Directory, reused.Bin
		run.state.Directory, run.state.Bin, run.state.Managed = reused.Directory, reused.Bin, true
		run.state.Stage = "packages"
		environment := managedTeXEnvironment(*reused)
		run.state.Environment = &environment
	}
	if input.environment != nil && !input.environment.Managed && input.Operation != "install" {
		run.external = input.environment
		run.root, run.bin = input.environment.Directory, input.environment.Bin
		run.state.Directory, run.state.Bin, run.state.Environment = run.root, run.bin, input.environment
		run.state.Stage = "packages"
	}
	if input.Operation == "packages" || input.Operation == "remove-packages" {
		run.state.ArchiveBytes = 0
	}
	a.texSetup = run
	a.workers.Add(1)
	go a.runTeXSetup(run, input.Parent == "")
	return nil
}

func (a *App) cancelTeXSetup() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.isTeXSetupRunningLocked() && a.texSetup.state.Cancelable {
		a.texSetup.state.Status = "cancelling"
		a.texSetup.cancel()
	}
}

func (a *App) texSetupStage(run *texSetupRun, stage string) {
	a.mu.Lock()
	run.state.Stage = stage
	a.mu.Unlock()
}

type texSetupOutput struct {
	app *App
	run *texSetupRun
}

func (output texSetupOutput) Write(data []byte) (int, error) {
	output.app.mu.Lock()
	defer output.app.mu.Unlock()
	output.run.log = append(output.run.log, data...)
	if len(output.run.log) > maxLogBytes {
		output.run.log = append([]byte{}, output.run.log[len(output.run.log)-maxLogBytes:]...)
	}
	return len(data), nil
}

func (a *App) texSetupLog(run *texSetupRun, format string, args ...any) {
	_, _ = fmt.Fprintf(texSetupOutput{a, run}, format, args...)
}

func (a *App) texSetupHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet, http.MethodPost) {
		return
	}
	var input texSetupInput
	if r.Method == http.MethodGet {
		a.mu.Lock()
		inspect := !a.isTeXSetupRunningLocked()
		a.mu.Unlock()
		if inspect {
			_, _ = a.currentTeXEnvironment(r.Context())
		}
	}
	if r.Method == http.MethodPost {
		if err := readJSON(w, r, &input); err != nil {
			writeError(w, err)
			return
		}
		if !input.Consent {
			writeError(w, fail(http.StatusBadRequest, "取得元と導入先を確認し，TeX の導入を選んでください．"))
			return
		}
		if input.Operation == "packages" || input.Operation == "remove-packages" {
			if !a.texSetupMu.TryLock() {
				writeError(w, texManagementBusyError())
				return
			}
			defer a.texSetupMu.Unlock()
			if err := a.checkTeXManagementAvailable(); err != nil {
				writeError(w, err)
				return
			}
			environment, err := a.currentTeXEnvironment(r.Context())
			if err != nil {
				writeError(w, err)
				return
			}
			input.environment = &environment
			if input.Operation == "packages" && (!environment.Managed || input.Revision != "" || input.Directory != "") {
				installed, err := readInstalledTeXPackages(environment)
				if err != nil {
					writeError(w, err)
					return
				}
				if input.Revision != installed.Revision || !samePath(input.Directory, environment.Directory) {
					writeJSON(w, http.StatusConflict, map[string]any{"error": messages.Text(messages.LanguageFromContext(r.Context()), "TeX の環境とパッケージの一覧を確認してから操作してください．"), "packages": installed})
					return
				}
			}
			if input.Operation == "remove-packages" {
				release, err := platform.AcquireTeXSetupLock(environment.Directory)
				if err != nil {
					writeError(w, err)
					return
				}
				ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
				preview, err := a.previewTeXPackageRemoval(ctx, environment, input.Packages)
				cancel()
				release()
				if err != nil {
					writeError(w, err)
					return
				}
				if input.Revision == "" || input.Revision != preview.Revision || !samePath(input.Directory, preview.Directory) {
					writeJSON(w, http.StatusConflict, map[string]any{"error": messages.Text(messages.LanguageFromContext(r.Context()), "TeX の削除予定が変更されました．内容をもう一度確認してください．"), "preview": preview})
					return
				}
				input.removalPlan = &preview
			}
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if r.Method == http.MethodPost {
		if err := a.startTeXSetupLocked(input); err != nil {
			writeError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, a.texSetupSnapshotLocked(messages.LanguageFromContext(r.Context())))
}

func (a *App) texSetupStopHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var input struct {
		ID string `json:"id"`
	}
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if input.ID == "" || a.texSetup == nil || input.ID != a.texSetup.state.ID {
		writeError(w, fail(http.StatusConflict, "TeX の導入状況が変更されました．現在の処理を確認してください．"))
		return
	}
	if a.isTeXSetupRunningLocked() {
		if !a.texSetup.state.Cancelable {
			writeError(w, fail(http.StatusConflict, "TeX の操作が終わるまでお待ちください．OS の画面が開いている場合は，その画面で操作してください．"))
			return
		}
		a.texSetup.state.Status = "cancelling"
		a.texSetup.cancel()
	}
	writeJSON(w, http.StatusOK, a.texSetupSnapshotLocked(messages.LanguageFromContext(r.Context())))
}

func (a *App) texSetupPickHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	if _, err := io.Copy(io.Discard, http.MaxBytesReader(w, r.Body, 4096)); err != nil {
		writeError(w, fail(http.StatusBadRequest, "フォルダー選択のリクエストを読み取れません．"))
		return
	}
	path, err := platform.PickFolder(r.Context())
	if errors.Is(err, context.Canceled) {
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": path, "cancelled": path == ""})
}

func managedTeXProgramsAvailable(bin string) bool {
	for _, name := range []string{"latexmk", "synctex", "pdflatex", "lualatex", "xelatex", "xdvipdfmx", "uplatex", "dvipdfmx", "bibtex", "upbibtex", "biber", "upmendex"} {
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		if !texProgramExists(filepath.Join(bin, name)) {
			return false
		}
	}
	return true
}

func sameTeXSetupLocation(left, right string) bool {
	a, leftErr := filepath.EvalSymlinks(left)
	b, rightErr := filepath.EvalSymlinks(right)
	return leftErr == nil && rightErr == nil && samePath(a, b)
}
