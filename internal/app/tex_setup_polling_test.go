package app

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func externalTeXForPollingTest(t *testing.T) (*App, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fixture uses a POSIX executable; real Windows tools are exercised in the MSIX checks")
	}
	a, _ := testApp(t)
	root, bin, _ := externalTeXTestTree(t)
	root, _ = filepath.EvalSymlinks(root)
	bin, _ = filepath.EvalSymlinks(bin)
	script := "#!/bin/sh\ncase \"$1\" in\n" +
		"-var-value=TEXMFROOT) printf '%s\\n' " + posixLiteral(root) + ";;\n" +
		"-var-value=TEXMFSYSVAR) printf '%s\\n' " + posixLiteral(filepath.Join(root, "texmf-var")) + ";;\n" +
		"-var-value=TEXMFSYSCONFIG) printf '%s\\n' " + posixLiteral(filepath.Join(root, "texmf-config")) + ";;\n" +
		"*) exit 2;;\nesac\n"
	if err := os.WriteFile(filepath.Join(bin, "kpsewhich"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	response := apiRequest(a, http.MethodPut, "/api/settings", map[string]any{"texBin": bin}, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("select external TeX: %d %s", response.Code, response.Body.String())
	}
	return a, root
}

func setTeXRootTimeForPollingTest(t *testing.T, root string) time.Time {
	t.Helper()
	before := time.Unix(1700000000, 0)
	if err := os.Chtimes(root, before, before); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(root)
	if err != nil {
		t.Fatal(err)
	}
	return info.ModTime()
}

func TestTeXSetupPollingWaitsToDiscoverEnvironmentUntilManagementFinishes(t *testing.T) {
	a, root := externalTeXForPollingTest(t)
	before := setTeXRootTimeForPollingTest(t, root)
	func() {
		// A deletion review owns this lock while it reads the installation.
		a.texSetupMu.Lock()
		defer a.texSetupMu.Unlock()
		state := texSetupStateForTest(t, a)
		if state.Status != "idle" || state.Environment != nil {
			t.Fatalf("status during the first inspection: %+v", state)
		}
		info, err := os.Stat(root)
		if err != nil || !info.ModTime().Equal(before) {
			t.Fatalf("polling wrote to the installation while management was reading it: %v", err)
		}
	}()
	state := texSetupStateForTest(t, a)
	if state.Environment == nil || !samePath(state.Environment.Directory, root) {
		t.Fatalf("status did not discover the installation after management finished: %+v", state)
	}
}

func TestTeXSetupPollingReusesEnvironmentAfterDeletionReview(t *testing.T) {
	a, root := externalTeXForPollingTest(t)
	review := teXDeletionForTest(t, a)
	before := setTeXRootTimeForPollingTest(t, root)
	state := texSetupStateForTest(t, a)
	if state.Environment == nil || !samePath(state.Environment.Directory, root) {
		t.Fatalf("status lost the reviewed installation: %+v", state)
	}
	info, err := os.Stat(root)
	if err != nil || !info.ModTime().Equal(before) {
		t.Fatalf("polling wrote to the installation after its deletion review: %v", err)
	}
	if current := teXDeletionForTest(t, a); current.Revision != review.Revision {
		t.Fatal("reading the setup status changed the reviewed files")
	}
}
