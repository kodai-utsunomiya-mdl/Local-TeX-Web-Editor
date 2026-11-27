package app

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

const maxTextSize = 8 << 20

type Options struct {
	ConfigDir         string
	ProjectPath       string
	TexBin            string
	Token             string
	Version           string
	InstallationError error
	Shutdown          func()
}

type App struct {
	settingsMu            sync.RWMutex
	settingsResetPending  bool
	folderPickerRequests  int
	uiMu                  sync.Mutex
	mu                    sync.Mutex
	cacheMu               sync.RWMutex
	shortcutMu            sync.Mutex
	startupMu             sync.Mutex
	startupHooks          *startupHooks
	templateMu            sync.Mutex
	shortcutCreator       func(string) (platform.ShortcutResult, error)
	saveFilePicker        fileSavePicker
	options               Options
	packageIdentity       *platform.PackageIdentity
	config                configuration
	project               *Project
	build                 *buildRun
	texSetup              *texSetupRun
	texSetupHooks         *texSetupHooks
	texSetupMu            sync.Mutex
	texEnvironment        *TeXEnvironment
	address               string
	closed                bool
	shutdownOnce          sync.Once
	workers               sync.WaitGroup
	lastPDF               string
	lastPDFID             string
	lastPDFMain           string
	lastPDFChanged        bool
	lastPDFMarkdownInputs map[string]bool
	pdfVersions           map[string]string
	pdfMains              map[string]string
	pdfOrder              []string
	compiledPDFs          map[string]CompiledPDF
	synctexVersions       map[string]*synctexVersion
	synctexSlots          chan struct{}

	browserEnd     chan struct{}
	updates        *applicationUpdates
	updateApplying bool
}

type State struct {
	SettingsGeneration     string                    `json:"settingsGeneration"`
	DraftsGeneration       string                    `json:"draftsGeneration"`
	Version                string                    `json:"version"`
	ExecutablePath         string                    `json:"executablePath"`
	InstallationError      string                    `json:"installationError,omitempty"`
	Platform               string                    `json:"platform"`
	Architecture           string                    `json:"architecture"`
	PackageIdentity        *platform.PackageIdentity `json:"packageIdentity,omitempty"`
	TexBin                 string                    `json:"texBin"`
	TexPackages            TeXPackageStatus          `json:"texPackages"`
	TexSetup               TeXSetupState             `json:"texSetup"`
	Latexmk                string                    `json:"latexmk"`
	ToolError              string                    `json:"toolError,omitempty"`
	Synctex                string                    `json:"synctex"`
	SynctexError           string                    `json:"synctexError,omitempty"`
	SynctexInstallCommands []string                  `json:"synctexInstallCommands"`
	ShortcutsSupported     bool                      `json:"shortcutsSupported"`
	Project                *Project                  `json:"project"`
	ProjectStatus          *ProjectStatus            `json:"projectStatus"`
	RecentProjects         []string                  `json:"recentProjects"`
	RecentProjectStatuses  []ProjectStatus           `json:"recentProjectStatuses"`
	Build                  *Build                    `json:"build"`
	CompiledPDFs           []CompiledPDF             `json:"compiledPDFs"`
}

type apiError struct {
	status  int
	message *messages.Message
}

func (e *apiError) Error() string { return e.message.Error() }

func (e *apiError) Unwrap() error { return e.message }

func (e *apiError) LocalizedMessage(language string) string {
	return e.message.LocalizedMessage(language)
}

func fail(status int, format string, args ...any) error {
	return &apiError{status, messages.Errorf(format, args...)}
}

func New(options Options) (*App, error) {
	if len(options.Token) < 16 {
		return nil, errors.New("the local API token must contain at least 16 characters")
	}
	if options.ConfigDir == "" {
		directories, err := platform.DefaultConfigDirectories()
		if err != nil {
			return nil, messages.Errorf("設定フォルダーを取得できません: %w", err)
		}
		options.ConfigDir = directories.Directory
	}
	identity, err := platform.CurrentPackageIdentity()
	if err != nil {
		return nil, err
	}
	options.ConfigDir, err = filepath.Abs(options.ConfigDir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(options.ConfigDir, 0700); err != nil {
		return nil, messages.Errorf("設定フォルダーを作成できません: %w", err)
	}
	if err := recoverSettingsReset(options.ConfigDir); err != nil {
		return nil, err
	}
	a := &App{
		options: options, packageIdentity: identity, pdfVersions: make(map[string]string), pdfMains: make(map[string]string), compiledPDFs: make(map[string]CompiledPDF),
		synctexVersions: make(map[string]*synctexVersion), synctexSlots: make(chan struct{}, 2),
		browserEnd: make(chan struct{}),
	}
	if err := a.loadConfig(); err != nil {
		return nil, err
	}
	a.initApplicationUpdates()
	if options.TexBin != "" {
		a.config.TexBin = options.TexBin
	}
	if options.ProjectPath != "" {
		if err := a.openProjectLocked(options.ProjectPath); err != nil {
			return nil, err
		}
	} else if len(a.config.RecentProjects) > 0 {
		// An unavailable recent folder should still allow the user to open another one.
		_ = a.openProjectLocked(a.config.RecentProjects[0])
	}
	return a, nil
}

// SetAddress receives the actual address of the listening loopback socket.
func (a *App) SetAddress(address string) {
	address = strings.TrimPrefix(address, "http://")
	address = strings.TrimSuffix(address, "/")
	a.mu.Lock()
	a.address = strings.ToLower(address)
	a.mu.Unlock()
}

func (a *App) Close() error {
	if a.updates != nil {
		a.updates.cancel()
		a.updates.mu.Lock()
		if a.updates.attempt != nil {
			a.updates.attempt.timer.Stop()
			a.updates.attempt = nil
		}
		a.updates.mu.Unlock()
	}
	a.mu.Lock()
	setupRunning := a.isTeXSetupRunningLocked()
	var setupDone <-chan struct{}
	if setupRunning {
		setupDone = a.texSetup.done
	}
	a.mu.Unlock()
	a.CloseBrowserSessions()
	platform.CancelFolderPicker()
	platform.CancelSavePicker()
	a.cancelTeXSetup()
	_ = a.stopBuild()
	if setupDone != nil {
		<-setupDone
	}
	done := make(chan struct{})
	go func() { a.workers.Wait(); close(done) }()
	wait := 15 * time.Second
	if setupRunning {
		wait = time.Minute
	}
	select {
	case <-done:
		return nil
	case <-time.After(wait):
		return messages.Errorf("コンパイルの停止を待っています．")
	}
}

func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/state", a.stateHandler)
	mux.HandleFunc("/api/session", a.browserSessionHandler)
	a.registerUpdateHandlers(mux)
	mux.HandleFunc("/api/project/open", a.openHandler)
	mux.HandleFunc("/api/project/recent", a.recentProjectHandler)
	mux.HandleFunc("/api/project/delete", a.projectDeleteHandler)
	mux.HandleFunc("/api/project/pick", a.pickHandler)
	mux.HandleFunc("/api/project/import", a.projectImportHandler)
	mux.HandleFunc("/api/project/download", a.projectDownloadHandler)
	mux.HandleFunc("/api/project/save-as", a.projectSaveAsHandler)
	mux.HandleFunc("/api/settings", a.settingsHandler)
	mux.HandleFunc("/api/settings/reset", a.settingsResetHandler)
	mux.HandleFunc("/api/tex/setup", a.texSetupHandler)
	mux.HandleFunc("/api/tex/setup/stop", a.texSetupStopHandler)
	mux.HandleFunc("/api/tex/setup/pick", a.texSetupPickHandler)
	mux.HandleFunc("/api/tex/setup/delete", a.texSetupDeleteHandler)
	mux.HandleFunc("/api/tex/setup/uninstaller", a.texSetupUninstallerHandler)
	mux.HandleFunc("/api/tex/packages", a.texPackagesHandler)
	mux.HandleFunc("/api/tex/packages/remove-preview", a.texPackageRemovalPreviewHandler)
	mux.HandleFunc("/api/tex/packages/manager", a.texPackageManagerHandler)
	mux.HandleFunc("/api/shortcuts", a.shortcutsHandler)
	mux.HandleFunc("/api/startup", a.startupHandler)
	mux.HandleFunc("/api/startup/settings", a.startupSettingsHandler)
	mux.HandleFunc("/api/storage", a.storageHandler)
	mux.HandleFunc("/api/file", a.fileHandler)
	mux.HandleFunc("/api/file/download", a.fileDownloadHandler)
	mux.HandleFunc("/api/file/save-as", a.fileSaveAsHandler)
	mux.HandleFunc("/api/entry", a.entryHandler)
	mux.HandleFunc("/api/project/search", a.projectSearchHandler)
	mux.HandleFunc("/api/project/replace", a.projectReplaceHandler)
	mux.HandleFunc("/api/history", a.historyHandler)
	mux.HandleFunc("/api/history/settings", a.historySettingsHandler)
	mux.HandleFunc("/api/assets/import", a.assetImportHandler)
	mux.HandleFunc("/api/files/import", a.fileImportHandler)
	mux.HandleFunc("/api/templates", a.templatesHandler)
	mux.HandleFunc("/api/templates/files", a.fileTemplateHandler)
	mux.HandleFunc("/api/templates/create-project", a.templateProjectHandler)
	mux.HandleFunc("/api/asset", a.assetHandler)
	mux.HandleFunc("/api/build", a.buildHandler)
	mux.HandleFunc("/api/build/stop", a.stopHandler)
	mux.HandleFunc("/api/pdf", a.pdfHandler)
	mux.HandleFunc("/api/pdf/delete", a.compiledPDFDeleteHandler)
	mux.HandleFunc("/api/synctex/forward", a.forwardSyncHandler)
	mux.HandleFunc("/api/synctex/inverse", a.inverseSyncHandler)
	mux.HandleFunc("/api/shutdown", a.shutdownHandler)
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, fail(http.StatusNotFound, "API が見つかりません．"))
	})
	return a.authenticate(mux)
}

func (a *App) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		language := messages.Language(r.Header.Get("Accept-Language"))
		w.Header().Set("Content-Language", language)
		w.Header().Add("Vary", "Accept-Language")
		r = r.WithContext(messages.WithLanguage(r.Context(), language))
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		a.mu.Lock()
		address, closed := a.address, a.closed
		a.mu.Unlock()
		if address == "" || closed {
			writeError(w, fail(http.StatusServiceUnavailable, "アプリを起動し直してください．"))
			return
		}
		remote, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil || net.ParseIP(remote) == nil || !net.ParseIP(remote).IsLoopback() || !strings.EqualFold(r.Host, address) {
			writeError(w, fail(http.StatusForbidden, "この接続からは利用できません．起動時に開いた画面を使用してください．"))
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+address {
			writeError(w, fail(http.StatusForbidden, "編集画面と異なるサイトからの接続です．"))
			return
		}
		if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			writeError(w, fail(http.StatusForbidden, "編集画面から操作してください．"))
			return
		}
		token := r.Header.Get("X-Local-Token")
		if subtle.ConstantTimeCompare([]byte(token), []byte(a.options.Token)) != 1 {
			writeError(w, fail(http.StatusUnauthorized, "接続情報が一致しません．アプリを起動したときの URL を開き直してください．"))
			return
		}
		a.serveSettingsRequest(next, w, r)
	})
}

func requireMethod(w http.ResponseWriter, r *http.Request, methods ...string) bool {
	for _, method := range methods {
		if r.Method == method {
			return true
		}
	}
	w.Header().Set("Allow", strings.Join(methods, ", "))
	writeError(w, fail(http.StatusMethodNotAllowed, "この操作は受け付けていません．"))
	return false
}

func readJSON(w http.ResponseWriter, r *http.Request, target any) error {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return fail(http.StatusUnsupportedMediaType, "JSON 形式で送信してください．")
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2*maxTextSize))
	if err != nil {
		return fail(http.StatusRequestEntityTooLarge, "送信するテキストが大きすぎます．")
	}
	if !utf8.Valid(body) {
		return fail(http.StatusBadRequest, "UTF-8 のテキストを送信してください．")
	}
	if err := json.Unmarshal(body, target); err != nil {
		return fail(http.StatusBadRequest, "送信内容を読み取れません: %v", err)
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	var known *apiError
	if errors.As(err, &known) {
		status = known.status
	} else if errors.Is(err, os.ErrNotExist) {
		status = http.StatusNotFound
	} else if errors.Is(err, os.ErrPermission) {
		status = http.StatusForbidden
	}
	writeJSON(w, status, map[string]string{"error": messages.ErrorText(w.Header().Get("Content-Language"), err)})
}

func (a *App) stateLocked(refresh bool, language ...string) State {
	selected := "ja"
	if len(language) > 0 {
		selected = language[0]
	}
	projectStatus := a.refreshProjectStatusLocked(refresh, selected)
	executable, _ := os.Executable()
	if executable != "" {
		executable, _ = filepath.Abs(executable)
	}
	result := State{
		SettingsGeneration: a.config.SettingsGeneration, DraftsGeneration: a.config.DraftsGeneration,
		Version: a.options.Version, Platform: runtime.GOOS, Architecture: runtime.GOARCH,
		PackageIdentity: a.packageIdentity,
		ExecutablePath:  executable, InstallationError: messages.ErrorText(selected, a.options.InstallationError),
		ShortcutsSupported: runtime.GOOS == "windows" && a.packageIdentity == nil,
		TexBin:             a.config.TexBin, RecentProjects: append([]string{}, a.config.RecentProjects...),
		TexSetup: a.texSetupSnapshotLocked(selected),
		Build:    a.buildSnapshotLocked(selected), CompiledPDFs: a.compiledPDFSnapshotLocked(),
		ProjectStatus: projectStatus, RecentProjectStatuses: a.recentProjectStatusesLocked(projectStatus, selected),
	}
	if a.project != nil {
		copy := *a.project
		copy.Files = append([]ProjectFile{}, copy.Files...)
		copy.Directories = append([]string{}, copy.Directories...)
		copy.DirectoryModifiedAt = make(map[string]time.Time, len(a.project.DirectoryModifiedAt))
		for path, modifiedAt := range a.project.DirectoryModifiedAt {
			copy.DirectoryModifiedAt[path] = modifiedAt
		}
		result.Project = &copy
	}
	tool, bin, err := findLatexmk(a.config.TexBin)
	result.Latexmk = tool
	result.Synctex, result.SynctexError, result.SynctexInstallCommands = synctexStatus(bin, selected)
	if a.config.TexBin == "" && bin != "" {
		result.TexBin = bin
	}
	result.TexPackages = texPackagesStatus(result.TexBin)
	if err != nil {
		result.ToolError = messages.ErrorText(selected, err)
	}
	return result
}

func (a *App) stateHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	a.mu.Lock()
	state := a.stateLocked(true, messages.LanguageFromContext(r.Context()))
	a.mu.Unlock()
	writeJSON(w, http.StatusOK, state)
}

func (a *App) openHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var input struct {
		Path string `json:"path"`
	}
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	a.mu.Lock()
	if a.isRunningLocked() {
		a.mu.Unlock()
		writeError(w, fail(http.StatusConflict, "コンパイルが終わるか，停止してから別のプロジェクトを開いてください．"))
		return
	}
	err := a.openProjectLocked(input.Path)
	var state State
	if err == nil {
		state = a.stateLocked(false, messages.LanguageFromContext(r.Context()))
	}
	a.mu.Unlock()
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func (a *App) settingsHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPut) {
		return
	}
	var input struct {
		TexBin *string `json:"texBin"`
		Main   *string `json:"main"`
		Mode   *string `json:"mode"`
	}
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	a.mu.Lock()
	err := a.checkProjectLocked(r.Header.Get("X-Project-Root"), true)
	if err == nil {
		err = a.updateSettingsLocked(input.TexBin, input.Main, input.Mode)
	}
	var state State
	if err == nil {
		state = a.stateLocked(false, messages.LanguageFromContext(r.Context()))
	}
	a.mu.Unlock()
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func (a *App) fileHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet, http.MethodPut) {
		return
	}
	var input FileDocument
	if r.Method == http.MethodPut {
		if err := readJSON(w, r, &input); err != nil {
			writeError(w, err)
			return
		}
	} else {
		input.Path = r.URL.Query().Get("path")
	}
	a.mu.Lock()
	var document FileDocument
	err := a.checkProjectLocked(r.Header.Get("X-Project-Root"))
	if err != nil {
		// The request belongs to a different project opened in another tab.
	} else if a.project == nil {
		err = fail(http.StatusBadRequest, "原稿フォルダーを開いてください．")
	} else if r.Method == http.MethodGet {
		document, err = readDocument(a.project.Root, input.Path)
	} else {
		document, err = a.saveDocumentWithHistoryLocked(input, messages.LanguageFromContext(r.Context()))
		if err == nil {
			if document.Revision != input.Revision {
				a.noteSavedSourceLocked(document.Path)
			}
			if files, directories, directoryModifiedAt, listErr := listProjectEntries(a.project.Root); listErr == nil {
				a.project.Files = files
				a.project.Directories = directories
				a.project.DirectoryModifiedAt = directoryModifiedAt
				document.DirectoryModifiedAt = directoryModifiedAt
				for _, file := range files {
					if file.Path == document.Path {
						entry := file
						document.Entry = &entry
						break
					}
				}
			}
		}
	}
	a.mu.Unlock()
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, document)
}

func (a *App) buildHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet, http.MethodPost) {
		return
	}
	if r.Method == http.MethodPost {
		var input struct {
			Main string `json:"main"`
		}
		if r.ContentLength != 0 {
			if err := readJSON(w, r, &input); err != nil {
				writeError(w, err)
				return
			}
		}
		build, err := a.startBuild(r.Header.Get("X-Project-Root"), input.Main)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, build)
		return
	}
	a.mu.Lock()
	if err := a.checkProjectLocked(r.Header.Get("X-Project-Root"), true); err != nil {
		a.mu.Unlock()
		writeError(w, err)
		return
	}
	build := a.buildSnapshotLocked(messages.LanguageFromContext(r.Context()))
	a.mu.Unlock()
	writeJSON(w, http.StatusOK, build)
}

func (a *App) stopHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	if err := a.stopBuild(r.Header.Get("X-Project-Root")); err != nil {
		writeError(w, err)
		return
	}
	a.mu.Lock()
	build := a.buildSnapshotLocked(messages.LanguageFromContext(r.Context()))
	a.mu.Unlock()
	writeJSON(w, http.StatusOK, build)
}

func (a *App) pdfHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet, http.MethodHead) {
		return
	}
	a.mu.Lock()
	if err := a.checkProjectLocked(r.Header.Get("X-Project-Root"), true); err != nil {
		a.mu.Unlock()
		writeError(w, err)
		return
	}
	path, buildID := a.lastPDF, a.lastPDFID
	if requested := r.URL.Query().Get("build"); requested != "" && requested != buildID {
		path, buildID = a.pdfVersions[requested], requested
		if path == "" {
			a.mu.Unlock()
			writeError(w, fail(http.StatusGone, "この版の PDF はキャッシュから削除されました．最新の PDF を開き直してください．"))
			return
		}
	}
	a.mu.Unlock()
	if path == "" {
		writeError(w, fail(http.StatusNotFound, "PDF はまだ生成されていません．コンパイルのログを確認してください．"))
		return
	}
	file, err := os.Open(path)
	if err != nil {
		writeError(w, messages.Errorf("PDF を開けません: %w", err))
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		writeError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", "inline; filename=\"document.pdf\"")
	w.Header().Set("ETag", `"`+buildID+`"`)
	http.ServeContent(w, r, "document.pdf", info.ModTime(), file)
}

func (a *App) shutdownHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	a.mu.Lock()
	if a.isTeXSetupRunningLocked() {
		if !a.texSetup.state.Cancelable {
			a.mu.Unlock()
			writeError(w, fail(http.StatusConflict, "TeX の操作が終わるまでお待ちください．OS の画面が開いている場合は，その画面で操作してください．"))
			return
		}
		a.texSetup.state.Status = "cancelling"
		a.texSetup.cancel()
	}
	a.mu.Unlock()
	_ = a.stopBuild()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	go func() {
		time.Sleep(100 * time.Millisecond)
		a.requestShutdown()
	}()
}

func (a *App) checkProjectLocked(expected string, allowUnavailable ...bool) error {
	if expected != "" {
		path, err := url.PathUnescape(expected)
		if err != nil {
			return fail(http.StatusBadRequest, "プロジェクトのパスを読み取れません．")
		}
		if a.project == nil || !samePath(a.project.Root, path) {
			return fail(http.StatusConflict, "別の画面でプロジェクトが切り替わりました．編集中の内容を確認してから，この画面を開き直してください．")
		}
	}
	if a.project != nil && !(len(allowUnavailable) > 0 && allowUnavailable[0]) {
		_, err := inspectProjectFolder(a.project.Root)
		return err
	}
	return nil
}
