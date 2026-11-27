package app

import (
	"errors"
	"net/http"
	"runtime"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

type startupHooks struct {
	status func(string) (platform.StartupState, error)
	set    func(string, bool) (platform.StartupState, error)
	open   func() error
}

func (a *App) startupFunctions() startupHooks {
	functions := startupHooks{platform.StartupStatus, platform.SetStartupEnabled, platform.OpenStartupSettings}
	if a.startupHooks != nil {
		if a.startupHooks.status != nil {
			functions.status = a.startupHooks.status
		}
		if a.startupHooks.set != nil {
			functions.set = a.startupHooks.set
		}
		if a.startupHooks.open != nil {
			functions.open = a.startupHooks.open
		}
	}
	return functions
}

// Apply the default once. Later launches use the OS registration as it stands,
// including changes made in Windows or macOS settings.
func (a *App) InitializeStartupRegistration() error {
	a.settingsMu.RLock()
	defer a.settingsMu.RUnlock()
	a.startupMu.Lock()
	defer a.startupMu.Unlock()
	a.mu.Lock()
	if a.closed || (a.config.StartupEnabled != nil && (!*a.config.StartupEnabled || a.config.StartupRegistration == a.startupRegistrationID())) {
		a.mu.Unlock()
		return nil
	}
	functions := a.startupFunctions()
	a.mu.Unlock()
	state, err := functions.status(a.options.ConfigDir)
	if err != nil {
		return messages.Errorf("ログイン時の起動を設定できませんでした．設定画面で確認してください: %w", err)
	}
	if !state.Supported {
		return nil
	}
	// Save before asking the OS, so an interrupted request is not repeated after
	// the user subsequently disables the registration in the system settings.
	if err := a.saveStartupPreference(true); err != nil {
		return err
	}
	if !state.Enabled && state.CanEnable {
		_, err = functions.set(a.options.ConfigDir, true)
		if err != nil {
			return messages.Errorf("ログイン時の起動を設定できませんでした．設定画面で確認してください: %w", err)
		}
	}
	return nil
}

func (a *App) saveStartupPreference(enabled bool) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	config := cloneConfig(a.config)
	config.StartupEnabled = &enabled
	config.StartupRegistration = a.startupRegistrationID()
	if err := a.saveConfig(config); err != nil {
		return messages.Errorf("ログイン時の起動設定を保存できません: %w", err)
	}
	a.config = config
	return nil
}

// A ZIP installation and an MSIX package use different OS registrations. The
// imported preference is applied once to the package's own startup task.
func (a *App) startupRegistrationID() string {
	if a.packageIdentity != nil {
		return "msix:" + a.packageIdentity.FamilyName
	}
	return runtime.GOOS
}

func (a *App) startupHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet, http.MethodPost) {
		return
	}
	var enabled *bool
	if r.Method == http.MethodPost {
		var input struct {
			Enabled *bool `json:"enabled"`
		}
		if err := readJSON(w, r, &input); err != nil {
			writeError(w, err)
			return
		}
		if input.Enabled == nil {
			writeError(w, fail(http.StatusBadRequest, "ログイン時の起動を有効にするか選んでください．"))
			return
		}
		enabled = input.Enabled
	}
	if enabled == nil {
		a.startupMu.Lock()
	} else if !a.startupMu.TryLock() {
		writeError(w, fail(http.StatusConflict, "ログイン時の起動設定を処理しています．完了してから操作してください．"))
		return
	}
	defer a.startupMu.Unlock()
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		writeError(w, fail(http.StatusServiceUnavailable, "アプリを起動し直してください．"))
		return
	}
	a.workers.Add(1)
	functions := a.startupFunctions()
	a.mu.Unlock()
	defer a.workers.Done()
	var state platform.StartupState
	var err error
	if enabled == nil {
		state, err = functions.status(a.options.ConfigDir)
	} else {
		err = a.saveStartupPreference(*enabled)
		if err == nil {
			state, err = functions.set(a.options.ConfigDir, *enabled)
		}
	}
	if err != nil {
		if errors.Is(err, platform.ErrStartupUnsupported) {
			err = fail(http.StatusNotImplemented, "%v", err)
		} else if errors.Is(err, platform.ErrStartupConflict) || errors.Is(err, platform.ErrLocked) {
			err = fail(http.StatusConflict, "%v", err)
		}
		writeError(w, err)
		return
	}
	state.Message = messages.Text(messages.LanguageFromContext(r.Context()), state.Message)
	writeJSON(w, http.StatusOK, state)
}

func (a *App) startupSettingsHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var input struct{}
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	if !a.startupMu.TryLock() {
		writeError(w, fail(http.StatusConflict, "ログイン時の起動設定を処理しています．完了してから操作してください．"))
		return
	}
	defer a.startupMu.Unlock()
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		writeError(w, fail(http.StatusServiceUnavailable, "アプリを起動し直してください．"))
		return
	}
	a.workers.Add(1)
	functions := a.startupFunctions()
	a.mu.Unlock()
	defer a.workers.Done()
	state, err := functions.status(a.options.ConfigDir)
	if err == nil && !state.CanOpenSettings {
		err = fail(http.StatusNotImplemented, "この環境では OS の起動設定を開けません．")
	}
	if err == nil {
		err = functions.open()
	}
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"opened": true})
}

// The exclusive settings request lock already waits for startup writes.
func (a *App) resetStartupRegistration(state platform.StartupState) error {
	if !state.Supported || state.Enabled || !state.CanEnable {
		return nil
	}
	_, err := a.startupFunctions().set(a.options.ConfigDir, true)
	return err
}
