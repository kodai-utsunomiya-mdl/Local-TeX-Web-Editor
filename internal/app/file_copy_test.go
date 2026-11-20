package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func assertNoEntryCopyFiles(t *testing.T, root string) {
	t.Helper()
	err := filepath.WalkDir(root, func(path string, item os.DirEntry, err error) error {
		if err == nil && strings.HasPrefix(item.Name(), ".local-tex-editor-copy-") {
			t.Errorf("temporary copy remains: %s", path)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}

func inspectedCopyEntryForTest(t *testing.T, root, path string) projectEntry {
	t.Helper()
	entry, err := inspectProjectEntry(context.Background(), root, path)
	if err != nil {
		t.Fatal(err)
	}
	return entry
}

func TestEntryCopyFilesPreserveBytesAndLeaveTheSource(t *testing.T) {
	a, root := testApp(t)
	if err := os.Mkdir(filepath.Join(root, "copies"), 0755); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name string
		data []byte
	}{
		{"図 1.png", testImagePNG(t)},
		{"binary.bin", []byte{0, 1, 2, 255}},
		{"notes.md", []byte("\xef\xbb\xbf# 日本語\r\n原稿\r\n")},
		{"empty.tex", []byte{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			writeTestFile(t, filepath.Join(root, test.name), test.data)
			entry := entryForTest(t, a, test.name)
			destination := "copies/" + test.name
			response := apiRequest(a, http.MethodPost, "/api/entry", map[string]string{
				"action": "copy", "path": test.name, "newPath": destination, "revision": entry.Revision,
			}, map[string]string{"X-Project-Root": url.PathEscape(root)})
			var result struct {
				Copied    bool   `json:"copied"`
				Path      string `json:"path"`
				Directory bool   `json:"directory"`
				OldPath   string `json:"oldPath"`
				State     State  `json:"state"`
			}
			if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &result) != nil || !result.Copied || result.Path != destination || result.Directory || result.OldPath != "" {
				t.Fatalf("copy %s: %d %s", test.name, response.Code, response.Body.String())
			}
			for _, name := range []string{test.name, destination} {
				actual, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(name)))
				if err != nil || !bytes.Equal(actual, test.data) || !hasFile(result.State.Project.Files, name) {
					t.Fatalf("file bytes or list differ for %s: %q %v", name, actual, err)
				}
			}
			original, _ := os.Stat(filepath.Join(root, test.name))
			copied, _ := os.Stat(filepath.Join(root, filepath.FromSlash(destination)))
			if os.SameFile(original, copied) {
				t.Fatal("the copy shares the original file")
			}
			if after := entryForTest(t, a, test.name); after.Revision != entry.Revision {
				t.Fatal("copying changed the source")
			}
		})
	}
	assertNoEntryCopyFiles(t, root)
}

func TestEntryCopyFolderIncludesNestedHiddenAndEmptyItems(t *testing.T) {
	a, root := testApp(t)
	files := map[string][]byte{
		"chapters/本文.tex":      []byte("日本語の原稿\n"),
		"chapters/figures/a.png": testImagePNG(t),
		"chapters/.git/config":  []byte("hidden settings\n"),
		"chapters/.hidden.bin":  {0, 255, 3},
	}
	for path, data := range files {
		writeTestFile(t, filepath.Join(root, filepath.FromSlash(path)), data)
	}
	for _, path := range []string{"chapters/nested/empty", "copies", "empty"} {
		if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(path)), 0755); err != nil {
			t.Fatal(err)
		}
	}
	for _, source := range []string{"chapters", "empty"} {
		entry := entryForTest(t, a, source)
		destination := "copies/" + source
		response := apiRequest(a, http.MethodPost, "/api/entry", map[string]string{
			"action": "copy", "path": source, "newPath": destination, "revision": entry.Revision,
		}, nil)
		var result struct {
			Copied    bool   `json:"copied"`
			Directory bool   `json:"directory"`
			State     State  `json:"state"`
		}
		if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &result) != nil || !result.Copied || !result.Directory {
			t.Fatalf("copy folder: %d %s", response.Code, response.Body.String())
		}
		if after := entryForTest(t, a, source); after.Revision != entry.Revision {
			t.Fatal("copying a folder changed its contents")
		}
		found := false
		for _, directory := range result.State.Project.Directories {
			found = found || directory == destination
		}
		if !found {
			t.Fatalf("the copied folder is absent from the file list: %#v", result.State.Project.Directories)
		}
	}
	for path, expected := range files {
		actual, err := os.ReadFile(filepath.Join(root, "copies", filepath.FromSlash(path)))
		if err != nil || !bytes.Equal(actual, expected) {
			t.Fatalf("folder content differs for %s: %q %v", path, actual, err)
		}
	}
	for _, path := range []string{"copies/chapters/nested/empty", "copies/empty"} {
		items, err := os.ReadDir(filepath.Join(root, filepath.FromSlash(path)))
		if err != nil || len(items) != 0 {
			t.Fatalf("empty folder was not copied: %s %v", path, err)
		}
	}
	assertNoEntryCopyFiles(t, root)
}

func TestEntryCopyUsesSavedContentAndLeavesMainHistoryAndDrafts(t *testing.T) {
	a, root := testApp(t)
	document, err := readDocument(root, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.recordHistory(root, document, "before copy", time.Now(), true); err != nil {
		t.Fatal(err)
	}
	key := "drafts:" + root
	projectStorageForTest(t, a, key, map[string]any{"entries": []map[string]string{{"path": "main.tex", "content": "unsaved text", "baseRevision": document.Revision}}})
	storage, err := a.storagePath(key)
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(storage)
	if err != nil {
		t.Fatal(err)
	}
	entry := entryForTest(t, a, "main.tex")
	response := apiRequest(a, http.MethodPost, "/api/entry", map[string]string{
		"action": "copy", "path": "main.tex", "newPath": "main-copy.tex", "revision": entry.Revision,
	}, nil)
	if response.Code != http.StatusCreated {
		t.Fatalf("copy main: %d %s", response.Code, response.Body.String())
	}
	if a.project.Main != "main.tex" || a.config.Projects[root].Main != "main.tex" {
		t.Fatal("copying changed the main document")
	}
	copied, err := readDocument(root, "main-copy.tex")
	if err != nil || copied.Content != document.Content || copied.Revision != document.Revision {
		t.Fatalf("the copy differs from the saved document: %#v %v", copied, err)
	}
	after, err := os.ReadFile(storage)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("copying changed the drafts: %v", err)
	}
	if original, copied := historyList(t, a, "main.tex"), historyList(t, a, "main-copy.tex"); len(original) != 1 || original[0].Label != "before copy" || len(copied) != 0 {
		t.Fatalf("history moved or was copied: original=%#v copied=%#v", original, copied)
	}
}

func TestEntryCopyRequiresTheCurrentRevision(t *testing.T) {
	for _, folder := range []bool{false, true} {
		t.Run(map[bool]string{false: "file", true: "folder"}[folder], func(t *testing.T) {
			a, root := testApp(t)
			path := "draft.md"
			if folder {
				path = "chapter/draft.md"
			}
			file := filepath.Join(root, filepath.FromSlash(path))
			writeTestFile(t, file, []byte("first"))
			source := path
			if folder {
				source = "chapter"
			}
			entry := entryForTest(t, a, source)
			info, _ := os.Stat(file)
			writeTestFile(t, file, []byte("other"))
			if err := os.Chtimes(file, info.ModTime(), info.ModTime()); err != nil {
				t.Fatal(err)
			}
			for _, expected := range []string{"", entry.Revision} {
				response := apiRequest(a, http.MethodPost, "/api/entry", map[string]string{
					"action": "copy", "path": source, "newPath": "copy", "revision": expected,
				}, nil)
				var conflict struct {
					ReviewRequired bool         `json:"reviewRequired"`
					Entry          projectEntry `json:"entry"`
				}
				if response.Code != http.StatusConflict || json.Unmarshal(response.Body.Bytes(), &conflict) != nil || !conflict.ReviewRequired || conflict.Entry.Revision == entry.Revision || conflict.Entry.Path != source {
					t.Fatalf("changed source did not require confirmation: %d %s", response.Code, response.Body.String())
				}
			}
			if _, err := os.Stat(filepath.Join(root, "copy")); !os.IsNotExist(err) {
				t.Fatal("an unconfirmed source was copied")
			}
			current := entryForTest(t, a, source)
			response := apiRequest(a, http.MethodPost, "/api/entry", map[string]string{
				"action": "copy", "path": source, "newPath": "copy", "revision": current.Revision,
			}, nil)
			if response.Code != http.StatusCreated {
				t.Fatalf("copy after confirmation: %d %s", response.Code, response.Body.String())
			}
		})
	}
}

type entryCopyContext struct {
	context.Context
	check func() error
}

func (c entryCopyContext) Err() error {
	if err := c.check(); err != nil {
		return err
	}
	return c.Context.Err()
}

func TestEntryCopyStopsIfSourceChangesOrRequestIsCancelled(t *testing.T) {
	for _, change := range []string{"content", "new child", "cancel"} {
		t.Run(change, func(t *testing.T) {
			_, root := testApp(t)
			original := bytes.Repeat([]byte("a"), 192*1024)
			source := filepath.Join(root, "folder", "large.bin")
			writeTestFile(t, source, original)
			entry := inspectedCopyEntryForTest(t, root, "folder")
			info, _ := os.Stat(source)
			changed := false
			ctx := entryCopyContext{Context: context.Background(), check: func() error {
				if changed {
					if change == "cancel" {
						return context.Canceled
					}
					return nil
				}
				matches, _ := filepath.Glob(filepath.Join(root, ".local-tex-editor-copy-*", "item", "large.bin"))
				if len(matches) == 0 {
					return nil
				}
				written, _ := os.Stat(matches[0])
				if written == nil || written.Size() == 0 {
					return nil
				}
				changed = true
				switch change {
				case "content":
					writeTestFile(t, source, bytes.Repeat([]byte("b"), len(original)))
					if err := os.Chtimes(source, info.ModTime(), info.ModTime()); err != nil {
						t.Fatal(err)
					}
				case "new child":
					writeTestFile(t, filepath.Join(root, "folder", "new.md"), []byte("added while copying"))
				case "cancel":
					return context.Canceled
				}
				return nil
			}}
			_, err := copyInspectedEntry(ctx, root, entry, "folder-copy")
			if err == nil || !changed {
				t.Fatalf("an unfinished copy succeeded: changed=%t error=%v", changed, err)
			}
			var known *apiError
			if change == "cancel" {
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("cancellation returned %v", err)
				}
			} else if !errors.As(err, &known) || known.status != http.StatusConflict {
				t.Fatalf("source changes returned %v", err)
			}
			if _, err := os.Stat(filepath.Join(root, "folder-copy")); !os.IsNotExist(err) {
				t.Fatal("a partial destination remains")
			}
			if _, err := os.Stat(source); err != nil {
				t.Fatalf("the source disappeared: %v", err)
			}
			assertNoEntryCopyFiles(t, root)
		})
	}
}

func TestEntryCopyDoesNotReplaceAnExistingDestination(t *testing.T) {
	for _, duringCopy := range []bool{false, true} {
		for _, directory := range []bool{false, true} {
			t.Run(map[bool]string{false: "before", true: "during"}[duringCopy]+map[bool]string{false: "/file", true: "/folder"}[directory], func(t *testing.T) {
				_, root := testApp(t)
				entry := inspectedCopyEntryForTest(t, root, "main.tex")
				destination := filepath.Join(root, "existing")
				create := func() {
					if directory {
						if err := os.Mkdir(destination, 0755); err != nil {
							t.Fatal(err)
						}
						writeTestFile(t, filepath.Join(destination, "keep.md"), []byte("keep this"))
					} else {
						writeTestFile(t, destination, []byte("keep this"))
					}
				}
				created := !duringCopy
				if created {
					create()
				}
				ctx := entryCopyContext{Context: context.Background(), check: func() error {
					matches, _ := filepath.Glob(filepath.Join(root, ".local-tex-editor-copy-*"))
					if !created && len(matches) > 0 {
						create()
						created = true
					}
					return nil
				}}
				_, err := copyInspectedEntry(ctx, root, entry, "existing")
				var known *apiError
				if !errors.As(err, &known) || known.status != http.StatusConflict || !created {
					t.Fatalf("existing destination: %v", err)
				}
				if directory {
					destination = filepath.Join(destination, "keep.md")
				}
				data, err := os.ReadFile(destination)
				if err != nil || string(data) != "keep this" {
					t.Fatalf("an existing item was changed: %q %v", data, err)
				}
				assertNoEntryCopyFiles(t, root)
			})
		}
	}
}

func TestEntryCopyRejectsInvalidPathsAndItsOwnDescendants(t *testing.T) {
	a, root := testApp(t)
	writeTestFile(t, filepath.Join(root, "folder", "nested", "body.tex"), []byte("body"))
	entry := entryForTest(t, a, "folder")
	for _, path := range []string{"", ".", "..", "../outside", "/outside", "C:/outside", "folder/../outside", ".git/copy", "CON", "trailing.", "missing/copy", "folder/new", "folder/nested/new", "folder"} {
		response := apiRequest(a, http.MethodPost, "/api/entry", map[string]string{
			"action": "copy", "path": entry.Path, "newPath": path, "revision": entry.Revision,
		}, nil)
		if response.Code < 400 {
			t.Fatalf("accepted destination %q: %s", path, response.Body.String())
		}
	}
	original, _ := os.Stat(filepath.Join(root, "folder"))
	if alias, err := os.Stat(filepath.Join(root, "FOLDER")); err == nil && os.SameFile(original, alias) {
		response := apiRequest(a, http.MethodPost, "/api/entry", map[string]string{
			"action": "copy", "path": entry.Path, "newPath": "FOLDER/nested/copy", "revision": entry.Revision,
		}, nil)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("accepted a child with different letter case: %d %s", response.Code, response.Body.String())
		}
	}
	if after := entryForTest(t, a, "folder"); after.Revision != entry.Revision {
		t.Fatal("an invalid destination changed the source folder")
	}
	assertNoEntryCopyFiles(t, root)
}

func TestEntryCopyRejectsLinksAndProjectChanges(t *testing.T) {
	a, root := testApp(t)
	entry := entryForTest(t, a, "main.tex")
	input := map[string]string{"action": "copy", "path": "main.tex", "newPath": "copy.tex", "revision": entry.Revision}
	response := apiRequest(a, http.MethodPost, "/api/entry", input, map[string]string{"X-Project-Root": url.PathEscape(root + "-other")})
	if response.Code != http.StatusConflict {
		t.Fatalf("wrong project: %d %s", response.Code, response.Body.String())
	}
	a.build = &buildRun{result: Build{Status: "running"}}
	response = apiRequest(a, http.MethodPost, "/api/entry", input, nil)
	a.build = nil
	if response.Code != http.StatusConflict {
		t.Fatalf("copied during compilation: %d %s", response.Code, response.Body.String())
	}
	outside := t.TempDir()
	writeTestFile(t, filepath.Join(outside, "outside.tex"), []byte("outside"))
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Skipf("links unavailable: %v", err)
	}
	for _, paths := range [][2]string{{"main.tex", "linked/copy.tex"}, {"linked/outside.tex", "copy.tex"}} {
		input["path"], input["newPath"] = paths[0], paths[1]
		response := apiRequest(a, http.MethodPost, "/api/entry", input, nil)
		if response.Code != http.StatusForbidden {
			t.Fatalf("accepted a link: %d %s", response.Code, response.Body.String())
		}
	}
	writeTestFile(t, filepath.Join(root, "folder", "body.tex"), []byte("body"))
	folder := entryForTest(t, a, "folder")
	if err := os.Symlink(outside, filepath.Join(root, "folder", "linked")); err != nil {
		t.Fatal(err)
	}
	response = apiRequest(a, http.MethodPost, "/api/entry", map[string]string{
		"action": "copy", "path": "folder", "newPath": "folder-copy", "revision": folder.Revision,
	}, nil)
	if response.Code != http.StatusForbidden {
		t.Fatalf("accepted a link inside a folder: %d %s", response.Code, response.Body.String())
	}
	for _, path := range []string{filepath.Join(root, "copy.tex"), filepath.Join(root, "folder-copy"), filepath.Join(outside, "copy.tex")} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("an invalid copy changed %s: %v", path, err)
		}
	}
	assertNoEntryCopyFiles(t, root)
}

func TestEntryCopyRejectsUnknownPostActions(t *testing.T) {
	a, root := testApp(t)
	response := apiRequest(a, http.MethodPost, "/api/entry", map[string]string{"action": "unknown", "path": "unexpected"}, nil)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unknown action: %d %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "unexpected")); !os.IsNotExist(err) {
		t.Fatal("an unknown action created a folder")
	}
	response = apiRequest(a, http.MethodPost, "/api/entry", map[string]string{"path": "new-folder"}, nil)
	if response.Code != http.StatusCreated {
		t.Fatalf("folder creation changed: %d %s", response.Code, response.Body.String())
	}
}

func TestEntryCopyChecksCreatedDirectoriesBeforeWritingChildren(t *testing.T) {
	for _, child := range []string{"", "item"} {
		t.Run(map[string]string{"": "temporary folder", "item": "copied folder"}[child], func(t *testing.T) {
			_, root := testApp(t)
			outside := t.TempDir()
			probe := filepath.Join(root, "link-check")
			if err := os.Symlink(outside, probe); err != nil {
				t.Skipf("links unavailable: %v", err)
			}
			if err := os.Remove(probe); err != nil {
				t.Fatal(err)
			}
			writeTestFile(t, filepath.Join(root, "folder", "nested", "body.md"), []byte("source text"))
			entry := inspectedCopyEntryForTest(t, root, "folder")
			changed := false
			link, moved := "", ""
			ctx := entryCopyContext{Context: context.Background(), check: func() error {
				if changed {
					return nil
				}
				matches, _ := filepath.Glob(filepath.Join(root, ".local-tex-editor-copy-*"))
				if len(matches) == 0 {
					return nil
				}
				candidate := matches[0]
				if child != "" {
					candidate = filepath.Join(candidate, child)
				}
				if _, err := os.Stat(candidate); os.IsNotExist(err) {
					return nil
				}
				link, moved = candidate, candidate+"-moved"
				if err := os.Rename(link, moved); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, link); err != nil {
					t.Fatal(err)
				}
				changed = true
				return nil
			}}
			_, err := copyInspectedEntry(ctx, root, entry, "folder-copy")
			var known *apiError
			if !changed || !errors.As(err, &known) || known.status != http.StatusForbidden {
				t.Fatalf("the changed directory was accepted: %v", err)
			}
			items, err := os.ReadDir(outside)
			if err != nil || len(items) != 0 {
				t.Fatalf("copy wrote through a link: %v, %v", items, err)
			}
			if _, err := os.Stat(filepath.Join(root, "folder-copy")); !os.IsNotExist(err) {
				t.Fatal("a destination was created after its working directory changed")
			}
			if err := os.Remove(link); err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(moved); err != nil {
				t.Fatal(err)
			}
		})
	}
}
