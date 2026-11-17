package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func legacyUIPath(root, key string) string {
	hash := sha256.Sum256([]byte(key))
	return filepath.Join(root, "ui-state", hex.EncodeToString(hash[:])+".json")
}

func TestImportLegacySettingsOpensProjectsAndDrafts(t *testing.T) {
	source, destination := t.TempDir(), filepath.Join(t.TempDir(), "LocalState", "LocalTeXEditor")
	project := filepath.Join(t.TempDir(), "日本語の原稿")
	writeTestFile(t, filepath.Join(project, "main.tex"), []byte("\\documentclass{article}\n\\begin{document}Saved source\\end{document}\n"))
	project, err := filepath.EvalSymlinks(project)
	if err != nil {
		t.Fatal(err)
	}
	settings, err := json.Marshal(configuration{TexBin: "", RecentProjects: []string{project}, Projects: map[string]projectSettings{project: {Main: "main.tex", Mode: "uplatex"}}})
	if err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(source, "settings.json"), settings)
	values := map[string]json.RawMessage{
		"preferences":        json.RawMessage(`{"language":"ja","theme":"dark","editorFontSize":18}`),
		"drafts:" + project:  json.RawMessage(`{"version":1,"entries":[{"id":"draft-one","path":"main.tex","content":"未保存の原稿"}]}`),
		"session:" + project: json.RawMessage(`{"activePath":"main.tex","previewChoice":"pdf","positions":{}}`),
	}
	for key, value := range values {
		if err := writeStoredUIValue(legacyUIPath(source, key), key, value); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{"active.json", "application.lock", "pdf-cache/output.pdf", "tex-perl-utf8-test/perl.exe", "ui-state/.local-tex-editor-save-incomplete"} {
		writeTestFile(t, filepath.Join(source, filepath.FromSlash(path)), []byte("process or cached data"))
	}
	if err := ImportLegacySettings(source, destination); err != nil {
		t.Fatal(err)
	}
	a, err := New(Options{Token: testToken, ConfigDir: destination, Version: "0.1.4"})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	a.SetAddress("127.0.0.1:8765")
	if a.project == nil || a.project.Root != project || a.project.Mode != "uplatex" || SavedInterfaceLanguage(destination) != "ja" {
		t.Fatalf("imported settings = %#v", a.project)
	}
	for key, want := range values {
		response := apiRequest(a, http.MethodGet, "/api/storage?key="+url.QueryEscape(key), nil, nil)
		result := decodeUIStorageResponse(t, response, http.StatusOK)
		if string(result.Value) != string(want) {
			t.Fatalf("imported %s = %s", key, result.Value)
		}
		original, err := readStoredUIValue(legacyUIPath(source, key), key)
		if err != nil || string(original) != string(want) {
			t.Fatalf("original %s changed: %s (%v)", key, original, err)
		}
	}
	for _, name := range []string{"active.json", "application.lock", "pdf-cache", "tex-perl-utf8-test", "ui-state/.local-tex-editor-save-incomplete"} {
		if _, err := os.Stat(filepath.Join(destination, filepath.FromSlash(name))); !os.IsNotExist(err) {
			t.Fatalf("process or cached data was imported: %s (%v)", name, err)
		}
	}
	if original, err := os.ReadFile(filepath.Join(source, "settings.json")); err != nil || string(original) != string(settings) {
		t.Fatalf("original settings changed: %s (%v)", original, err)
	}
}

func TestLegacySettingsImportPreservesExistingValuesAndRunsOnce(t *testing.T) {
	source, destination := t.TempDir(), t.TempDir()
	writeTestFile(t, filepath.Join(source, "settings.json"), []byte(`{"texBin":"old"}`))
	writeTestFile(t, filepath.Join(destination, "settings.json"), []byte(`{"texBin":"new"}`))
	for _, entry := range []struct{ root, value string }{{source, `{"language":"ja"}`}, {destination, `{"language":"en"}`}} {
		if err := writeStoredUIValue(legacyUIPath(entry.root, "preferences"), "preferences", json.RawMessage(entry.value)); err != nil {
			t.Fatal(err)
		}
	}
	if err := ImportLegacySettings(source, destination); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(destination, "settings.json")); err != nil || string(data) != `{"texBin":"new"}` || SavedInterfaceLanguage(destination) != "en" {
		t.Fatalf("existing Store settings changed: %s (%v)", data, err)
	}
	if err := os.Remove(legacyUIPath(destination, "preferences")); err != nil {
		t.Fatal(err)
	}
	if err := ImportLegacySettings(source, destination); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(legacyUIPath(destination, "preferences")); !os.IsNotExist(err) {
		t.Fatalf("a deleted record was reimported: %v", err)
	}
}

func TestLegacySettingsImportChecksAllJSONBeforeWriting(t *testing.T) {
	for _, kind := range []string{"incomplete", "wrong-key", "oversized-settings", "invalid-utf8"} {
		t.Run(kind, func(t *testing.T) {
			source, destination := t.TempDir(), t.TempDir()
			settings := []byte(`{"texBin":"C:\\texlive\\2025\\bin\\windows"}`)
			writeTestFile(t, filepath.Join(source, "settings.json"), settings)
			path := legacyUIPath(source, "drafts:test")
			switch kind {
			case "incomplete":
				writeTestFile(t, path, []byte(`{"key":"drafts:test","value":{"entries":[`))
			case "wrong-key":
				writeTestFile(t, path, []byte(`{"key":"drafts:another","value":{}}`))
			case "oversized-settings":
				writeTestFile(t, filepath.Join(source, "settings.json"), []byte(strings.Repeat(" ", (1<<20)+1)))
			case "invalid-utf8":
				writeTestFile(t, path, append([]byte(`{"key":"drafts:test","value":"`), 0xff, '"', '}'))
			}
			if err := ImportLegacySettings(source, destination); err == nil {
				t.Fatal("invalid saved data was accepted")
			}
			entries, err := os.ReadDir(destination)
			if err != nil || len(entries) != 0 {
				t.Fatalf("part of an invalid import was written: %v (%v)", entries, err)
			}
			writeTestFile(t, filepath.Join(source, "settings.json"), settings)
			if err := writeStoredUIValue(path, "drafts:test", json.RawMessage(`{"entries":[]}`)); err != nil {
				t.Fatal(err)
			}
			if err := ImportLegacySettings(source, destination); err != nil {
				t.Fatalf("the completed data could not be imported on retry: %v", err)
			}
		})
	}
}
