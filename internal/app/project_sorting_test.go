package app

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func fileListedWithTime(t *testing.T, project *Project, path string) ProjectFile {
	t.Helper()
	for _, file := range project.Files {
		if file.Path == path {
			return file
		}
	}
	t.Fatalf("file %s is missing from the project", path)
	return ProjectFile{}
}

func projectStateWithTimes(t *testing.T, a *App) State {
	t.Helper()
	response := apiRequest(a, http.MethodGet, "/api/state", nil, nil)
	var state State
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &state) != nil || state.Project == nil {
		t.Fatalf("project state: %d %s", response.Code, response.Body.String())
	}
	return state
}

func modificationTimeForTest(t *testing.T, path string) time.Time {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.ModTime()
}

func TestProjectListsFileAndFolderModificationTimes(t *testing.T) {
	a, root := testApp(t)
	writeTestFile(t, filepath.Join(root, "chapters", "body.tex"), []byte("body\n"))
	if err := os.Mkdir(filepath.Join(root, "empty"), 0700); err != nil {
		t.Fatal(err)
	}
	times := map[string]time.Time{
		"main.tex":          time.Date(2025, 1, 2, 3, 4, 5, 123000000, time.UTC),
		"chapters/body.tex": time.Date(2025, 6, 2, 3, 4, 5, 456000000, time.UTC),
		"chapters":          time.Date(2025, 2, 2, 3, 4, 5, 789000000, time.UTC),
		"empty":             time.Date(2025, 3, 2, 3, 4, 5, 0, time.UTC),
	}
	for relative, modified := range times {
		if err := os.Chtimes(filepath.Join(root, filepath.FromSlash(relative)), modified, modified); err != nil {
			t.Fatal(err)
		}
	}
	state := projectStateWithTimes(t, a)
	for _, relative := range []string{"main.tex", "chapters/body.tex"} {
		entry := fileListedWithTime(t, state.Project, relative)
		if expected := modificationTimeForTest(t, filepath.Join(root, filepath.FromSlash(relative))); !entry.ModifiedAt.Equal(expected) {
			t.Fatalf("file %s modification time = %s; want %s", relative, entry.ModifiedAt, expected)
		}
	}
	for _, relative := range []string{"chapters", "empty"} {
		actual := state.Project.DirectoryModifiedAt[relative]
		if expected := modificationTimeForTest(t, filepath.Join(root, relative)); !actual.Equal(expected) {
			t.Fatalf("folder %s modification time = %s; want %s", relative, actual, expected)
		}
	}
	if state.Project.DirectoryModifiedAt["chapters"].Equal(fileListedWithTime(t, state.Project, "chapters/body.tex").ModifiedAt) {
		t.Fatal("folder modification time was replaced with its child's time")
	}
	a.mu.Lock()
	copy := a.stateLocked(false)
	copy.Project.DirectoryModifiedAt["chapters"] = time.Time{}
	unchanged := !a.project.DirectoryModifiedAt["chapters"].IsZero()
	a.mu.Unlock()
	if !unchanged {
		t.Fatal("editing a returned project snapshot changed the live folder times")
	}
}

func TestSaveReturnsCurrentFileAndFolderModificationTimes(t *testing.T) {
	a, root := testApp(t)
	file := filepath.Join(root, "notes", "draft.md")
	writeTestFile(t, file, []byte("old\n"))
	oldTime := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	if err := os.Chtimes(file, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}
	document, err := readDocument(root, "notes/draft.md")
	if err != nil {
		t.Fatal(err)
	}
	document.Content = "saved text\n"
	response := apiRequest(a, http.MethodPut, "/api/file", document, nil)
	var saved FileDocument
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &saved) != nil || saved.Entry == nil {
		t.Fatalf("save metadata: %d %s", response.Code, response.Body.String())
	}
	actual := modificationTimeForTest(t, file)
	if saved.Entry.Path != document.Path || saved.Entry.Size != int64(len(document.Content)) || !saved.Entry.ModifiedAt.Equal(actual) || !actual.After(oldTime) {
		t.Fatalf("saved file metadata = %#v; modification time = %s", saved.Entry, actual)
	}
	if !saved.DirectoryModifiedAt["notes"].Equal(modificationTimeForTest(t, filepath.Dir(file))) {
		t.Fatalf("save did not include the parent folder's time: %#v", saved.DirectoryModifiedAt)
	}
	response = apiRequest(a, http.MethodPut, "/api/file", saved, nil)
	var repeated FileDocument
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &repeated) != nil || repeated.Entry == nil || !repeated.Entry.ModifiedAt.Equal(actual) {
		t.Fatalf("saving the same text changed its modification time: %d %s", response.Code, response.Body.String())
	}
}

func TestProjectTimesFollowExternalChangesAndRenames(t *testing.T) {
	a, root := testApp(t)
	writeTestFile(t, filepath.Join(root, "draft.txt"), []byte("first\n"))
	initial := fileListedWithTime(t, projectStateWithTimes(t, a).Project, "draft.txt")
	writeTestFile(t, filepath.Join(root, "draft.txt"), []byte("changed outside the editor\n"))
	changedTime := time.Date(2024, 10, 12, 13, 14, 15, 0, time.UTC)
	if err := os.Chtimes(filepath.Join(root, "draft.txt"), changedTime, changedTime); err != nil {
		t.Fatal(err)
	}
	changed := fileListedWithTime(t, projectStateWithTimes(t, a).Project, "draft.txt")
	if changed.ModifiedAt.Equal(initial.ModifiedAt) || !changed.ModifiedAt.Equal(modificationTimeForTest(t, filepath.Join(root, "draft.txt"))) || changed.Size == initial.Size {
		t.Fatalf("external update was not listed: before %#v; after %#v", initial, changed)
	}
	entry := entryForTest(t, a, "draft.txt")
	response := apiRequest(a, http.MethodPatch, "/api/entry", map[string]string{"path": entry.Path, "newPath": "renamed.txt", "revision": entry.Revision}, nil)
	var result struct {
		State State `json:"state"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.State.Project == nil {
		t.Fatalf("rename state: %d %s", response.Code, response.Body.String())
	}
	renamed := fileListedWithTime(t, result.State.Project, "renamed.txt")
	if !renamed.ModifiedAt.Equal(modificationTimeForTest(t, filepath.Join(root, "renamed.txt"))) || hasFile(result.State.Project.Files, "draft.txt") {
		t.Fatalf("rename returned stale file metadata: %#v", result.State.Project.Files)
	}
}
