package app

import (
	"errors"
	"net/http"
	"strings"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
)

const settingsGenerationHeader = "X-Settings-Generation"

type settingsResetOptions struct {
	Settings     bool `json:"settings"`
	Drafts       bool `json:"drafts"`
	History      bool `json:"history"`
	Templates    bool `json:"templates"`
	Cache        bool `json:"cache"`
	Confirmation bool `json:"confirmation"`
}

type settingsResetSize struct {
	Files int   `json:"files"`
	Bytes int64 `json:"bytes"`
}

type settingsResetSummary struct {
	Directory          string            `json:"directory"`
	Settings           settingsResetSize `json:"settings"`
	Drafts             settingsResetSize `json:"drafts"`
	History            settingsResetSize `json:"history"`
	Templates          settingsResetSize `json:"templates"`
	Cache              settingsResetSize `json:"cache"`
	SettingsGeneration string            `json:"settingsGeneration"`
	DraftsGeneration   string            `json:"draftsGeneration"`
}

func (a *App) writeSettingsConflictLocked(w http.ResponseWriter, r *http.Request, resetRequired bool, message string) {
	writeJSON(w, http.StatusConflict, map[string]any{
		"error": messages.Text(messages.LanguageFromContext(r.Context()), message), "resetRequired": resetRequired,
		"settingsGeneration": a.config.SettingsGeneration, "draftsGeneration": a.config.DraftsGeneration,
	})
}

func (a *App) settingsGenerationMatchesLocked(r *http.Request) bool {
	_, specified := r.Header[http.CanonicalHeaderKey(settingsGenerationHeader)]
	if !specified && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
		return true
	}
	// Existing clients can use the original empty generation. After the first
	// reset, an omitted header cannot authorize a write from an older tab.
	return r.Header.Get(settingsGenerationHeader) == a.config.SettingsGeneration
}

// A reset waits for finite requests to finish before changing their saved data.
// Streams observe availability only and must not hold that wait open forever.
func (a *App) serveSettingsRequest(next http.Handler, w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api/session" || (r.URL.Path == "/api/settings/reset" && r.Method == http.MethodPost) {
		next.ServeHTTP(w, r)
		return
	}
	a.settingsMu.RLock()
	defer a.settingsMu.RUnlock()
	if r.Context().Err() != nil {
		return
	}
	picker := r.Method == http.MethodPost && (r.URL.Path == "/api/project/pick" || r.URL.Path == "/api/tex/setup/pick" || r.URL.Path == "/api/file/save-as")
	a.mu.Lock()
	if !a.settingsGenerationMatchesLocked(r) {
		a.writeSettingsConflictLocked(w, r, true, "別の画面で保存情報が初期化されました．未保存の原稿を確認してから，画面を読み込み直してください．")
		a.mu.Unlock()
		return
	}
	if picker && a.settingsResetPending {
		a.writeSettingsConflictLocked(w, r, false, "保存情報の初期化が終わってから操作してください．")
		a.mu.Unlock()
		return
	}
	if picker {
		a.folderPickerRequests++
	}
	w.Header().Set(settingsGenerationHeader, a.config.SettingsGeneration)
	a.mu.Unlock()
	if picker {
		defer func() {
			a.mu.Lock()
			a.folderPickerRequests--
			a.mu.Unlock()
		}()
	}
	next.ServeHTTP(w, r)
}

// Match the order used by template capture, project changes, and document saves.
func (a *App) lockSettingsData() func() {
	a.templateMu.Lock()
	a.mu.Lock()
	a.uiMu.Lock()
	editHistoryMu.Lock()
	a.cacheMu.Lock()
	return func() {
		a.cacheMu.Unlock()
		editHistoryMu.Unlock()
		a.uiMu.Unlock()
		a.mu.Unlock()
		a.templateMu.Unlock()
	}
}

func (a *App) settingsResetBusyLocked() bool {
	return a.isRunningLocked() || a.isTeXSetupRunningLocked() || a.folderPickerRequests > 0
}

func (a *App) settingsResetHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet, http.MethodPost) {
		return
	}
	if r.Method == http.MethodGet {
		unlock := a.lockSettingsData()
		inspection, err := inspectSettingsReset(r.Context(), a.options.ConfigDir, settingsResetOptions{Settings: true, Drafts: true, History: true, Templates: true, Cache: true})
		inspection.SettingsGeneration, inspection.DraftsGeneration = a.config.SettingsGeneration, a.config.DraftsGeneration
		unlock()
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, inspection.settingsResetSummary)
		return
	}
	var input settingsResetOptions
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	if !input.Confirmation || !(input.Settings || input.Drafts || input.History || input.Templates || input.Cache) {
		writeError(w, fail(http.StatusBadRequest, "初期化する項目を 1 つ以上選び，確認してから実行してください．"))
		return
	}
	a.mu.Lock()
	if !a.settingsGenerationMatchesLocked(r) {
		a.writeSettingsConflictLocked(w, r, true, "別の画面で保存情報が初期化されました．未保存の原稿を確認してから，画面を読み込み直してください．")
		a.mu.Unlock()
		return
	}
	if a.settingsResetPending || a.settingsResetBusyLocked() {
		a.writeSettingsConflictLocked(w, r, false, "コンパイル，TeX の操作，フォルダー選択が終わってから初期化してください．")
		a.mu.Unlock()
		return
	}
	// Reserve the reset before waiting. A new native picker must not start
	// between the busy check and the exclusive request lock.
	a.settingsResetPending = true
	a.mu.Unlock()
	a.settingsMu.Lock()
	defer func() {
		a.mu.Lock()
		a.settingsResetPending = false
		a.mu.Unlock()
		a.settingsMu.Unlock()
	}()
	if r.Context().Err() != nil {
		return
	}
	unlock := a.lockSettingsData()
	defer unlock()
	if a.closed {
		writeError(w, fail(http.StatusServiceUnavailable, "アプリを起動し直してください．"))
		return
	}
	if a.settingsResetBusyLocked() {
		a.writeSettingsConflictLocked(w, r, false, "コンパイル，TeX の操作，フォルダー選択が終わってから初期化してください．")
		return
	}
	if err := recoverSettingsReset(a.options.ConfigDir); err != nil {
		writeError(w, err)
		return
	}
	inspection, err := inspectSettingsReset(r.Context(), a.options.ConfigDir, input)
	if err != nil {
		writeError(w, err)
		return
	}
	generation, err := randomID()
	if err != nil {
		writeError(w, err)
		return
	}
	config := cloneConfig(a.config)
	if input.Settings {
		config.TexBin, config.RecentProjects, config.Projects = "", []string{}, map[string]projectSettings{}
	}
	config.SettingsGeneration = generation
	if input.Drafts {
		config.DraftsGeneration = generation
	}
	warning, err := a.applySettingsReset(r.Context(), inspection, config)
	if err != nil {
		var known *apiError
		if errors.As(err, &known) && known.status == http.StatusConflict {
			a.writeSettingsConflictLocked(w, r, false, err.Error())
		} else {
			writeError(w, err)
		}
		return
	}
	a.config = config
	if input.Settings {
		if err := a.resetStartupRegistration(); err != nil {
			startupWarning := messages.Errorf("設定は初期化しましたが，ログイン時の起動を変更できませんでした: %w", err)
			if warning == nil {
				warning = startupWarning
			} else {
				warning = messages.Errorf("%v\n%v", warning, startupWarning)
			}
		}
		a.clearDeletedProjectLocked()
		a.texSetup, a.texEnvironment = nil, nil
	} else if input.Cache {
		project := a.project
		a.clearDeletedProjectLocked()
		a.project = project
	}
	w.Header().Set(settingsGenerationHeader, generation)
	writeJSON(w, http.StatusOK, map[string]any{
		"state":              a.stateLocked(false, messages.LanguageFromContext(r.Context())),
		"settingsGeneration": generation, "draftsGeneration": config.DraftsGeneration,
		"warning": strings.TrimSpace(messages.ErrorText(messages.LanguageFromContext(r.Context()), warning)),
	})
}
