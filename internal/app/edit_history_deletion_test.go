package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func recordHistoryForDeletionTest(t *testing.T, a *App, root, path, content string, now time.Time) historyEntry {
	t.Helper()
	entry, err := a.recordHistory(root, FileDocument{Path: path, Content: content, LineEnding: "lf"}, content, now, true)
	if err != nil {
		t.Fatal(err)
	}
	return entry
}

func deleteHistoryForTest(t *testing.T, a *App, path string, ids []string) historyDeletionResult {
	t.Helper()
	response := apiRequest(a, http.MethodDelete, "/api/history", map[string]any{"path": path, "ids": ids}, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("delete history: %d %s", response.Code, response.Body.String())
	}
	var result historyDeletionResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Deleted == nil || result.Entries == nil {
		t.Fatalf("history response should contain arrays: %s", response.Body.String())
	}
	return result
}

func TestDeleteEditHistoryRemovesSelectedVersionsAndReturnsCurrentList(t *testing.T) {
	a, root := testApp(t)
	original, err := os.ReadFile(filepath.Join(root, "main.tex"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Add(-10 * time.Minute)
	first := recordHistoryForDeletionTest(t, a, root, "main.tex", "最初の版", now)
	kept := recordHistoryForDeletionTest(t, a, root, "main.tex", "残す版", now.Add(time.Minute))
	third := recordHistoryForDeletionTest(t, a, root, "main.tex", "削除する版", now.Add(2*time.Minute))
	selected := []string{first.ID, third.ID}
	latest := recordHistoryForDeletionTest(t, a, root, "main.tex", "選択した後に作成した版", now.Add(3*time.Minute))
	directory, err := a.historyDirectory(root, "main.tex", false)
	if err != nil {
		t.Fatal(err)
	}
	keptFiles := map[string][]byte{}
	for _, suffix := range []string{".gz", ".json"} {
		data, err := os.ReadFile(filepath.Join(directory, kept.ID+suffix))
		if err != nil {
			t.Fatal(err)
		}
		keptFiles[suffix] = data
	}

	result := deleteHistoryForTest(t, a, "main.tex", selected)
	if !reflect.DeepEqual(result.Deleted, selected) {
		t.Fatalf("deleted IDs: got %#v, want %#v", result.Deleted, selected)
	}
	if len(result.Entries) != 2 || result.Entries[0].ID != latest.ID || result.Entries[1].ID != kept.ID {
		t.Fatalf("remaining versions: %#v", result.Entries)
	}
	if result.Settings != defaultHistorySettings() {
		t.Fatalf("history settings changed: %#v", result.Settings)
	}
	for _, id := range selected {
		for _, suffix := range []string{".gz", ".json"} {
			if _, err := os.Lstat(filepath.Join(directory, id+suffix)); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("selected record still exists: %s%s, %v", id, suffix, err)
			}
		}
	}
	for suffix, expected := range keptFiles {
		data, err := os.ReadFile(filepath.Join(directory, kept.ID+suffix))
		if err != nil || !bytes.Equal(data, expected) {
			t.Fatalf("unselected record changed: %s, %v", suffix, err)
		}
	}
	current, err := os.ReadFile(filepath.Join(root, "main.tex"))
	if err != nil || !bytes.Equal(current, original) {
		t.Fatalf("deleting history changed the document: %v", err)
	}
}

func TestDeleteEditHistoryHandlesExpiredIDsAndRepeatedRequests(t *testing.T) {
	a, root := testApp(t)
	old := recordHistoryForDeletionTest(t, a, root, "main.tex", "expired", time.Now().Add(-60*24*time.Hour))
	current := recordHistoryForDeletionTest(t, a, root, "main.tex", "selected", time.Now().Add(-time.Minute))
	ids := []string{old.ID, current.ID, current.ID}
	result := deleteHistoryForTest(t, a, "main.tex", ids)
	if !reflect.DeepEqual(result.Deleted, []string{current.ID}) || len(result.Entries) != 0 {
		t.Fatalf("deleting expired and repeated IDs: %#v", result)
	}
	result = deleteHistoryForTest(t, a, "main.tex", ids)
	if len(result.Deleted) != 0 || len(result.Entries) != 0 {
		t.Fatalf("repeated deletion: %#v", result)
	}
	result = deleteHistoryForTest(t, a, "unwritten.md", []string{current.ID})
	if len(result.Deleted) != 0 || len(result.Entries) != 0 {
		t.Fatalf("missing history: %#v", result)
	}
	if _, err := a.historyDirectory(root, "unwritten.md", false); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("deletion created a history directory: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "unwritten.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("deletion created a document: %v", err)
	}
}

func TestDeleteEditHistoryRetriesWhenOnlyOneRecordFileRemains(t *testing.T) {
	for _, missingSuffix := range []string{".gz", ".json"} {
		t.Run("missing "+missingSuffix, func(t *testing.T) {
			a, root := testApp(t)
			writeTestFile(t, filepath.Join(root, "other.tex"), []byte("another document"))
			now := time.Now().Add(-time.Minute)
			selected := recordHistoryForDeletionTest(t, a, root, "main.tex", "partly removed record", now)
			kept := recordHistoryForDeletionTest(t, a, root, "main.tex", "unselected record", now.Add(time.Second))
			other := recordHistoryForDeletionTest(t, a, root, "other.tex", "partly removed record", now)
			if other.ID != selected.ID {
				t.Fatal("the test requires identical IDs for different documents")
			}
			directory, err := a.historyDirectory(root, "main.tex", false)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(filepath.Join(directory, selected.ID+missingSuffix)); err != nil {
				t.Fatal(err)
			}
			entries, err := readHistoryEntries(directory)
			if err != nil || len(entries) != 1 || entries[0].ID != kept.ID {
				t.Fatalf("incomplete record should be absent from the ordinary list: %#v, %v", entries, err)
			}

			result := deleteHistoryForTest(t, a, "main.tex", []string{selected.ID})
			if !reflect.DeepEqual(result.Deleted, []string{selected.ID}) || len(result.Entries) != 1 || result.Entries[0].ID != kept.ID {
				t.Fatalf("retrying deletion: %#v", result)
			}
			for _, suffix := range []string{".gz", ".json"} {
				if _, err := os.Lstat(filepath.Join(directory, selected.ID+suffix)); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("retry left a record file: %s, %v", suffix, err)
				}
			}
			result = deleteHistoryForTest(t, a, "main.tex", []string{selected.ID})
			if len(result.Deleted) != 0 || len(result.Entries) != 1 || result.Entries[0].ID != kept.ID {
				t.Fatalf("repeating a completed deletion: %#v", result)
			}
			if entries := historyList(t, a, "other.tex"); len(entries) != 1 || entries[0].ID != other.ID {
				t.Fatalf("retry deleted another document's history: %#v", entries)
			}
		})
	}
}

func TestDeleteEditHistoryValidatesWholeSelectionBeforeRemovingRecords(t *testing.T) {
	a, root := testApp(t)
	entry := recordHistoryForDeletionTest(t, a, root, "main.tex", "keep this record", time.Now())
	tooMany := make([]string, historyMaxVersions+1)
	for index := range tooMany {
		tooMany[index] = entry.ID
	}
	for _, test := range []struct {
		name string
		ids  any
	}{
		{"missing selection", nil},
		{"empty selection", []string{}},
		{"invalid ID after a valid ID", []string{entry.ID, "../../outside"}},
		{"invalid ID before a valid ID", []string{"not-a-history-id", entry.ID}},
		{"too many IDs", tooMany},
		{"wrong value type", entry.ID},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := apiRequest(a, http.MethodDelete, "/api/history", map[string]any{"path": "main.tex", "ids": test.ids}, nil)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("invalid selection: %d %s", response.Code, response.Body.String())
			}
			entries := historyList(t, a, "main.tex")
			if len(entries) != 1 || entries[0].ID != entry.ID {
				t.Fatalf("invalid selection removed a record: %#v", entries)
			}
		})
	}
}

func TestDeleteEditHistoryStaysWithinCurrentProjectAndFile(t *testing.T) {
	a, root := testApp(t)
	writeTestFile(t, filepath.Join(root, "other.tex"), []byte("another document"))
	now := time.Now().Add(-time.Minute)
	entry := recordHistoryForDeletionTest(t, a, root, "main.tex", "same earlier text", now)
	otherFile := recordHistoryForDeletionTest(t, a, root, "other.tex", "same earlier text", now)
	second := filepath.Join(t.TempDir(), "second project")
	writeTestFile(t, filepath.Join(second, "main.tex"), []byte("another project"))
	opened := apiRequest(a, http.MethodPost, "/api/project/open", map[string]string{"path": second}, nil)
	if opened.Code != http.StatusOK {
		t.Fatalf("open another project: %s", opened.Body.String())
	}
	secondRoot := a.project.Root
	otherProject := recordHistoryForDeletionTest(t, a, secondRoot, "main.tex", "same earlier text", now)
	if entry.ID != otherFile.ID || entry.ID != otherProject.ID {
		t.Fatal("the test requires identical IDs stored for different files and projects")
	}
	response := apiRequest(a, http.MethodDelete, "/api/history", map[string]any{"path": "main.tex", "ids": []string{entry.ID}}, map[string]string{"X-Project-Root": url.PathEscape(root)})
	if response.Code != http.StatusConflict {
		t.Fatalf("stale project: %d %s", response.Code, response.Body.String())
	}
	if entries := historyList(t, a, "main.tex"); len(entries) != 1 || entries[0].ID != otherProject.ID {
		t.Fatalf("stale project header deleted the current project's version: %#v", entries)
	}
	result := deleteHistoryForTest(t, a, "main.tex", []string{entry.ID})
	if !reflect.DeepEqual(result.Deleted, []string{otherProject.ID}) {
		t.Fatalf("current project deletion: %#v", result)
	}
	opened = apiRequest(a, http.MethodPost, "/api/project/open", map[string]string{"path": root}, nil)
	if opened.Code != http.StatusOK {
		t.Fatalf("reopen original project: %s", opened.Body.String())
	}
	if entries := historyList(t, a, "main.tex"); len(entries) != 1 || entries[0].ID != entry.ID {
		t.Fatalf("another project's deletion affected this project: %#v", entries)
	}
	deleteHistoryForTest(t, a, "main.tex", []string{entry.ID})
	if entries := historyList(t, a, "other.tex"); len(entries) != 1 || entries[0].ID != otherFile.ID {
		t.Fatalf("deletion affected another file: %#v", entries)
	}
}

func TestDeleteEditHistoryWorksWhileRecordingIsDisabledAndTheFileIsMissing(t *testing.T) {
	a, root := testApp(t)
	entry := recordHistoryForDeletionTest(t, a, root, "main.tex", "saved earlier", time.Now())
	response := apiRequest(a, http.MethodPut, "/api/history/settings", map[string]any{"enabled": false, "days": 30, "maxBytes": 50 << 20}, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("disable recording: %s", response.Body.String())
	}
	if err := os.Remove(filepath.Join(root, "main.tex")); err != nil {
		t.Fatal(err)
	}
	result := deleteHistoryForTest(t, a, "main.tex", []string{entry.ID})
	if result.Settings.Enabled || !reflect.DeepEqual(result.Deleted, []string{entry.ID}) || len(result.Entries) != 0 {
		t.Fatalf("delete disabled history: %#v", result)
	}
	if _, err := os.Stat(filepath.Join(root, "main.tex")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("history deletion recreated the document: %v", err)
	}
}

func TestDeleteEditHistoryRejectsPathsOutsideTheProject(t *testing.T) {
	a, root := testApp(t)
	entry := recordHistoryForDeletionTest(t, a, root, "main.tex", "keep this record", time.Now())
	for _, path := range []string{"../main.tex", filepath.Join(t.TempDir(), "main.tex"), "", "image.png"} {
		response := apiRequest(a, http.MethodDelete, "/api/history", map[string]any{"path": path, "ids": []string{entry.ID}}, nil)
		if response.Code < 400 {
			t.Fatalf("invalid path %q: %d %s", path, response.Code, response.Body.String())
		}
	}
	if entries := historyList(t, a, "main.tex"); len(entries) != 1 || entries[0].ID != entry.ID {
		t.Fatalf("an invalid path deleted history: %#v", entries)
	}
}

func TestDeleteEditHistoryDoesNotTraverseLinkedStorage(t *testing.T) {
	for _, kind := range []string{"directory", "metadata", "compressed text"} {
		t.Run(kind, func(t *testing.T) {
			a, root := testApp(t)
			entry := recordHistoryForDeletionTest(t, a, root, "main.tex", "original record", time.Now())
			directory, err := a.historyDirectory(root, "main.tex", false)
			if err != nil {
				t.Fatal(err)
			}
			outside := filepath.Join(t.TempDir(), "outside")
			linkedPath := directory
			if kind == "metadata" {
				linkedPath = filepath.Join(directory, entry.ID+".json")
			} else if kind == "compressed text" {
				linkedPath = filepath.Join(directory, entry.ID+".gz")
			}
			if err := os.Rename(linkedPath, outside); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(outside, linkedPath); err != nil {
				t.Skipf("symlink unavailable: %v", err)
			}
			response := apiRequest(a, http.MethodDelete, "/api/history", map[string]any{"path": "main.tex", "ids": []string{entry.ID}}, nil)
			if response.Code < 400 {
				t.Fatalf("linked history storage accepted: %s", response.Body.String())
			}
			if _, err := os.Lstat(outside); err != nil {
				t.Fatalf("deletion affected the linked destination: %v", err)
			}
			if kind == "directory" {
				for _, suffix := range []string{".gz", ".json"} {
					if _, err := os.Stat(filepath.Join(outside, entry.ID+suffix)); err != nil {
						t.Fatalf("linked history record was removed: %v", err)
					}
				}
			} else {
				for _, suffix := range []string{".gz", ".json"} {
					if _, err := os.Lstat(filepath.Join(directory, entry.ID+suffix)); err != nil {
						t.Fatalf("a rejected request removed part of the record: %v", err)
					}
				}
			}
		})
	}
}

func TestDeleteEditHistoryLeavesOtherExpiredRecordsToNormalPruning(t *testing.T) {
	a, root := testApp(t)
	old := time.Now().Add(-40 * 24 * time.Hour)
	selected := recordHistoryForDeletionTest(t, a, root, "main.tex", "selected old record", old)
	other := recordHistoryForDeletionTest(t, a, root, "main.tex", "another old record", old.Add(time.Minute))
	result := deleteHistoryForTest(t, a, "main.tex", []string{selected.ID})
	if len(result.Entries) != 1 || result.Entries[0].ID != other.ID {
		t.Fatalf("deletion also pruned an unselected record: %#v", result)
	}
	if entries := historyList(t, a, "main.tex"); len(entries) != 0 {
		t.Fatalf("normal listing stopped pruning expired history: %#v", entries)
	}
}
