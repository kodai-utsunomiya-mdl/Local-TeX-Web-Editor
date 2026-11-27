package app

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/updater"
)

type ApplicationUpdateState struct {
	Automatic       bool    `json:"automatic"`
	Supported       bool    `json:"supported"`
	Channel         string  `json:"channel"`
	CurrentVersion  string  `json:"currentVersion"`
	LatestVersion   string  `json:"latestVersion"`
	Phase           string  `json:"phase"`
	LastCheckedAt   string  `json:"lastCheckedAt"`
	Progress        float64 `json:"progress"`
	Message         string  `json:"message"`
	Error           string  `json:"error"`
	CanInstall      bool    `json:"canInstall"`
	ReleaseNotesURL string  `json:"releaseNotesURL"`
	DeferredUntil   string  `json:"deferredUntil"`
}

type updateCommand struct {
	ID     string `json:"id"`
	Action string `json:"action"`
}

const failedApplicationUpdateMessage = "前回この版への更新に失敗しました．さらに新しい版を自動で確認します．同じ版への更新は手動で再試行できます．"

type updateEvent struct {
	Type      string `json:"type"`
	AttemptID string `json:"attemptId,omitempty"`
	Automatic bool   `json:"automatic,omitempty"`
	Message   string `json:"message,omitempty"`
}
type updateBrowserClient struct {
	id     string
	events chan updateEvent
	ready  bool
}
type updateAttempt struct {
	id        string
	automatic bool
	clients   map[string]*updateBrowserClient
	timer     *time.Timer
}

type applicationUpdates struct {
	mu                sync.Mutex
	state             ApplicationUpdateState
	ctx               context.Context
	cancel            context.CancelFunc
	started           bool
	startedAt         time.Time
	nextCheck         time.Time
	nextInstall       time.Time
	deferredUntil     time.Time
	checking          bool
	clients           map[string]*updateBrowserClient
	attempt           *updateAttempt
	command           *updateCommand
	applyingAttemptID string
	nativeToken       string
	downloadDirectory string
	client            *updater.Client
	problem           error
	failedVersion     string
	// Tests substitute actual package acquisition and installation, so they can
	// exercise cross-tab coordination without restarting the test process.
	install func(bool) error
	check   func(context.Context, bool) error
}

func (a *App) initApplicationUpdates() {
	ctx, cancel := context.WithCancel(context.Background())
	u := &applicationUpdates{ctx: ctx, cancel: cancel, startedAt: time.Now(), clients: make(map[string]*updateBrowserClient), client: updater.NewClient(), nativeToken: os.Getenv("LOCAL_TEX_EDITOR_NATIVE_UPDATE_TOKEN")}
	u.state = ApplicationUpdateState{CurrentVersion: a.options.Version, Phase: "idle", Channel: "unsupported", ReleaseNotesURL: updater.Repository + "/releases/latest"}
	if !a.config.LastAppUpdateCheck.IsZero() && !a.config.LastAppUpdateCheck.After(time.Now()) {
		u.nextCheck = a.config.LastAppUpdateCheck.Add(24 * time.Hour)
		u.state.LastCheckedAt = a.config.LastAppUpdateCheck.UTC().Format(time.RFC3339)
	}
	u.deferredUntil = a.config.AppUpdateDeferredUntil
	switch {
	case a.packageIdentity != nil:
		u.state.Channel = "store"
		u.state.Supported = true
	case runtime.GOOS == "windows" && runtime.GOARCH == "amd64":
		u.state.Channel = "windows-zip"
		u.state.Supported = true
	case runtime.GOOS == "darwin":
		u.state.Channel = "macos"
		u.state.Supported = len(u.nativeToken) >= 32
	}
	if !updater.StableVersion(a.options.Version) {
		u.state.Supported = false
	}
	a.updates = u
}

func (a *App) automaticUpdatesEnabled() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.config.AutomaticAppUpdates == nil || *a.config.AutomaticAppUpdates
}

func (a *App) updateState(language string) ApplicationUpdateState {
	automatic := a.automaticUpdatesEnabled()
	u := a.updates
	u.mu.Lock()
	defer u.mu.Unlock()
	s := u.state
	s.Automatic = automatic
	s.Message = messages.Text(language, s.Message)
	s.Error = messages.Text(language, s.Error)
	if u.problem != nil {
		s.Error = messages.ErrorText(language, u.problem)
	}
	if !u.deferredUntil.IsZero() {
		s.DeferredUntil = u.deferredUntil.UTC().Format(time.RFC3339)
	}
	return s
}

func (a *App) registerUpdateHandlers(mux *http.ServeMux) {
	mux.HandleFunc("/api/updates", a.applicationUpdatesHandler)
	mux.HandleFunc("/api/updates/settings", a.applicationUpdateSettingsHandler)
	mux.HandleFunc("/api/updates/check", a.applicationUpdateCheckHandler)
	mux.HandleFunc("/api/updates/install", a.applicationUpdateInstallHandler)
	mux.HandleFunc("/api/updates/ready", a.applicationUpdateReadyHandler)
	mux.HandleFunc("/api/updates/defer", a.applicationUpdateDeferHandler)
	mux.HandleFunc("/api/updates/native", a.nativeApplicationUpdateHandler)
}

func (a *App) applicationUpdatesHandler(w http.ResponseWriter, r *http.Request) {
	if requireMethod(w, r, http.MethodGet) {
		writeJSON(w, http.StatusOK, a.updateState(messages.LanguageFromContext(r.Context())))
	}
}

func (a *App) applicationUpdateSettingsHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var input struct {
		Automatic *bool `json:"automatic"`
	}
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	if input.Automatic == nil {
		writeError(w, fail(http.StatusBadRequest, "自動更新を有効にするか選んでください．"))
		return
	}
	a.mu.Lock()
	config := cloneConfig(a.config)
	config.AutomaticAppUpdates = input.Automatic
	if *input.Automatic {
		config.AppUpdateDeferredUntil = time.Time{}
	}
	err := a.saveConfig(config)
	if err == nil {
		a.config = config
	}
	a.mu.Unlock()
	if err != nil {
		writeError(w, err)
		return
	}
	u := a.updates
	u.mu.Lock()
	if !*input.Automatic && u.attempt != nil && u.attempt.automatic {
		a.cancelUpdateAttemptLocked("自動更新を停止しました．")
	}
	if *input.Automatic {
		u.nextCheck = time.Time{}
		u.deferredUntil = time.Time{}
	}
	u.mu.Unlock()
	writeJSON(w, http.StatusOK, a.updateState(messages.LanguageFromContext(r.Context())))
}

func (a *App) applicationUpdateCheckHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var input struct{}
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	if err := a.startUpdateCheck(true); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, a.updateState(messages.LanguageFromContext(r.Context())))
}

func (a *App) applicationUpdateInstallHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var input struct{}
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	if err := a.beginUpdateAttempt(false); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, a.updateState(messages.LanguageFromContext(r.Context())))
}

func (a *App) applicationUpdateDeferHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var input struct {
		Minutes int `json:"minutes"`
	}
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	if input.Minutes != 60 {
		writeError(w, fail(http.StatusBadRequest, "更新を延期する時間を選んでください．"))
		return
	}
	u := a.updates
	u.mu.Lock()
	if u.state.Phase == "applying" {
		u.mu.Unlock()
		writeError(w, fail(http.StatusConflict, "アプリの更新を適用しています．"))
		return
	}
	u.deferredUntil = time.Now().Add(time.Hour)
	deferred := u.deferredUntil
	if u.attempt != nil {
		a.cancelUpdateAttemptLocked("更新を 1 時間延期しました．")
	}
	u.mu.Unlock()
	a.mu.Lock()
	config := cloneConfig(a.config)
	config.AppUpdateDeferredUntil = deferred
	err := a.saveConfig(config)
	if err == nil {
		a.config = config
	}
	a.mu.Unlock()
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, a.updateState(messages.LanguageFromContext(r.Context())))
}

func (a *App) StartAutomaticUpdates() {
	u := a.updates
	if u == nil {
		return
	}
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return
	}
	u.mu.Lock()
	if u.started {
		u.mu.Unlock()
		a.mu.Unlock()
		return
	}
	u.started = true
	u.mu.Unlock()
	a.workers.Add(1)
	a.mu.Unlock()
	go func() {
		defer a.workers.Done()
		timer := time.NewTimer(10 * time.Second)
		defer timer.Stop()
		select {
		case <-u.ctx.Done():
			return
		case <-timer.C:
		}
		a.restoreDownloadedUpdate()
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			a.runAutomaticUpdateTasks()
			select {
			case <-u.ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}

func (a *App) runAutomaticUpdateTasks() {
	if !a.automaticUpdatesEnabled() {
		return
	}
	u := a.updates
	u.mu.Lock()
	s := u.state
	now := time.Now()
	failedPrepared := s.CanInstall && u.failedVersion != "" && u.failedVersion == s.LatestVersion
	check := s.Supported && s.Channel != "macos" && (!s.CanInstall || failedPrepared || s.Phase == "error") && !u.checking && now.After(u.nextCheck) && s.Phase != "preparing" && s.Phase != "applying"
	install := s.CanInstall && s.Phase == "ready" && (u.failedVersion == "" || u.failedVersion != s.LatestVersion) && now.After(u.deferredUntil) && now.After(u.nextInstall) && now.Sub(u.startedAt) >= time.Minute
	u.mu.Unlock()
	if check {
		_ = a.startUpdateCheck(false)
	}
	if install {
		_ = a.beginUpdateAttempt(true)
	}
}

func (a *App) startUpdateCheck(manual bool) error {
	u := a.updates
	u.mu.Lock()
	if !u.state.Supported {
		u.mu.Unlock()
		return fail(http.StatusNotImplemented, "この起動方法ではアプリの自動更新を利用できません．")
	}
	if u.checking || u.state.Phase == "preparing" || u.state.Phase == "applying" {
		u.mu.Unlock()
		return nil
	}
	if u.state.Channel == "macos" {
		u.command = &updateCommand{randomUpdateID(), "check"}
		u.state.Phase = "checking"
		u.state.Error = ""
		u.mu.Unlock()
		return nil
	}
	previous := u.state
	previousDirectory := u.downloadDirectory
	hadPreparedUpdate := previous.CanInstall && previous.Phase == "ready"
	channel := u.state.Channel
	u.checking = true
	u.state.Phase = "checking"
	u.state.CanInstall = false
	u.state.Progress = 0
	u.state.Error = ""
	u.problem = nil
	u.state.Message = ""
	u.downloadDirectory = ""
	u.nextCheck = time.Now().Add(24 * time.Hour)
	u.mu.Unlock()
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		u.mu.Lock()
		u.checking = false
		u.mu.Unlock()
		return errors.New("the application is closing")
	}
	a.workers.Add(1)
	a.mu.Unlock()
	go func() {
		defer a.workers.Done()
		var err error
		if u.check != nil {
			err = u.check(u.ctx, manual)
		} else if channel == "store" {
			err = a.checkStoreUpdate(manual)
		} else {
			err = a.checkDownloadUpdate()
		}
		u.mu.Lock()
		u.checking = false
		if err != nil && u.ctx.Err() == nil {
			if hadPreparedUpdate {
				// The displayed version and install directory must describe the
				// same completed download when a newer download cannot finish.
				u.state = previous
				u.downloadDirectory = previousDirectory
			} else {
				u.state.Phase = "error"
				u.state.CanInstall = false
				u.downloadDirectory = ""
			}
			u.state.Error = err.Error()
			u.problem = err
			u.nextCheck = time.Now().Add(time.Hour)
		}
		if u.state.CanInstall && u.failedVersion != "" && u.failedVersion == u.state.LatestVersion {
			u.state.Message = failedApplicationUpdateMessage
		}
		u.mu.Unlock()
		if err == nil {
			a.recordApplicationUpdateCheck(time.Now())
		}
	}()
	return nil
}

func (a *App) checkDownloadUpdate() error {
	u := a.updates
	release, err := u.client.Latest(u.ctx)
	if err != nil {
		return err
	}
	u.mu.Lock()
	u.state.LastCheckedAt = time.Now().UTC().Format(time.RFC3339)
	u.state.LatestVersion = release.Manifest.Version
	u.state.ReleaseNotesURL = release.Manifest.ReleaseNotesURL
	if !updater.Newer(release.Manifest.Version, a.options.Version) {
		u.state.Phase = "up-to-date"
		u.state.CanInstall = false
		u.mu.Unlock()
		return nil
	}
	u.state.Phase = "downloading"
	u.state.Progress = 0
	u.mu.Unlock()
	directory := filepath.Join(a.options.ConfigDir, "updates", "v"+release.Manifest.Version)
	if _, _, err := u.client.ReadDownloaded(directory, "windows-amd64"); err != nil {
		if _, err := u.client.Download(u.ctx, release, "windows-amd64", directory, func(progress float64) { u.mu.Lock(); u.state.Progress = progress; u.mu.Unlock() }); err != nil {
			return err
		}
	}
	u.mu.Lock()
	u.downloadDirectory = directory
	u.state.Phase = "ready"
	u.state.CanInstall = true
	u.state.Progress = 1
	u.mu.Unlock()
	return nil
}

func (a *App) restoreDownloadedUpdate() {
	u := a.updates
	u.mu.Lock()
	channel := u.state.Channel
	u.mu.Unlock()
	if channel != "windows-zip" {
		return
	}
	entries, _ := os.ReadDir(filepath.Join(a.options.ConfigDir, "updates"))
	if data, err := os.ReadFile(filepath.Join(a.options.ConfigDir, "updates", "failed.json")); err == nil && len(data) < 16<<10 {
		var failed struct {
			Version string `json:"version"`
			Error   string `json:"error"`
		}
		if json.Unmarshal(data, &failed) == nil {
			u.mu.Lock()
			u.failedVersion = failed.Version
			u.state.Error = failed.Error
			u.mu.Unlock()
		}
	}
	var newest string
	var directory string
	for _, entry := range entries {
		version := strings.TrimPrefix(entry.Name(), "v")
		if entry.IsDir() && (version == a.options.Version || updater.Newer(a.options.Version, version)) {
			_ = os.RemoveAll(filepath.Join(a.options.ConfigDir, "updates", entry.Name()))
			continue
		}
		if !entry.IsDir() || !updater.Newer(version, a.options.Version) || (newest != "" && !updater.Newer(version, newest)) {
			continue
		}
		path := filepath.Join(a.options.ConfigDir, "updates", entry.Name())
		release, _, err := u.client.ReadDownloaded(path, "windows-amd64")
		if err == nil && release.Manifest.Version == version {
			newest = version
			directory = path
		}
	}
	if newest != "" {
		u.mu.Lock()
		u.downloadDirectory = directory
		u.state.LatestVersion = newest
		u.state.Phase = "ready"
		u.state.CanInstall = true
		u.state.Progress = 1
		u.state.ReleaseNotesURL = updater.Repository + "/releases/tag/v" + newest
		if newest == u.failedVersion {
			u.state.Message = failedApplicationUpdateMessage
		}
		u.mu.Unlock()
	}
}

func (a *App) checkStoreUpdate(manual bool) error {
	u := a.updates
	result, err := platform.ManageStoreUpdates(u.ctx, platform.StoreUpdateOptions{Action: "check", ConfigDir: a.options.ConfigDir})
	if err != nil {
		return err
	}
	u.mu.Lock()
	u.state.LastCheckedAt = time.Now().UTC().Format(time.RFC3339)
	u.state.LatestVersion = result.Version
	u.state.ReleaseNotesURL = "https://apps.microsoft.com/detail/9P6QF32N19HG"
	u.mu.Unlock()
	if !result.Available {
		u.mu.Lock()
		u.state.Phase = "up-to-date"
		u.state.CanInstall = false
		u.mu.Unlock()
		return nil
	}
	u.mu.Lock()
	u.state.Phase = "downloading"
	u.mu.Unlock()
	result, err = platform.ManageStoreUpdates(u.ctx, platform.StoreUpdateOptions{Action: "download", Interactive: manual, ConfigDir: a.options.ConfigDir})
	if err != nil {
		return err
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	u.state.Message = result.Message
	u.state.CanInstall = result.Downloaded
	if result.Downloaded {
		u.state.Phase = "ready"
		u.state.Progress = 1
	} else {
		u.state.Phase = "waiting"
	}
	return nil
}

func randomUpdateID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(bytes[:])
}

func (a *App) nativeApplicationUpdateHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet, http.MethodPost) {
		return
	}
	u := a.updates
	if len(u.nativeToken) < 32 || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Native-Update-Token")), []byte(u.nativeToken)) != 1 {
		writeError(w, fail(http.StatusForbidden, "アプリの更新用接続を確認できません．"))
		return
	}
	if r.Method == http.MethodGet {
		automatic := a.automaticUpdatesEnabled()
		u.mu.Lock()
		command := u.command
		u.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"automatic": automatic, "command": command})
		return
	}
	var input struct {
		Phase              string  `json:"phase"`
		LatestVersion      string  `json:"latestVersion"`
		ReleaseNotesURL    string  `json:"releaseNotesURL"`
		CheckedAt          string  `json:"checkedAt"`
		Error              string  `json:"error"`
		Progress           float64 `json:"progress"`
		CompletedCommandID string  `json:"completedCommandId"`
	}
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	switch input.Phase {
	case "checking", "downloading", "ready", "up-to-date", "error", "applying":
	default:
		writeError(w, fail(http.StatusBadRequest, "更新の状態を読み取れません．"))
		return
	}
	u.mu.Lock()
	if input.CompletedCommandID != "" && u.command != nil && u.command.ID == input.CompletedCommandID {
		u.command = nil
	}
	if u.state.Phase != "preparing" && u.state.Phase != "applying" {
		u.state.Phase = input.Phase
	}
	if input.Phase == "error" && u.state.Phase == "applying" {
		u.state.Phase = "error"
		go a.releaseUpdatePreparation()
	}
	if input.LatestVersion != "" {
		u.state.LatestVersion = input.LatestVersion
	}
	if strings.HasPrefix(input.ReleaseNotesURL, updater.Repository+"/releases/") {
		u.state.ReleaseNotesURL = input.ReleaseNotesURL
	}
	u.state.Progress = max(0, min(1, input.Progress))
	u.state.Error = input.Error
	u.problem = nil
	u.state.CanInstall = input.Phase == "ready"
	if input.CheckedAt != "" {
		u.state.LastCheckedAt = input.CheckedAt
	}
	u.mu.Unlock()
	if checked, err := time.Parse(time.RFC3339, input.CheckedAt); err == nil && !checked.After(time.Now()) {
		a.recordApplicationUpdateCheck(checked)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) recordApplicationUpdateCheck(when time.Time) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed || a.config.LastAppUpdateCheck.Equal(when) {
		return
	}
	config := cloneConfig(a.config)
	config.LastAppUpdateCheck = when.UTC()
	if a.saveConfig(config) == nil {
		a.config = config
	}
}
