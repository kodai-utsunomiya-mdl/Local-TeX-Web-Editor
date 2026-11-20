package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func compiledPDFStateForTest(t *testing.T, a *App) State {
	t.Helper()
	response := apiRequest(a, http.MethodGet, "/api/state", nil, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("state: %d %s", response.Code, response.Body.String())
	}
	var state State
	if err := json.Unmarshal(response.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	return state
}

func finishCompiledPDFForTest(t *testing.T, a *App, root, main, name string, inputs map[string]bool) CompiledPDF {
	t.Helper()
	project := *a.project
	project.Main = main
	directory, err := ensureBuildDirectory(root, main)
	if err != nil {
		t.Fatal(err)
	}
	id, err := randomID()
	if err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(directory, name)
	writeTestFile(t, original, []byte("%PDF-1.7\n"+main+"\n"+id+"\n%%EOF\n"))
	stem := strings.TrimSuffix(name, filepath.Ext(name))
	writeTestFile(t, filepath.Join(directory, stem+".synctex"), []byte("SyncTeX Version:1\nInput:1:./"+main+"\nOutput:pdf\nContent:\n!1\nPostamble:\n"))
	fdb := fmt.Sprintf("[\"pdflatex\"] 1 %q %q %q 1 0\n", "./"+main, buildDirectoryRelative(main)+"/"+name, stem)
	writeTestFile(t, filepath.Join(directory, "current.fdb_latexmk"), []byte(fdb))
	found, err := findOutputPDF(root, main, directory)
	if err != nil || !samePath(found, original) {
		t.Fatalf("find the named PDF: %q %v", found, err)
	}
	pdf, err := a.copySuccessfulPDF(root, found, id)
	if err != nil {
		t.Fatal(err)
	}
	sources := snapshotSourceRevisions(root)
	for path := range sources {
		if !markdownSourceAffectsPDF(path, inputs) {
			delete(sources, path)
		}
	}
	sync, err := a.cacheSyncTeX(root, found, pdf, id, t.TempDir(), sources)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	run := &buildRun{project: project, started: now, sources: sources, markdownInputs: inputs, synctex: sync, pdfName: filepath.Base(found),
		result: Build{ID: id, Main: main, Status: "running", StartedAt: now.UTC().Format(time.RFC3339Nano)}}
	a.mu.Lock()
	a.build = run
	a.mu.Unlock()
	code := 0
	a.finishBuild(run, &code, nil, pdf, id)
	for _, value := range compiledPDFStateForTest(t, a).CompiledPDFs {
		if value.Main == main {
			return value
		}
	}
	t.Fatalf("compiled PDF for %q is missing", main)
	return CompiledPDF{}
}

func reopenCompiledPDFProjectForTest(t *testing.T, a *App) *App {
	t.Helper()
	reopened, err := New(a.options)
	if err != nil {
		t.Fatal(err)
	}
	reopened.SetAddress("127.0.0.1:8765")
	t.Cleanup(func() { _ = reopened.Close() })
	return reopened
}

func TestCompiledPDFsListEachDocumentWithItsActualNameAndRestore(t *testing.T) {
	a, root := testApp(t)
	for _, main := range []string{"notes/別の原稿.tex", "reports/final.tex"} {
		writeTestFile(t, filepath.Join(root, filepath.FromSlash(main)), []byte("\\documentclass{article}\n\\begin{document}Other\\end{document}\n"))
	}
	ordinary := []byte("%PDF-1.7\nExisting project file\n")
	writeTestFile(t, filepath.Join(root, "main.pdf"), ordinary)
	if initial := compiledPDFStateForTest(t, a); initial.CompiledPDFs == nil || len(initial.CompiledPDFs) != 0 {
		t.Fatalf("the initial compiled list is not empty: %#v", initial.CompiledPDFs)
	}
	want := []CompiledPDF{
		finishCompiledPDFForTest(t, a, root, "main.tex", "submission.pdf", nil),
		finishCompiledPDFForTest(t, a, root, "notes/別の原稿.tex", "日本語の PDF.pdf", map[string]bool{}),
		finishCompiledPDFForTest(t, a, root, "reports/final.tex", "submission.pdf", nil),
	}
	check := func(app *App) {
		t.Helper()
		state := compiledPDFStateForTest(t, app)
		if !reflect.DeepEqual(state.CompiledPDFs, want) {
			t.Fatalf("compiled PDF list changed: got %#v, want %#v", state.CompiledPDFs, want)
		}
		for _, value := range state.CompiledPDFs {
			path := filepath.Join(app.projectCacheDirectory(root), "pdf-"+value.BuildID+".pdf")
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if value.Size != info.Size() || !value.ModifiedAt.Equal(info.ModTime().UTC()) || !value.SyncTeXReady || value.SourceChanged {
				t.Fatalf("PDF file details: %#v", value)
			}
			response := apiRequest(app, http.MethodGet, "/api/pdf?build="+url.QueryEscape(value.BuildID), nil, map[string]string{"Range": "bytes=0-4"})
			if response.Code != http.StatusPartialContent || response.Body.String() != "%PDF-" {
				t.Fatalf("read %s: %d %s", value.Main, response.Code, response.Body.String())
			}
			if sync, err := app.syncVersion(root, value.BuildID); err != nil || len(sync.Inputs) != 1 || sync.Inputs[0].Path != value.Main {
				t.Fatalf("SyncTeX for %s: %#v %v", value.Main, sync, err)
			}
		}
		for _, file := range state.Project.Files {
			if strings.HasPrefix(file.Path, ".local-tex-editor/") {
				t.Fatalf("a compilation file appeared in the ordinary files: %s", file.Path)
			}
		}
		data, err := os.ReadFile(filepath.Join(root, "main.pdf"))
		if err != nil || string(data) != string(ordinary) {
			t.Fatalf("existing PDF changed: %q %v", data, err)
		}
	}
	check(a)
	reopened := reopenCompiledPDFProjectForTest(t, a)
	check(reopened)
	if state := compiledPDFStateForTest(t, reopened); !state.Build.Restored || state.Build.PDFBuildID != want[2].BuildID {
		t.Fatalf("the latest PDF did not reopen: %#v", state.Build)
	}
	otherRoot := t.TempDir()
	writeTestFile(t, filepath.Join(otherRoot, "main.tex"), []byte("Another project\n"))
	response := apiRequest(reopened, http.MethodPost, "/api/project/open", map[string]string{"path": otherRoot}, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("open another project: %s", response.Body.String())
	}
	if state := compiledPDFStateForTest(t, reopened); len(state.CompiledPDFs) != 0 {
		t.Fatalf("the other project has the previous PDFs: %#v", state.CompiledPDFs)
	}
	response = apiRequest(reopened, http.MethodGet, "/api/pdf?build="+want[0].BuildID, nil, nil)
	if response.Code != http.StatusGone {
		t.Fatalf("the previous project's PDF is available: %d", response.Code)
	}
	response = apiRequest(reopened, http.MethodPost, "/api/project/open", map[string]string{"path": root}, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("return to the project: %s", response.Body.String())
	}
	check(reopened)
}

func TestCompiledPDFsKeepEachLatestResultAndTheTwoRecentVersions(t *testing.T) {
	a, root := testApp(t)
	for _, main := range []string{"b.tex", "c.tex"} {
		writeTestFile(t, filepath.Join(root, main), []byte("\\documentclass{article}\n"))
	}
	a1 := finishCompiledPDFForTest(t, a, root, "main.tex", "first-name.pdf", nil)
	b1 := finishCompiledPDFForTest(t, a, root, "b.tex", "b.pdf", nil)
	c1 := finishCompiledPDFForTest(t, a, root, "c.tex", "c.pdf", nil)
	a2 := finishCompiledPDFForTest(t, a, root, "main.tex", "revised-name.pdf", nil)
	a3 := finishCompiledPDFForTest(t, a, root, "main.tex", "revised-name.pdf", nil)
	checkFiles := func(app *App, expired []CompiledPDF, available []CompiledPDF) {
		t.Helper()
		for _, value := range expired {
			for _, extension := range []string{".pdf", ".json", ".synctex.gz"} {
				path := filepath.Join(app.projectCacheDirectory(root), "pdf-"+value.BuildID+extension)
				if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("old version was not removed: %s, %v", path, err)
				}
			}
			if response := apiRequest(app, http.MethodGet, "/api/pdf?build="+value.BuildID, nil, nil); response.Code != http.StatusGone {
				t.Fatalf("old version status: %d", response.Code)
			}
		}
		for _, value := range available {
			response := apiRequest(app, http.MethodGet, "/api/pdf?build="+value.BuildID, nil, nil)
			if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), value.BuildID) {
				t.Fatalf("saved version is unavailable: %s, %d", value.Main, response.Code)
			}
			if _, err := app.syncVersion(root, value.BuildID); err != nil {
				t.Fatal(err)
			}
		}
	}
	checkFiles(a, []CompiledPDF{a1}, []CompiledPDF{a2, a3, b1, c1})
	reopened := reopenCompiledPDFProjectForTest(t, a)
	checkFiles(reopened, []CompiledPDF{a1}, []CompiledPDF{a2, a3, b1, c1})
	if list := compiledPDFStateForTest(t, reopened).CompiledPDFs; !reflect.DeepEqual(list, []CompiledPDF{b1, c1, a3}) {
		t.Fatalf("the latest result per document was not restored: %#v", list)
	}
	c2 := finishCompiledPDFForTest(t, reopened, root, "c.tex", "c.pdf", nil)
	checkFiles(reopened, []CompiledPDF{a1, a2, c1}, []CompiledPDF{a3, b1, c2})
	if len(reopened.pdfVersions) != 3 || len(reopened.pdfOrder) != 2 {
		t.Fatalf("unexpected number of versions: %d, %d", len(reopened.pdfVersions), len(reopened.pdfOrder))
	}
}

func TestCompiledPDFsKeepSuccessfulResultsAfterFailureAndCancellation(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		t.Run(fmt.Sprintf("cancelled=%t", cancelled), func(t *testing.T) {
			a, root := testApp(t)
			writeTestFile(t, filepath.Join(root, "other.tex"), []byte("\\documentclass{article}\n"))
			finishCompiledPDFForTest(t, a, root, "main.tex", "main.pdf", nil)
			finishCompiledPDFForTest(t, a, root, "other.tex", "other.pdf", nil)
			before := compiledPDFStateForTest(t, a).CompiledPDFs
			id, err := randomID()
			if err != nil {
				t.Fatal(err)
			}
			original := filepath.Join(root, filepath.FromSlash(buildDirectoryRelative("other.tex")), "other.pdf")
			writeTestFile(t, original, []byte("%PDF-1.7\nPartial output from the next attempt\n"))
			copied := ""
			if cancelled {
				copied, err = a.copySuccessfulPDF(root, original, id)
				if err != nil {
					t.Fatal(err)
				}
			}
			run := &buildRun{project: Project{Root: root, Main: "other.tex", Mode: a.project.Mode}, started: time.Now(), cancelRequested: cancelled,
				result: Build{ID: id, Main: "other.tex", Status: "running"}}
			a.build = run
			code := 1
			a.finishBuild(run, &code, errors.New("TeX failed"), copied, id)
			if got := compiledPDFStateForTest(t, a).CompiledPDFs; !reflect.DeepEqual(got, before) {
				t.Fatalf("an unsuccessful result changed the list: %#v", got)
			}
			for _, value := range before {
				response := apiRequest(a, http.MethodGet, "/api/pdf?build="+value.BuildID, nil, nil)
				if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), value.BuildID) {
					t.Fatalf("the successful PDF changed: %s", response.Body.String())
				}
			}
			if cancelled {
				if _, err := os.Stat(copied); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("the cancelled copy remains: %v", err)
				}
			}
		})
	}
}

func TestCompiledPDFsRestoreOlderMetadataAndSkipDamagedNewerResults(t *testing.T) {
	a, root := testApp(t)
	first := finishCompiledPDFForTest(t, a, root, "main.tex", "custom-name.pdf", nil)
	second := finishCompiledPDFForTest(t, a, root, "main.tex", "custom-name.pdf", nil)
	firstJSON := filepath.Join(a.projectCacheDirectory(root), "pdf-"+first.BuildID+".json")
	data, err := os.ReadFile(firstJSON)
	if err != nil {
		t.Fatal(err)
	}
	var metadata map[string]any
	if err := json.Unmarshal(data, &metadata); err != nil {
		t.Fatal(err)
	}
	delete(metadata, "name")
	data, err = json.Marshal(metadata)
	if err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, firstJSON, data)
	writeTestFile(t, filepath.Join(a.projectCacheDirectory(root), "pdf-"+second.BuildID+".pdf"), []byte("Incomplete PDF"))
	reopened := reopenCompiledPDFProjectForTest(t, a)
	first.Name = ""
	if list := compiledPDFStateForTest(t, reopened).CompiledPDFs; !reflect.DeepEqual(list, []CompiledPDF{first}) {
		t.Fatalf("the older result did not reopen: %#v", list)
	}
}

func TestCompiledPDFsTrackMarkdownInputsAndRestoreAfterSettingsChange(t *testing.T) {
	a, root := testApp(t)
	writeTestFile(t, filepath.Join(root, "other.tex"), []byte("\\documentclass{article}\n"))
	writeTestFile(t, filepath.Join(root, "notes.md"), []byte("Original note\n"))
	first := finishCompiledPDFForTest(t, a, root, "main.tex", "main.pdf", map[string]bool{"notes.md": true})
	second := finishCompiledPDFForTest(t, a, root, "other.tex", "other.pdf", map[string]bool{})
	document, err := readDocument(root, "notes.md")
	if err != nil {
		t.Fatal(err)
	}
	document.Content += "Changed note\n"
	if response := apiRequest(a, http.MethodPut, "/api/file", document, nil); response.Code != http.StatusOK {
		t.Fatalf("save note: %s", response.Body.String())
	}
	first.SourceChanged = true
	want := []CompiledPDF{first, second}
	if list := compiledPDFStateForTest(t, a).CompiledPDFs; !reflect.DeepEqual(list, want) {
		t.Fatalf("the note affected another PDF: %#v", list)
	}
	reopened := reopenCompiledPDFProjectForTest(t, a)
	if list := compiledPDFStateForTest(t, reopened).CompiledPDFs; !reflect.DeepEqual(list, want) {
		t.Fatalf("the inputs or change notice did not reopen: %#v", list)
	}
	if response := apiRequest(reopened, http.MethodPut, "/api/settings", map[string]string{"mode": "lualatex"}, nil); response.Code != http.StatusOK {
		t.Fatalf("change compilation settings: %s", response.Body.String())
	}
	second.SourceChanged = true
	want = []CompiledPDF{first, second}
	if list := compiledPDFStateForTest(t, reopened).CompiledPDFs; !reflect.DeepEqual(list, want) {
		t.Fatalf("settings change notices: %#v", list)
	}
	again := reopenCompiledPDFProjectForTest(t, reopened)
	if list := compiledPDFStateForTest(t, again).CompiledPDFs; !reflect.DeepEqual(list, want) {
		t.Fatalf("PDFs compiled with the previous settings did not reopen: %#v", list)
	}
}
