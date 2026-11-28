package app

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestMarkdownSavesFollowThePDFInputsAndSurviveRestart(t *testing.T) {
	for _, test := range []struct {
		name, path string
		recorder   bool
		during     bool
		changed    bool
	}{
		{"unrelated note", "notes.md", true, false, false},
		{"recorded note", "included/本文.md", true, false, true},
		{"custom conversion input", "converted.markdown", true, false, true},
		{"unrelated note during compilation", "notes.md", true, true, false},
		{"recorded note during compilation", "included/本文.md", true, true, true},
		{"recorder unavailable", "notes.md", false, false, true},
		{"bibliography", "references.bib", true, false, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			a, root := testApp(t)
			for _, path := range []string{"notes.md", "included/本文.md", "converted.markdown", "references.bib"} {
				writeTestFile(t, filepath.Join(root, filepath.FromSlash(path)), []byte("Original contents\n"))
			}
			directory, err := ensureBuildDirectory(root, "main.tex")
			if err != nil {
				t.Fatal(err)
			}
			original := filepath.Join(directory, "main.pdf")
			writeTestFile(t, original, []byte("%PDF-1.7\nRecorded PDF\n"))
			if test.recorder {
				writeTestFile(t, filepath.Join(directory, "main.fls"), []byte("INPUT ./main.tex\nINPUT ./included/本文.md\n"))
				writeTestFile(t, filepath.Join(directory, "main.fdb_latexmk"), []byte("[\"markdown conversion\"]\n  \"converted.markdown\" 1 18 hash \"\"\n"))
			}
			sources := snapshotSourceRevisions(root)
			id, err := randomID()
			if err != nil {
				t.Fatal(err)
			}
			pdf, err := a.copySuccessfulPDF(root, original, id)
			if err != nil {
				t.Fatal(err)
			}
			now := time.Now()
			run := &buildRun{project: *a.project, started: now, sources: sources,
				result: Build{ID: id, Main: "main.tex", Status: "running", StartedAt: now.UTC().Format(time.RFC3339Nano)}}
			a.build = run
			save := func() {
				document, err := readDocument(root, test.path)
				if err != nil {
					t.Fatal(err)
				}
				document.Content += "Changed contents\n"
				response := apiRequest(a, http.MethodPut, "/api/file", document, nil)
				if response.Code != http.StatusOK {
					t.Fatalf("save: %d %s", response.Code, response.Body.String())
				}
			}
			if test.during {
				save()
			}
			run.sources, run.markdownInputs = sourcesForPDF(root, root, "main.tex", original, sources)
			code := 0
			a.finishBuild(run, &code, nil, pdf, id)
			if !test.during {
				save()
			}
			check := func(app *App) {
				response := apiRequest(app, http.MethodGet, "/api/build", nil, nil)
				var build Build
				if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &build) != nil {
					t.Fatalf("build: %d %s", response.Code, response.Body.String())
				}
				if build.PDFBuildID != id || build.PDFMain != "main.tex" || build.SourceChanged != test.changed || build.PDFSourceChanged != test.changed {
					t.Fatalf("saved %s: %#v", test.path, build)
				}
				if test.recorder && !reflect.DeepEqual(build.PDFMarkdownInputs, []string{"converted.markdown", "included/本文.md"}) {
					t.Fatalf("recorded Markdown inputs = %#v", build.PDFMarkdownInputs)
				}
				if !test.recorder && build.PDFMarkdownInputs != nil {
					t.Fatalf("missing recorder was treated as an empty input list: %#v", build.PDFMarkdownInputs)
				}
			}
			check(a)
			reopened, err := New(a.options)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = reopened.Close() })
			reopened.SetAddress("127.0.0.1:8765")
			check(reopened)
		})
	}
}

func TestMarkdownSaveUsesTheVisiblePDFWhenAnotherDocumentFailed(t *testing.T) {
	for _, visibleUsesNote := range []bool{false, true} {
		a, root := testApp(t)
		writeTestFile(t, filepath.Join(root, "notes.md"), []byte("Original note\n"))
		a.lastPDF, a.lastPDFID, a.lastPDFMain = "cached.pdf", "visible", "main.tex"
		a.lastPDFMarkdownInputs = make(map[string]bool)
		a.build = &buildRun{result: Build{ID: "failed", Main: "other.tex", Status: "failed"}, markdownInputs: make(map[string]bool)}
		if visibleUsesNote {
			a.lastPDFMarkdownInputs["notes.md"] = true
		} else {
			a.build.markdownInputs["notes.md"] = true
		}
		document, err := readDocument(root, "notes.md")
		if err != nil {
			t.Fatal(err)
		}
		document.Content += "Edited note\n"
		response := apiRequest(a, http.MethodPut, "/api/file", document, nil)
		if response.Code != http.StatusOK {
			t.Fatal(response.Body.String())
		}
		response = apiRequest(a, http.MethodGet, "/api/build", nil, nil)
		var build Build
		if json.Unmarshal(response.Body.Bytes(), &build) != nil || build.PDFMain != "main.tex" || build.PDFSourceChanged != visibleUsesNote || build.SourceChanged == visibleUsesNote {
			t.Fatalf("visibleUsesNote = %v: %s", visibleUsesNote, response.Body.String())
		}
	}
}
