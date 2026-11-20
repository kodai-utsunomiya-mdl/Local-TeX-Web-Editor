package app

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func projectStateForTest(t *testing.T, a *App) State {
	t.Helper()
	response := apiRequest(a, http.MethodGet, "/api/state", nil, map[string]string{"Accept-Language": "en"})
	if response.Code != http.StatusOK {
		t.Fatalf("state: %d %s", response.Code, response.Body.String())
	}
	var state State
	if err := json.Unmarshal(response.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	return state
}

func TestRecentProjectsFollowFoldersMovedOutsideTheApp(t *testing.T) {
	a, root := testApp(t)
	previous := filepath.Join(t.TempDir(), "earlier project")
	writeTestFile(t, filepath.Join(previous, "notes.md"), []byte("# Earlier notes\n"))
	opened := apiRequest(a, http.MethodPost, "/api/project/open", map[string]string{"path": previous}, nil)
	if opened.Code != http.StatusOK {
		t.Fatal(opened.Body.String())
	}
	var prior State
	if err := json.Unmarshal(opened.Body.Bytes(), &prior); err != nil {
		t.Fatal(err)
	}
	previous = prior.Project.Root
	if response := apiRequest(a, http.MethodPost, "/api/project/open", map[string]string{"path": root}, nil); response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	moved := previous + " moved"
	if err := os.Rename(previous, moved); err != nil {
		t.Fatal(err)
	}
	state := projectStateForTest(t, a)
	if state.ProjectStatus == nil || state.ProjectStatus.Status != "available" || len(state.RecentProjectStatuses) != 2 {
		t.Fatalf("unexpected project states: %#v", state)
	}
	for _, status := range state.RecentProjectStatuses {
		if samePath(status.Path, previous) && (status.Status != "missing" || !strings.Contains(status.Message, "new location")) {
			t.Fatalf("moved folder: %#v", status)
		}
	}
	if len(state.RecentProjects) != 2 {
		t.Fatal("the missing folder was removed without a user action")
	}
	if err := os.Rename(moved, previous); err != nil {
		t.Fatal(err)
	}
	for _, status := range projectStateForTest(t, a).RecentProjectStatuses {
		if status.Status != "available" || status.Message != "" {
			t.Fatalf("restored folder: %#v", status)
		}
	}
}

func TestMissingCurrentProjectKeepsDraftsAndPDFsAndStopsWrites(t *testing.T) {
	a, root := testApp(t)
	document, err := readDocument(root, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	pdf := finishCompiledPDFForTest(t, a, root, "main.tex", "paper.pdf", map[string]bool{})
	moved := root + " moved"
	if err := os.Rename(root, moved); err != nil {
		t.Fatal(err)
	}
	state := projectStateForTest(t, a)
	if state.Project == nil || !samePath(state.Project.Root, root) || state.ProjectStatus.Status != "missing" || len(state.Project.Files) != 0 || len(state.Project.Directories) != 0 {
		t.Fatalf("missing current folder: %#v", state)
	}
	document.Content = "Unsaved text that must not recreate the missing folder."
	headers := map[string]string{"X-Project-Root": url.PathEscape(root)}
	for _, request := range []struct {
		method string
		path   string
		body   any
	}{
		{http.MethodPut, "/api/file", document},
		{http.MethodPost, "/api/entry", map[string]string{"path": "new-folder"}},
		{http.MethodPost, "/api/build", map[string]string{"main": "main.tex"}},
	} {
		if response := apiRequest(a, request.method, request.path, request.body, headers); response.Code != http.StatusNotFound {
			t.Fatalf("%s %s: %d %s", request.method, request.path, response.Code, response.Body.String())
		}
	}
	for _, endpoint := range []string{"/api/pdf?build=" + pdf.BuildID, "/api/build"} {
		if response := apiRequest(a, http.MethodGet, endpoint, nil, headers); response.Code != http.StatusOK {
			t.Fatalf("cached result %s: %d %s", endpoint, response.Code, response.Body.String())
		}
	}
	if response := apiRequest(a, http.MethodPost, "/api/build/stop", nil, headers); response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	key := "drafts:" + root
	if response := apiRequest(a, http.MethodPut, "/api/storage", map[string]any{"key": key, "value": map[string]string{"content": document.Content}}, headers); response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("the unavailable folder was recreated: %v", err)
	}
	if err := os.Rename(moved, root); err != nil {
		t.Fatal(err)
	}
	restored := projectStateForTest(t, a)
	if restored.ProjectStatus.Status != "available" || !hasFile(restored.Project.Files, "main.tex") {
		t.Fatalf("restored current folder: %#v", restored)
	}
	response := apiRequest(a, http.MethodGet, "/api/storage?key="+url.QueryEscape(key), nil, nil)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), document.Content) {
		t.Fatal("the saved draft was not available after returning to the folder")
	}
}

func TestProjectStatusExplainsAFileAtTheOldFolderPath(t *testing.T) {
	a, root := testApp(t)
	if err := os.Rename(root, root+" moved"); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, root, []byte("This is a file now."))
	state := projectStateForTest(t, a)
	if state.ProjectStatus.Status != "not-directory" || len(state.Project.Files) != 0 {
		t.Fatalf("file at project path: %#v", state.ProjectStatus)
	}
	if response := apiRequest(a, http.MethodPost, "/api/entry", map[string]string{"path": "new"}, nil); response.Code != http.StatusBadRequest {
		t.Fatal(response.Body.String())
	}
}

func TestProjectStatusRejectsAReplacementLink(t *testing.T) {
	a, root := testApp(t)
	if err := os.Rename(root, root+" moved"); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	writeTestFile(t, filepath.Join(outside, "main.tex"), []byte("Leave this outside file as written."))
	if err := os.Symlink(outside, root); err != nil {
		t.Skipf("symbolic links are unavailable: %v", err)
	}
	state := projectStateForTest(t, a)
	if state.ProjectStatus.Status != "changed" || len(state.Project.Files) != 0 {
		t.Fatalf("replacement link: %#v", state.ProjectStatus)
	}
	response := apiRequest(a, http.MethodPost, "/api/entry", map[string]string{"path": "new-folder"}, nil)
	if response.Code != http.StatusConflict {
		t.Fatalf("operation through the replacement link: %d %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(filepath.Join(outside, "new-folder")); !os.IsNotExist(err) {
		t.Fatalf("operation changed the linked folder: %v", err)
	}
}

func TestRemovingARecentProjectOnlyChangesItsListEntry(t *testing.T) {
	a, root := testApp(t)
	other := filepath.Join(t.TempDir(), "other project")
	writeTestFile(t, filepath.Join(other, "notes.md"), []byte("# Other notes\n"))
	response := apiRequest(a, http.MethodPost, "/api/project/open", map[string]string{"path": other}, nil)
	if response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	var opened State
	if err := json.Unmarshal(response.Body.Bytes(), &opened); err != nil {
		t.Fatal(err)
	}
	other = opened.Project.Root
	if response := apiRequest(a, http.MethodPost, "/api/project/open", map[string]string{"path": root}, nil); response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	for _, prefix := range []string{"drafts:", "session:"} {
		projectStorageForTest(t, a, prefix+other, map[string]string{"content": "Saved work"})
	}
	for index := 0; index < 2; index++ {
		response := apiRequest(a, http.MethodDelete, "/api/project/recent", map[string]string{"path": other}, nil)
		var result struct {
			Removed bool  `json:"removed"`
			State   State `json:"state"`
		}
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil {
			t.Fatalf("remove recent project: %d %s", response.Code, response.Body.String())
		}
		if result.Removed != (index == 0) || len(result.State.RecentProjects) != 1 || !samePath(result.State.Project.Root, root) {
			t.Fatalf("removing the entry changed another state: %#v", result)
		}
	}
	if content, err := os.ReadFile(filepath.Join(other, "notes.md")); err != nil || string(content) != "# Other notes\n" {
		t.Fatalf("project contents changed: %q %v", content, err)
	}
	if _, found := a.config.Projects[other]; !found {
		t.Fatal("the project settings were removed")
	}
	for _, prefix := range []string{"drafts:", "session:"} {
		response := apiRequest(a, http.MethodGet, "/api/storage?key="+url.QueryEscape(prefix+other), nil, nil)
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "Saved work") {
			t.Fatalf("saved work was removed: %s", response.Body.String())
		}
	}
	data, err := os.ReadFile(filepath.Join(a.options.ConfigDir, "settings.json"))
	var config configuration
	if err != nil || json.Unmarshal(data, &config) != nil || len(config.RecentProjects) != 1 || config.RecentProjects[0] != root {
		t.Fatalf("recent projects were not saved: %s %v", data, err)
	}
}

func TestHistoryCanBeReadWhenTheProjectFolderIsMissing(t *testing.T) {
	a, root := testApp(t)
	path := "chapters/notes.md"
	content := "# Text recorded before moving the project\n"
	writeTestFile(t, filepath.Join(root, filepath.FromSlash(path)), []byte(content))
	response := apiRequest(a, http.MethodPost, "/api/history", map[string]string{"path": path, "content": content, "label": "Before moving"}, nil)
	if response.Code != http.StatusCreated {
		t.Fatal(response.Body.String())
	}
	entries := historyList(t, a, path)
	if len(entries) != 1 {
		t.Fatalf("recorded history: %#v", entries)
	}
	if err := os.Rename(root, root+" moved"); err != nil {
		t.Fatal(err)
	}
	endpoint := "/api/history?path=" + url.QueryEscape(path)
	headers := map[string]string{"X-Project-Root": url.PathEscape(root)}
	response = apiRequest(a, http.MethodGet, endpoint, nil, headers)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), entries[0].ID) {
		t.Fatalf("history list from the missing folder: %d %s", response.Code, response.Body.String())
	}
	response = apiRequest(a, http.MethodGet, endpoint+"&id="+entries[0].ID, nil, headers)
	var version struct {
		Content string `json:"content"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &version) != nil || version.Content != content {
		t.Fatalf("history text from the missing folder: %d %s", response.Code, response.Body.String())
	}
	response = apiRequest(a, http.MethodGet, endpoint, nil, map[string]string{"X-Project-Root": url.PathEscape(root + " moved")})
	if response.Code != http.StatusConflict {
		t.Fatalf("history request from a different project: %d %s", response.Code, response.Body.String())
	}
	response = apiRequest(a, http.MethodGet, "/api/history?path="+url.QueryEscape("../notes.md"), nil, headers)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("history path outside the project: %d %s", response.Code, response.Body.String())
	}
}
