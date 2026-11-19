package app

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func historyList(t *testing.T, a *App, path string) []historyEntry {
	t.Helper()
	response := apiRequest(a, http.MethodGet, "/api/history?path="+url.QueryEscape(path), nil, nil)
	if response.Code != http.StatusOK { t.Fatalf("history: %d %s", response.Code, response.Body.String()) }
	var result struct { Entries []historyEntry `json:"entries"` }
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil { t.Fatal(err) }
	return result.Entries
}

func TestEditHistoryRecordsPreviousTextWithoutRecordingEveryAutosave(t *testing.T) {
	a, root := testApp(t)
	document, err := readDocument(root, "main.tex"); if err != nil { t.Fatal(err) }
	original := document.Content
	for index := 0; index < 3; index++ {
		document.Content += "new line\n"
		response := apiRequest(a, http.MethodPut, "/api/file", document, nil)
		if response.Code != http.StatusOK { t.Fatalf("save: %s", response.Body.String()) }
		if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil { t.Fatal(err) }
	}
	entries := historyList(t, a, "main.tex")
	if len(entries) != 1 { t.Fatalf("autosaves recorded %d versions", len(entries)) }
	response := apiRequest(a, http.MethodGet, "/api/history?path=main.tex&id="+entries[0].ID, nil, nil)
	var version struct { Content string `json:"content"` }
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &version) != nil || version.Content != original { t.Fatalf("earlier text: %s", response.Body.String()) }
}

func TestEditHistoryCanNameCurrentTextAndTurnOffNewRecords(t *testing.T) {
	a, root := testApp(t)
	document, _ := readDocument(root, "main.tex")
	response := apiRequest(a, http.MethodPost, "/api/history", map[string]string{"path": document.Path, "content": "unsaved working text😀\n", "revision": document.Revision, "label": "投稿前"}, nil)
	if response.Code != http.StatusCreated { t.Fatalf("name version: %s", response.Body.String()) }
	entries := historyList(t, a, "main.tex")
	if len(entries) != 1 || entries[0].Label != "投稿前" { t.Fatalf("named version: %#v", entries) }
	response = apiRequest(a, http.MethodPut, "/api/history/settings", map[string]any{"enabled": false, "days": 30, "maxBytes": 50 << 20}, nil)
	if response.Code != http.StatusOK { t.Fatalf("settings: %s", response.Body.String()) }
	document.Content = "changed after disabling history\n"
	response = apiRequest(a, http.MethodPut, "/api/file", document, nil)
	if response.Code != http.StatusOK { t.Fatalf("save: %s", response.Body.String()) }
	if len(historyList(t, a, "main.tex")) != 1 { t.Fatal("history recorded a new version while disabled") }
}

func TestEditHistoryEnforcesVersionAgeAndStorageLimits(t *testing.T) {
	a, root := testApp(t)
	start := time.Now().Add(-3 * time.Hour)
	for index := 0; index < historyMaxVersions+5; index++ {
		document := FileDocument{Path: "main.tex", Content: strings.Repeat(string(rune('a'+index%20)), 500) + time.Duration(index).String()}
		if _, err := a.recordHistory(root, document, "", start.Add(time.Duration(index)*time.Minute), true); err != nil { t.Fatal(err) }
	}
	directory, _ := a.historyDirectory(root, "main.tex", false)
	entries, err := readHistoryEntries(directory); if err != nil { t.Fatal(err) }
	if len(entries) != historyMaxVersions { t.Fatalf("versions: %d", len(entries)) }
	settings := defaultHistorySettings(); settings.MaxBytes = 1024
	if err := a.pruneHistory(settings, time.Now()); err != nil { t.Fatal(err) }
	var size int64
	_ = filepath.WalkDir(filepath.Join(a.options.ConfigDir, "history"), func(path string, entry os.DirEntry, err error) error { if err == nil && !entry.IsDir() { info, _ := entry.Info(); size += info.Size() }; return err })
	if size > settings.MaxBytes { t.Fatalf("history uses %d bytes, limit %d", size, settings.MaxBytes) }
	settings = defaultHistorySettings(); settings.Days = 1
	if err := a.pruneHistory(settings, time.Now().Add(2*24*time.Hour)); err != nil { t.Fatal(err) }
	entries, err = readHistoryEntries(directory); if err != nil { t.Fatal(err) }
	if len(entries) != 0 { t.Fatal("expired versions remained") }
}

func TestEditHistoryFailureDoesNotMisreportASuccessfulSave(t *testing.T) {
	a, root := testApp(t)
	writeTestFile(t, filepath.Join(a.options.ConfigDir, "history"), []byte("a file blocks the history directory"))
	document, _ := readDocument(root, "main.tex"); document.Content += "new text\n"
	response := apiRequest(a, http.MethodPut, "/api/file", document, map[string]string{"Accept-Language": "en"})
	if response.Code != http.StatusOK { t.Fatalf("save failed because history was unavailable: %s", response.Body.String()) }
	var saved FileDocument
	if err := json.Unmarshal(response.Body.Bytes(), &saved); err != nil { t.Fatal(err) }
	if !strings.Contains(saved.HistoryWarning, "document was saved") { t.Fatalf("missing history warning: %#v", saved) }
	current, _ := readDocument(root, "main.tex")
	if current.Content != document.Content { t.Fatal("the source was not saved") }
}

func TestEditHistoryRejectsPathsOutsideProjectAndOversizedRecords(t *testing.T) {
	a, _ := testApp(t)
	response := apiRequest(a, http.MethodPost, "/api/history", map[string]string{"path": "../secret.tex", "content": "outside"}, nil)
	if response.Code < 400 { t.Fatal("history accepted an outside path") }
	response = apiRequest(a, http.MethodPost, "/api/history", map[string]string{"path": "main.tex", "content": strings.Repeat("x", historyMaxFileBytes+1)}, nil)
	if response.Code != http.StatusRequestEntityTooLarge { t.Fatalf("oversized record: %d %s", response.Code, response.Body.String()) }
}
