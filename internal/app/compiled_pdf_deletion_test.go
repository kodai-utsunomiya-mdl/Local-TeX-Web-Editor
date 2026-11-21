package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

type compiledPDFDeletionResult struct {
	Main            string   `json:"main"`
	DeletedBuildIDs []string `json:"deletedBuildIds"`
	State           State    `json:"state"`
}

func compiledPDFDeletionForTest(t *testing.T, a *App, entry CompiledPDF) compiledPDFDeletion {
	t.Helper()
	response := apiRequest(a, http.MethodGet, "/api/pdf/delete?main="+url.QueryEscape(entry.Main)+"&build="+url.QueryEscape(entry.BuildID), nil,
		map[string]string{"X-Project-Root": url.PathEscape(a.project.Root)})
	if response.Code != http.StatusOK {
		t.Fatalf("inspect compiled PDF: %d %s", response.Code, response.Body.String())
	}
	var inspection compiledPDFDeletion
	if err := json.Unmarshal(response.Body.Bytes(), &inspection); err != nil {
		t.Fatal(err)
	}
	if inspection.ProjectRoot != a.project.Root || inspection.Main != entry.Main || inspection.BuildID != entry.BuildID || inspection.Revision == "" {
		t.Fatalf("incomplete inspection: %+v", inspection)
	}
	return inspection
}

func compiledPDFDeletionInput(inspection compiledPDFDeletion) map[string]string {
	return map[string]string{"main": inspection.Main, "buildId": inspection.BuildID, "revision": inspection.Revision}
}

func deleteCompiledPDFForTest(t *testing.T, a *App, inspection compiledPDFDeletion) compiledPDFDeletionResult {
	t.Helper()
	response := apiRequest(a, http.MethodDelete, "/api/pdf/delete", compiledPDFDeletionInput(inspection),
		map[string]string{"X-Project-Root": url.PathEscape(inspection.ProjectRoot)})
	if response.Code != http.StatusOK {
		t.Fatalf("delete compiled PDF: %d %s", response.Code, response.Body.String())
	}
	var result compiledPDFDeletionResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func assertCompiledPDFFileMissing(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected removed path %q, got %v", path, err)
	}
}

func TestCompiledPDFDeletionRemovesAllVersionsAndLeavesOtherDocuments(t *testing.T) {
	a, root := testApp(t)
	writeTestFile(t, filepath.Join(root, "chapters", "appendix.tex"), []byte("appendix source"))
	writeTestFile(t, filepath.Join(root, "submission.pdf"), []byte("ordinary PDF copied into the project"))
	original, err := os.ReadFile(filepath.Join(root, "main.tex"))
	if err != nil {
		t.Fatal(err)
	}
	old := finishCompiledPDFForTest(t, a, root, "main.tex", "submission.pdf", nil)
	cache := a.projectCacheDirectory(root)
	oldFiles := map[string][]byte{}
	for _, extension := range []string{".pdf", ".json", ".synctex.gz"} {
		name := "pdf-" + old.BuildID + extension
		data, err := os.ReadFile(filepath.Join(cache, name))
		if err != nil {
			t.Fatal(err)
		}
		oldFiles[name] = data
	}
	selected := finishCompiledPDFForTest(t, a, root, "main.tex", "submission.pdf", nil)
	other := finishCompiledPDFForTest(t, a, root, "chapters/appendix.tex", "submission.pdf", nil)
	// Simulate an older cache record left on disk after a previous cleanup.
	for name, data := range oldFiles {
		writeTestFile(t, filepath.Join(cache, name), data)
	}
	writeTestFile(t, filepath.Join(root, buildRelative, "_minted-main", "snippet.pygtex"), []byte("generated code"))
	if err := os.Mkdir(filepath.Join(root, buildRelative, "empty-output"), 0700); err != nil {
		t.Fatal(err)
	}
	reserved := filepath.Join(root, buildRelative, "doc-00000000000000000000000000000000", "unlisted.pdf")
	writeTestFile(t, reserved, []byte("a different document's output"))
	before := compiledPDFStateForTest(t, a)
	inspection := compiledPDFDeletionForTest(t, a, selected)
	if inspection.Name != "submission.pdf" || inspection.VersionCount != 2 || inspection.FileCount < 10 || inspection.Size == 0 {
		t.Fatalf("missing output or prior cache files: %+v", inspection)
	}
	for _, item := range inspection.Entries {
		if strings.Contains(item.Path, "/doc-") || item.Path == "submission.pdf" && item.Area == "build" {
			t.Fatalf("another document or ordinary PDF was selected: %+v", item)
		}
	}
	result := deleteCompiledPDFForTest(t, a, inspection)
	wantIDs := []string{old.BuildID, selected.BuildID}
	sort.Strings(wantIDs)
	if !reflect.DeepEqual(result.DeletedBuildIDs, wantIDs) || result.Main != "main.tex" {
		t.Fatalf("deleted builds: %+v", result)
	}
	if len(result.State.CompiledPDFs) != 1 || result.State.CompiledPDFs[0].BuildID != other.BuildID || result.State.Build.PDFBuildID != other.BuildID {
		t.Fatalf("the other PDF changed: %+v", result.State)
	}
	if result.State.Build.ID != before.Build.ID || result.State.Build.Log != before.Build.Log {
		t.Fatal("deleting a PDF changed the compilation log")
	}
	for _, id := range wantIDs {
		for _, extension := range []string{".pdf", ".json", ".synctex.gz", ".synctex"} {
			assertCompiledPDFFileMissing(t, filepath.Join(cache, "pdf-"+id+extension))
		}
		if response := apiRequest(a, http.MethodGet, "/api/pdf?build="+url.QueryEscape(id), nil, nil); response.Code != http.StatusGone {
			t.Fatalf("deleted PDF still available: %d", response.Code)
		}
		if _, exists := a.synctexVersions[id]; exists {
			t.Fatalf("deleted SyncTeX version %q is still available", id)
		}
	}
	for _, relative := range []string{"submission.pdf", "current.fdb_latexmk", "_minted-main", "empty-output"} {
		assertCompiledPDFFileMissing(t, filepath.Join(root, buildRelative, relative))
	}
	for _, path := range []string{reserved, filepath.Join(root, buildDirectoryRelative(other.Main), "submission.pdf"), filepath.Join(cache, "pdf-"+other.BuildID+".pdf")} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("another document's file changed: %s: %v", path, err)
		}
	}
	if data, err := os.ReadFile(filepath.Join(root, "main.tex")); err != nil || string(data) != string(original) {
		t.Fatalf("source changed: %q %v", data, err)
	}
	if data, err := os.ReadFile(filepath.Join(root, "submission.pdf")); err != nil || string(data) != "ordinary PDF copied into the project" {
		t.Fatalf("ordinary PDF changed: %q %v", data, err)
	}
	reopened := reopenCompiledPDFProjectForTest(t, a)
	state := compiledPDFStateForTest(t, reopened)
	if len(state.CompiledPDFs) != 1 || state.CompiledPDFs[0].Main != other.Main {
		t.Fatalf("deleted PDF returned after reopening: %+v", state.CompiledPDFs)
	}
	newEntry := finishCompiledPDFForTest(t, reopened, root, selected.Main, "submission.pdf", nil)
	if newEntry.BuildID == selected.BuildID || len(compiledPDFStateForTest(t, reopened).CompiledPDFs) != 2 {
		t.Fatal("compiling again did not recreate the PDF")
	}
}

func TestCompiledPDFDeletionUsesRemainingPDFThenClearsTheLastPDF(t *testing.T) {
	a, root := testApp(t)
	writeTestFile(t, filepath.Join(root, "appendix.tex"), []byte("appendix"))
	first := finishCompiledPDFForTest(t, a, root, "main.tex", "main.pdf", nil)
	last := finishCompiledPDFForTest(t, a, root, "appendix.tex", "appendix.pdf", nil)
	before := compiledPDFStateForTest(t, a)
	result := deleteCompiledPDFForTest(t, a, compiledPDFDeletionForTest(t, a, last))
	if result.State.Build.ID != last.BuildID || result.State.Build.Main != last.Main || result.State.Build.Log != before.Build.Log {
		t.Fatalf("the build log changed: %+v", result.State.Build)
	}
	if !result.State.Build.PDFReady || result.State.Build.PDFBuildID != first.BuildID || result.State.Build.PDFMain != first.Main || !result.State.Build.SyncTeXReady {
		t.Fatalf("remaining PDF was not selected: %+v", result.State.Build)
	}
	assertCompiledPDFFileMissing(t, filepath.Join(root, buildDirectoryRelative(last.Main)))
	result = deleteCompiledPDFForTest(t, a, compiledPDFDeletionForTest(t, a, first))
	if len(result.State.CompiledPDFs) != 0 || result.State.Build.PDFReady || result.State.Build.PDFBuildID != "" || result.State.Build.PDFMain != "" || result.State.Build.SyncTeXReady {
		t.Fatalf("the last PDF was not cleared: %+v", result.State)
	}
	if len(a.pdfVersions) != 0 || len(a.pdfMains) != 0 || len(a.pdfOrder) != 0 || len(a.synctexVersions) != 0 {
		t.Fatal("deleted versions remain in memory")
	}
	state := compiledPDFStateForTest(t, reopenCompiledPDFProjectForTest(t, a))
	if len(state.CompiledPDFs) != 0 || state.Build != nil {
		t.Fatalf("the last PDF returned after reopening: %+v", state)
	}
	if response := apiRequest(a, http.MethodGet, "/api/pdf", nil, nil); response.Code != http.StatusNotFound {
		t.Fatalf("default PDF after deletion: %d", response.Code)
	}
}

func TestCompiledPDFDeletionPreservesFailedAndCancelledBuildLogs(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		status := "failed"
		if cancelled {
			status = "cancelled"
		}
		t.Run(status, func(t *testing.T) {
			a, root := testApp(t)
			writeTestFile(t, filepath.Join(root, "appendix.tex"), []byte("appendix"))
			writeTestFile(t, filepath.Join(root, "body.md"), []byte("body"))
			other := finishCompiledPDFForTest(t, a, root, "appendix.tex", "appendix.pdf", map[string]bool{"body.md": true})
			selected := finishCompiledPDFForTest(t, a, root, "main.tex", "main.pdf", nil)
			run := &buildRun{project: *a.project, started: time.Now(), cancelRequested: cancelled,
				result: Build{ID: "latest-attempt", Main: "main.tex", Status: "running"}}
			a.mu.Lock()
			a.build = run
			a.mu.Unlock()
			code := 1
			a.finishBuild(run, &code, errors.New("compilation did not finish"), "", "")
			before := compiledPDFStateForTest(t, a)
			result := deleteCompiledPDFForTest(t, a, compiledPDFDeletionForTest(t, a, selected))
			if result.State.Build.ID != "latest-attempt" || result.State.Build.Status != status || result.State.Build.Log != before.Build.Log {
				t.Fatalf("the unsuccessful build log changed: %+v", result.State.Build)
			}
			if result.State.Build.PDFBuildID != other.BuildID || result.State.Build.PDFMain != other.Main || !reflect.DeepEqual(result.State.Build.PDFMarkdownInputs, []string{"body.md"}) {
				t.Fatalf("remaining PDF metadata: %+v", result.State.Build)
			}
		})
	}
}

func TestCompiledPDFDeletionReviewsANewerBuild(t *testing.T) {
	a, root := testApp(t)
	first := finishCompiledPDFForTest(t, a, root, "main.tex", "first.pdf", nil)
	inspection := compiledPDFDeletionForTest(t, a, first)
	newer := finishCompiledPDFForTest(t, a, root, "main.tex", "newer.pdf", nil)
	for _, method := range []string{http.MethodGet, http.MethodDelete} {
		path := "/api/pdf/delete"
		var input any = compiledPDFDeletionInput(inspection)
		if method == http.MethodGet {
			path += "?main=main.tex&build=" + url.QueryEscape(first.BuildID)
			input = nil
		}
		response := apiRequest(a, method, path, input, map[string]string{"Accept-Language": "en"})
		var result struct {
			Error          string              `json:"error"`
			ReviewRequired bool                `json:"reviewRequired"`
			Inspection     compiledPDFDeletion `json:"inspection"`
			State          State               `json:"state"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if response.Code != http.StatusConflict || !result.ReviewRequired || result.Inspection.BuildID != newer.BuildID || result.Inspection.Name != "newer.pdf" || !strings.Contains(result.Error, "Review") {
			t.Fatalf("stale %s confirmation: %d %s", method, response.Code, response.Body.String())
		}
		if result.State.Build.PDFBuildID != newer.BuildID {
			t.Fatal("the conflict did not return the latest state")
		}
	}
	if response := apiRequest(a, http.MethodGet, "/api/pdf?build="+url.QueryEscape(newer.BuildID), nil, nil); response.Code != http.StatusOK {
		t.Fatalf("the newer PDF was changed: %d", response.Code)
	}
}

func TestCompiledPDFDeletionReviewsChangedFilesAndNewChildren(t *testing.T) {
	for _, change := range []string{"output contents", "cache contents", "new child"} {
		t.Run(change, func(t *testing.T) {
			a, root := testApp(t)
			entry := finishCompiledPDFForTest(t, a, root, "main.tex", "main.pdf", nil)
			aux := filepath.Join(root, buildRelative, "main.aux")
			writeTestFile(t, aux, []byte("before"))
			inspection := compiledPDFDeletionForTest(t, a, entry)
			target := aux
			if change == "cache contents" {
				target = filepath.Join(a.projectCacheDirectory(root), "pdf-"+entry.BuildID+".pdf")
			}
			if change == "new child" {
				writeTestFile(t, filepath.Join(root, buildRelative, "new-output.txt"), []byte("new content"))
			} else {
				info, err := os.Stat(target)
				if err != nil {
					t.Fatal(err)
				}
				data, err := os.ReadFile(target)
				if err != nil {
					t.Fatal(err)
				}
				data[len(data)-1] ^= 1
				writeTestFile(t, target, data)
				if err := os.Chtimes(target, info.ModTime(), info.ModTime()); err != nil {
					t.Fatal(err)
				}
			}
			response := apiRequest(a, http.MethodDelete, "/api/pdf/delete", compiledPDFDeletionInput(inspection), nil)
			var result struct {
				ReviewRequired bool                `json:"reviewRequired"`
				Inspection     compiledPDFDeletion `json:"inspection"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if response.Code != http.StatusConflict || !result.ReviewRequired || result.Inspection.Revision == inspection.Revision {
				t.Fatalf("changed files were not reviewed: %d %s", response.Code, response.Body.String())
			}
			if _, err := os.Stat(aux); err != nil {
				t.Fatal("the rejected deletion removed a file")
			}
			deleteCompiledPDFForTest(t, a, result.Inspection)
		})
	}
}

func TestCompiledPDFDeletionBlocksCompilationAndAnotherProject(t *testing.T) {
	a, root := testApp(t)
	entry := finishCompiledPDFForTest(t, a, root, "main.tex", "main.pdf", nil)
	inspection := compiledPDFDeletionForTest(t, a, entry)
	response := apiRequest(a, http.MethodDelete, "/api/pdf/delete", compiledPDFDeletionInput(inspection), map[string]string{"X-Project-Root": url.PathEscape(t.TempDir())})
	if response.Code != http.StatusConflict {
		t.Fatalf("another project: %d %s", response.Code, response.Body.String())
	}
	a.mu.Lock()
	a.build.result.Status = "running"
	a.mu.Unlock()
	for _, method := range []string{http.MethodGet, http.MethodDelete} {
		path := "/api/pdf/delete"
		if method == http.MethodGet {
			path += "?main=main.tex&build=" + url.QueryEscape(entry.BuildID)
		}
		response = apiRequest(a, method, path, compiledPDFDeletionInput(inspection), nil)
		if response.Code != http.StatusConflict {
			t.Errorf("running compilation: %s %d %s", method, response.Code, response.Body.String())
		}
	}
	a.mu.Lock()
	a.build.result.Status = "success"
	a.mu.Unlock()
	if _, err := os.Stat(filepath.Join(a.projectCacheDirectory(root), "pdf-"+entry.BuildID+".pdf")); err != nil {
		t.Fatal("a blocked operation removed the PDF")
	}
}

func TestCompiledPDFDeletionWaitsForAnotherInstanceToFinishCompiling(t *testing.T) {
	a, root := testApp(t)
	entry := finishCompiledPDFForTest(t, a, root, "main.tex", "main.pdf", nil)
	inspection := compiledPDFDeletionForTest(t, a, entry)
	ready := make(chan error, 1)
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		release, err := platform.AcquireProjectLock(root)
		ready <- err
		if err == nil {
			<-stop
			release()
		}
	}()
	if err := <-ready; err != nil {
		t.Fatal(err)
	}
	defer func() { close(stop); <-done }()
	response := apiRequest(a, http.MethodDelete, "/api/pdf/delete", compiledPDFDeletionInput(inspection), nil)
	if response.Code != http.StatusConflict {
		t.Fatalf("another instance's build: %d %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, buildRelative, "main.pdf")); err != nil {
		t.Fatal("a blocked deletion changed the build output")
	}
}

func TestCompiledPDFDeletionRemovesIncompleteCacheVersions(t *testing.T) {
	a, root := testApp(t)
	old := finishCompiledPDFForTest(t, a, root, "main.tex", "main.pdf", nil)
	latest := finishCompiledPDFForTest(t, a, root, "main.tex", "main.pdf", nil)
	cache := a.projectCacheDirectory(root)
	// A previous attempt may have removed either half of a cache record.
	if err := os.Remove(filepath.Join(cache, "pdf-"+old.BuildID+".json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(cache, "pdf-"+latest.BuildID+".pdf")); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(root, "main.tex"), filepath.Join(root, "renamed.tex")); err != nil {
		t.Fatal(err)
	}
	result := deleteCompiledPDFForTest(t, a, compiledPDFDeletionForTest(t, a, latest))
	if len(result.DeletedBuildIDs) != 2 || len(result.State.CompiledPDFs) != 0 {
		t.Fatalf("incomplete versions remain: %+v", result)
	}
	assertCompiledPDFFileMissing(t, filepath.Join(cache, "pdf-"+old.BuildID+".pdf"))
	assertCompiledPDFFileMissing(t, filepath.Join(cache, "pdf-"+latest.BuildID+".json"))
	if _, err := os.Stat(filepath.Join(root, "renamed.tex")); err != nil {
		t.Fatal(err)
	}
}

func TestCompiledPDFDeletionRejectsLinksToOutputAndCache(t *testing.T) {
	for _, area := range []string{"build", "cache"} {
		t.Run(area, func(t *testing.T) {
			a, root := testApp(t)
			entry := finishCompiledPDFForTest(t, a, root, "main.tex", "main.pdf", nil)
			inspection := compiledPDFDeletionForTest(t, a, entry)
			target := filepath.Join(root, buildRelative, "main.pdf")
			if area == "cache" {
				target = filepath.Join(a.projectCacheDirectory(root), "pdf-"+entry.BuildID+".pdf")
			}
			outside := filepath.Join(t.TempDir(), "outside.pdf")
			writeTestFile(t, outside, []byte("outside file"))
			if err := os.Remove(target); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(outside, target); err != nil {
				t.Skipf("symlinks are unavailable: %v", err)
			}
			response := apiRequest(a, http.MethodDelete, "/api/pdf/delete", compiledPDFDeletionInput(inspection), nil)
			if response.Code != http.StatusForbidden {
				t.Fatalf("linked %s output: %d %s", area, response.Code, response.Body.String())
			}
			if data, err := os.ReadFile(outside); err != nil || string(data) != "outside file" {
				t.Fatalf("outside file changed: %q %v", data, err)
			}
		})
	}
}

func TestCompiledPDFDeletionRechecksTheConfirmedTreeBeforeRemovingFiles(t *testing.T) {
	a, root := testApp(t)
	entry := finishCompiledPDFForTest(t, a, root, "main.tex", "main.pdf", nil)
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cacheMu.Lock()
	defer a.cacheMu.Unlock()
	inspection, err := a.inspectCompiledPDFDeletionLocked(context.Background(), entry.Main)
	if err != nil {
		t.Fatal(err)
	}
	added := filepath.Join(root, buildRelative, "new.aux")
	writeTestFile(t, added, []byte("created after confirmation"))
	err = a.removeCompiledPDFDeletionLocked(context.Background(), inspection)
	var failure *apiError
	if !errors.As(err, &failure) || failure.status != http.StatusConflict {
		t.Fatalf("new output file: %v", err)
	}
	for _, path := range []string{added, filepath.Join(root, buildRelative, "main.pdf"), filepath.Join(a.projectCacheDirectory(root), "pdf-"+entry.BuildID+".pdf")} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("changed tree was partially removed: %s: %v", path, err)
		}
	}
}
