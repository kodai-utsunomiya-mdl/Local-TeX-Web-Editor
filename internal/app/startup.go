package app

import (
	"errors"
	"net/http"

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
	var state platform.StartupState
	var err error
	if enabled == nil {
		state, err = functions.status(a.options.ConfigDir)
	} else {
		state, err = functions.set(a.options.ConfigDir, *enabled)
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
func (a *App) resetStartupRegistration() error {
	functions := a.startupFunctions()
	state, err := functions.status(a.options.ConfigDir)
	if err != nil {
		return err
	}
	if !state.Supported || (!state.Enabled && !state.CanDisable) {
		return nil
	}
	if !state.CanDisable {
		return messages.Errorf("ログイン時の起動は OS が管理しています．OS の起動設定で確認してください．")
	}
	_, err = functions.set(a.options.ConfigDir, false)
	return err
}
