package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestFileDownloadPreservesBytesAndNames(t *testing.T) {
	a, root := testApp(t)
	for _, test := range []struct {
		name string
		data []byte
	}{
		{"日本語の 原稿.md", []byte("\xef\xbb\xbf# 原稿\r\n本文\r\n")},
		{"data/bytes.bin", []byte{0, 1, 255, 13, 10}},
		{"image.svg", []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>untrusted()</script></svg>`)},
		{"empty.tex", []byte{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			writeTestFile(t, filepath.Join(root, filepath.FromSlash(test.name)), test.data)
			response := apiRequest(a, http.MethodGet, "/api/file/download?path="+url.QueryEscape(test.name), nil, nil)
			if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), test.data) {
				t.Fatalf("download: %d %q", response.Code, response.Body.Bytes())
			}
			kind, parameters, err := mime.ParseMediaType(response.Header().Get("Content-Disposition"))
			if err != nil || kind != "attachment" || parameters["filename"] != filepath.Base(test.name) || response.Header().Get("Content-Type") != "application/octet-stream" {
				t.Fatalf("download headers: %v %v", response.Header(), err)
			}
		})
	}
	response := apiRequest(a, http.MethodGet, "/api/file/download?path=data%2Fbytes.bin", nil, map[string]string{"Range": "bytes=1-2"})
	if response.Code != http.StatusPartialContent || !bytes.Equal(response.Body.Bytes(), []byte{1, 255}) {
		t.Fatalf("range: %d %q", response.Code, response.Body.Bytes())
	}
	response = apiRequest(a, http.MethodHead, "/api/file/download?path=data%2Fbytes.bin", nil, nil)
	if response.Code != http.StatusOK || response.Body.Len() != 0 || response.Header().Get("Content-Length") != "5" {
		t.Fatalf("head: %d %v", response.Code, response.Header())
	}
}

func TestFileDownloadIncludesCurrentTextWithoutSavingOriginal(t *testing.T) {
	a, root := testApp(t)
	original := []byte("\xef\xbb\xbf# Saved\r\n")
	writeTestFile(t, filepath.Join(root, "notes.md"), original)
	content := "# 編集中\n追加した本文\n"
	response := apiRequest(a, http.MethodPost, "/api/file/download", fileExportInput{Path: "notes.md", Content: &content, LineEnding: "crlf"}, nil)
	want := []byte("\xef\xbb\xbf# 編集中\r\n追加した本文\r\n")
	if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), want) {
		t.Fatalf("edited download: %d %q", response.Code, response.Body.Bytes())
	}
	current, _ := os.ReadFile(filepath.Join(root, "notes.md"))
	if !bytes.Equal(current, original) {
		t.Fatalf("original changed: %q", current)
	}
	response = apiRequest(a, http.MethodPost, "/api/file/download", fileExportInput{Path: "missing.md", Content: &content}, nil)
	if response.Code != http.StatusOK || response.Body.String() != content {
		t.Fatalf("missing file with current text: %d %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "missing.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("download created an original: %v", err)
	}
}

func TestFileDownloadRejectsInvalidPathsAndPayloads(t *testing.T) {
	a, root := testApp(t)
	writeTestFile(t, filepath.Join(root, "folder", "file.txt"), []byte("text"))
	for _, relative := range []string{"", "../outside.txt", "folder", ".git/config"} {
		response := apiRequest(a, http.MethodGet, "/api/file/download?path="+url.QueryEscape(relative), nil, nil)
		if response.Code < 400 {
			t.Fatalf("accepted %q: %d", relative, response.Code)
		}
	}
	content := "new bytes"
	for _, input := range []fileExportInput{
		{Path: "file.bin", Content: &content},
		{Path: "main.tex", BuildID: "one"},
		{BuildID: "one", Content: &content},
	} {
		if response := apiRequest(a, http.MethodPost, "/api/file/download", input, nil); response.Code < 400 {
			t.Fatalf("accepted invalid input: %#v", input)
		}
	}
	response := apiRequest(a, http.MethodGet, "/api/file/download?path=main.tex", nil, map[string]string{"X-Project-Root": url.PathEscape(filepath.Join(root, "other"))})
	if response.Code != http.StatusConflict {
		t.Fatalf("wrong project: %d", response.Code)
	}
	outside := filepath.Join(t.TempDir(), "outside.txt")
	writeTestFile(t, outside, []byte("outside"))
	if err := os.Symlink(outside, filepath.Join(root, "linked.txt")); err == nil {
		response = apiRequest(a, http.MethodGet, "/api/file/download?path=linked.txt", nil, nil)
		if response.Code != http.StatusForbidden {
			t.Fatalf("linked file: %d", response.Code)
		}
	}
}

func TestFileSaveAsUsesTheSelectedDestinationAndCanCancel(t *testing.T) {
	a, root := testApp(t)
	data := []byte{0, 1, 255, 13, 10}
	writeTestFile(t, filepath.Join(root, "日本語の 図.bin"), data)
	destination := filepath.Join(t.TempDir(), "別の 名前.bin")
	a.saveFilePicker = func(_ context.Context, name string) (string, error) {
		if name != "日本語の 図.bin" {
			t.Errorf("suggested name = %q", name)
		}
		return destination, nil
	}
	for _, previous := range [][]byte{nil, []byte("existing file selected for replacement")} {
		if previous != nil {
			writeTestFile(t, destination, previous)
		}
		response := apiRequest(a, http.MethodPost, "/api/file/save-as", fileExportInput{Path: "日本語の 図.bin"}, nil)
		if response.Code != http.StatusOK {
			t.Fatalf("save as: %d %s", response.Code, response.Body.String())
		}
		var result struct{ Path string }
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatalf("saved path: %s %v", response.Body.String(), err)
		}
		// Windows can expand a temporary folder's short name in the returned
		// path. The response must identify the file selected by the user.
		selected, selectedErr := os.Stat(destination)
		returned, returnedErr := os.Stat(result.Path)
		if selectedErr != nil || returnedErr != nil || !filepath.IsAbs(result.Path) || !os.SameFile(selected, returned) {
			t.Fatalf("selected path %q (%v), returned path %q (%v)", destination, selectedErr, result.Path, returnedErr)
		}
		actual, err := os.ReadFile(destination)
		if err != nil || !bytes.Equal(actual, data) {
			t.Fatalf("saved bytes: %q %v", actual, err)
		}
	}
	a.saveFilePicker = func(context.Context, string) (string, error) { return "", nil }
	response := apiRequest(a, http.MethodPost, "/api/file/save-as", fileExportInput{Path: "日本語の 図.bin"}, nil)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"cancelled":true`) {
		t.Fatalf("cancel: %d %s", response.Code, response.Body.String())
	}
	actual, _ := os.ReadFile(filepath.Join(root, "日本語の 図.bin"))
	if !bytes.Equal(actual, data) {
		t.Fatalf("source changed: %q", actual)
	}
}

func TestFileSaveAsWritesCurrentTextAndHandlesTheOriginalPath(t *testing.T) {
	a, root := testApp(t)
	originalPath := filepath.Join(root, "notes.md")
	original := []byte("\xef\xbb\xbf# Saved\r\n")
	writeTestFile(t, originalPath, original)
	destination := filepath.Join(t.TempDir(), "exported.md")
	a.saveFilePicker = func(context.Context, string) (string, error) { return destination, nil }
	content := "# Current\n日本語\n"
	input := fileExportInput{Path: "notes.md", Content: &content, LineEnding: "crlf", Revision: revision(original)}
	response := apiRequest(a, http.MethodPost, "/api/file/save-as", input, nil)
	want := []byte("\xef\xbb\xbf# Current\r\n日本語\r\n")
	actual, err := os.ReadFile(destination)
	if response.Code != http.StatusOK || err != nil || !bytes.Equal(actual, want) {
		t.Fatalf("current text: %d %q %v", response.Code, actual, err)
	}
	actual, _ = os.ReadFile(originalPath)
	if !bytes.Equal(actual, original) {
		t.Fatalf("original changed: %q", actual)
	}
	destination = originalPath
	response = apiRequest(a, http.MethodPost, "/api/file/save-as", input, nil)
	var result struct{ Document *FileDocument }
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Document == nil || result.Document.Revision != revision(want) {
		t.Fatalf("save original: %d %s", response.Code, response.Body.String())
	}
	actual, _ = os.ReadFile(originalPath)
	if !bytes.Equal(actual, want) {
		t.Fatalf("saved original: %q", actual)
	}
	response = apiRequest(a, http.MethodPost, "/api/file/save-as", input, nil)
	if response.Code != http.StatusConflict {
		t.Fatalf("stale original: %d %s", response.Code, response.Body.String())
	}
}

type exportCancellationContext struct {
	context.Context
	checked chan error
}

func (ctx *exportCancellationContext) Err() error {
	err := ctx.Context.Err()
	select {
	case ctx.checked <- err:
	default:
	}
	return err
}

func TestFileSaveAsCancelledWhileWaitingDoesNotSaveTheOriginal(t *testing.T) {
	a, root := testApp(t)
	originalPath := filepath.Join(root, "notes.md")
	original := []byte("# Saved\n")
	writeTestFile(t, originalPath, original)
	content := "# Edited\n"
	data, err := json.Marshal(fileExportInput{Path: "notes.md", Content: &content, Revision: revision(original)})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	observed := &exportCancellationContext{Context: ctx, checked: make(chan error, 1)}
	a.saveFilePicker = func(context.Context, string) (string, error) {
		// Keep the app busy after the user selects the original file. The
		// request can be cancelled while it waits to save the edited text.
		a.mu.Lock()
		return originalPath, nil
	}
	request := httptest.NewRequest(http.MethodPost, "/api/file/save-as", bytes.NewReader(data)).WithContext(observed)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		a.fileSaveAsHandler(response, request)
		close(done)
	}()
	select {
	case err := <-observed.checked:
		cancel()
		a.mu.Unlock()
		if err != nil {
			t.Fatalf("the request was already cancelled before waiting: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the request did not reach the selected destination")
	case <-done:
		t.Fatalf("the save stopped before the destination was selected: %d %s", response.Code, response.Body.String())
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the cancelled save did not finish")
	}
	actual, err := os.ReadFile(originalPath)
	if err != nil || !bytes.Equal(actual, original) {
		t.Fatalf("the cancelled request changed the original: %q %v", actual, err)
	}
}

func TestCompiledPDFDownloadAndSaveAsUseTheSelectedBuild(t *testing.T) {
	a, _ := testApp(t)
	first, second := filepath.Join(t.TempDir(), "first.pdf"), filepath.Join(t.TempDir(), "second.pdf")
	writeTestFile(t, first, []byte("%PDF-first"))
	writeTestFile(t, second, []byte("%PDF-second"))
	a.mu.Lock()
	a.lastPDF, a.lastPDFID = second, "second"
	a.pdfVersions["first"], a.pdfVersions["second"] = first, second
	a.recordCompiledPDFLocked("first.tex", "投稿用の原稿.pdf", "first", first, false, nil)
	a.recordCompiledPDFLocked("second.tex", "second.pdf", "second", second, false, nil)
	a.mu.Unlock()
	response := apiRequest(a, http.MethodPost, "/api/file/download", fileExportInput{BuildID: "first"}, nil)
	if response.Code != http.StatusOK || response.Body.String() != "%PDF-first" {
		t.Fatalf("selected download: %d %s", response.Code, response.Body.String())
	}
	destination := filepath.Join(t.TempDir(), "selected.pdf")
	a.saveFilePicker = func(_ context.Context, name string) (string, error) {
		if name != "投稿用の原稿.pdf" {
			t.Errorf("PDF suggested name = %q", name)
		}
		return destination, nil
	}
	response = apiRequest(a, http.MethodPost, "/api/file/save-as", fileExportInput{BuildID: "first"}, nil)
	actual, err := os.ReadFile(destination)
	if response.Code != http.StatusOK || err != nil || string(actual) != "%PDF-first" {
		t.Fatalf("selected save as: %d %q %v", response.Code, actual, err)
	}
	response = apiRequest(a, http.MethodPost, "/api/file/save-as", fileExportInput{BuildID: "missing"}, nil)
	if response.Code != http.StatusGone {
		t.Fatalf("missing PDF: %d %s", response.Code, response.Body.String())
	}
}

func TestFileSaveAsRechecksTheProjectAfterTheDialog(t *testing.T) {
	a, _ := testApp(t)
	destination := filepath.Join(t.TempDir(), "saved.tex")
	a.saveFilePicker = func(context.Context, string) (string, error) {
		a.mu.Lock()
		a.project = nil
		a.mu.Unlock()
		return destination, nil
	}
	response := apiRequest(a, http.MethodPost, "/api/file/save-as", fileExportInput{Path: "main.tex"}, nil)
	if response.Code != http.StatusConflict {
		t.Fatalf("project switched: %d %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(destination); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("destination was written: %v", err)
	}
}

type exportChangeReader struct {
	io.ReadSeeker
	once func()
}

func (reader *exportChangeReader) Read(data []byte) (int, error) {
	if reader.once != nil {
		change := reader.once
		reader.once = nil
		change()
	}
	return reader.ReadSeeker.Read(data)
}

func TestFileExportDoesNotOverwriteAChangedDestination(t *testing.T) {
	for _, existed := range []bool{false, true} {
		t.Run(map[bool]string{false: "new", true: "existing"}[existed], func(t *testing.T) {
			destination := filepath.Join(t.TempDir(), "result.txt")
			if existed {
				writeTestFile(t, destination, []byte("original destination"))
			}
			checked, parent, previous, err := exportDestination(destination)
			if err != nil {
				t.Fatal(err)
			}
			reader := &exportChangeReader{ReadSeeker: strings.NewReader("exported text"), once: func() { writeTestFile(t, destination, []byte("other application saved this")) }}
			source := &fileExportSource{reader: reader, size: int64(len("exported text"))}
			if err := writeExport(context.Background(), source, checked, parent, previous); err == nil {
				t.Fatal("overwrote a changed destination")
			}
			actual, _ := os.ReadFile(destination)
			if string(actual) != "other application saved this" {
				t.Fatalf("destination changed: %q", actual)
			}
			entries, _ := os.ReadDir(filepath.Dir(destination))
			if len(entries) != 1 {
				t.Fatalf("temporary files remain: %v", entries)
			}
		})
	}
}
