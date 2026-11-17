package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestProductRenameUsesExistingSettingsAndDrafts(t *testing.T) {
	base := t.TempDir()
	switch runtime.GOOS {
	case "windows":
		t.Setenv("APPDATA", base)
	case "darwin":
		t.Setenv("HOME", base)
		base = filepath.Join(base, "Library", "Application Support")
	default:
		t.Setenv("XDG_CONFIG_HOME", base)
	}
	legacyDirectory := filepath.Join(base, "LocalTeXEditor")
	project := filepath.Join(t.TempDir(), "Existing manuscript")
	writeTestFile(t, filepath.Join(project, "main.tex"), []byte("\\documentclass{article}\n\\begin{document}Existing manuscript\\end{document}\n"))
	project, err := filepath.EvalSymlinks(project)
	if err != nil {
		t.Fatal(err)
	}
	settings, err := json.Marshal(configuration{
		TexBin: filepath.Join(t.TempDir(), "TeX Live"), RecentProjects: []string{project},
		Projects: map[string]projectSettings{project: {Main: "main.tex", Mode: "uplatex"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(legacyDirectory, "settings.json"), settings)
	values := map[string]json.RawMessage{
		"preferences":       json.RawMessage(`{"language":"ja","theme":"dark","fontSize":18}`),
		"drafts:" + project: json.RawMessage(`{"main.tex":{"content":"未保存の原稿","revision":"previous-version"}}`),
	}
	for key, value := range values {
		hash := sha256.Sum256([]byte(key))
		path := filepath.Join(legacyDirectory, "ui-state", hex.EncodeToString(hash[:])+".json")
		if err := writeStoredUIValue(path, key, value); err != nil {
			t.Fatal(err)
		}
	}
	a, err := New(Options{Token: testToken, Version: "0.1.4"})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	a.SetAddress("127.0.0.1:8765")
	if a.options.ConfigDir != legacyDirectory || a.project == nil || a.project.Main != "main.tex" || a.project.Mode != "uplatex" {
		t.Fatalf("existing configuration was not opened: directory=%s, project=%#v", a.options.ConfigDir, a.project)
	}
	if SavedInterfaceLanguage("") != "ja" {
		t.Fatal("the update page did not read the existing language preference")
	}
	for key, want := range values {
		response := apiRequest(a, http.MethodGet, "/api/storage?key="+url.QueryEscape(key), nil, nil)
		value := decodeUIStorageResponse(t, response, http.StatusOK)
		if string(value.Value) != string(want) {
			t.Fatalf("stored value %s changed after the rename: %s", key, value.Value)
		}
	}
	if _, err := os.Lstat(filepath.Join(base, "LocalTeXWebEditor")); !os.IsNotExist(err) {
		t.Fatalf("a second settings directory was created: %v", err)
	}
}

func TestSettingsOnlyInvalidatePDFWhenCompilationSettingsChange(t *testing.T) {
	for _, test := range []struct {
		name           string
		change         string
		alreadyChanged bool
		wantChanged    bool
	}{
		{name: "no compiler settings"},
		{name: "same compiler settings", change: "same"},
		{name: "equivalent compiler path", change: "equivalent"},
		{name: "another fallback main document", change: "main"},
		{name: "another compilation mode", change: "mode", wantChanged: true},
		{name: "another TeX installation", change: "texBin", wantChanged: true},
		{name: "existing source edits remain", change: "same", alreadyChanged: true, wantChanged: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			a, root := testApp(t)
			texBin := filepath.Join(t.TempDir(), "TeX Live", "bin")
			a.config.TexBin = texBin
			pdfPath := filepath.Join(t.TempDir(), "compiled.pdf")
			writeTestFile(t, pdfPath, []byte("%PDF-1.7\nprevious successful build\n"))
			a.lastPDF, a.lastPDFID = pdfPath, "existing-build"
			a.lastPDFMain, a.lastPDFChanged = "main.tex", test.alreadyChanged
			a.build = &buildRun{result: Build{ID: "existing-build", Status: "success", SourceChanged: test.alreadyChanged}, started: time.Now(), finished: time.Now()}
			body := map[string]string{}
			if test.change != "" {
				body = map[string]string{"texBin": texBin, "main": a.project.Main, "mode": a.project.Mode}
			}
			switch test.change {
			case "equivalent":
				body["texBin"] = "  " + texBin + string(filepath.Separator) + "  "
			case "main":
				writeTestFile(t, filepath.Join(root, "another.tex"), []byte("\\documentclass{article}\n\\begin{document}Another\\end{document}\n"))
				body["main"] = "another.tex"
			case "mode":
				body["mode"] = "uplatex"
			case "texBin":
				body["texBin"] = filepath.Join(t.TempDir(), "another TeX Live")
			}
			response := apiRequest(a, http.MethodPut, "/api/settings", body, map[string]string{"X-Project-Root": url.PathEscape(root)})
			var state State
			if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &state) != nil || state.Build == nil {
				t.Fatalf("settings: %d %s", response.Code, response.Body.String())
			}
			if state.Build.SourceChanged != test.wantChanged {
				t.Fatalf("sourceChanged = %v, want %v", state.Build.SourceChanged, test.wantChanged)
			}
			if state.Build.PDFSourceChanged != test.wantChanged || state.Build.PDFMain != "main.tex" {
				t.Fatalf("visible PDF metadata changed unexpectedly: %#v", state.Build)
			}
			if state.Build.PDFBuildID != "existing-build" || !state.Build.PDFReady || state.Build.Status != "success" {
				t.Fatalf("settings replaced the previous result: %#v", state.Build)
			}
		})
	}
}
