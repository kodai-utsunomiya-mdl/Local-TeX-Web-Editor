package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
)

func projectDeletionForTest(t *testing.T, a *App, root string) projectDeletion {
	t.Helper()
	response := apiRequest(a, http.MethodGet, "/api/project/delete?path="+url.QueryEscape(root), nil, nil)
	var result projectDeletion
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil {
		t.Fatalf("project deletion preview: %d %s", response.Code, response.Body.String())
	}
	return result
}

func projectDeletionTestDirectory(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func registerProjectDeletionTest(t *testing.T, a *App, root string) {
	t.Helper()
	a.mu.Lock()
	defer a.mu.Unlock()
	a.config.RecentProjects = append(a.config.RecentProjects, root)
	a.config.Projects[root] = projectSettings{Main: "main.tex", Mode: "pdflatex"}
	if err := a.saveConfig(a.config); err != nil {
		t.Fatal(err)
	}
}

func projectStorageForTest(t *testing.T, a *App, key string, value any) {
	t.Helper()
	response := apiRequest(a, http.MethodPut, "/api/storage", map[string]any{"key": key, "value": value}, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("project storage: %d %s", response.Code, response.Body.String())
	}
}

func TestProjectDeletionPreviewIncludesHiddenItemsAndNestedDrafts(t *testing.T) {
	a, root := testApp(t)
	writeTestFile(t, filepath.Join(root, ".git", "config"), []byte("git settings"))
	writeTestFile(t, filepath.Join(root, ".local-tex-editor", "build", "main.pdf"), []byte("PDF"))
	nested := filepath.Join(root, "appendix")
	writeTestFile(t, filepath.Join(nested, "notes.md"), []byte("notes"))
	registerProjectDeletionTest(t, a, nested)
	projectStorageForTest(t, a, "drafts:"+root, map[string]any{"version": 1, "entries": []map[string]string{{"id": "one", "path": "main.tex", "content": "unsaved", "baseRevision": "old"}}})
	projectStorageForTest(t, a, "drafts:"+nested, map[string]any{"version": 1, "entries": []map[string]string{{"id": "two", "path": "new.md", "content": "new draft", "baseRevision": ""}}})
	preview := projectDeletionForTest(t, a, root)
	if preview.Path != root || preview.Name != filepath.Base(root) || preview.FileCount != 4 || preview.DirectoryCount != 4 || preview.Size <= 0 || preview.Revision == "" {
		t.Fatalf("unexpected project preview: %#v", preview)
	}
	paths := []string{}
	for _, entry := range preview.Entries {
		paths = append(paths, entry.Path)
		if !entry.Directory && entry.ContentRevision == "" {
			t.Fatalf("file content is absent from the preview: %#v", entry)
		}
	}
	for _, expected := range []string{".git/config", ".local-tex-editor/build/main.pdf", "appendix/notes.md", "main.tex"} {
		found := false
		for _, path := range paths {
			found = found || path == expected
		}
		if !found {
			t.Fatalf("preview does not include %q: %#v", expected, paths)
		}
	}
	if strings.Join(preview.DraftPaths, ",") != "appendix/new.md,main.tex" {
		t.Fatalf("draft paths: %#v", preview.DraftPaths)
	}
	if a.project == nil || a.project.Root != root {
		t.Fatal("preview changed the current project")
	}
	if again := projectDeletionForTest(t, a, root); again.Revision != preview.Revision {
		t.Fatal("reading an unchanged preview changed its revision")
	}
}

func TestProjectDeletionRemovesCurrentFolderAndItsRegisteredState(t *testing.T) {
	a, root := testApp(t)
	nested := filepath.Join(root, "chapter")
	writeTestFile(t, filepath.Join(nested, "main.tex"), []byte("chapter"))
	registerProjectDeletionTest(t, a, nested)
	other := projectDeletionTestDirectory(t)
	registerProjectDeletionTest(t, a, other)
	for _, project := range []string{root, nested, other} {
		projectStorageForTest(t, a, "drafts:"+project, map[string]any{"entries": []any{}})
		projectStorageForTest(t, a, "session:"+project, map[string]any{"tabs": []string{"main.tex"}})
		writeTestFile(t, filepath.Join(a.projectCacheDirectory(project), "pdf-old.pdf"), []byte("cached PDF"))
	}
	projectStorageForTest(t, a, "preferences", map[string]string{"language": "ja"})
	a.lastPDF, a.lastPDFID, a.lastPDFMain = "old.pdf", "old", "main.tex"
	a.pdfVersions["old"] = "old.pdf"
	preview := projectDeletionForTest(t, a, root)
	response := apiRequest(a, http.MethodDelete, "/api/project/delete", map[string]string{
		"path": root, "revision": preview.Revision, "confirmation": preview.Name,
	}, nil)
	var result struct {
		Deleted         bool     `json:"deleted"`
		RemovedProjects []string `json:"removedProjects"`
		State           State    `json:"state"`
		Warning         string   `json:"warning"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || !result.Deleted || result.Warning != "" {
		t.Fatalf("delete project: %d %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(root); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("project folder still exists: %v", err)
	}
	if result.State.Project != nil || a.project != nil || a.build != nil || a.lastPDF != "" || a.lastPDFID != "" || a.lastPDFMain != "" || len(a.pdfVersions) != 0 {
		t.Fatalf("the deleted project is still selected: %#v", result.State)
	}
	expected := []string{root, nested}
	sort.Strings(expected)
	if strings.Join(result.RemovedProjects, "\n") != strings.Join(expected, "\n") {
		t.Fatalf("removed projects: %#v", result.RemovedProjects)
	}
	if len(a.config.RecentProjects) != 1 || a.config.RecentProjects[0] != other || len(a.config.Projects) != 1 {
		t.Fatalf("project settings were not removed: %#v", a.config)
	}
	var saved configuration
	data, err := os.ReadFile(filepath.Join(a.options.ConfigDir, "settings.json"))
	if err != nil || json.Unmarshal(data, &saved) != nil || len(saved.Projects) != 1 || len(saved.RecentProjects) != 1 || saved.RecentProjects[0] != other {
		t.Fatalf("saved project settings: %q %v", data, err)
	}
	for _, project := range []string{root, nested} {
		if _, err := os.Stat(a.projectCacheDirectory(project)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("deleted project's PDF cache remains: %v", err)
		}
		for _, prefix := range []string{"drafts:", "session:"} {
			path, _ := a.storagePath(prefix + project)
			if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("deleted project's UI record remains: %s: %v", prefix+project, err)
			}
		}
	}
	for _, key := range []string{"drafts:" + other, "session:" + other, "preferences"} {
		path, _ := a.storagePath(key)
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("unrelated UI record changed: %s: %v", key, err)
		}
	}
	if _, err := os.Stat(filepath.Join(a.projectCacheDirectory(other), "pdf-old.pdf")); err != nil {
		t.Fatalf("another project's PDF cache changed: %v", err)
	}
}

func TestDeletingRecentProjectLeavesCurrentProjectAndBuildOpen(t *testing.T) {
	a, current := testApp(t)
	other := projectDeletionTestDirectory(t)
	writeTestFile(t, filepath.Join(other, "main.tex"), []byte("other manuscript"))
	registerProjectDeletionTest(t, a, other)
	build := &buildRun{result: Build{Status: "success", Main: "main.tex"}}
	a.build = build
	project := a.project
	preview := projectDeletionForTest(t, a, other)
	response := apiRequest(a, http.MethodDelete, "/api/project/delete", map[string]string{
		"path": other, "revision": preview.Revision, "confirmation": preview.Name,
	}, nil)
	if response.Code != http.StatusOK || a.project != project || a.project.Root != current || a.build != build {
		t.Fatalf("deleting another project changed the current one: %d %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(filepath.Join(current, "main.tex")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(other); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("recent project still exists: %v", err)
	}
}

func TestProjectDeletionRequiresRegistrationNameAndRevision(t *testing.T) {
	a, root := testApp(t)
	other := projectDeletionTestDirectory(t)
	writeTestFile(t, filepath.Join(other, "keep.txt"), []byte("keep"))
	for _, method := range []string{http.MethodGet, http.MethodDelete} {
		path := "/api/project/delete"
		var body any = map[string]string{"path": other, "revision": "unconfirmed", "confirmation": filepath.Base(other)}
		if method == http.MethodGet {
			path += "?path=" + url.QueryEscape(other)
			body = nil
		}
		response := apiRequest(a, method, path, body, nil)
		if response.Code != http.StatusForbidden {
			t.Fatalf("unregistered project %s: %d %s", method, response.Code, response.Body.String())
		}
	}
	preview := projectDeletionForTest(t, a, root)
	for _, confirmation := range []string{"", preview.Name + " "} {
		response := apiRequest(a, http.MethodDelete, "/api/project/delete", map[string]string{"path": root, "revision": preview.Revision, "confirmation": confirmation}, nil)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("wrong confirmation: %d %s", response.Code, response.Body.String())
		}
	}
	response := apiRequest(a, http.MethodDelete, "/api/project/delete", map[string]string{"path": root, "confirmation": preview.Name}, nil)
	var conflict struct {
		Project projectDeletion `json:"project"`
	}
	if response.Code != http.StatusConflict || json.Unmarshal(response.Body.Bytes(), &conflict) != nil || conflict.Project.Revision != preview.Revision {
		t.Fatalf("missing revision: %d %s", response.Code, response.Body.String())
	}
	for _, path := range []string{filepath.Join(root, "main.tex"), filepath.Join(other, "keep.txt")} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("confirmation failure changed a file: %v", err)
		}
	}
}

func TestProjectDeletionDetectsContentChangesEvenWithTheSameSizeAndDate(t *testing.T) {
	a, root := testApp(t)
	path := filepath.Join(root, "notes.txt")
	writeTestFile(t, path, []byte("before"))
	info, _ := os.Stat(path)
	preview := projectDeletionForTest(t, a, root)
	writeTestFile(t, path, []byte("after!"))
	if err := os.Chtimes(path, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	response := apiRequest(a, http.MethodDelete, "/api/project/delete", map[string]string{"path": root, "revision": preview.Revision, "confirmation": preview.Name}, nil)
	var conflict struct {
		Project projectDeletion `json:"project"`
	}
	if response.Code != http.StatusConflict || json.Unmarshal(response.Body.Bytes(), &conflict) != nil || conflict.Project.Revision == preview.Revision || conflict.Project.Path != root {
		t.Fatalf("changed content: %d %s", response.Code, response.Body.String())
	}
	if content, err := os.ReadFile(path); err != nil || !bytes.Equal(content, []byte("after!")) {
		t.Fatalf("changed content was removed: %q %v", content, err)
	}
	if _, err := os.Stat(filepath.Join(root, "main.tex")); err != nil {
		t.Fatal("a conflict removed another file")
	}
}

func TestProjectDeletionReturnsNewFilesAndDraftsForConfirmation(t *testing.T) {
	for _, kind := range []string{"file", "draft"} {
		t.Run(kind, func(t *testing.T) {
			a, root := testApp(t)
			preview := projectDeletionForTest(t, a, root)
			if kind == "file" {
				writeTestFile(t, filepath.Join(root, "new.txt"), []byte("new content"))
			} else {
				projectStorageForTest(t, a, "drafts:"+root, map[string]any{"entries": []map[string]string{{"path": "unsaved.md", "content": "new draft"}}})
			}
			response := apiRequest(a, http.MethodDelete, "/api/project/delete", map[string]string{"path": root, "revision": preview.Revision, "confirmation": preview.Name}, nil)
			var conflict struct {
				Project projectDeletion `json:"project"`
			}
			if response.Code != http.StatusConflict || json.Unmarshal(response.Body.Bytes(), &conflict) != nil || conflict.Project.Revision == preview.Revision {
				t.Fatalf("new item: %d %s", response.Code, response.Body.String())
			}
			if kind == "file" && conflict.Project.FileCount != preview.FileCount+1 {
				t.Fatalf("new file is absent from the confirmation: %#v", conflict.Project)
			}
			if kind == "draft" && strings.Join(conflict.Project.DraftPaths, ",") != "unsaved.md" {
				t.Fatalf("new draft is absent from the confirmation: %#v", conflict.Project)
			}
			if _, err := os.Stat(filepath.Join(root, "main.tex")); err != nil {
				t.Fatal("the project changed before the new confirmation")
			}
		})
	}
}

func TestProjectDeletionRevisionIncludesDraftContent(t *testing.T) {
	a, root := testApp(t)
	projectStorageForTest(t, a, "drafts:"+root, map[string]any{"entries": []map[string]string{{"path": "main.tex", "content": "first draft"}}})
	first := projectDeletionForTest(t, a, root)
	projectStorageForTest(t, a, "drafts:"+root, map[string]any{"entries": []map[string]string{{"path": "main.tex", "content": "second draft"}}})
	second := projectDeletionForTest(t, a, root)
	if first.Revision == second.Revision || strings.Join(first.DraftPaths, ",") != strings.Join(second.DraftPaths, ",") {
		t.Fatal("draft contents did not change the revision")
	}
}

func TestProjectDeletionRejectsSpecialFolders(t *testing.T) {
	a, _ := testApp(t)
	home := t.TempDir()
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", home)
	} else {
		t.Setenv("HOME", home)
	}
	volumeRoot := filepath.VolumeName(a.options.ConfigDir) + string(filepath.Separator)
	for _, root := range []string{volumeRoot, home, a.options.ConfigDir, filepath.Dir(a.options.ConfigDir)} {
		registerProjectDeletionTest(t, a, root)
		for _, method := range []string{http.MethodGet, http.MethodDelete} {
			path := "/api/project/delete"
			var body any = map[string]string{"path": root, "revision": "none", "confirmation": filepath.Base(root)}
			if method == http.MethodGet {
				path += "?path=" + url.QueryEscape(root)
				body = nil
			}
			response := apiRequest(a, method, path, body, nil)
			if response.Code != http.StatusForbidden {
				t.Fatalf("special folder %q %s: %d %s", root, method, response.Code, response.Body.String())
			}
		}
	}
	if _, err := os.Stat(filepath.Join(a.options.ConfigDir, "settings.json")); err != nil {
		t.Fatal("the app settings changed")
	}
}

func TestProjectDeletionRejectsFoldersOverlappingAnotherOpenProject(t *testing.T) {
	a, root := testApp(t)
	child := filepath.Join(root, "child")
	if err := os.Mkdir(child, 0700); err != nil {
		t.Fatal(err)
	}
	for _, other := range []string{child, filepath.Dir(root)} {
		registerProjectDeletionTest(t, a, other)
		response := apiRequest(a, http.MethodGet, "/api/project/delete?path="+url.QueryEscape(other), nil, nil)
		if response.Code != http.StatusConflict {
			t.Fatalf("overlapping project: %d %s", response.Code, response.Body.String())
		}
	}
}

func TestProjectDeletionRejectsLinksAtTheRootAndInsideTheProject(t *testing.T) {
	a, root := testApp(t)
	outside := t.TempDir()
	writeTestFile(t, filepath.Join(outside, "keep.txt"), []byte("outside"))
	link := filepath.Join(t.TempDir(), "linked-project")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink creation is unavailable: %v", err)
	}
	registerProjectDeletionTest(t, a, link)
	response := apiRequest(a, http.MethodGet, "/api/project/delete?path="+url.QueryEscape(link), nil, nil)
	if response.Code != http.StatusForbidden {
		t.Fatalf("linked root: %d %s", response.Code, response.Body.String())
	}
	if err := os.Symlink(outside, filepath.Join(root, "linked-child")); err != nil {
		t.Fatal(err)
	}
	response = apiRequest(a, http.MethodGet, "/api/project/delete?path="+url.QueryEscape(root), nil, nil)
	if response.Code != http.StatusForbidden {
		t.Fatalf("linked child: %d %s", response.Code, response.Body.String())
	}
	if content, err := os.ReadFile(filepath.Join(outside, "keep.txt")); err != nil || string(content) != "outside" {
		t.Fatalf("a linked folder changed: %q %v", content, err)
	}
}

func TestProjectDeletionRejectsLinksAddedAfterConfirmation(t *testing.T) {
	for _, location := range []string{"root", "child"} {
		t.Run(location, func(t *testing.T) {
			a, root := testApp(t)
			preview := projectDeletionForTest(t, a, root)
			outside := projectDeletionTestDirectory(t)
			writeTestFile(t, filepath.Join(outside, "keep.txt"), []byte("outside"))
			link, original := filepath.Join(root, "linked-child"), root
			if location == "root" {
				original = filepath.Join(projectDeletionTestDirectory(t), "moved")
				if err := os.Rename(root, original); err != nil {
					t.Fatal(err)
				}
				link = root
			}
			if err := os.Symlink(outside, link); err != nil {
				t.Skipf("symlink creation is unavailable: %v", err)
			}
			response := apiRequest(a, http.MethodDelete, "/api/project/delete", map[string]string{"path": root, "revision": preview.Revision, "confirmation": preview.Name}, nil)
			if response.Code != http.StatusForbidden {
				t.Fatalf("link added after confirmation: %d %s", response.Code, response.Body.String())
			}
			if content, err := os.ReadFile(filepath.Join(outside, "keep.txt")); err != nil || string(content) != "outside" {
				t.Fatalf("an outside file changed: %q %v", content, err)
			}
			if _, err := os.Stat(filepath.Join(original, "main.tex")); err != nil {
				t.Fatal("the original manuscript was removed")
			}
		})
	}
}

func TestProjectDeletionWaitsForCompilation(t *testing.T) {
	a, root := testApp(t)
	preview := projectDeletionForTest(t, a, root)
	a.build = &buildRun{result: Build{Status: "running"}}
	defer func() { a.build = nil }()
	response := apiRequest(a, http.MethodDelete, "/api/project/delete", map[string]string{"path": root, "revision": preview.Revision, "confirmation": preview.Name}, nil)
	if response.Code != http.StatusConflict {
		t.Fatalf("project removed during compilation: %d %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "main.tex")); err != nil {
		t.Fatal(err)
	}
}

func TestProjectDeletionSupportsAnEmptyFolderAndLegacyDrafts(t *testing.T) {
	a, root := testApp(t)
	if err := os.Remove(filepath.Join(root, "main.tex")); err != nil {
		t.Fatal(err)
	}
	projectStorageForTest(t, a, "drafts:"+root, map[string]any{"old.tex": map[string]string{"content": "old draft", "revision": "old"}})
	preview := projectDeletionForTest(t, a, root)
	if preview.FileCount != 0 || preview.DirectoryCount != 0 || len(preview.Entries) != 0 || strings.Join(preview.DraftPaths, ",") != "old.tex" {
		t.Fatalf("empty folder preview: %#v", preview)
	}
	response := apiRequest(a, http.MethodDelete, "/api/project/delete", map[string]string{"path": root, "revision": preview.Revision, "confirmation": preview.Name}, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("empty project: %d %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(root); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("empty project folder remains: %v", err)
	}
}
