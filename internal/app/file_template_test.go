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
)

func TestFileTemplatesReadBuiltinTextWithoutCreatingFiles(t *testing.T) {
	a, root := testApp(t)
	before, err := os.ReadFile(filepath.Join(root, "main.tex"))
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range builtinTemplates("en") {
		endpoint := "/api/templates/files?id=" + url.QueryEscape(item.ID)
		response := apiRequest(a, http.MethodGet, endpoint, nil, map[string]string{"Accept-Language": "en"})
		var result struct {
			Template projectTemplate     `json:"template"`
			Files    []fileTemplateEntry `json:"files"`
		}
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Template.Name != item.Name || len(result.Files) != len(item.Files) {
			t.Fatalf("builtin file list: %d %s", response.Code, response.Body.String())
		}
		file := result.Files[0]
		response = apiRequest(a, http.MethodGet, endpoint+"&path="+url.QueryEscape(file.Path), nil, nil)
		var document struct {
			ID      string `json:"id"`
			Path    string `json:"path"`
			Name    string `json:"name"`
			Content string `json:"content"`
		}
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &document) != nil || document.ID != item.ID || document.Path != file.Path || document.Name != file.Name || document.Content != string(item.Files[file.Path]) || file.Bytes != len(item.Files[file.Path]) {
			t.Fatalf("builtin content: %d %s", response.Code, response.Body.String())
		}
	}
	after, err := os.ReadFile(filepath.Join(root, "main.tex"))
	if err != nil || !bytes.Equal(before, after) || a.project.Main != "main.tex" || len(a.project.Files) != 1 {
		t.Fatalf("preview changed the project: %v", err)
	}
}

func TestFileTemplatesListOnlyEditableTextAndReadTheSelectedFile(t *testing.T) {
	a, root := testApp(t)
	writeTestFile(t, filepath.Join(root, "notes", "日本語.md"), []byte("\xef\xbb\xbf# 登録したメモ\r\n本文\r\n"))
	writeTestFile(t, filepath.Join(root, "figures", "plot.png"), testImagePNG(t))
	writeTestFile(t, filepath.Join(root, "binary.md"), []byte{0, 255, 0, 1})
	response := apiRequest(a, http.MethodPost, "/api/templates", map[string]any{
		"name": "研究用", "paths": []string{"main.tex", "notes/日本語.md", "figures/plot.png", "binary.md"},
	}, nil)
	var item projectTemplate
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &item) != nil {
		t.Fatalf("register: %d %s", response.Code, response.Body.String())
	}
	writeTestFile(t, filepath.Join(root, "notes", "日本語.md"), []byte("changed after registration"))
	endpoint := "/api/templates/files?id=" + item.ID
	response = apiRequest(a, http.MethodGet, endpoint, nil, nil)
	var result struct {
		Template projectTemplate     `json:"template"`
		Files    []fileTemplateEntry `json:"files"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || len(result.Files) != 2 || result.Files[0].Path != "main.tex" || result.Files[1].Path != "notes/日本語.md" || result.Template.FileCount != 4 {
		t.Fatalf("editable files: %d %s", response.Code, response.Body.String())
	}
	response = apiRequest(a, http.MethodGet, endpoint+"&path="+url.QueryEscape("notes/日本語.md"), nil, nil)
	var document struct {
		Name       string `json:"name"`
		Content    string `json:"content"`
		LineEnding string `json:"lineEnding"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &document) != nil || document.Name != "日本語.md" || document.Content != "# 登録したメモ\n本文\n" || document.LineEnding != "crlf" {
		t.Fatalf("saved template content: %d %s", response.Code, response.Body.String())
	}
	for _, path := range []string{"figures/plot.png", "binary.md"} {
		response := apiRequest(a, http.MethodGet, endpoint+"&path="+url.QueryEscape(path), nil, nil)
		if response.Code != http.StatusUnsupportedMediaType {
			t.Fatalf("binary template file %s: %d %s", path, response.Code, response.Body.String())
		}
	}
}

func TestFileTemplatesRejectMissingFilesInvalidPathsAndWrites(t *testing.T) {
	a, _ := testApp(t)
	endpoint := "/api/templates/files?id=builtin-article"
	for _, path := range []string{"", "../main.tex", "/main.tex", "C:/main.tex", ".git/config", "folder/../main.tex", `folder\main.tex`} {
		response := apiRequest(a, http.MethodGet, endpoint+"&path="+url.QueryEscape(path), nil, nil)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid path %q: %d %s", path, response.Code, response.Body.String())
		}
	}
	for _, query := range []string{"id=unknown", "id=" + url.QueryEscape("../outside"), "id=builtin-article&path=missing.tex"} {
		response := apiRequest(a, http.MethodGet, "/api/templates/files?"+query, nil, nil)
		if response.Code != http.StatusNotFound {
			t.Fatalf("missing template or file: %d %s", response.Code, response.Body.String())
		}
	}
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		response := apiRequest(a, method, endpoint, map[string]string{"content": "replace"}, nil)
		if response.Code != http.StatusMethodNotAllowed {
			t.Fatalf("template reader accepted %s: %d", method, response.Code)
		}
	}
}

func TestFileTemplatesRejectLinkedArchives(t *testing.T) {
	a, _ := testApp(t)
	id := strings.Repeat("a", 32)
	item := templateContents{projectTemplate: projectTemplate{ID: id, Name: "Example", Main: "main.tex", Mode: "pdflatex"}, Files: map[string][]byte{"main.tex": []byte("example\n")}}
	if err := a.saveTemplateLocked(item, false); err != nil {
		t.Fatal(err)
	}
	directory, err := a.templateDirectory()
	if err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(directory, id+".zip")
	data, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside.zip")
	writeTestFile(t, outside, data)
	if err := os.Remove(archive); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, archive); err != nil {
		t.Skipf("links unavailable: %v", err)
	}
	response := apiRequest(a, http.MethodGet, "/api/templates/files?id="+id+"&path=main.tex", nil, nil)
	if response.Code != http.StatusForbidden {
		t.Fatalf("linked archive: %d %s", response.Code, response.Body.String())
	}
	after, err := os.ReadFile(outside)
	if err != nil || !bytes.Equal(data, after) {
		t.Fatalf("the archive outside the template folder changed: %v", err)
	}
}
