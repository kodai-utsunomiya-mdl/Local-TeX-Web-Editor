package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBuildRequestUsesTheSelectedDocumentAndKeepsTheFallback(t *testing.T) {
	a, root := testApp(t)
	main := "別の 文書/paper.tex"
	writeTestFile(t, filepath.Join(root, filepath.FromSlash(main)), []byte("\\documentclass{article}\n\\begin{document}Another paper\\end{document}\n"))
	a.config.TexBin = filepath.Join(t.TempDir(), "missing compiler")
	response := apiRequest(a, http.MethodPost, "/api/build", map[string]string{"main": main}, nil)
	var started Build
	if response.Code != http.StatusAccepted || json.Unmarshal(response.Body.Bytes(), &started) != nil {
		t.Fatalf("start: %d %s", response.Code, response.Body.String())
	}
	if started.Main != main || started.Status != "running" {
		t.Fatalf("the selected document was not captured: %#v", started)
	}
	a.workers.Wait()
	a.mu.Lock()
	finished := a.buildSnapshotLocked()
	fallback := a.project.Main
	configured := a.config.Projects[root].Main
	a.mu.Unlock()
	if finished.Main != main || finished.Status != "failed" || fallback != "main.tex" || configured != "main.tex" {
		t.Fatalf("build = %#v, fallback = %q, configured = %q", finished, fallback, configured)
	}
	response = apiRequest(a, http.MethodPost, "/api/build", map[string]string{}, nil)
	if response.Code != http.StatusAccepted || json.Unmarshal(response.Body.Bytes(), &started) != nil || started.Main != "main.tex" {
		t.Fatalf("an empty request did not use the fallback: %d %s", response.Code, response.Body.String())
	}
	a.workers.Wait()
}

func TestBuildRequestRejectsFilesOutsideTheProjectAndNonTeXFiles(t *testing.T) {
	a, root := testApp(t)
	writeTestFile(t, filepath.Join(root, "notes.md"), []byte("# Notes\n"))
	for _, main := range []string{"../other.tex", "sub/../../other.tex", `C:\outside.tex`, "/outside.tex", "notes.md", ".local-tex-editor/build/main.tex"} {
		response := apiRequest(a, http.MethodPost, "/api/build", map[string]string{"main": main}, nil)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%q: status = %d, body = %s", main, response.Code, response.Body.String())
		}
	}
	if a.build != nil {
		t.Fatal("a rejected document started a compiler")
	}
	outside := t.TempDir()
	writeTestFile(t, filepath.Join(outside, "paper.tex"), []byte("outside"))
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Skipf("symlink creation is unavailable: %v", err)
	}
	response := apiRequest(a, http.MethodPost, "/api/build", map[string]string{"main": "linked/paper.tex"}, nil)
	if response.Code != http.StatusForbidden {
		t.Fatalf("a linked document was accepted: %d %s", response.Code, response.Body.String())
	}
}

func TestDocumentsWithTheSameNameUseTheirOwnCompilerFiles(t *testing.T) {
	root := t.TempDir()
	var directories []string
	for _, main := range []string{"first/main.tex", "second/main.tex"} {
		project := Project{Root: root, Main: main, Mode: "project"}
		directory, err := ensureBuildDirectory(root, main)
		if err != nil {
			t.Fatal(err)
		}
		directories = append(directories, directory)
		relative, err := filepath.Rel(root, directory)
		if err != nil {
			t.Fatal(err)
		}
		relative = filepath.ToSlash(relative)
		arguments := strings.Join(latexmkArguments(project), "\n")
		if !strings.Contains(arguments, "-outdir="+relative+"\n-auxdir="+relative) || !strings.HasSuffix(arguments, "./"+main) {
			t.Fatalf("compiler files did not follow %q: %s", main, arguments)
		}
		writeTestFile(t, filepath.Join(directory, "shared-job.pdf"), []byte("%PDF-1.7\n"+main+"\n"))
		writeTestFile(t, filepath.Join(directory, "main.pdf"), []byte("%PDF-1.7\nstale conventional filename\n"))
		fdb := fmt.Sprintf("[\"latex\"] 1 \"./%s\" \"%s/shared-job.dvi\" \"shared-job\" 1 0\n[\"dvipdf\"] 1 \"%s/shared-job.dvi\" \"%s/shared-job.pdf\" \"shared-job\" 1 0\n", main, relative, relative, relative)
		writeTestFile(t, filepath.Join(directory, "shared-job.fdb_latexmk"), []byte(fdb))
		pdf, err := findOutputPDF(root, main, directory)
		if err != nil || !samePath(pdf, filepath.Join(directory, "shared-job.pdf")) {
			t.Fatalf("PDF for %q: %q, %v", main, pdf, err)
		}
		content, err := os.ReadFile(pdf)
		if err != nil || !strings.Contains(string(content), main) {
			t.Fatalf("PDF came from another document: %q, %v", content, err)
		}
	}
	if samePath(directories[0], directories[1]) {
		t.Fatal("two documents with the same basename shared compiler files")
	}
	if buildDirectoryRelative("main.tex") != buildRelative {
		t.Fatal("the existing main.tex compiler directory changed")
	}
}

func TestSuccessfulDocumentAndItsSyncTeXRemainAvailableAfterAnotherFails(t *testing.T) {
	a, root := testApp(t)
	other := "notes/other.tex"
	writeTestFile(t, filepath.Join(root, filepath.FromSlash(other)), []byte("\\documentclass{article}\n\\begin{document}Other\\end{document}\n"))
	successful := func(main string) string {
		t.Helper()
		project := *a.project
		project.Main = main
		directory, err := ensureBuildDirectory(root, main)
		if err != nil {
			t.Fatal(err)
		}
		original := filepath.Join(directory, "example.pdf")
		writeTestFile(t, original, []byte("%PDF-1.7\n"+main+"\n"))
		writeTestFile(t, filepath.Join(directory, "example.synctex"), []byte("SyncTeX Version:1\nInput:1:./"+main+"\nOutput:pdf\nContent:\n!1\nPostamble:\n"))
		id, err := randomID()
		if err != nil {
			t.Fatal(err)
		}
		pdf, err := a.copySuccessfulPDF(root, original, id)
		if err != nil {
			t.Fatal(err)
		}
		sources := snapshotSourceRevisions(root)
		sync, err := a.cacheSyncTeX(root, original, pdf, id, t.TempDir(), sources)
		if err != nil {
			t.Fatal(err)
		}
		now := time.Now()
		run := &buildRun{project: project, started: now, sources: sources, synctex: sync,
			result: Build{ID: id, Main: main, Status: "running", StartedAt: now.UTC().Format(time.RFC3339Nano)}}
		a.mu.Lock()
		a.build = run
		a.mu.Unlock()
		code := 0
		a.finishBuild(run, &code, nil, pdf, id)
		return id
	}
	firstID := successful("main.tex")
	failed := &buildRun{project: Project{Root: root, Main: other, Mode: a.project.Mode}, started: time.Now(), result: Build{ID: "failed-other", Main: other, Status: "running"}}
	a.mu.Lock()
	a.build = failed
	a.mu.Unlock()
	code := 1
	a.finishBuild(failed, &code, errors.New("TeX error"), "", "")
	a.mu.Lock()
	build := a.buildSnapshotLocked()
	a.mu.Unlock()
	if build.Main != other || build.PDFMain != "main.tex" || build.PDFBuildID != firstID || !build.SyncTeXReady || build.PDFSourceChanged {
		t.Fatalf("a failed document replaced the visible result: %#v", build)
	}
	version, err := a.syncVersion("", firstID)
	if err != nil || len(version.Inputs) != 1 || version.Inputs[0].Path != "main.tex" {
		t.Fatalf("the old PDF lost its own SyncTeX data: %#v, %v", version, err)
	}
	document, err := readDocument(root, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	document.Content += "% changed after the successful PDF\n"
	response := apiRequest(a, http.MethodPut, "/api/file", document, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("save: %s", response.Body.String())
	}
	a.mu.Lock()
	build = a.buildSnapshotLocked()
	a.mu.Unlock()
	if !build.PDFSourceChanged || build.PDFMain != "main.tex" {
		t.Fatalf("the visible PDF did not report later source edits: %#v", build)
	}
	lastID := successful(other)
	reopened, err := New(a.options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	reopened.mu.Lock()
	build = reopened.buildSnapshotLocked()
	fallback := reopened.project.Main
	reopened.mu.Unlock()
	if build == nil || !build.Restored || build.Main != other || build.PDFMain != other || build.PDFBuildID != lastID || !build.SyncTeXReady || build.PDFSourceChanged || fallback != "main.tex" {
		t.Fatalf("the last compiled document did not restore with its own metadata: %#v, fallback %q", build, fallback)
	}
}
