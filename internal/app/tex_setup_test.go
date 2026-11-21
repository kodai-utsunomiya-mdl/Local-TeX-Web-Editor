package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type texSetupTransport func(*http.Request) (*http.Response, error)

func (transport texSetupTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func fakeTeXSetup(t *testing.T) (*App, string, *atomic.Int32) {
	t.Helper()
	a, _ := testApp(t)
	parent := t.TempDir()
	archive := []byte("a verified distribution fixture")
	sum := sha256.Sum256(archive)
	requests := &atomic.Int32{}
	a.texSetupHooks = &texSetupHooks{
		archive: texSetupArchive{URL: "https://example.invalid/tinytex.exe", Filename: "tinytex.exe", SHA256: hex.EncodeToString(sum[:]), Bytes: int64(len(archive))},
		client: &http.Client{Transport: texSetupTransport(func(request *http.Request) (*http.Response, error) {
			requests.Add(1)
			return &http.Response{StatusCode: http.StatusOK, ContentLength: int64(len(archive)), Body: io.NopCloser(bytes.NewReader(archive)), Header: make(http.Header)}, nil
		})},
		extract: func(ctx context.Context, run *texSetupRun, path string) error {
			data, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(data, archive) {
				return errors.New("unexpected archive passed to extraction")
			}
			bin := texSetupBinDirectory(run.root)
			if err := os.MkdirAll(bin, 0700); err != nil {
				return err
			}
			for _, name := range []string{"latexmk", "synctex", "pdflatex", "lualatex", "xelatex", "xdvipdfmx", "uplatex", "dvipdfmx", "bibtex", "upbibtex", "biber", "upmendex", "tlmgr"} {
				if runtime.GOOS == "windows" {
					if name == "tlmgr" {
						name += ".bat"
					} else {
						name += ".exe"
					}
				}
				if err := os.WriteFile(filepath.Join(bin, name), []byte("fixture executable"), 0755); err != nil {
					return err
				}
			}
			if err := os.MkdirAll(filepath.Join(run.root, "tlpkg"), 0700); err != nil {
				return err
			}
			if err := os.WriteFile(filepath.Join(run.root, "tlpkg", "texlive.tlpdb"), []byte("name texlive.infra\ncategory TLCore\nrevision 1\n\nname latexmk\ncategory Package\nrevision 2\n\nname siunitx\ncategory Package\nrevision 3\nrunfiles size=2\n texmf-dist/tex/latex/siunitx/siunitx.sty\n\n"), 0600); err != nil {
				return err
			}
			return os.WriteFile(filepath.Join(run.root, "release-texlive.txt"), []byte("TeX Live version 2026\n"), 0600)
		},
		packages: func(context.Context, *texSetupRun) error { return nil },
		check:    func(context.Context, *texSetupRun) error { return nil },
	}
	return a, parent, requests
}

func texSetupStateForTest(t *testing.T, a *App) TeXSetupState {
	t.Helper()
	response := apiRequest(a, http.MethodGet, "/api/tex/setup", nil, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("setup state: %d %s", response.Code, response.Body.String())
	}
	var state TeXSetupState
	if err := json.Unmarshal(response.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	return state
}

func startTeXSetupForTest(t *testing.T, a *App, input any) TeXSetupState {
	t.Helper()
	response := apiRequest(a, http.MethodPost, "/api/tex/setup", input, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("start setup: %d %s", response.Code, response.Body.String())
	}
	var state TeXSetupState
	if err := json.Unmarshal(response.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	return state
}

func waitTeXSetupForTest(t *testing.T, a *App, status string) TeXSetupState {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		state := texSetupStateForTest(t, a)
		if state.Status != "running" && state.Status != "cancelling" {
			if state.Status != status {
				t.Fatalf("setup status = %s, want %s: error=%s log=%s", state.Status, status, state.Error, state.Log)
			}
			return state
		}
		if time.Now().After(deadline) {
			t.Fatalf("setup did not finish: %+v", state)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func awaitTeXSetupHook(t *testing.T, a *App, entered <-chan struct{}) {
	t.Helper()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatalf("setup did not reach the command: %+v", texSetupStateForTest(t, a))
	}
}

func TestTeXSetupInstallsRecordsAndReusesTheEnvironment(t *testing.T) {
	a, parent, requests := fakeTeXSetup(t)
	writeTestFile(t, filepath.Join(parent, "existing.txt"), []byte("existing parent content"))
	startTeXSetupForTest(t, a, texSetupInput{Consent: true, Operation: "install", Parent: parent})
	state := waitTeXSetupForTest(t, a, "succeeded")
	if !state.Managed || state.Cancelable || state.Stage != "complete" || state.DownloadedBytes != state.ArchiveBytes || state.Bin == "" {
		t.Fatalf("completed setup: %+v", state)
	}
	if a.config.TexBin != state.Bin || len(a.config.TeXInstallations) != 1 || validateManagedTeX(a.config.TeXInstallations[0]) != nil {
		t.Fatal("the completed environment was not selected and recorded")
	}
	if data, err := os.ReadFile(filepath.Join(parent, "existing.txt")); err != nil || string(data) != "existing parent content" {
		t.Fatal("the chosen parent was changed")
	}
	restarted := reopenCompiledPDFProjectForTest(t, a)
	restarted.texSetupHooks = a.texSetupHooks
	if state := texSetupStateForTest(t, restarted); !state.Managed || state.Bin != a.config.TexBin {
		t.Fatalf("managed environment after reopening: %+v", state)
	}
	startTeXSetupForTest(t, restarted, texSetupInput{Consent: true, Operation: "install", Parent: parent})
	again := waitTeXSetupForTest(t, restarted, "succeeded")
	if again.Directory != state.Directory || requests.Load() != 1 {
		t.Fatal("a completed environment was downloaded again")
	}
}

func TestTeXSetupRejectsAnArchiveBeforeExecutingIt(t *testing.T) {
	for _, failure := range []string{"hash", "size"} {
		t.Run(failure, func(t *testing.T) {
			a, parent, _ := fakeTeXSetup(t)
			a.config.TexBin = filepath.Join(parent, "existing-tex")
			previous := a.config.TexBin
			var extracted atomic.Bool
			a.texSetupHooks.extract = func(context.Context, *texSetupRun, string) error { extracted.Store(true); return nil }
			if failure == "hash" {
				a.texSetupHooks.archive.SHA256 = strings.Repeat("0", 64)
			} else {
				a.texSetupHooks.archive.Bytes++
			}
			startTeXSetupForTest(t, a, texSetupInput{Consent: true, Operation: "install", Parent: parent})
			state := waitTeXSetupForTest(t, a, "failed")
			if extracted.Load() || state.Error == "" || a.config.TexBin != previous {
				t.Fatal("an invalid archive was executed or changed the selected TeX")
			}
			assertCompiledPDFFileMissing(t, filepath.Dir(state.Directory))
			if _, err := os.Stat(parent); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestTeXSetupCancellationStopsWorkAndLeavesTheParent(t *testing.T) {
	a, parent, _ := fakeTeXSetup(t)
	started := make(chan struct{})
	a.texSetupHooks.packages = func(ctx context.Context, _ *texSetupRun) error { close(started); <-ctx.Done(); return ctx.Err() }
	start := startTeXSetupForTest(t, a, texSetupInput{Consent: true, Operation: "install", Parent: parent})
	awaitTeXSetupHook(t, a, started)
	wrong := apiRequest(a, http.MethodPost, "/api/tex/setup/stop", map[string]string{"id": "previous-job"}, nil)
	if wrong.Code != http.StatusConflict {
		t.Fatalf("stale stop: %d", wrong.Code)
	}
	response := apiRequest(a, http.MethodPost, "/api/tex/setup/stop", map[string]string{"id": start.ID}, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("stop: %d %s", response.Code, response.Body.String())
	}
	state := waitTeXSetupForTest(t, a, "cancelled")
	assertCompiledPDFFileMissing(t, filepath.Dir(state.Directory))
	if _, err := os.Stat(parent); err != nil {
		t.Fatal(err)
	}
	if a.config.TexBin != "" || len(a.config.TeXInstallations) != 0 {
		t.Fatal("cancelled setup changed settings")
	}
}

func TestTeXSetupRespectsSettingsChangedDuringInstallation(t *testing.T) {
	a, parent, _ := fakeTeXSetup(t)
	started, finish := make(chan struct{}), make(chan struct{})
	a.texSetupHooks.packages = func(context.Context, *texSetupRun) error { close(started); <-finish; return nil }
	startTeXSetupForTest(t, a, texSetupInput{Consent: true, Operation: "install", Parent: parent})
	awaitTeXSetupHook(t, a, started)
	selected := filepath.Join(parent, "another-existing-tex")
	response := apiRequest(a, http.MethodPut, "/api/settings", map[string]string{"texBin": selected}, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("choose another TeX: %d %s", response.Code, response.Body.String())
	}
	close(finish)
	state := waitTeXSetupForTest(t, a, "failed")
	if a.config.TexBin != selected || len(a.config.TeXInstallations) != 0 {
		t.Fatal("setup overwrote the user's newer choice")
	}
	assertCompiledPDFFileMissing(t, filepath.Dir(state.Directory))
}

func TestTeXSetupRequiresConsentAndSerializesCompilation(t *testing.T) {
	a, parent, _ := fakeTeXSetup(t)
	response := apiRequest(a, http.MethodPost, "/api/tex/setup", texSetupInput{Operation: "install", Parent: parent}, nil)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("missing consent: %d", response.Code)
	}
	started := make(chan struct{})
	a.texSetupHooks.packages = func(ctx context.Context, _ *texSetupRun) error { close(started); <-ctx.Done(); return ctx.Err() }
	startTeXSetupForTest(t, a, texSetupInput{Consent: true, Operation: "install", Parent: parent})
	awaitTeXSetupHook(t, a, started)
	for _, path := range []string{"/api/build", "/api/tex/setup"} {
		response := apiRequest(a, http.MethodPost, path, texSetupInput{Consent: true, Operation: "install", Parent: parent}, nil)
		if response.Code != http.StatusConflict {
			t.Fatalf("concurrent %s: %d %s", path, response.Code, response.Body.String())
		}
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.texSetup.state.Status != "cancelled" {
		t.Fatalf("close left setup running: %+v", a.texSetup.state)
	}
}

func TestTeXSetupPackagesUseOnlyTheRecordedSelectedEnvironment(t *testing.T) {
	a, parent, _ := fakeTeXSetup(t)
	response := apiRequest(a, http.MethodPost, "/api/tex/setup", texSetupInput{Consent: true, Operation: "packages", Packages: []string{"siunitx"}}, nil)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unmanaged TeX: %d", response.Code)
	}
	startTeXSetupForTest(t, a, texSetupInput{Consent: true, Operation: "install", Parent: parent})
	installed := waitTeXSetupForTest(t, a, "succeeded")
	var calls atomic.Int32
	a.texSetupHooks.packages = func(_ context.Context, run *texSetupRun) error {
		calls.Add(1)
		if !run.reinstall || len(run.state.Packages) != 1 || run.state.Packages[0] != "siunitx" {
			return errors.New("unexpected package arguments")
		}
		return nil
	}
	startTeXSetupForTest(t, a, texSetupInput{Consent: true, Operation: "packages", Packages: []string{"siunitx", "siunitx"}, Reinstall: true})
	state := waitTeXSetupForTest(t, a, "succeeded")
	if calls.Load() != 1 || state.Directory != installed.Directory || state.ArchiveBytes != 0 {
		t.Fatal("package operation did not use the selected environment")
	}
	if err := os.WriteFile(filepath.Join(installed.Directory, managedTeXMarker), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	response = apiRequest(a, http.MethodPost, "/api/tex/setup", texSetupInput{Consent: true, Operation: "packages", Packages: []string{"siunitx"}}, nil)
	if response.Code != http.StatusConflict || calls.Load() != 1 {
		t.Fatal("a changed ownership record allowed package changes")
	}
}

func TestTeXSetupCleanupDoesNotFollowALinkOutsideItsDirectory(t *testing.T) {
	parent, info, err := prepareTeXSetupParent(t.TempDir(), false)
	if err != nil {
		t.Fatal(err)
	}
	job, err := makeTeXSetupDirectory(parent, info)
	if err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	writeTestFile(t, filepath.Join(outside, "manuscript.tex"), []byte("keep this manuscript"))
	if err := os.Symlink(outside, filepath.Join(job.path, "linked-folder")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := removeTeXSetupDirectory(job); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(outside, "manuscript.tex")); err != nil || string(data) != "keep this manuscript" {
		t.Fatal("cleanup followed a link")
	}
}

func TestTeXSetupLogHasABoundedSize(t *testing.T) {
	a, _, _ := fakeTeXSetup(t)
	run := &texSetupRun{}
	data := bytes.Repeat([]byte("log line\n"), maxLogBytes)
	n, err := (texSetupOutput{a, run}).Write(data)
	if err != nil || n != len(data) || len(run.log) != maxLogBytes || !bytes.Equal(run.log, data[len(data)-maxLogBytes:]) {
		t.Fatal("setup log did not keep its bounded tail")
	}
}
