package app

import (
	"errors"
	"net/http"
	"runtime"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

func (a *App) shortcutsHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var input map[string]string
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	destination := input["destination"]
	if len(input) != 1 || (destination != "start-menu" && destination != "desktop") {
		writeError(w, fail(http.StatusBadRequest, "作成先に start-menu または desktop を指定してください．"))
		return
	}
	if a.packageIdentity != nil {
		writeError(w, fail(http.StatusNotImplemented, "%v", platform.ErrShortcutsManagedByWindows))
		return
	}
	if !a.shortcutMu.TryLock() {
		writeError(w, fail(http.StatusConflict, "ショートカットを作成しています．処理が終わるまでお待ちください．"))
		return
	}
	defer a.shortcutMu.Unlock()
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		writeError(w, fail(http.StatusServiceUnavailable, "アプリを起動し直してください．"))
		return
	}
	a.workers.Add(1)
	create := a.shortcutCreator
	a.mu.Unlock()
	defer a.workers.Done()
	if create == nil {
		create = platform.CreateShortcut
	}
	result, err := create(destination)
	if err != nil {
		switch {
		case errors.Is(err, platform.ErrShortcutsUnsupported), errors.Is(err, platform.ErrShortcutsManagedByWindows):
			err = fail(http.StatusNotImplemented, "%v", err)
		case errors.Is(err, platform.ErrShortcutConflict), errors.Is(err, platform.ErrLocked):
			err = fail(http.StatusConflict, "%v", err)
		}
		writeError(w, err)
		return
	}
	result.Message = messages.Text(messages.LanguageFromContext(r.Context()), result.Message)
	writeJSON(w, http.StatusOK, result)
}

func (a *App) canInitializeShortcuts() bool {
	if a.packageIdentity != nil {
		return false
	}
	if a.shortcutSetupCheck != nil {
		return a.shortcutSetupCheck(a.options.ConfigDir)
	}
	return runtime.GOOS == "windows" && platform.IsDefaultConfigDirectory(a.options.ConfigDir)
}

// Create both launch shortcuts once for a new Windows ZIP installation.
// Saving completion first lets later launches leave deleted shortcuts alone.
func (a *App) InitializeShortcuts() error {
	a.settingsMu.RLock()
	defer a.settingsMu.RUnlock()
	a.shortcutMu.Lock()
	defer a.shortcutMu.Unlock()
	a.mu.Lock()
	if a.closed || !a.config.ShortcutSetupPending || !a.canInitializeShortcuts() {
		a.mu.Unlock()
		return nil
	}
	config := cloneConfig(a.config)
	config.ShortcutSetupPending = false
	if err := a.saveConfig(config); err != nil {
		a.mu.Unlock()
		return messages.Errorf("ショートカットを自動で作成できませんでした．設定から作成してください．%w", err)
	}
	a.config = config
	create := a.shortcutCreator
	a.mu.Unlock()
	if create == nil {
		create = platform.CreateShortcut
	}
	var problems installationErrors
	for _, target := range []struct{ destination, message string }{
		{"start-menu", "スタートメニューにショートカットを作成できませんでした．設定から作成してください．%w"},
		{"desktop", "デスクトップにショートカットを作成できませんでした．設定から作成してください．%w"},
	} {
		if _, err := create(target.destination); err != nil {
			problems = append(problems, messages.Errorf(target.message, err))
		}
	}
	if len(problems) != 0 {
		return problems
	}
	return nil
}
