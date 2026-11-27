package app

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type projectArchiveTestEntry struct {
	name string
	data []byte
	mode os.FileMode
}

func projectArchiveTestZIP(t *testing.T, entries ...projectArchiveTestEntry) []byte {
	t.Helper()
	var data bytes.Buffer
	writer := zip.NewWriter(&data)
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.name, Method: zip.Store}
		if entry.mode != 0 {
			header.SetMode(entry.mode)
		}
		file, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write(entry.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func assertProjectArchiveTemporaryFilesRemoved(t *testing.T, directory string) {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".local-tex-editor-project-import-") || strings.HasPrefix(entry.Name(), ".project-import-") {
			t.Errorf("an unfinished import remains: %s", entry.Name())
		}
	}
}

func TestProjectArchiveImportPreservesProjectFilesAndUnwrapsItsFolder(t *testing.T) {
	contents := map[string][]byte{
		"main.tex":          []byte("\\documentclass{article}\r\n\\input{chapters/導入}\r\n"),
		"chapters/導入.tex":   []byte("日本語の原稿\r\n"),
		"references.bib":    []byte("@article{sample,title={Sample}}\n"),
		"figures/image.png": {0, 1, 2, 255},
		"fonts/font.otf":    {79, 84, 84, 79, 0, 255},
		"latexmkrc":         []byte("$pdf_mode = 4;\n"),
		"styles/local.sty":  []byte("\\ProvidesPackage{local}\n"),
		"references.bbl":    []byte("generated bibliography\n"),
		"reference.pdf":     []byte("%PDF-1.7\n"),
		".gitignore":        []byte("*.aux\n"),
	}
	entries := []projectArchiveTestEntry{{name: "原稿/", mode: os.ModeDir | 0755}, {name: "原稿/empty/", mode: os.ModeDir | 0755}}
	for name, data := range contents {
		entries = append(entries, projectArchiveTestEntry{name: "原稿/" + name, data: data})
	}
	for _, name := range []string{".git/config", ".local-tex-editor/history", "__MACOSX/._main.tex", ".DS_Store", "._main.tex", "Thumbs.db", "desktop.ini", "node_modules/package/file.js"} {
		entries = append(entries, projectArchiveTestEntry{name: "原稿/" + name, data: []byte("metadata")})
	}
	archive := projectArchiveTestZIP(t, entries...)
	parent := t.TempDir()
	result, err := extractProjectArchive(context.Background(), bytes.NewReader(archive), int64(len(archive)), "原稿.zip", parent, "読み込んだ原稿")
	if err != nil {
		t.Fatal(err)
	}
	if result.Main != "main.tex" || result.Mode != "project" {
		t.Fatalf("imported project = %+v", result)
	}
	for name, want := range contents {
		actual, err := os.ReadFile(filepath.Join(result.Path, filepath.FromSlash(name)))
		if err != nil || !bytes.Equal(actual, want) {
			t.Errorf("%s = %q, %v; want %q", name, actual, err, want)
		}
	}
	files, directories, _, err := listProjectEntries(result.Path)
	if err != nil || len(files) != len(contents) {
		t.Fatalf("project files = %d, %v", len(files), err)
	}
	if !strings.Contains(strings.Join(directories, "/"), "empty") {
		t.Fatalf("the empty project folder was lost: %v", directories)
	}
	for _, name := range []string{".git", ".local-tex-editor", "__MACOSX", ".DS_Store", "._main.tex", "Thumbs.db", "desktop.ini", "node_modules"} {
		if _, err := os.Lstat(filepath.Join(result.Path, name)); !os.IsNotExist(err) {
			t.Errorf("metadata was imported: %s (%v)", name, err)
		}
	}
	assertProjectArchiveTemporaryFilesRemoved(t, parent)
}

func TestProjectArchiveImportOnlyUnwrapsAMatchingProjectFolder(t *testing.T) {
	for _, test := range []struct {
		name, archive, target, file, expected string
	}{
		{"ZIP name", "Project.zip", "Imported", "Project/main.tex", "main.tex"},
		{"new project name", "download.zip", "Project", "Project/main.tex", "main.tex"},
		{"source folder", "Project.zip", "Imported", "src/main.tex", "src/main.tex"},
		{"top level file", "Project.zip", "Imported", "main.tex", "main.tex"},
	} {
		t.Run(test.name, func(t *testing.T) {
			archive := projectArchiveTestZIP(t, projectArchiveTestEntry{name: test.file, data: []byte("\\documentclass{article}")})
			result, err := extractProjectArchive(context.Background(), bytes.NewReader(archive), int64(len(archive)), test.archive, t.TempDir(), test.target)
			if err != nil {
				t.Fatal(err)
			}
			if result.Main != test.expected || result.Mode != "pdflatex" {
				t.Fatalf("project = %+v", result)
			}
			if _, err := os.Stat(filepath.Join(result.Path, filepath.FromSlash(test.expected))); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestProjectArchiveImportAcceptsAValidEmptyZIP(t *testing.T) {
	for _, entries := range [][]projectArchiveTestEntry{nil, {{name: "Project/", mode: os.ModeDir | 0755}}, {{name: ".DS_Store", data: []byte("metadata")}}} {
		archive := projectArchiveTestZIP(t, entries...)
		result, err := extractProjectArchive(context.Background(), bytes.NewReader(archive), int64(len(archive)), "Project.zip", t.TempDir(), "Empty")
		if err != nil {
			t.Fatal(err)
		}
		items, err := os.ReadDir(result.Path)
		if err != nil || len(items) != 0 || result.Main != "" || result.Mode != "pdflatex" {
			t.Fatalf("empty project = %+v, %v, %v", result, items, err)
		}
	}
}

func TestProjectArchiveImportRejectsUnsafeNamesAndSpecialFiles(t *testing.T) {
	for _, name := range []string{"../outside.tex", "folder/../../outside.tex", `folder\..\outside.tex`, "/outside.tex", `C:\outside.tex`, `\\server\outside.tex`, "folder//file.tex", "./file.tex", "folder/./file.tex", "NUL.tex", "CON", "COM1.txt", "LPT¹.txt", "CONIN$", "file.tex:extra", "folder./file.tex", "file.tex ", "file?.tex", "file\x00.tex", "file\n.tex", "invalid-\xff.tex"} {
		t.Run(name, func(t *testing.T) {
			archive := projectArchiveTestZIP(t, projectArchiveTestEntry{name: name, data: []byte("outside")})
			parent := t.TempDir()
			if _, err := extractProjectArchive(context.Background(), bytes.NewReader(archive), int64(len(archive)), "Project.zip", parent, "Project"); err == nil {
				t.Fatal("an unsafe ZIP path was accepted")
			}
			items, err := os.ReadDir(parent)
			if err != nil || len(items) != 0 {
				t.Fatalf("an invalid archive left files: %v, %v", items, err)
			}
		})
	}
	for _, mode := range []os.FileMode{os.ModeSymlink | 0777, os.ModeNamedPipe | 0600, os.ModeDevice | 0600, os.ModeSocket | 0600} {
		archive := projectArchiveTestZIP(t, projectArchiveTestEntry{name: "linked.tex", data: []byte("../outside.tex"), mode: mode})
		if _, err := extractProjectArchive(context.Background(), bytes.NewReader(archive), int64(len(archive)), "Project.zip", t.TempDir(), "Project"); err == nil {
			t.Fatalf("a special file was accepted: %s", mode)
		}
	}
}

func TestProjectArchiveImportRejectsAmbiguousPaths(t *testing.T) {
	for _, names := range [][]string{
		{"main.tex", "main.tex"}, {"main.tex", "MAIN.tex"},
		{"figures/a.png", "Figures/b.png"}, {"figures/a.png", `figures\a.png`},
		{"K.tex", "K.tex"}, {"σ.tex", "ς.tex"},
		{"folder", "folder/main.tex"}, {"folder/main.tex", "folder"},
		{"folder/", "folder/", "main.tex"}, {"Project/", "Project/", "Project/main.tex"},
	} {
		t.Run(strings.Join(names, ","), func(t *testing.T) {
			var entries []projectArchiveTestEntry
			for _, name := range names {
				entry := projectArchiveTestEntry{name: name, data: []byte("contents")}
				if strings.HasSuffix(name, "/") {
					entry.data, entry.mode = nil, os.ModeDir|0755
				}
				entries = append(entries, entry)
			}
			archive := projectArchiveTestZIP(t, entries...)
			if _, err := extractProjectArchive(context.Background(), bytes.NewReader(archive), int64(len(archive)), "Project.zip", t.TempDir(), "Project"); err == nil {
				t.Fatal("ambiguous ZIP paths were accepted")
			}
		})
	}
}

func TestProjectArchiveImportChecksDeclaredSizesAndEntryCountsBeforeExtraction(t *testing.T) {
	entry := func(name string, size uint64) *zip.File {
		return &zip.File{FileHeader: zip.FileHeader{Name: name, UncompressedSize64: size}}
	}
	for _, test := range []struct {
		name  string
		files []*zip.File
	}{
		{"individual size", []*zip.File{entry("main.tex", projectArchiveMaxFileSize+1)}},
		{"total size", []*zip.File{entry("a", projectArchiveMaxFileSize), entry("b", projectArchiveMaxFileSize), entry("c", projectArchiveMaxFileSize), entry("d", projectArchiveMaxFileSize), entry("e", 1)}},
		{"encrypted", []*zip.File{{FileHeader: zip.FileHeader{Name: "main.tex", Flags: 1}}}},
		{"reparse point", []*zip.File{{FileHeader: zip.FileHeader{Name: "main.tex", ExternalAttrs: 0x400}}}},
		{"folder data", []*zip.File{entry("folder/", 1)}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := inspectProjectArchive(&zip.Reader{File: test.files}, "Project.zip", "Project"); err == nil {
				t.Fatal("the invalid archive was accepted")
			}
		})
	}
	tooManyFiles := make([]*zip.File, projectArchiveMaxFiles+1)
	for index := range tooManyFiles {
		tooManyFiles[index] = entry(fmt.Sprintf("file-%d.tex", index), 0)
	}
	if _, err := inspectProjectArchive(&zip.Reader{File: tooManyFiles}, "Project.zip", "Project"); err == nil {
		t.Fatal("too many files were accepted")
	}
	if _, err := inspectProjectArchive(&zip.Reader{File: make([]*zip.File, projectArchiveMaxEntries+1)}, "Project.zip", "Project"); err == nil {
		t.Fatal("too many explicit entries were accepted")
	}
	implicitDirectories := make([]*zip.File, 5001)
	for index := range implicitDirectories {
		implicitDirectories[index] = entry(fmt.Sprintf("folder-%d/a/b/c/main.tex", index), 0)
	}
	if _, err := inspectProjectArchive(&zip.Reader{File: implicitDirectories}, "Project.zip", "Project"); err == nil {
		t.Fatal("too many implicit parent directories were accepted")
	}
}

func TestProjectArchiveImportRemovesIncompleteFilesAfterCRCFailure(t *testing.T) {
	archive := projectArchiveTestZIP(t,
		projectArchiveTestEntry{name: "first.tex", data: []byte("valid file")},
		projectArchiveTestEntry{name: "second.tex", data: []byte("damaged file")})
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	offset, err := reader.File[1].DataOffset()
	if err != nil {
		t.Fatal(err)
	}
	archive[offset] ^= 1
	parent := t.TempDir()
	if _, err := extractProjectArchive(context.Background(), bytes.NewReader(archive), int64(len(archive)), "Project.zip", parent, "Project"); err == nil {
		t.Fatal("a damaged file was imported")
	}
	items, err := os.ReadDir(parent)
	if err != nil || len(items) != 0 {
		t.Fatalf("a failed extraction left files: %v, %v", items, err)
	}
}

type projectArchiveReadHook struct {
	io.ReaderAt
	offset int64
	once   sync.Once
	action func()
}

func (reader *projectArchiveReadHook) ReadAt(buffer []byte, offset int64) (int, error) {
	if offset == reader.offset {
		reader.once.Do(reader.action)
	}
	return reader.ReaderAt.ReadAt(buffer, offset)
}

func TestProjectArchiveImportHandlesCancellationAndConcurrentDestinationCreation(t *testing.T) {
	for _, cancel := range []bool{true, false} {
		t.Run(fmt.Sprintf("cancel=%t", cancel), func(t *testing.T) {
			archive := projectArchiveTestZIP(t, projectArchiveTestEntry{name: "main.tex", data: []byte("\\documentclass{article}")})
			parsed, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
			if err != nil {
				t.Fatal(err)
			}
			offset, err := parsed.File[0].DataOffset()
			if err != nil {
				t.Fatal(err)
			}
			parent := t.TempDir()
			ctx, stop := context.WithCancel(context.Background())
			defer stop()
			reader := &projectArchiveReadHook{ReaderAt: bytes.NewReader(archive), offset: offset, action: func() {
				if cancel {
					stop()
				} else {
					writeTestFile(t, filepath.Join(parent, "Project", "original.txt"), []byte("existing content"))
				}
			}}
			_, err = extractProjectArchive(ctx, reader, int64(len(archive)), "Project.zip", parent, "Project")
			if err == nil || cancel && !errors.Is(err, context.Canceled) {
				t.Fatalf("unfinished import error = %v", err)
			}
			if cancel {
				if _, err := os.Lstat(filepath.Join(parent, "Project")); !os.IsNotExist(err) {
					t.Fatalf("cancelled import created the project: %v", err)
				}
			} else {
				data, err := os.ReadFile(filepath.Join(parent, "Project", "original.txt"))
				if err != nil || string(data) != "existing content" {
					t.Fatalf("the existing destination changed: %q, %v", data, err)
				}
				if _, err := os.Stat(filepath.Join(parent, "Project", "main.tex")); !os.IsNotExist(err) {
					t.Fatal("the import wrote into the competing project")
				}
			}
			assertProjectArchiveTemporaryFilesRemoved(t, parent)
		})
	}
}

func TestProjectArchiveImportLeavesExistingItemsUnchanged(t *testing.T) {
	archive := projectArchiveTestZIP(t, projectArchiveTestEntry{name: "main.tex", data: []byte("new project")})
	for _, kind := range []string{"file", "directory", "link"} {
		t.Run(kind, func(t *testing.T) {
			parent := t.TempDir()
			destination := filepath.Join(parent, "Project")
			sentinel := destination
			if kind == "directory" {
				sentinel = filepath.Join(destination, "original.txt")
			} else if kind == "link" {
				sentinel = filepath.Join(t.TempDir(), "original.txt")
			}
			writeTestFile(t, sentinel, []byte("existing content"))
			if kind == "link" {
				if err := os.Symlink(sentinel, destination); err != nil {
					t.Skipf("links unavailable: %v", err)
				}
			}
			if _, err := extractProjectArchive(context.Background(), bytes.NewReader(archive), int64(len(archive)), "Project.zip", parent, "Project"); err == nil {
				t.Fatal("an existing destination was accepted")
			}
			data, err := os.ReadFile(sentinel)
			if err != nil || string(data) != "existing content" {
				t.Fatalf("existing content = %q, %v", data, err)
			}
			assertProjectArchiveTemporaryFilesRemoved(t, parent)
		})
	}
}

func projectArchiveMultipartRequest(t *testing.T, archive []byte, parent, name string, extraField string) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	file, err := writer.CreateFormFile("archive", "Project.zip")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(archive); err != nil {
		t.Fatal(err)
	}
	for key, value := range map[string]string{"parent": parent, "name": name} {
		if err := writer.WriteField(key, value); err != nil {
			t.Fatal(err)
		}
	}
	if extraField != "" {
		if err := writer.WriteField(extraField, "unexpected"); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/project/import", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

func TestProjectArchiveImportHandlerCreatesTheProjectWithoutChangingTheOpenProject(t *testing.T) {
	a, current := testApp(t)
	archive := projectArchiveTestZIP(t, projectArchiveTestEntry{name: "main.tex", data: []byte("\\documentclass{article}")})
	request := projectArchiveMultipartRequest(t, archive, t.TempDir(), "Imported", "")
	response := httptest.NewRecorder()
	a.projectImportHandler(response, request)
	var result importedProjectArchive
	if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &result) != nil {
		t.Fatalf("import = %d %s", response.Code, response.Body.String())
	}
	if result.Main != "main.tex" || result.Mode != "pdflatex" || !filepath.IsAbs(result.Path) {
		t.Fatalf("created project = %+v", result)
	}
	if !samePath(a.project.Root, current) {
		t.Fatal("importing a project changed the current project")
	}
	assertProjectArchiveTemporaryFilesRemoved(t, a.options.ConfigDir)
}

func TestProjectArchiveImportHandlerRejectsMalformedRequestsAndRemovesUploadedFiles(t *testing.T) {
	a, _ := testApp(t)
	archive := projectArchiveTestZIP(t, projectArchiveTestEntry{name: "main.tex", data: []byte("project")})
	for _, test := range []struct {
		name, extra, destination string
		data                     []byte
		status                   int
	}{
		{"broken ZIP", "", "Project", []byte("not a ZIP"), http.StatusBadRequest},
		{"duplicate field", "name", "Project", archive, http.StatusBadRequest},
		{"unknown field", "other", "Project", archive, http.StatusBadRequest},
		{"invalid project name", "", "../outside", archive, http.StatusBadRequest},
		{"oversized field", "", strings.Repeat("x", 4097), archive, http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			parent := t.TempDir()
			request := projectArchiveMultipartRequest(t, test.data, parent, test.destination, test.extra)
			response := httptest.NewRecorder()
			a.projectImportHandler(response, request)
			if response.Code != test.status {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
			assertProjectArchiveTemporaryFilesRemoved(t, a.options.ConfigDir)
			assertProjectArchiveTemporaryFilesRemoved(t, parent)
		})
	}
	request := projectArchiveMultipartRequest(t, archive, t.TempDir(), "Project", "")
	request.ContentLength = projectArchiveMaxSize + 65<<10
	response := httptest.NewRecorder()
	a.projectImportHandler(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized request = %d %s", response.Code, response.Body.String())
	}
	assertProjectArchiveTemporaryFilesRemoved(t, a.options.ConfigDir)
}
