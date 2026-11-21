package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type settingsResetFixture struct {
	app       *App
	root      string
	files     map[string][]string
	contents  map[string][]byte
	installed []managedTeXInstallation
}

func setupSettingsResetTest(t *testing.T) settingsResetFixture {
	t.Helper()
	a, root := testApp(t)
	fixture := settingsResetFixture{app: a, root: root, files: map[string][]string{}, contents: map[string][]byte{}}
	remember := func(area, path string) {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		fixture.files[area] = append(fixture.files[area], path)
		fixture.contents[path] = data
	}
	for key, value := range map[string]string{
		"preferences":       `{"language":"ja","autoSave":false,"editorFontSize":18}`,
		"session:" + root:   `{"openPaths":["main.tex"],"activePath":"main.tex"}`,
		"drafts:" + root:    `{"entries":[{"path":"main.tex","content":"unsaved document"}]}`,
		"unknown-ui-record": `{"content":"independent information"}`,
	} {
		path, err := a.storagePath(key)
		if err != nil {
			t.Fatal(err)
		}
		if err := writeStoredUIValue(path, key, json.RawMessage(value)); err != nil {
			t.Fatal(err)
		}
		area := "settings"
		if strings.HasPrefix(key, "drafts:") {
			area = "drafts"
		} else if key == "unknown-ui-record" {
			area = "unknown"
		}
		remember(area, path)
	}
	entry, err := a.recordHistory(root, FileDocument{Path: "main.tex", Content: "earlier document", LineEnding: "lf"}, "earlier", time.Now(), true)
	if err != nil {
		t.Fatal(err)
	}
	historyDirectory, err := a.historyDirectory(root, "main.tex", false)
	if err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{".gz", ".json"} {
		remember("history", filepath.Join(historyDirectory, entry.ID+suffix))
	}
	writeTestFile(t, filepath.Join(a.options.ConfigDir, "history-settings.json"), []byte(`{"enabled":false,"days":90,"maxBytes":104857600}`))
	remember("settings", filepath.Join(a.options.ConfigDir, "history-settings.json"))
	template := templateContents{projectTemplate: projectTemplate{ID: strings.Repeat("a", 32), Name: "My template", Main: "main.tex", Mode: "pdflatex"}, Files: map[string][]byte{"main.tex": []byte("template document")}}
	if err := a.saveTemplateLocked(template, false); err != nil {
		t.Fatal(err)
	}
	remember("templates", filepath.Join(a.options.ConfigDir, "templates", template.ID+".zip"))
	id, err := randomID()
	if err != nil {
		t.Fatal(err)
	}
	cache := a.projectCacheDirectory(root)
	for _, suffix := range []string{".pdf", ".json", ".synctex.gz"} {
		path := filepath.Join(cache, "pdf-"+id+suffix)
		writeTestFile(t, path, []byte("cached "+suffix))
		remember("cache", path)
	}
	a.lastPDF, a.lastPDFID, a.lastPDFMain = filepath.Join(cache, "pdf-"+id+".pdf"), id, "main.tex"
	a.pdfVersions[id], a.pdfMains[id] = a.lastPDF, "main.tex"
	a.pdfOrder = []string{id}
	a.build = &buildRun{result: Build{ID: id, Status: "success"}}
	a.compiledPDFs[compiledPDFKey("main.tex")] = CompiledPDF{Main: "main.tex", BuildID: id}
	installation := managedTeXInstallation{Format: 1, ID: "installed-tex", Parent: filepath.Join(a.options.ConfigDir, "tex"), Directory: filepath.Join(a.options.ConfigDir, "tex", "TinyTeX"), Release: "test"}
	installation.Bin = filepath.Join(installation.Directory, "bin")
	a.config.TexBin = installation.Bin
	a.config.TeXInstallations = []managedTeXInstallation{installation}
	a.project.Mode = "uplatex"
	a.config.Projects[root] = projectSettings{Main: "main.tex", Mode: "uplatex"}
	fixture.installed = append([]managedTeXInstallation{}, a.config.TeXInstallations...)
	if err := a.saveConfig(a.config); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		filepath.Join(installation.Directory, "installed-package.sty"),
		filepath.Join(root, ".local-tex-editor", "build", "main.pdf"),
		filepath.Join(root, "main.tex"),
		filepath.Join(a.options.ConfigDir, legacySettingsImportMarker),
		filepath.Join(a.options.ConfigDir, "app.lock"),
		filepath.Join(a.options.ConfigDir, "notes.tex"),
		filepath.Join(a.options.ConfigDir, "ui-state", "notes.tex"),
		filepath.Join(historyDirectory, "notes.tex"),
		filepath.Join(a.options.ConfigDir, "templates", "notes.tex"),
		filepath.Join(cache, "notes.tex"),
	} {
		if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
			writeTestFile(t, path, []byte("independent file\n"))
		}
		remember("unknown", path)
	}
	return fixture
}

func (fixture settingsResetFixture) checkFiles(t *testing.T, deleted map[string]bool) {
	t.Helper()
	for area, paths := range fixture.files {
		for _, path := range paths {
			data, err := os.ReadFile(path)
			if deleted[area] {
				if !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("%s file still exists: %s (%v)", area, path, err)
				}
			} else if err != nil || !bytes.Equal(data, fixture.contents[path]) {
				t.Fatalf("unselected %s file changed: %s (%v)", area, path, err)
			}
		}
	}
}

func decodeSettingsReset(t *testing.T, response *httptest.ResponseRecorder) State {
	t.Helper()
	var result struct {
		State              State  `json:"state"`
		SettingsGeneration string `json:"settingsGeneration"`
		DraftsGeneration   string `json:"draftsGeneration"`
		Warning            string `json:"warning"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.SettingsGeneration == "" || result.Warning != "" {
		t.Fatalf("reset: %d %s", response.Code, response.Body.String())
	}
	if result.State.SettingsGeneration != result.SettingsGeneration || result.State.DraftsGeneration != result.DraftsGeneration {
		t.Fatalf("inconsistent generations: %s", response.Body.String())
	}
	return result.State
}

func TestSettingsResetClearsSettingsAndLeavesDocumentsAndUserData(t *testing.T) {
	fixture := setupSettingsResetTest(t)
	a := fixture.app
	response := apiRequest(a, http.MethodGet, "/api/settings/reset", nil, nil)
	var summary settingsResetSummary
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &summary) != nil {
		t.Fatalf("summary: %d %s", response.Code, response.Body.String())
	}
	if summary.Settings.Files != 4 || summary.Drafts.Files != 1 || summary.History.Files != 2 || summary.Templates.Files != 1 || summary.Cache.Files != 3 || summary.SettingsGeneration != "" || summary.DraftsGeneration != "" {
		t.Fatalf("unexpected summary: %#v", summary)
	}
	for _, area := range []settingsResetSize{summary.Settings, summary.Drafts, summary.History, summary.Templates, summary.Cache} {
		if area.Bytes <= 0 {
			t.Fatalf("missing storage size: %#v", summary)
		}
	}
	state := decodeSettingsReset(t, apiRequest(a, http.MethodPost, "/api/settings/reset", settingsResetOptions{Settings: true, Confirmation: true}, nil))
	if state.Project != nil || state.Build != nil || len(state.CompiledPDFs) != 0 || len(state.RecentProjects) != 0 || state.DraftsGeneration != "" {
		t.Fatalf("the current project was not cleared: %#v", state)
	}
	if a.config.TexBin != "" || len(a.config.Projects) != 0 || !reflect.DeepEqual(a.config.TeXInstallations, fixture.installed) {
		t.Fatalf("reset settings: %#v", a.config)
	}
	fixture.checkFiles(t, map[string]bool{"settings": true})
	if settings, err := a.readHistorySettings(); err != nil || settings != defaultHistorySettings() {
		t.Fatalf("history preferences: %#v %v", settings, err)
	}
	reopened, err := New(Options{ConfigDir: a.options.ConfigDir, Token: testToken})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	if reopened.config.SettingsGeneration != state.SettingsGeneration || reopened.project != nil || !reflect.DeepEqual(reopened.config.TeXInstallations, fixture.installed) {
		t.Fatalf("reset did not survive restart: %#v", reopened.config)
	}
}

func TestSettingsResetDeletesOnlySelectedUserData(t *testing.T) {
	for _, selection := range []string{"drafts", "history", "templates", "cache", "all"} {
		t.Run(selection, func(t *testing.T) {
			fixture := setupSettingsResetTest(t)
			a := fixture.app
			selected := map[string]bool{}
			for _, area := range []string{"drafts", "history", "templates", "cache"} {
				selected[area] = selection == area || selection == "all"
			}
			input := settingsResetOptions{Drafts: selected["drafts"], History: selected["history"], Templates: selected["templates"], Cache: selected["cache"], Confirmation: true}
			state := decodeSettingsReset(t, apiRequest(a, http.MethodPost, "/api/settings/reset", input, nil))
			if state.Project == nil || state.Project.Root != fixture.root || state.Project.Mode != "uplatex" || len(state.RecentProjects) != 1 || a.config.TexBin != fixture.installed[0].Bin {
				t.Fatalf("selected project settings changed: %#v", state)
			}
			if (state.DraftsGeneration != "") != selected["drafts"] {
				t.Fatalf("draft generation changed for %s: %q", selection, state.DraftsGeneration)
			}
			if selected["cache"] && (state.Build != nil || len(state.CompiledPDFs) != 0 || a.lastPDF != "") {
				t.Fatalf("the deleted PDF is still displayed: %#v", state)
			}
			if !selected["cache"] && (state.Build == nil || len(state.CompiledPDFs) != 1 || a.lastPDF == "") {
				t.Fatalf("an unselected PDF changed: %#v", state)
			}
			fixture.checkFiles(t, selected)
			if !reflect.DeepEqual(a.config.TeXInstallations, fixture.installed) {
				t.Fatal("the installed TeX registrations changed")
			}
		})
	}
}

func TestSettingsResetRequiresSelectionAndConfirmation(t *testing.T) {
	fixture := setupSettingsResetTest(t)
	for _, input := range []settingsResetOptions{{}, {Settings: true}, {Drafts: true}, {Confirmation: true}} {
		response := apiRequest(fixture.app, http.MethodPost, "/api/settings/reset", input, nil)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("unconfirmed reset: %d %s", response.Code, response.Body.String())
		}
		fixture.checkFiles(t, nil)
	}
	if fixture.app.config.SettingsGeneration != "" {
		t.Fatal("a rejected request changed the generation")
	}
}

func checkSettingsConflict(t *testing.T, response *httptest.ResponseRecorder, state State, required bool) {
	t.Helper()
	var result struct {
		ResetRequired      *bool  `json:"resetRequired"`
		SettingsGeneration string `json:"settingsGeneration"`
		DraftsGeneration   string `json:"draftsGeneration"`
	}
	if response.Code != http.StatusConflict || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.ResetRequired == nil || *result.ResetRequired != required || result.SettingsGeneration != state.SettingsGeneration || result.DraftsGeneration != state.DraftsGeneration {
		t.Fatalf("reset conflict: %d %s", response.Code, response.Body.String())
	}
}

func TestSettingsResetRejectsOldAndMissingGenerationsForWrites(t *testing.T) {
	fixture := setupSettingsResetTest(t)
	a := fixture.app
	state := decodeSettingsReset(t, apiRequest(a, http.MethodPost, "/api/settings/reset", settingsResetOptions{Drafts: true, Confirmation: true}, nil))
	for _, headers := range []map[string]string{nil, {settingsGenerationHeader: ""}, {settingsGenerationHeader: "older"}} {
		for _, request := range []struct {
			method, path string
			body         any
		}{
			{http.MethodPut, "/api/storage", map[string]any{"key": "preferences", "value": map[string]string{"language": "en"}}},
			{http.MethodPatch, "/api/storage", map[string]any{"key": "drafts:" + fixture.root, "baseRevision": "", "insert": "{}"}},
			{http.MethodDelete, "/api/storage?key=preferences", nil},
			{http.MethodPut, "/api/settings", map[string]string{"texBin": ""}},
			{http.MethodPut, "/api/history/settings", map[string]any{"enabled": true, "days": 30, "maxBytes": 50 << 20}},
			{http.MethodPost, "/api/project/open", map[string]string{"path": fixture.root}},
			{http.MethodPost, "/api/settings/reset", settingsResetOptions{Settings: true, Confirmation: true}},
		} {
			checkSettingsConflict(t, apiRequest(a, request.method, request.path, request.body, headers), state, true)
		}
	}
	checkSettingsConflict(t, apiRequest(a, http.MethodGet, "/api/state", nil, map[string]string{settingsGenerationHeader: ""}), state, true)
	for _, path := range []string{"/api/state", "/api/settings/reset", "/api/storage?key=preferences"} {
		if response := apiRequest(a, http.MethodGet, path, nil, nil); response.Code != http.StatusOK {
			t.Fatalf("initial read: %d %s", response.Code, response.Body.String())
		}
	}
	if response := apiRequest(a, http.MethodGet, "/api/pdf?build="+a.lastPDFID, nil, nil); response.Code != http.StatusOK {
		t.Fatalf("binary read without a generation: %d %s", response.Code, response.Body.String())
	}
	response := apiRequest(a, http.MethodPut, "/api/storage", map[string]any{"key": "preferences", "value": map[string]string{"language": "en"}}, map[string]string{settingsGenerationHeader: state.SettingsGeneration})
	if response.Code != http.StatusOK {
		t.Fatalf("new generation could not save: %d %s", response.Code, response.Body.String())
	}
}

func TestSettingsResetRefusesActiveBuildAndTeXOperations(t *testing.T) {
	for _, operation := range []string{"build", "TeX", "cancelling TeX"} {
		t.Run(operation, func(t *testing.T) {
			fixture := setupSettingsResetTest(t)
			a := fixture.app
			if operation == "build" {
				a.build.result.Status = "running"
			} else {
				status := "running"
				if operation == "cancelling TeX" {
					status = "cancelling"
				}
				a.texSetup = &texSetupRun{state: TeXSetupState{Status: status}}
			}
			response := apiRequest(a, http.MethodPost, "/api/settings/reset", settingsResetOptions{Settings: true, Drafts: true, Confirmation: true}, nil)
			checkSettingsConflict(t, response, State{}, false)
			a.build.result.Status, a.texSetup = "success", nil
			fixture.checkFiles(t, nil)
		})
	}
}

func testSettingsRequest(a *App, method, path string, body any) (*http.Request, *httptest.ResponseRecorder) {
	var data bytes.Buffer
	_ = json.NewEncoder(&data).Encode(body)
	request := httptest.NewRequest(method, "http://127.0.0.1:8765"+path, &data)
	request.RemoteAddr = "127.0.0.1:54321"
	request.Header.Set("X-Local-Token", testToken)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(settingsGenerationHeader, a.config.SettingsGeneration)
	return request, httptest.NewRecorder()
}

func TestSettingsResetRefusesAnOpenFolderPicker(t *testing.T) {
	fixture := setupSettingsResetTest(t)
	a := fixture.app
	started, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	request, response := testSettingsRequest(a, http.MethodPost, "/api/project/pick", map[string]any{})
	go func() {
		defer close(done)
		a.authenticate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			close(started)
			<-release
			writeJSON(w, http.StatusOK, map[string]string{"path": fixture.root})
		})).ServeHTTP(response, request)
	}()
	<-started
	reset := apiRequest(a, http.MethodPost, "/api/settings/reset", settingsResetOptions{Settings: true, Confirmation: true}, nil)
	close(release)
	<-done
	checkSettingsConflict(t, reset, State{}, false)
	fixture.checkFiles(t, nil)
}

func waitForSettingsReset(t *testing.T, a *App) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		a.mu.Lock()
		pending := a.settingsResetPending
		a.mu.Unlock()
		if pending {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("the reset did not start waiting for the current request")
}

func TestSettingsResetWaitsForCurrentWritesAndRejectsQueuedOldWrites(t *testing.T) {
	fixture := setupSettingsResetTest(t)
	a := fixture.app
	started, release, firstDone := make(chan struct{}), make(chan struct{}), make(chan struct{})
	body := map[string]any{"key": "preferences", "value": map[string]string{"language": "en"}}
	request, first := testSettingsRequest(a, http.MethodPut, "/api/storage", body)
	go func() {
		defer close(firstDone)
		a.authenticate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			close(started)
			<-release
			a.storageHandler(w, r)
		})).ServeHTTP(first, request)
	}()
	<-started
	resetDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		resetDone <- apiRequest(a, http.MethodPost, "/api/settings/reset", settingsResetOptions{Settings: true, Confirmation: true}, nil)
	}()
	waitForSettingsReset(t, a)
	oldDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		oldDone <- apiRequest(a, http.MethodPut, "/api/storage", body, map[string]string{settingsGenerationHeader: ""})
	}()
	close(release)
	<-firstDone
	if first.Code != http.StatusOK {
		t.Fatalf("current write: %d %s", first.Code, first.Body.String())
	}
	state := decodeSettingsReset(t, <-resetDone)
	checkSettingsConflict(t, <-oldDone, state, true)
	path, _ := a.storagePath("preferences")
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("an older write restored the preferences: %v", err)
	}
}

func TestCancelledSettingsResetDoesNotChangeSavedData(t *testing.T) {
	fixture := setupSettingsResetTest(t)
	a := fixture.app
	started, release, currentDone := make(chan struct{}), make(chan struct{}), make(chan struct{})
	request, response := testSettingsRequest(a, http.MethodGet, "/api/storage?key=preferences", nil)
	go func() {
		defer close(currentDone)
		a.authenticate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(started); <-release; a.storageHandler(w, r) })).ServeHTTP(response, request)
	}()
	<-started
	reset, result := testSettingsRequest(a, http.MethodPost, "/api/settings/reset", settingsResetOptions{Settings: true, Confirmation: true})
	ctx, cancel := context.WithCancel(reset.Context())
	reset = reset.WithContext(ctx)
	done := make(chan struct{})
	go func() { defer close(done); a.Handler().ServeHTTP(result, reset) }()
	waitForSettingsReset(t, a)
	cancel()
	close(release)
	<-currentDone
	<-done
	fixture.checkFiles(t, nil)
	if a.config.SettingsGeneration != "" {
		t.Fatal("a cancelled reset changed the generation")
	}
}

func TestSettingsResetDoesNotFollowLinks(t *testing.T) {
	for _, area := range []string{"ui-state", "history", "templates", "cache"} {
		t.Run(area, func(t *testing.T) {
			a, _ := testApp(t)
			outside := t.TempDir()
			original := filepath.Join(outside, "main.tex")
			writeTestFile(t, original, []byte("external document"))
			if err := os.Symlink(outside, filepath.Join(a.options.ConfigDir, area)); err != nil {
				t.Skipf("symlinks are unavailable: %v", err)
			}
			input := settingsResetOptions{Settings: area == "ui-state", History: area == "history", Templates: area == "templates", Cache: area == "cache", Confirmation: true}
			response := apiRequest(a, http.MethodPost, "/api/settings/reset", input, nil)
			if response.Code != http.StatusForbidden || a.config.SettingsGeneration != "" {
				t.Fatalf("linked storage accepted: %d %s", response.Code, response.Body.String())
			}
			if data, err := os.ReadFile(original); err != nil || string(data) != "external document" {
				t.Fatalf("external document changed: %q %v", data, err)
			}
		})
	}
}

func TestSettingsResetLeavesUnknownLinksAndClearsUnreadablePreferences(t *testing.T) {
	a, _ := testApp(t)
	preferences, _ := a.storagePath("preferences")
	writeTestFile(t, preferences, []byte("damaged preference record"))
	outside := t.TempDir()
	writeTestFile(t, filepath.Join(outside, "main.tex"), []byte("external document"))
	link := filepath.Join(a.options.ConfigDir, "ui-state", "personal-folder")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks are unavailable: %v", err)
	}
	decodeSettingsReset(t, apiRequest(a, http.MethodPost, "/api/settings/reset", settingsResetOptions{Settings: true, Drafts: true, Confirmation: true}, nil))
	if _, err := os.Stat(preferences); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unreadable preferences remain: %v", err)
	}
	if _, err := os.Lstat(link); err != nil {
		t.Fatalf("an unrelated link was removed: %v", err)
	}
	if data, err := os.ReadFile(filepath.Join(outside, "main.tex")); err != nil || string(data) != "external document" {
		t.Fatalf("an unrelated document changed: %q %v", data, err)
	}
}

func TestSettingsResetRecoversAStoppedTransaction(t *testing.T) {
	for _, committed := range []bool{false, true} {
		name := "before settings were saved"
		if committed {
			name = "after settings were saved"
		}
		t.Run(name, func(t *testing.T) {
			a, _ := testApp(t)
			preferences, _ := a.storagePath("preferences")
			if err := writeStoredUIValue(preferences, "preferences", json.RawMessage(`{"language":"ja"}`)); err != nil {
				t.Fatal(err)
			}
			generation, err := randomID()
			if err != nil {
				t.Fatal(err)
			}
			stage := filepath.Join(a.options.ConfigDir, settingsResetPrefix+generation)
			relative, _ := filepath.Rel(a.options.ConfigDir, preferences)
			journal := settingsResetJournal{Version: 1, Generation: generation, Paths: []string{"settings.json", filepath.ToSlash(relative)}}
			data, _ := json.Marshal(journal)
			writeTestFile(t, filepath.Join(stage, settingsResetJournalName), data)
			for _, path := range journal.Paths {
				destination := filepath.Join(stage, filepath.FromSlash(path))
				if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(filepath.Join(a.options.ConfigDir, filepath.FromSlash(path)), destination); err != nil {
					t.Fatal(err)
				}
			}
			if committed {
				if err := a.saveConfig(configuration{SettingsGeneration: generation, Projects: map[string]projectSettings{}, RecentProjects: []string{}}); err != nil {
					t.Fatal(err)
				}
			}
			reopened, err := New(Options{ConfigDir: a.options.ConfigDir, Token: testToken})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = reopened.Close() })
			if _, err := os.Stat(stage); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("temporary reset data remain: %v", err)
			}
			value, err := readStoredUIValue(preferences, "preferences")
			if err != nil || (len(value) == 0) != committed || (reopened.config.SettingsGeneration == generation) != committed {
				t.Fatalf("recovered reset: committed=%v value=%s config=%#v err=%v", committed, value, reopened.config, err)
			}
		})
	}
}
