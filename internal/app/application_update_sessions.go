package app

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/updater"
)

func (a *App) registerUpdateBrowser(id string) *updateBrowserClient {
	u := a.updates
	if u == nil {
		return nil
	}
	if len(id) < 16 || len(id) > 128 || strings.ContainsAny(id, "\r\n\x00") {
		id = "legacy-" + randomUpdateID()
	}
	client := &updateBrowserClient{id: id, events: make(chan updateEvent, 8)}
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.attempt != nil {
		a.cancelUpdateAttemptLocked("編集画面との接続を確認してから更新します．")
	}
	u.clients[id] = client
	return client
}

func (a *App) unregisterUpdateBrowser(client *updateBrowserClient) {
	if client == nil || a.updates == nil {
		return
	}
	u := a.updates
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.clients[client.id] != client {
		return
	}
	delete(u.clients, client.id)
	if u.attempt != nil {
		a.cancelUpdateAttemptLocked("編集画面との接続を確認してから更新します．")
	}
}

func (a *App) sendUpdateEventLocked(event updateEvent) {
	for _, client := range a.updates.clients {
		select {
		case client.events <- event:
		default:
		}
	}
}

func (a *App) cancelUpdateAttemptLocked(message string) {
	u := a.updates
	if u.attempt == nil {
		return
	}
	id := u.attempt.id
	u.attempt.timer.Stop()
	u.attempt = nil
	u.nextInstall = time.Now().Add(time.Minute)
	if u.state.Phase == "preparing" {
		u.state.Phase = "ready"
	}
	u.state.Message = message
	a.sendUpdateEventLocked(updateEvent{Type: "update-cancelled", AttemptID: id, Message: message})
}

func (a *App) beginUpdateAttempt(automatic bool) error {
	if automatic && !a.automaticUpdatesEnabled() {
		return nil
	}
	a.mu.Lock()
	busy := a.closed || a.settingsResetPending || a.isRunningLocked() || a.isTeXSetupRunningLocked() || a.folderPickerRequests > 0
	a.mu.Unlock()
	if busy {
		if automatic {
			return nil
		}
		return fail(http.StatusConflict, "編集中の操作やコンパイルが終わってから更新してください．")
	}
	u := a.updates
	u.mu.Lock()
	if u.attempt != nil || u.state.Phase == "applying" {
		u.mu.Unlock()
		return nil
	}
	if !u.state.CanInstall || u.state.Phase != "ready" {
		u.mu.Unlock()
		return fail(http.StatusConflict, "更新のダウンロードが完了するまでお待ちください．")
	}
	if automatic && (time.Now().Before(u.deferredUntil) || time.Now().Before(u.nextInstall)) {
		u.mu.Unlock()
		return nil
	}
	attempt := &updateAttempt{id: randomUpdateID(), automatic: automatic, clients: make(map[string]*updateBrowserClient)}
	for id, client := range u.clients {
		client.ready = false
		attempt.clients[id] = client
	}
	attempt.timer = time.AfterFunc(30*time.Second, func() {
		u.mu.Lock()
		defer u.mu.Unlock()
		if u.attempt == attempt {
			a.cancelUpdateAttemptLocked("開いている編集画面の保存が終わってから更新します．")
		}
	})
	u.attempt = attempt
	u.state.Phase = "preparing"
	u.state.Message = "開いている編集画面の保存状況を確認しています．"
	a.sendUpdateEventLocked(updateEvent{Type: "prepare-update", AttemptID: attempt.id, Automatic: automatic})
	empty := len(attempt.clients) == 0
	u.mu.Unlock()
	if empty {
		a.startUpdateCommit(attempt.id)
	}
	return nil
}

func (a *App) applicationUpdateReadyHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var input struct {
		ClientID  string `json:"clientId"`
		AttemptID string `json:"attemptId"`
		Ready     bool   `json:"ready"`
		Reason    string `json:"reason"`
	}
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	u := a.updates
	u.mu.Lock()
	attempt := u.attempt
	if attempt == nil || attempt.id != input.AttemptID || attempt.clients[input.ClientID] == nil || u.clients[input.ClientID] != attempt.clients[input.ClientID] {
		u.mu.Unlock()
		writeError(w, fail(http.StatusConflict, "更新前の確認をもう一度行います．"))
		return
	}
	complete := false
	if !input.Ready {
		a.cancelUpdateAttemptLocked("未保存の原稿や実行中の操作があるため，更新を待っています．")
	} else {
		attempt.clients[input.ClientID].ready = true
		complete = true
		for _, client := range attempt.clients {
			if !client.ready {
				complete = false
				break
			}
		}
	}
	u.mu.Unlock()
	writeJSON(w, http.StatusOK, a.updateState(messages.LanguageFromContext(r.Context())))
	if complete {
		a.startUpdateCommit(input.AttemptID)
	}
}

func (a *App) startUpdateCommit(id string) {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return
	}
	a.workers.Add(1)
	a.mu.Unlock()
	go func() { defer a.workers.Done(); a.commitApplicationUpdate(id) }()
}

func (a *App) commitApplicationUpdate(id string) {
	u := a.updates
	// Let every finite request finish, then close the gate for new writes. A
	// compile, file import, or settings reset cannot race the process restart.
	a.settingsMu.Lock()
	a.mu.Lock()
	u.mu.Lock()
	attempt := u.attempt
	if attempt == nil || attempt.id != id {
		u.mu.Unlock()
		a.mu.Unlock()
		a.settingsMu.Unlock()
		return
	}
	busy := a.closed || a.settingsResetPending || a.isRunningLocked() || a.isTeXSetupRunningLocked() || a.folderPickerRequests > 0
	if attempt.automatic && (a.config.AutomaticAppUpdates != nil && !*a.config.AutomaticAppUpdates || time.Now().Before(u.deferredUntil)) {
		busy = true
	}
	for clientID, client := range attempt.clients {
		if !client.ready || u.clients[clientID] != client {
			busy = true
		}
	}
	if len(u.clients) != len(attempt.clients) {
		busy = true
	}
	if busy {
		a.cancelUpdateAttemptLocked("未保存の原稿や実行中の操作があるため，更新を待っています．")
		u.mu.Unlock()
		a.mu.Unlock()
		a.settingsMu.Unlock()
		return
	}
	attempt.timer.Stop()
	u.attempt = nil
	u.state.Phase = "applying"
	u.applyingAttemptID = id
	u.state.Message = "アプリを更新しています．"
	u.state.Error = ""
	u.problem = nil
	a.updateApplying = true
	automatic := attempt.automatic
	channel := u.state.Channel
	directory := u.downloadDirectory
	a.sendUpdateEventLocked(updateEvent{Type: "applying-update", AttemptID: id})
	u.mu.Unlock()
	a.mu.Unlock()
	a.settingsMu.Unlock()
	var err error
	if u.install != nil {
		err = u.install(automatic)
	} else {
		switch channel {
		case "windows-zip":
			err = updater.LaunchInstaller(directory, a.options.ConfigDir, a.options.Version, true)
			if err == nil {
				a.requestShutdown()
				return
			}
		case "store":
			var result platform.StoreUpdateState
			result, err = platform.ManageStoreUpdates(u.ctx, platform.StoreUpdateOptions{Action: "install", Interactive: !automatic, Restart: true, ConfigDir: a.options.ConfigDir})
			if err == nil && result.Status != "installed" {
				err = messages.Errorf("Microsoft Store の設定や接続状況により，更新を待っています．")
			}
			// Store may terminate and restart this process while the call is active.
			// If it returns, leave the current editor available for Windows to finish.
		case "macos":
			u.mu.Lock()
			u.command = &updateCommand{randomUpdateID(), "install"}
			u.mu.Unlock()
			// Sparkle requests /api/shutdown only after arranging the replacement and
			// relaunch. Keep the backend alive until its launcher reaches that point.
			return
		default:
			err = errors.New("application updates are unavailable for this platform")
		}
	}
	a.releaseUpdatePreparation()
	u.mu.Lock()
	u.state.Message = ""
	if err != nil {
		u.state.Phase = "ready"
		u.state.Error = err.Error()
		u.problem = err
		u.nextInstall = time.Now().Add(time.Hour)
	} else {
		u.state.Phase = "up-to-date"
		u.state.CanInstall = false
		u.state.Error = ""
		u.problem = nil
	}
	u.mu.Unlock()
}

func (a *App) releaseUpdatePreparation() {
	a.mu.Lock()
	a.updateApplying = false
	a.mu.Unlock()
	u := a.updates
	u.mu.Lock()
	a.sendUpdateEventLocked(updateEvent{Type: "update-cancelled", AttemptID: u.applyingAttemptID, Message: "編集を再開できます．"})
	u.applyingAttemptID = ""
	u.mu.Unlock()
}
