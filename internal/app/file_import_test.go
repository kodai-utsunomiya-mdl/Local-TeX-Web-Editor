package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func importRequest(a *App, relative string, body io.Reader, headers map[string]string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8765/api/files/import?path="+url.QueryEscape(relative), body)
	request.RemoteAddr = "127.0.0.1:54321"
	request.Header.Set("X-Local-Token", testToken)
	request.Header.Set("Content-Type", "application/octet-stream")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response := httptest.NewRecorder()
	a.Handler().ServeHTTP(response, request)
	return response
}

func importTargetForTest(t *testing.T, a *App, path string) fileImportTarget {
	t.Helper()
	response := apiRequest(a, http.MethodGet, "/api/files/import?path="+url.QueryEscape(path), nil, nil)
	var target fileImportTarget
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &target) != nil {
		t.Fatalf("inspect import target: %d %s", response.Code, response.Body.String())
	}
	return target
}

func TestFileImportCopiesBytesWithoutChangingTextOrBinaryFiles(t *testing.T) {
	a, root := testApp(t)
	if err := os.Mkdir(filepath.Join(root, "figures"), 0755); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string][]byte{
		"figures/図 1.png": testImagePNG(t),
		"figures/data.bin": {0, 1, 2, 255},
		"notes.md":         []byte("\xef\xbb\xbf# 日本語\r\n"),
		"empty.tex":        {},
	} {
		target := importTargetForTest(t, a, name)
		if target.Exists || target.Path != name {
			t.Fatalf("unexpected new destination: %#v", target)
		}
		response := importRequest(a, name, bytes.NewReader(data), map[string]string{"X-Project-Root": url.PathEscape(root)})
		var result struct {
			Path     string `json:"path"`
			Bytes    int64  `json:"bytes"`
			Replaced bool   `json:"replaced"`
			State    State  `json:"state"`
		}
		if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Path != name || result.Bytes != int64(len(data)) || result.Replaced {
			t.Fatalf("copy %s: %d %s", name, response.Code, response.Body.String())
		}
		actual, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(name)))
		if err != nil || !bytes.Equal(actual, data) || !hasFile(result.State.Project.Files, name) {
			t.Fatalf("copied content or file list differs: %q %v", actual, err)
		}
	}
}

func TestFileImportRequiresConfirmationBeforeReplacingAnExistingFile(t *testing.T) {
	a, root := testApp(t)
	file := filepath.Join(root, "image.png")
	writeTestFile(t, file, []byte("original bytes"))
	writeTestFile(t, filepath.Join(root, "image-2.png"), []byte("another image"))
	target := importTargetForTest(t, a, "image.png")
	if !target.Exists || !target.Replaceable || target.Revision == "" || target.Alternative != "image-3.png" {
		t.Fatalf("the conflict is missing its choices: %#v", target)
	}
	response := importRequest(a, "image.png", strings.NewReader("new bytes"), nil)
	var conflict struct {
		ReviewRequired bool             `json:"reviewRequired"`
		Target         fileImportTarget `json:"target"`
	}
	if response.Code != http.StatusConflict || json.Unmarshal(response.Body.Bytes(), &conflict) != nil || !conflict.ReviewRequired || conflict.Target.Revision != target.Revision {
		t.Fatalf("replacement did not require confirmation: %d %s", response.Code, response.Body.String())
	}
	actual, _ := os.ReadFile(file)
	if string(actual) != "original bytes" {
		t.Fatal("an unconfirmed replacement changed the file")
	}
	response = importRequest(a, "image.png", strings.NewReader("new bytes"), map[string]string{"X-File-Revision": target.Revision})
	if response.Code != http.StatusCreated {
		t.Fatalf("confirmed replacement: %d %s", response.Code, response.Body.String())
	}
	actual, _ = os.ReadFile(file)
	if string(actual) != "new bytes" {
		t.Fatalf("replacement content: %q", actual)
	}
}

type importChangeReader struct {
	reader io.Reader
	change func()
}

func (r *importChangeReader) Read(data []byte) (int, error) {
	if r.change != nil {
		change := r.change
		r.change = nil
		change()
	}
	return r.reader.Read(data)
}

func TestFileImportChecksForDestinationChangesWhileReceivingData(t *testing.T) {
	for _, test := range []struct {
		name     string
		existing bool
	}{{"new file", false}, {"existing file", true}} {
		t.Run(test.name, func(t *testing.T) {
			a, root := testApp(t)
			file := filepath.Join(root, "notes.md")
			if test.existing {
				writeTestFile(t, file, []byte("first"))
			}
			target := importTargetForTest(t, a, "notes.md")
			body := &importChangeReader{reader: strings.NewReader("uploaded bytes"), change: func() {
				info, _ := os.Stat(file)
				writeTestFile(t, file, []byte("other"))
				if info != nil {
					if err := os.Chtimes(file, info.ModTime(), info.ModTime()); err != nil {
						t.Fatal(err)
					}
				}
			}}
			response := importRequest(a, "notes.md", body, map[string]string{"X-File-Revision": target.Revision})
			if response.Code != http.StatusConflict {
				t.Fatalf("the changed destination was accepted: %d %s", response.Code, response.Body.String())
			}
			actual, _ := os.ReadFile(file)
			if string(actual) != "other" {
				t.Fatalf("an external change was overwritten: %q", actual)
			}
			matches, _ := filepath.Glob(filepath.Join(root, ".local-tex-editor-import-*"))
			if len(matches) != 0 {
				t.Fatalf("temporary copies remain: %v", matches)
			}
		})
	}
}

type failedImportReader struct{}

func (failedImportReader) Read([]byte) (int, error) { return 0, errors.New("upload stopped") }

func TestFileImportStopsWithoutCreatingOrReplacingTheDestination(t *testing.T) {
	a, root := testApp(t)
	writeTestFile(t, filepath.Join(root, "existing.md"), []byte("keep this"))
	for _, path := range []string{"new.md", "existing.md"} {
		target := importTargetForTest(t, a, path)
		response := importRequest(a, path, failedImportReader{}, map[string]string{"X-File-Revision": target.Revision})
		if response.Code < 400 {
			t.Fatalf("an unfinished upload succeeded: %d", response.Code)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "new.md")); !os.IsNotExist(err) {
		t.Fatalf("a partial new file exists: %v", err)
	}
	actual, _ := os.ReadFile(filepath.Join(root, "existing.md"))
	if string(actual) != "keep this" {
		t.Fatal("an unfinished upload replaced the original")
	}
	matches, _ := filepath.Glob(filepath.Join(root, ".local-tex-editor-import-*"))
	if len(matches) != 0 {
		t.Fatalf("temporary copies remain: %v", matches)
	}
}

func TestFileImportRespectsProjectBoundariesAndLinks(t *testing.T) {
	a, root := testApp(t)
	for _, path := range []string{"", ".", "../outside.png", ".git/new.png", "folder/../image.png", "C:/outside.png", "CON"} {
		response := importRequest(a, path, strings.NewReader("image"), nil)
		if response.Code < 400 {
			t.Fatalf("accepted path %q", path)
		}
	}
	response := importRequest(a, "wrong-project.md", strings.NewReader("text"), map[string]string{"X-Project-Root": url.PathEscape(root + "-other")})
	if response.Code != http.StatusConflict {
		t.Fatalf("wrong project: %d", response.Code)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Skipf("links unavailable: %v", err)
	}
	response = importRequest(a, "linked/image.png", strings.NewReader("image"), nil)
	if response.Code < 400 {
		t.Fatal("copied through a link")
	}
	if _, err := os.Stat(filepath.Join(outside, "image.png")); !os.IsNotExist(err) {
		t.Fatalf("a file was copied outside the project: %v", err)
	}
}

func TestFileImportRejectsLargeRequestBeforeReadingTheBody(t *testing.T) {
	a, root := testApp(t)
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8765/api/files/import?path=large.bin", failedImportReader{})
	request.RemoteAddr = "127.0.0.1:54321"
	request.Header.Set("X-Local-Token", testToken)
	request.ContentLength = maxAssetSize + 1
	response := httptest.NewRecorder()
	a.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("large request: %d %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "large.bin")); !os.IsNotExist(err) {
		t.Fatalf("a large upload created a file: %v", err)
	}
}
