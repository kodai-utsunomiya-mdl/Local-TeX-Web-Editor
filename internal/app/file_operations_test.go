package app

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func entryForTest(t *testing.T, a *App, path string) projectEntry {
	t.Helper()
	response := apiRequest(a, http.MethodGet, "/api/entry?path="+url.QueryEscape(path), nil, nil)
	var entry projectEntry
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &entry) != nil {
		t.Fatalf("entry %s: %d %s", path, response.Code, response.Body.String())
	}
	return entry
}

func TestFileRenameUpdatesMainAndMovesEditHistory(t *testing.T) {
	a, root := testApp(t)
	document, err := readDocument(root, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.recordHistory(root, document, "before rename", time.Now(), true); err != nil {
		t.Fatal(err)
	}
	entry := entryForTest(t, a, "main.tex")
	if entry.ContentRevision != document.Revision || entry.Directory {
		t.Fatalf("wrong entry: %#v", entry)
	}
	response := apiRequest(a, http.MethodPatch, "/api/entry", map[string]string{"path": entry.Path, "newPath": "renamed.tex", "revision": entry.Revision}, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("rename: %d %s", response.Code, response.Body.String())
	}
	if a.project.Main != "renamed.tex" || a.config.Projects[root].Main != "renamed.tex" {
		t.Fatalf("main was not renamed: %#v", a.project)
	}
	if _, err := os.Stat(filepath.Join(root, "main.tex")); !os.IsNotExist(err) {
		t.Fatalf("old path still exists: %v", err)
	}
	actual, err := readDocument(root, "renamed.tex")
	if err != nil || actual.Content != document.Content || actual.Revision != document.Revision {
		t.Fatalf("renamed content: %#v %v", actual, err)
	}
	entries := historyList(t, a, "renamed.tex")
	if len(entries) != 1 || entries[0].Label != "before rename" {
		t.Fatalf("history did not follow the file: %#v", entries)
	}
	entry = entryForTest(t, a, "renamed.tex")
	response = apiRequest(a, http.MethodDelete, "/api/entry", entry, nil)
	if response.Code != http.StatusOK || a.project.Main != "" || a.config.Projects[root].Main != "" {
		t.Fatalf("delete main: %d %s", response.Code, response.Body.String())
	}
}

func TestFolderRenameUpdatesContainedMainAndRejectsNonemptyDeletion(t *testing.T) {
	a, root := testApp(t)
	writeTestFile(t, filepath.Join(root, "chapters", "body.tex"), []byte("chapter\n"))
	writeTestFile(t, filepath.Join(root, "chapters", "script.py"), []byte("print('日本語')\n"))
	a.project.Main = "chapters/body.tex"
	a.project.Files, _ = listProjectFiles(root)
	doc, _ := readDocument(root, "chapters/body.tex")
	if _, err := a.recordHistory(root, doc, "chapter", time.Now(), true); err != nil {
		t.Fatal(err)
	}
	entry := entryForTest(t, a, "chapters")
	if !entry.Directory || entry.Empty {
		t.Fatalf("folder entry: %#v", entry)
	}
	response := apiRequest(a, http.MethodDelete, "/api/entry", entry, nil)
	if response.Code != http.StatusConflict {
		t.Fatalf("nonempty delete: %d %s", response.Code, response.Body.String())
	}
	response = apiRequest(a, http.MethodPatch, "/api/entry", map[string]string{"path": "chapters", "newPath": "sections", "revision": entry.Revision}, nil)
	if response.Code != http.StatusOK || a.project.Main != "sections/body.tex" {
		t.Fatalf("folder rename: %d %s", response.Code, response.Body.String())
	}
	if _, err := readDocument(root, "sections/script.py"); err != nil {
		t.Fatal(err)
	}
	if len(historyList(t, a, "sections/body.tex")) != 1 {
		t.Fatal("contained history did not move")
	}
	response = apiRequest(a, http.MethodPost, "/api/entry", map[string]string{"path": "sections/empty"}, nil)
	if response.Code != http.StatusCreated {
		t.Fatalf("create folder: %d %s", response.Code, response.Body.String())
	}
	empty := entryForTest(t, a, "sections/empty")
	if !empty.Directory || !empty.Empty {
		t.Fatalf("empty folder: %#v", empty)
	}
	response = apiRequest(a, http.MethodDelete, "/api/entry", empty, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("delete empty folder: %d %s", response.Code, response.Body.String())
	}
}

func TestFolderRenameMovesHistoryForFilesRecreatedAfterTheLastRefresh(t *testing.T) {
	a, root := testApp(t)
	oldPath := "chapter/draft.tex"
	writeTestFile(t, filepath.Join(root, filepath.FromSlash(oldPath)), []byte("earlier text\n"))
	document, err := readDocument(root, oldPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.recordHistory(root, document, "earlier draft", time.Now(), true); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, filepath.FromSlash(oldPath))); err != nil {
		t.Fatal(err)
	}
	// Refresh while the file is absent, then recreate it outside the editor.
	a.project.Files, err = listProjectFiles(root)
	if err != nil {
		t.Fatal(err)
	}
	if hasFile(a.project.Files, oldPath) {
		t.Fatal("the cached list should not contain the removed file")
	}
	writeTestFile(t, filepath.Join(root, filepath.FromSlash(oldPath)), []byte("recreated externally\n"))
	entry := entryForTest(t, a, "chapter")
	response := apiRequest(a, http.MethodPatch, "/api/entry", map[string]string{"path": "chapter", "newPath": "section", "revision": entry.Revision}, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("rename with an old file list: %d %s", response.Code, response.Body.String())
	}
	current, err := readDocument(root, "section/draft.tex")
	if err != nil || current.Content != "recreated externally\n" {
		t.Fatalf("the recreated file did not move: %#v %v", current, err)
	}
	entries := historyList(t, a, "section/draft.tex")
	if len(entries) != 1 || entries[0].Label != "earlier draft" {
		t.Fatalf("earlier history did not follow the recreated file: %#v", entries)
	}
	response = apiRequest(a, http.MethodGet, "/api/history?path=section/draft.tex&id="+entries[0].ID, nil, nil)
	var version struct {
		Content string `json:"content"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &version) != nil || version.Content != "earlier text\n" {
		t.Fatalf("earlier text is unavailable after the folder moved: %s", response.Body.String())
	}
}

func TestEntryChangesRejectStaleRevisionsAndOccupiedDestinations(t *testing.T) {
	a, root := testApp(t)
	writeTestFile(t, filepath.Join(root, "notes.md"), []byte("before"))
	entry := entryForTest(t, a, "notes.md")
	writeTestFile(t, filepath.Join(root, "notes.md"), []byte("external change"))
	for _, method := range []string{http.MethodPatch, http.MethodDelete} {
		response := apiRequest(a, method, "/api/entry", map[string]string{"path": "notes.md", "newPath": "new.md", "revision": entry.Revision}, nil)
		if response.Code != http.StatusConflict {
			t.Fatalf("stale %s: %d %s", method, response.Code, response.Body.String())
		}
	}
	entry = entryForTest(t, a, "notes.md")
	writeTestFile(t, filepath.Join(root, "occupied.md"), []byte("keep this"))
	response := apiRequest(a, http.MethodPatch, "/api/entry", map[string]string{"path": "notes.md", "newPath": "occupied.md", "revision": entry.Revision}, nil)
	if response.Code != http.StatusConflict {
		t.Fatalf("occupied path: %d %s", response.Code, response.Body.String())
	}
	actual, _ := os.ReadFile(filepath.Join(root, "occupied.md"))
	if string(actual) != "keep this" {
		t.Fatal("the destination was overwritten")
	}
	response = apiRequest(a, http.MethodDelete, "/api/entry", map[string]string{"path": "notes.md"}, nil)
	if response.Code != http.StatusConflict {
		t.Fatal("a delete without a revision was accepted")
	}
	writeTestFile(t, filepath.Join(root, "folder", "file.txt"), []byte("first"))
	folder := entryForTest(t, a, "folder")
	writeTestFile(t, filepath.Join(root, "folder", "new.txt"), []byte("new child"))
	response = apiRequest(a, http.MethodPatch, "/api/entry", map[string]string{"path": "folder", "newPath": "moved", "revision": folder.Revision}, nil)
	if response.Code != http.StatusConflict {
		t.Fatalf("folder changed after preview: %d %s", response.Code, response.Body.String())
	}
}

func TestEntryChangesRespectProjectBoundaryAndRejectLinks(t *testing.T) {
	a, root := testApp(t)
	entry := entryForTest(t, a, "main.tex")
	for _, path := range []string{"../escape", ".git/new", "C:/outside", "file/../other", "CON", "trailing."} {
		response := apiRequest(a, http.MethodPost, "/api/entry", map[string]string{"path": path}, nil)
		if response.Code < 400 {
			t.Fatalf("accepted folder path %q", path)
		}
		response = apiRequest(a, http.MethodPatch, "/api/entry", map[string]string{"path": "main.tex", "newPath": path, "revision": entry.Revision}, nil)
		if response.Code < 400 {
			t.Fatalf("accepted rename path %q", path)
		}
	}
	response := apiRequest(a, http.MethodDelete, "/api/entry", entry, map[string]string{"X-Project-Root": url.PathEscape(root + "-other")})
	if response.Code != http.StatusConflict {
		t.Fatalf("wrong project: %d", response.Code)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Skipf("links unavailable: %v", err)
	}
	response = apiRequest(a, http.MethodPost, "/api/entry", map[string]string{"path": "linked/new-folder"}, nil)
	if response.Code < 400 {
		t.Fatal("created a folder through a link")
	}
	response = apiRequest(a, http.MethodGet, "/api/entry?path=linked", nil, nil)
	if response.Code < 400 {
		t.Fatal("inspected a link as a regular folder")
	}
	if _, err := os.Stat(filepath.Join(outside, "new-folder")); !os.IsNotExist(err) {
		t.Fatal("the outside folder was changed")
	}
}

func TestProgramFilesCanBeListedEditedAndSavedAsUTF8(t *testing.T) {
	a, root := testApp(t)
	for _, name := range []string{"script.py", "component.tsx", "main.cpp", "main.go", "lib.rs", "script.ps1", "Makefile", "Dockerfile", "CMakeLists.txt", ".gitignore", "settings.ini", "index.html", "analysis.R", "notebook.ipynb"} {
		if !isTextFile(name) {
			t.Fatalf("unsupported source file %s", name)
		}
	}
	original := append([]byte{0xef, 0xbb, 0xbf}, []byte("# 日本語\r\nprint('old')\r\n")...)
	writeTestFile(t, filepath.Join(root, "script.py"), original)
	response := apiRequest(a, http.MethodGet, "/api/file?path=script.py", nil, nil)
	var document FileDocument
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &document) != nil {
		t.Fatalf("read Python: %s", response.Body.String())
	}
	document.Content = "# 日本語\nprint('edited')\n"
	response = apiRequest(a, http.MethodPut, "/api/file", document, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("save Python: %s", response.Body.String())
	}
	actual, _ := os.ReadFile(filepath.Join(root, "script.py"))
	expected := append([]byte{0xef, 0xbb, 0xbf}, []byte(strings.ReplaceAll(document.Content, "\n", "\r\n"))...)
	if !bytes.Equal(actual, expected) {
		t.Fatalf("encoding or line endings changed: %q", actual)
	}
	found := false
	for _, file := range a.project.Files {
		if file.Path == "script.py" {
			found = file.Kind == "text"
		}
	}
	if !found {
		t.Fatal("Python file is absent from the editable file list")
	}
	writeTestFile(t, filepath.Join(root, "binary.py"), []byte{0xff, 0xfe, 0, 0})
	if response := apiRequest(a, http.MethodGet, "/api/file?path=binary.py", nil, nil); response.Code < 400 {
		t.Fatal("binary bytes were accepted as program text")
	}
}
