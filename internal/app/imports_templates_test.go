package app

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testImagePNG(t *testing.T) []byte {
	t.Helper()
	canvas := image.NewRGBA(image.Rect(0, 0, 2, 2))
	canvas.Set(0, 0, color.RGBA{R: 200, G: 80, B: 20, A: 255})
	var data bytes.Buffer
	if err := png.Encode(&data, canvas); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func TestImportImageAddsFilesWithoutReplacingAnExistingImage(t *testing.T) {
	a, root := testApp(t)
	data := testImagePNG(t)
	old := []byte("existing image")
	writeTestFile(t, filepath.Join(root, "figures", "図 1.png"), old)
	response := apiRequest(a, http.MethodPost, "/api/assets/import", map[string]string{"path": "figures/図 1.png", "data": base64.StdEncoding.EncodeToString(data)}, map[string]string{"X-Project-Root": url.PathEscape(root)})
	var imported importedAsset
	if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &imported) != nil {
		t.Fatalf("image import: %d %s", response.Code, response.Body.String())
	}
	if imported.Path != "figures/図 1-2.png" || imported.Kind != "image" || imported.Bytes != len(data) {
		t.Fatalf("image metadata: %#v", imported)
	}
	actual, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(imported.Path)))
	if err != nil || !bytes.Equal(actual, data) {
		t.Fatalf("imported bytes: %v", err)
	}
	actual, _ = os.ReadFile(filepath.Join(root, "figures", "図 1.png"))
	if !bytes.Equal(actual, old) {
		t.Fatal("the existing image was overwritten")
	}
	if !hasFile(a.project.Files, imported.Path) {
		t.Fatal("the imported image is absent from the project file list")
	}
}

func TestImageImportRejectsPathsOutsideTheProjectAndMismatchedFormats(t *testing.T) {
	a, root := testApp(t)
	data := base64.StdEncoding.EncodeToString(testImagePNG(t))
	for _, path := range []string{"../outside.png", ".git/image.png", "image.tex", "image.jpg", "x%y.png"} {
		response := apiRequest(a, http.MethodPost, "/api/assets/import", map[string]string{"path": path, "data": data}, nil)
		if response.Code >= 200 && response.Code < 300 {
			t.Fatalf("accepted %s", path)
		}
	}
	response := apiRequest(a, http.MethodPost, "/api/assets/import", map[string]string{"path": "image.png", "data": data}, map[string]string{"X-Project-Root": url.PathEscape(root + "-other")})
	if response.Code != http.StatusConflict {
		t.Fatalf("wrong project: %d %s", response.Code, response.Body.String())
	}
	if _, err := importAssetType([]byte("not an image"), "image.png"); err == nil {
		t.Fatal("an arbitrary file was accepted as an image")
	}
	if _, err := importAssetType(bytes.Repeat([]byte("x"), maxImportedAsset+1), "image.png"); err == nil {
		t.Fatal("the upload limit was not applied")
	}
}

func TestImageImportRejectsLinkedDirectories(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Skipf("links are unavailable: %v", err)
	}
	if _, err := importAsset(root, "linked/test.png", testImagePNG(t)); err == nil {
		t.Fatal("an image was written through a link")
	}
	if _, err := os.Stat(filepath.Join(outside, "test.png")); !os.IsNotExist(err) {
		t.Fatal("the outside folder was changed")
	}
}

func TestBuiltinTemplateCreatesANewFolderAndLeavesTheCurrentProjectOpen(t *testing.T) {
	a, current := testApp(t)
	parent := t.TempDir()
	response := apiRequest(a, http.MethodGet, "/api/templates", nil, map[string]string{"Accept-Language": "en"})
	var result struct{ Templates []projectTemplate `json:"templates"` }
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || len(result.Templates) != 4 {
		t.Fatalf("template list: %d %s", response.Code, response.Body.String())
	}
	if result.Templates[0].Name != "Japanese document" {
		t.Fatalf("English template name: %q", result.Templates[0].Name)
	}
	response = apiRequest(a, http.MethodPost, "/api/templates/create-project", map[string]string{"id": "builtin-japanese", "parent": parent, "name": "日本語の原稿"}, nil)
	if response.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", response.Code, response.Body.String())
	}
	var created struct {
		Path string `json:"path"`
		Main string `json:"main"`
		Mode string `json:"mode"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	// Use the path returned by the API, which expands aliases such as /var on
	// macOS and temporary folders with 8.3 names on Windows.
	path := created.Path
	content, err := os.ReadFile(filepath.Join(path, "main.tex"))
	if err != nil || !bytes.Contains(content, []byte("ltjsarticle")) {
		t.Fatalf("Japanese source: %s (%v)", content, err)
	}
	if !samePath(a.project.Root, current) {
		t.Fatalf("creating a template changed the open project: %q instead of %q", a.project.Root, current)
	}
	if settings := a.config.Projects[path]; settings.Main != "main.tex" || settings.Mode != "lualatex" || created.Main != settings.Main || created.Mode != settings.Mode {
		t.Fatalf("the new project's compiler setting does not match its response: %#v, %#v", settings, created)
	}
	response = apiRequest(a, http.MethodPost, "/api/templates/create-project", map[string]string{"id": "builtin-article", "parent": parent, "name": "日本語の原稿"}, nil)
	if response.Code != http.StatusConflict {
		t.Fatalf("existing folder: %d %s", response.Code, response.Body.String())
	}
	after, _ := os.ReadFile(filepath.Join(path, "main.tex"))
	if !bytes.Equal(content, after) {
		t.Fatal("an existing project was overwritten")
	}
}

func TestCustomTemplateCanBeRegisteredRenamedUsedAndDeleted(t *testing.T) {
	a, root := testApp(t)
	writeTestFile(t, filepath.Join(root, "notes.md"), []byte("# Custom notes\n"))
	writeTestFile(t, filepath.Join(root, "figures", "plot.png"), testImagePNG(t))
	writeTestFile(t, filepath.Join(root, "main.pdf"), []byte("generated PDF"))
	response := apiRequest(a, http.MethodPost, "/api/templates", map[string]any{"name": "私の論文", "description": "研究用", "paths": []string{"main.tex", "notes.md", "figures/plot.png"}}, nil)
	var item projectTemplate
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &item) != nil || item.FileCount != 3 || item.Builtin {
		t.Fatalf("capture: %d %s", response.Code, response.Body.String())
	}
	writeTestFile(t, filepath.Join(root, "notes.md"), []byte("changed since registration\n"))
	response = apiRequest(a, http.MethodPatch, "/api/templates", map[string]string{"id": item.ID, "name": "修論", "description": ""}, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("rename: %d %s", response.Code, response.Body.String())
	}
	parent := t.TempDir()
	response = apiRequest(a, http.MethodPost, "/api/templates/create-project", map[string]string{"id": item.ID, "parent": parent, "name": "thesis"}, nil)
	if response.Code != http.StatusCreated {
		t.Fatalf("reuse: %d %s", response.Code, response.Body.String())
	}
	content, _ := os.ReadFile(filepath.Join(parent, "thesis", "notes.md"))
	if string(content) != "# Custom notes\n" {
		t.Fatalf("the template used later source edits: %q", content)
	}
	if _, err := os.Stat(filepath.Join(parent, "thesis", "main.pdf")); !os.IsNotExist(err) {
		t.Fatal("a generated PDF was included")
	}
	response = apiRequest(a, http.MethodDelete, "/api/templates", map[string]string{"id": item.ID}, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("delete: %d %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(filepath.Join(parent, "thesis", "main.tex")); err != nil {
		t.Fatal("removing the template changed an existing project")
	}
}

func TestTemplatesExcludeGeneratedFilesAndBuiltinTemplatesCannotBeChanged(t *testing.T) {
	a, root := testApp(t)
	writeTestFile(t, filepath.Join(root, "main.pdf"), []byte("pdf"))
	writeTestFile(t, filepath.Join(root, "main.aux"), []byte("aux"))
	for _, path := range []string{"main.pdf", "main.aux", "../outside.tex"} {
		response := apiRequest(a, http.MethodPost, "/api/templates", map[string]any{"name": "Test", "paths": []string{path}}, nil)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("accepted generated or outside file %s: %d %s", path, response.Code, response.Body.String())
		}
	}
	for _, method := range []string{http.MethodPatch, http.MethodDelete} {
		response := apiRequest(a, method, "/api/templates", map[string]string{"id": "builtin-japanese", "name": "changed"}, nil)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("changed a builtin template: %d %s", response.Code, response.Body.String())
		}
	}
}

func TestTemplateArchiveChecksFilePathsAndUncompressedSize(t *testing.T) {
	id := strings.Repeat("1", 32)
	for _, name := range []string{"files/../../outside.tex", "files/.git/config", "files/C:/file.tex", "files/test.exe"} {
		var archive bytes.Buffer
		writer := zip.NewWriter(&archive)
		manifest, _ := writer.Create("template.json")
		_ = json.NewEncoder(manifest).Encode(projectTemplate{ID: id, Name: "test", Mode: "pdflatex"})
		file, _ := writer.Create(name)
		_, _ = file.Write([]byte("text"))
		_ = writer.Close()
		reader, err := zip.NewReader(bytes.NewReader(archive.Bytes()), int64(archive.Len()))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := decodeTemplate(reader, id, false); err == nil {
			t.Fatalf("accepted archive entry %q", name)
		}
	}
	reader := &zip.Reader{File: []*zip.File{{FileHeader: zip.FileHeader{Name: "files/main.tex", UncompressedSize64: maxImportedAsset + 1}}}}
	if _, err := decodeTemplate(reader, id, true); err == nil {
		t.Fatal("the archive metadata exceeded the file limit")
	}
}
