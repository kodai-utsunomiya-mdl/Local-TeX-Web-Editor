package app

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func readProjectArchive(t *testing.T, data []byte) map[string][]byte {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	files := make(map[string][]byte)
	for _, entry := range reader.File {
		file, err := entry.Open()
		if err != nil {
			t.Fatal(err)
		}
		content, err := io.ReadAll(file)
		_ = file.Close()
		if err != nil {
			t.Fatal(err)
		}
		if _, exists := files[entry.Name]; exists {
			t.Fatalf("duplicate ZIP entry %q", entry.Name)
		}
		files[entry.Name] = content
	}
	return files
}

func archiveProjectHeaders(root string) map[string]string {
	return map[string]string{"X-Project-Root": url.PathEscape(root)}
}

func TestProjectArchiveDownloadIncludesInputsAndOmitsKnownOutputs(t *testing.T) {
	a, root := testApp(t)
	want := map[string][]byte{
		"main.tex":             []byte("\xef\xbb\xbf\\documentclass{article}\r\n\\begin{document}原稿\\end{document}\r\n"),
		"図/figure.pdf":         {0x25, 0x50, 0x44, 0x46, 0, 255},
		"図/photo.png":          {0, 1, 2, 255},
		"main.pdf":             []byte("A PDF may also be an input."),
		"main.aux":             []byte("\\newlabel{external}{{1}{1}}"),
		"main.bbl":             []byte("\\begin{thebibliography}{1}\\end{thebibliography}"),
		"main.ist":             []byte("heading_prefix \"custom\""),
		"refs.bib":             []byte("@book{key,title={A title}}"),
		"custom.sty":           []byte("\\ProvidesPackage{custom}"),
		"custom.cls":           []byte("\\ProvidesClass{custom}"),
		"custom.bst":           []byte("ENTRY {} {} {}"),
		".latexmkrc":           []byte("$pdf_mode = 1;\n"),
		"latexmkrc":            []byte("$bibtex_use = 2;\n"),
		"fonts/example.otf":    {0, 255, 0, 1},
		"data/results.log":     []byte("iteration 1: 0.5\n"),
		"data/predictions.out": []byte("positive\nnegative\n"),
		"data/main.log":        []byte("No neighbouring main.tex exists here.\n"),
		"empty.txt":            {},
	}
	for name, content := range want {
		writeTestFile(t, filepath.Join(root, filepath.FromSlash(name)), content)
	}
	if err := os.Mkdir(filepath.Join(root, "empty directory"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"main.log", "main.out", "main.toc", "main.run.xml", "main.synctex.gz", "main.fdb_latexmk", "main.bcf",
		".git/config", ".local-tex-editor/build/main.pdf", "__MACOSX/copy", ".DS_Store", "._main.tex", "Thumbs.db", "desktop.ini", "node_modules/a.js",
	} {
		writeTestFile(t, filepath.Join(root, filepath.FromSlash(name)), []byte("excluded"))
	}
	response := apiRequest(a, http.MethodPost, "/api/project/download", struct{}{}, archiveProjectHeaders(root))
	if response.Code != http.StatusOK {
		t.Fatalf("download: %d %s", response.Code, response.Body.String())
	}
	kind, parameters, err := mime.ParseMediaType(response.Header().Get("Content-Disposition"))
	if err != nil || kind != "attachment" || parameters["filename"] != filepath.Base(root)+".zip" || response.Header().Get("Content-Type") != "application/zip" {
		t.Fatalf("headers: %v (%v)", response.Header(), err)
	}
	files := readProjectArchive(t, response.Body.Bytes())
	for _, directory := range []string{"図/", "fonts/", "data/", "empty directory/"} {
		want[directory] = []byte{}
	}
	if len(files) != len(want) {
		t.Fatalf("ZIP entries: %v", files)
	}
	for name, content := range want {
		actual, exists := files[name]
		if !exists || !bytes.Equal(actual, content) {
			t.Errorf("entry %q: found=%v, content=%q", name, exists, actual)
		}
	}
}

func TestProjectArchiveDownloadRequiresTheCurrentProject(t *testing.T) {
	a, root := testApp(t)
	for _, test := range []struct {
		method  string
		headers map[string]string
		status  int
	}{
		{http.MethodGet, archiveProjectHeaders(root), http.StatusMethodNotAllowed},
		{http.MethodPost, nil, http.StatusBadRequest},
		{http.MethodPost, archiveProjectHeaders(filepath.Join(root, "other")), http.StatusConflict},
	} {
		response := apiRequest(a, test.method, "/api/project/download", struct{}{}, test.headers)
		if response.Code != test.status || response.Header().Get("Content-Type") == "application/zip" {
			t.Fatalf("request %s %v: %d %s", test.method, test.headers, response.Code, response.Body.String())
		}
	}
}

func TestProjectArchiveDoesNotFollowFileOrDirectoryLinks(t *testing.T) {
	a, root := testApp(t)
	outside := t.TempDir()
	writeTestFile(t, filepath.Join(outside, "private.txt"), []byte("outside project"))
	if err := os.Symlink(filepath.Join(outside, "private.txt"), filepath.Join(root, "linked.txt")); err != nil {
		t.Skipf("symbolic links are unavailable: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "linked directory")); err != nil {
		t.Fatal(err)
	}
	response := apiRequest(a, http.MethodPost, "/api/project/download", struct{}{}, archiveProjectHeaders(root))
	if response.Code != http.StatusOK {
		t.Fatalf("download: %d %s", response.Code, response.Body.String())
	}
	files := readProjectArchive(t, response.Body.Bytes())
	if len(files) != 1 || files["main.tex"] == nil {
		t.Fatalf("linked entries were included: %v", files)
	}
}

func TestProjectArchiveRejectsNamesThatCollideOnImport(t *testing.T) {
	for _, names := range [][2]string{{"Main.tex", "main.tex"}, {"K.tex", "\u212a.tex"}} {
		t.Run(names[0]+"-"+names[1], func(t *testing.T) {
			root := t.TempDir()
			writeTestFile(t, filepath.Join(root, names[0]), []byte("first"))
			file, err := os.OpenFile(filepath.Join(root, names[1]), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
			if errors.Is(err, os.ErrExist) {
				t.Skip("this filesystem already treats the names as equal")
			}
			if err != nil {
				t.Fatal(err)
			}
			_ = file.Close()
			_, err = inspectProjectArchiveSources(context.Background(), root, "")
			var failure *apiError
			if !errors.As(err, &failure) || failure.status != http.StatusBadRequest {
				t.Fatalf("case-fold collision: %v", err)
			}
		})
	}
}

func TestEmptyProjectArchiveCanBeImported(t *testing.T) {
	root := t.TempDir()
	snapshot, err := inspectProjectArchiveSources(context.Background(), root, "")
	if err != nil {
		t.Fatal(err)
	}
	source, err := createProjectArchive(context.Background(), root, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	defer source.close()
	reader, err := zip.NewReader(source.file, source.size)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := inspectProjectArchive(reader, source.name, filepath.Base(root))
	if err != nil || len(entries) != 0 {
		t.Fatalf("empty project import: %v, %v", entries, err)
	}
}

func TestProjectArchiveRejectsFilesChangedAfterInspection(t *testing.T) {
	for _, change := range []string{"edit", "add", "remove", "replace"} {
		t.Run(change, func(t *testing.T) {
			root := t.TempDir()
			name := filepath.Join(root, "main.tex")
			writeTestFile(t, name, []byte("original"))
			snapshot, err := inspectProjectArchiveSources(context.Background(), root, "")
			if err != nil {
				t.Fatal(err)
			}
			switch change {
			case "edit":
				writeTestFile(t, name, []byte("modified text"))
			case "add":
				writeTestFile(t, filepath.Join(root, "new.tex"), []byte("new text"))
			case "remove":
				if err := os.Remove(name); err != nil {
					t.Fatal(err)
				}
			case "replace":
				if err := os.Rename(name, filepath.Join(t.TempDir(), "original.tex")); err != nil {
					t.Fatal(err)
				}
				writeTestFile(t, name, []byte("original"))
				if err := os.Chtimes(name, snapshot.entries[0].info.ModTime(), snapshot.entries[0].info.ModTime()); err != nil {
					t.Fatal(err)
				}
			}
			source, err := createProjectArchive(context.Background(), root, snapshot)
			if source != nil {
				source.close()
				t.Fatal("changed project produced an archive")
			}
			var failure *apiError
			if !errors.As(err, &failure) || failure.status != http.StatusConflict {
				t.Fatalf("changed project: %v", err)
			}
		})
	}
}

func TestProjectArchiveRejectsAReplacedEmptyDirectory(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "empty")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	snapshot, err := inspectProjectArchiveSources(context.Background(), root, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(directory, filepath.Join(t.TempDir(), "previous")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(directory, snapshot.entries[0].info.Mode().Perm()); err != nil {
		t.Fatal(err)
	}
	modified := snapshot.entries[0].info.ModTime()
	if err := os.Chtimes(directory, modified, modified); err != nil {
		t.Fatal(err)
	}
	source, err := createProjectArchive(context.Background(), root, snapshot)
	if source != nil {
		source.close()
		t.Fatal("a replaced directory produced an archive")
	}
	var failure *apiError
	if !errors.As(err, &failure) || failure.status != http.StatusConflict {
		t.Fatalf("replaced directory: %v", err)
	}
}

type projectArchiveChangeWriter struct {
	io.WriteCloser
	change func()
}

func (writer *projectArchiveChangeWriter) Write(data []byte) (int, error) {
	if writer.change != nil {
		writer.change()
		writer.change = nil
	}
	return writer.WriteCloser.Write(data)
}

func TestProjectArchiveRejectsChangesWhileReading(t *testing.T) {
	root := t.TempDir()
	name := filepath.Join(root, "main.tex")
	writeTestFile(t, name, bytes.Repeat([]byte("original\n"), 20000))
	snapshot, err := inspectProjectArchiveSources(context.Background(), root, "")
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	archive := zip.NewWriter(&output)
	archive.RegisterCompressor(zip.Deflate, func(destination io.Writer) (io.WriteCloser, error) {
		compressor, err := flate.NewWriter(destination, flate.BestSpeed)
		if err != nil {
			return nil, err
		}
		return &projectArchiveChangeWriter{WriteCloser: compressor, change: func() {
			writeTestFile(t, name, bytes.Repeat([]byte("modified\n"), 20000))
			modified := snapshot.entries[0].info.ModTime().Add(time.Second)
			if err := os.Chtimes(name, modified, modified); err != nil {
				t.Fatal(err)
			}
		}}, nil
	})
	err = addProjectArchiveFile(context.Background(), archive, root, snapshot.entries[0], make([]byte, 4096))
	var failure *apiError
	if !errors.As(err, &failure) || failure.status != http.StatusConflict {
		t.Fatalf("file changed while reading: %v", err)
	}
	_ = archive.Close()
}

func TestProjectArchiveLimitsBeforeReadingFileContents(t *testing.T) {
	for _, test := range []struct {
		name  string
		sizes []int64
	}{
		{"one large file", []int64{projectArchiveMaxFileSize + 1}},
		{"total size", []int64{projectArchiveMaxFileSize, projectArchiveMaxFileSize, projectArchiveMaxFileSize, projectArchiveMaxFileSize, 1}},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			for index, size := range test.sizes {
				file, err := os.Create(filepath.Join(root, fmt.Sprintf("file-%d.bin", index)))
				if err != nil {
					t.Fatal(err)
				}
				err = file.Truncate(size)
				_ = file.Close()
				if err != nil {
					t.Fatal(err)
				}
			}
			_, err := inspectProjectArchiveSources(context.Background(), root, "")
			var failure *apiError
			if !errors.As(err, &failure) || failure.status != http.StatusRequestEntityTooLarge {
				t.Fatalf("size limit: %v", err)
			}
		})
	}
	root := t.TempDir()
	for index := 0; index <= projectArchiveMaxFiles; index++ {
		writeTestFile(t, filepath.Join(root, fmt.Sprintf("file-%05d.txt", index)), nil)
	}
	_, err := inspectProjectArchiveSources(context.Background(), root, "")
	var failure *apiError
	if !errors.As(err, &failure) || failure.status != http.StatusRequestEntityTooLarge {
		t.Fatalf("file count limit: %v", err)
	}
}

func TestProjectArchiveStopsWhenCancelledOrTheZIPIsTooLarge(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "main.tex"), []byte("original"))
	snapshot, err := inspectProjectArchiveSources(context.Background(), root, "")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if source, err := createProjectArchive(ctx, root, snapshot); source != nil || !errors.Is(err, context.Canceled) {
		if source != nil {
			source.close()
		}
		t.Fatalf("cancelled creation: %v", err)
	}
	file, err := os.CreateTemp(t.TempDir(), "archive-*")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	writer := &projectArchiveWriter{file: file, size: projectArchiveMaxSize - 2}
	n, err := writer.Write([]byte{1, 2, 3})
	var failure *apiError
	if n != 0 || !errors.As(err, &failure) || failure.status != http.StatusRequestEntityTooLarge {
		t.Fatalf("ZIP size limit: %d %v", n, err)
	}
}

func TestProjectArchiveSaveAsUsesTheSelectedDestinationAndCanCancel(t *testing.T) {
	a, root := testApp(t)
	destination := filepath.Join(t.TempDir(), "別の プロジェクト.zip")
	writeTestFile(t, destination, []byte("previous ZIP"))
	a.saveFilePicker = func(_ context.Context, name string) (string, error) {
		if name != filepath.Base(root)+".zip" {
			t.Errorf("suggested name: %q", name)
		}
		return destination, nil
	}
	response := apiRequest(a, http.MethodPost, "/api/project/save-as", struct{}{}, archiveProjectHeaders(root))
	if response.Code != http.StatusOK {
		t.Fatalf("save as: %d %s", response.Code, response.Body.String())
	}
	var saved struct{ Path string }
	if err := json.Unmarshal(response.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	actual, err := os.ReadFile(saved.Path)
	if err != nil {
		t.Fatal(err)
	}
	if len(readProjectArchive(t, actual)) != 1 {
		t.Fatal("saved ZIP is missing the manuscript")
	}
	a.saveFilePicker = func(context.Context, string) (string, error) { return "", nil }
	response = apiRequest(a, http.MethodPost, "/api/project/save-as", struct{}{}, archiveProjectHeaders(root))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"cancelled":true`) {
		t.Fatalf("cancelled Save As: %d %s", response.Code, response.Body.String())
	}
	current, err := os.ReadFile(destination)
	if err != nil || !bytes.Equal(current, actual) {
		t.Fatalf("cancel changed the destination: %v", err)
	}
	other := t.TempDir()
	writeTestFile(t, filepath.Join(other, "main.tex"), []byte("other project"))
	a.saveFilePicker = func(context.Context, string) (string, error) {
		a.mu.Lock()
		err := a.openProjectLocked(other)
		a.mu.Unlock()
		return destination, err
	}
	response = apiRequest(a, http.MethodPost, "/api/project/save-as", struct{}{}, archiveProjectHeaders(root))
	if response.Code != http.StatusConflict {
		t.Fatalf("project switch: %d %s", response.Code, response.Body.String())
	}
	current, err = os.ReadFile(destination)
	if err != nil || !bytes.Equal(current, actual) {
		t.Fatalf("project switch changed the destination: %v", err)
	}
}
