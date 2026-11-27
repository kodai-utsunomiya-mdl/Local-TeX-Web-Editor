package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func updateTestApp(t *testing.T) (*App, chan bool) {
	t.Helper()
	a, _ := testApp(t)
	a.options.Version = "0.1.17"
	u := a.updates
	u.state = ApplicationUpdateState{Supported: true, Channel: "windows-zip", CurrentVersion: "0.1.17", LatestVersion: "0.1.18", Phase: "ready", CanInstall: true}
	u.startedAt = time.Now().Add(-2 * time.Minute)
	installed := make(chan bool, 4)
	u.install = func(automatic bool) error { installed <- automatic; return nil }
	return a, installed
}

func updateEventFrom(t *testing.T, client *updateBrowserClient, kind string) updateEvent {
	t.Helper()
	select {
	case e := <-client.events:
		if e.Type != kind {
			t.Fatalf("event=%+v, want %s", e, kind)
		}
		return e
	case <-time.After(time.Second):
		t.Fatalf("missing %s event", kind)
	}
	return updateEvent{}
}

func updateReady(t *testing.T, a *App, client *updateBrowserClient, attempt string, ready bool) int {
	t.Helper()
	response := apiRequest(a, http.MethodPost, "/api/updates/ready", map[string]any{"clientId": client.id, "attemptId": attempt, "ready": ready}, nil)
	return response.Code
}

func TestApplicationUpdatesDefaultToAutomaticAndRememberOptOut(t *testing.T) {
	a, _ := updateTestApp(t)
	response := apiRequest(a, http.MethodGet, "/api/updates", nil, nil)
	var state ApplicationUpdateState
	if json.Unmarshal(response.Body.Bytes(), &state) != nil || !state.Automatic {
		t.Fatalf("initial update state: %s", response.Body.String())
	}
	response = apiRequest(a, http.MethodPost, "/api/updates/settings", map[string]bool{"automatic": false}, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("settings: %s", response.Body.String())
	}
	second, err := New(a.options)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if second.automaticUpdatesEnabled() {
		t.Fatal("the update opt-out was not restored")
	}
	var checked atomic.Bool
	a.updates.check = func(ctx context.Context, manual bool) error { checked.Store(manual); return nil }
	response = apiRequest(a, http.MethodPost, "/api/updates/check", map[string]any{}, nil)
	if response.Code != http.StatusAccepted {
		t.Fatalf("manual check: %s", response.Body.String())
	}
	a.workers.Wait()
	if !checked.Load() {
		t.Fatal("manual updates must work while automatic updates are off")
	}
}

func TestApplicationUpdateWaitsForEveryEditor(t *testing.T) {
	a, installed := updateTestApp(t)
	first := a.registerUpdateBrowser("first-editor-client-id")
	second := a.registerUpdateBrowser("second-editor-client-id")
	if err := a.beginUpdateAttempt(true); err != nil {
		t.Fatal(err)
	}
	e := updateEventFrom(t, first, "prepare-update")
	updateEventFrom(t, second, "prepare-update")
	if updateReady(t, a, first, e.AttemptID, true) != http.StatusOK {
		t.Fatal("first editor was rejected")
	}
	select {
	case <-installed:
		t.Fatal("updated before the second editor saved its work")
	default:
	}
	if updateReady(t, a, second, e.AttemptID, false) != http.StatusOK {
		t.Fatal("second editor could not postpone the update")
	}
	updateEventFrom(t, first, "update-cancelled")
	updateEventFrom(t, second, "update-cancelled")
	if err := a.beginUpdateAttempt(false); err != nil {
		t.Fatal(err)
	}
	e = updateEventFrom(t, first, "prepare-update")
	updateEventFrom(t, second, "prepare-update")
	updateReady(t, a, first, e.AttemptID, true)
	updateReady(t, a, second, e.AttemptID, true)
	select {
	case automatic := <-installed:
		if automatic {
			t.Fatal("a manual update was treated as automatic")
		}
	case <-time.After(time.Second):
		t.Fatal("the prepared update was not installed")
	}
	a.workers.Wait()
	applying := updateEventFrom(t, first, "applying-update")
	cancelled := updateEventFrom(t, first, "update-cancelled")
	if applying.AttemptID != e.AttemptID || cancelled.AttemptID != e.AttemptID {
		t.Fatal("the editor could not identify the end of its update attempt")
	}
}

func TestApplicationUpdateRestartsPreparationWhenEditorsChange(t *testing.T) {
	for _, disconnect := range []bool{false, true} {
		t.Run(map[bool]string{false: "new editor", true: "disconnected editor"}[disconnect], func(t *testing.T) {
			a, installed := updateTestApp(t)
			client := a.registerUpdateBrowser("first-editor-client-id")
			if err := a.beginUpdateAttempt(false); err != nil {
				t.Fatal(err)
			}
			e := updateEventFrom(t, client, "prepare-update")
			if disconnect {
				a.unregisterUpdateBrowser(client)
			} else {
				a.registerUpdateBrowser("second-editor-client-id")
			}
			if updateReady(t, a, client, e.AttemptID, true) != http.StatusConflict {
				t.Fatal("an old preparation was accepted after the editors changed")
			}
			select {
			case <-installed:
				t.Fatal("updated after the set of open editors changed")
			default:
			}
		})
	}
}

func TestApplicationUpdateRejectsAnUnrelatedEditorAcknowledgment(t *testing.T) {
	a, installed := updateTestApp(t)
	client := a.registerUpdateBrowser("first-editor-client-id")
	a.beginUpdateAttempt(false)
	e := updateEventFrom(t, client, "prepare-update")
	stranger := &updateBrowserClient{id: "unregistered-editor-id"}
	if updateReady(t, a, stranger, e.AttemptID, true) != http.StatusConflict {
		t.Fatal("an unregistered editor acknowledged another editor's work")
	}
	select {
	case <-installed:
		t.Fatal("updated without the registered editor's response")
	default:
	}
}

func TestAutomaticUpdateWaitsWhileCompilationOrTeXSetupRuns(t *testing.T) {
	a, installed := updateTestApp(t)
	a.build = &buildRun{result: Build{Status: "running"}}
	if err := a.beginUpdateAttempt(true); err != nil {
		t.Fatal(err)
	}
	select {
	case <-installed:
		t.Fatal("updated during compilation")
	default:
	}
	if a.updates.attempt != nil {
		t.Fatal("prepared an update during compilation")
	}
	a.build = nil
	response := apiRequest(a, http.MethodPost, "/api/updates/defer", map[string]int{"minutes": 60}, nil)
	if response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	a.runAutomaticUpdateTasks()
	select {
	case <-installed:
		t.Fatal("updated during the one-hour postponement")
	default:
	}
}

func TestUpdateStopsNewWritesUntilInstallationFinishes(t *testing.T) {
	a, started := updateTestApp(t)
	finish := make(chan struct{})
	a.updates.install = func(automatic bool) error { started <- automatic; <-finish; return nil }
	if err := a.beginUpdateAttempt(false); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("update did not start")
	}
	response := apiRequest(a, http.MethodPut, "/api/storage", map[string]any{"key": "preferences", "value": map[string]string{"language": "en"}}, nil)
	if response.Code != http.StatusServiceUnavailable {
		close(finish)
		t.Fatalf("a write ran during installation: %d", response.Code)
	}
	close(finish)
	a.workers.Wait()
	response = apiRequest(a, http.MethodPut, "/api/storage", map[string]any{"key": "preferences", "value": map[string]string{"language": "en"}}, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("the write gate did not reopen: %s", response.Body.String())
	}
}

func TestNativeUpdateBridgeRequiresItsOwnToken(t *testing.T) {
	a, _ := updateTestApp(t)
	a.updates.nativeToken = "a-native-token-which-is-not-the-browser-token"
	a.updates.state.Channel = "macos"
	if response := apiRequest(a, http.MethodGet, "/api/updates/native", nil, nil); response.Code != http.StatusForbidden {
		t.Fatal("a browser could use the native update bridge")
	}
	headers := map[string]string{"X-Native-Update-Token": a.updates.nativeToken}
	response := apiRequest(a, http.MethodPost, "/api/updates/native", map[string]any{"phase": "ready", "latestVersion": "0.1.18", "progress": 1}, headers)
	if response.Code != http.StatusOK {
		t.Fatalf("native state: %s", response.Body.String())
	}
	a.updates.install = nil
	if err := a.beginUpdateAttempt(false); err != nil {
		t.Fatal(err)
	}
	a.workers.Wait()
	response = apiRequest(a, http.MethodGet, "/api/updates/native", nil, headers)
	var result struct {
		Automatic bool
		Command   *updateCommand
	}
	if json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Command == nil || result.Command.Action != "install" {
		t.Fatalf("missing native install command: %s", response.Body.String())
	}
	response = apiRequest(a, http.MethodPost, "/api/updates/native", map[string]any{"phase": "error", "error": "download unavailable", "completedCommandId": result.Command.ID}, headers)
	if response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
}

func TestAutomaticUpdateChecksForANewerVersionAfterARollback(t *testing.T) {
	a, installed := updateTestApp(t)
	u := a.updates
	u.failedVersion = u.state.LatestVersion
	var checks atomic.Int32
	u.check = func(_ context.Context, manual bool) error {
		if manual {
			t.Error("a scheduled check was marked as manual")
		}
		checks.Add(1)
		u.mu.Lock()
		u.state.Phase = "ready"
		u.state.CanInstall = true
		u.mu.Unlock()
		return nil
	}
	a.runAutomaticUpdateTasks()
	a.workers.Wait()
	if checks.Load() != 1 {
		t.Fatal("the failed version prevented the next automatic check")
	}
	select {
	case <-installed:
		t.Fatal("automatically retried the version that had rolled back")
	default:
	}
	state := a.updateState("en")
	if !strings.Contains(state.Message, "previous update") || !strings.Contains(state.Message, "manually") {
		t.Fatalf("the failed update was described as ready for automatic installation: %q", state.Message)
	}
	u.mu.Lock()
	u.nextCheck = time.Now().Add(-time.Second)
	u.mu.Unlock()
	u.check = func(_ context.Context, _ bool) error {
		checks.Add(1)
		u.mu.Lock()
		u.state.LatestVersion = "0.1.19"
		u.state.Phase = "ready"
		u.state.CanInstall = true
		u.downloadDirectory = "newer-complete-download"
		u.mu.Unlock()
		return nil
	}
	a.runAutomaticUpdateTasks()
	a.workers.Wait()
	if checks.Load() != 2 {
		t.Fatal("a later release was not checked automatically")
	}
	a.runAutomaticUpdateTasks()
	a.workers.Wait()
	select {
	case automatic := <-installed:
		if !automatic {
			t.Fatal("the newer release was not installed automatically")
		}
	default:
		t.Fatal("the earlier rollback prevented the newer release from updating")
	}
}

func TestFailedCheckRestoresTheVersionAndFilesOfAPreparedUpdate(t *testing.T) {
	a, installed := updateTestApp(t)
	u := a.updates
	u.downloadDirectory = "original-complete-download"
	u.state.Progress = 1
	u.state.ReleaseNotesURL = "https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor/releases/tag/v0.1.18"
	previous := u.state
	started, finish := make(chan struct{}), make(chan struct{})
	u.check = func(_ context.Context, manual bool) error {
		if !manual {
			t.Error("the requested check was not marked as manual")
		}
		u.mu.Lock()
		u.state.Phase = "downloading"
		u.state.LatestVersion = "0.1.19"
		u.state.ReleaseNotesURL = "https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor/releases/tag/v0.1.19"
		u.state.Progress = 0.25
		u.downloadDirectory = "incomplete-newer-download"
		u.mu.Unlock()
		close(started)
		<-finish
		return errors.New("the newer download was interrupted")
	}
	response := apiRequest(a, http.MethodPost, "/api/updates/check", map[string]any{}, nil)
	if response.Code != http.StatusAccepted {
		close(finish)
		t.Fatalf("manual check: %s", response.Body.String())
	}
	<-started
	checking := a.updateState("en")
	if checking.CanInstall {
		close(finish)
		t.Fatal("the in-progress download was offered for installation")
	}
	close(finish)
	a.workers.Wait()
	state := a.updateState("en")
	if state.Phase != "ready" || !state.CanInstall || state.LatestVersion != previous.LatestVersion ||
		state.ReleaseNotesURL != previous.ReleaseNotesURL || state.Progress != previous.Progress ||
		u.downloadDirectory != "original-complete-download" {
		t.Fatalf("the completed update did not recover: state=%+v, directory=%q", state, u.downloadDirectory)
	}
	if !strings.Contains(state.Error, "interrupted") {
		t.Fatalf("the failed download was not explained: %+v", state)
	}
	response = apiRequest(a, http.MethodPost, "/api/updates/install", map[string]any{}, nil)
	if response.Code != http.StatusAccepted {
		t.Fatalf("the completed update could not be installed: %s", response.Body.String())
	}
	a.workers.Wait()
	select {
	case automatic := <-installed:
		if automatic {
			t.Fatal("the requested installation was marked as automatic")
		}
	default:
		t.Fatal("the original completed update was not installed")
	}
}

func TestAutomaticUpdateRetriesAfterACheckFailsWithoutAPreparedUpdate(t *testing.T) {
	a, installed := updateTestApp(t)
	u := a.updates
	u.state.Phase = "idle"
	u.state.CanInstall = false
	u.check = func(context.Context, bool) error { return errors.New("connection interrupted") }
	a.runAutomaticUpdateTasks()
	a.workers.Wait()
	state := a.updateState("en")
	if state.Phase != "error" || state.CanInstall {
		t.Fatalf("failed check: %+v", state)
	}
	u.mu.Lock()
	u.nextCheck = time.Now().Add(-time.Second)
	u.mu.Unlock()
	var checked atomic.Bool
	u.check = func(context.Context, bool) error {
		checked.Store(true)
		u.mu.Lock()
		u.state.Phase = "up-to-date"
		u.state.CanInstall = false
		u.mu.Unlock()
		return nil
	}
	a.runAutomaticUpdateTasks()
	a.workers.Wait()
	if !checked.Load() || a.updateState("en").Phase != "up-to-date" {
		t.Fatal("the automatic check did not recover after the connection returned")
	}
	select {
	case <-installed:
		t.Fatal("installed an update without a completed download")
	default:
	}
}
