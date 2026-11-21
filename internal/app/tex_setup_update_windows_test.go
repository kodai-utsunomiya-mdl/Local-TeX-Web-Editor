//go:build windows

package app

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func texSetupWindowsUpdateFixture(t *testing.T) (*App, *texSetupRun) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "TinyTeX")
	bin := filepath.Join(root, "bin", "windows")
	for _, directory := range []string{bin, filepath.Join(root, "temp")} {
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := texSetupCommandPath(root); err != nil {
		t.Skipf("this test location cannot provide a TeX-compatible Windows path: %v", err)
	}
	return &App{}, &texSetupRun{root: root, bin: bin}
}

func TestTeXSetupSelfUpdateRunsOnlyThePreparedWindowsUpdater(t *testing.T) {
	a, run := texSetupWindowsUpdateFixture(t)
	temporary := filepath.Join(run.root, "temp")
	updater := filepath.Join(temporary, "updater-w32")
	writeTestFile(t, updater, []byte("@echo off\r\n>\"%~dp0stale.txt\" echo old updater\r\n"))
	writeTestFile(t, filepath.Join(temporary, "update-self.log"), []byte("old update log"))
	finish, err := a.prepareTeXSetupSelfUpdate(run, "tlmgr", []string{"--machine-readable", "--repository", "https://example.invalid/tlnet", "update", "--self"})
	if err != nil || finish == nil {
		t.Fatalf("preparing the self-update: %v", err)
	}
	var output bytes.Buffer
	if err := finish(context.Background(), &output); err != nil {
		t.Fatal(err)
	}
	assertCompiledPDFFileMissing(t, filepath.Join(temporary, "stale.txt"))
	if output.Len() != 0 {
		t.Fatalf("stale output was reported: %s", output.String())
	}
	writeTestFile(t, updater+".bat", []byte("@echo off\r\n>\"%~dp0stale.txt\" echo old batch\r\n"))
	writeTestFile(t, updater, []byte("@echo off\r\n>\"%~dp0update-self.log\" echo current update log\r\n>\"%~dp0finished.txt\" echo completed\r\nexit /b 0\r\n"))
	if err := finish(context.Background(), &output); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(temporary, "finished.txt"))
	if err != nil || !strings.Contains(string(data), "completed") {
		t.Fatalf("the prepared updater did not complete before returning: %s %v", data, err)
	}
	if !strings.Contains(output.String(), "current update log") || strings.Contains(output.String(), "old update log") {
		t.Fatalf("the updater log was not included: %s", output.String())
	}
	assertCompiledPDFFileMissing(t, updater)
	assertCompiledPDFFileMissing(t, updater+".bat")
	assertCompiledPDFFileMissing(t, filepath.Join(temporary, "update-self.log"))
	assertCompiledPDFFileMissing(t, filepath.Join(temporary, "stale.txt"))
}

func TestTeXSetupSelfUpdateRemovesItsEmptyWindowsTemporaryDirectory(t *testing.T) {
	a, run := texSetupWindowsUpdateFixture(t)
	finish, err := a.prepareTeXSetupSelfUpdate(run, "tlmgr", []string{"update", "--self"})
	if err != nil || finish == nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(run.root, "temp", "updater-w32"), []byte("@echo off\r\n>\"%~dp0update-self.log\" echo update complete\r\nexit /b 0\r\n"))
	if err := finish(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	assertCompiledPDFFileMissing(t, filepath.Join(run.root, "temp"))
	if !strings.Contains(string(run.log), "update complete") {
		t.Fatalf("the update log was removed before it was recorded: %s", run.log)
	}
}

func TestTeXSetupSelfUpdateReturnsWindowsUpdaterFailureAndLog(t *testing.T) {
	a, run := texSetupWindowsUpdateFixture(t)
	finish, err := a.prepareTeXSetupSelfUpdate(run, "tlmgr", []string{"update", "--self"})
	if err != nil || finish == nil {
		t.Fatal(err)
	}
	// The official updater starts a nested cmd process and redirects that
	// process to update-self.log. Its exit status must survive both shells.
	script := "@echo off\r\n" +
		"if [%1]==[:doit] goto :doit\r\n" +
		"cmd.exe /e:on/v:off/d/c call \"%~f0\" :doit 2^>\"%~dp0update-self.log\" 1^>^&2\r\n" +
		"rem\r\ngoto :eof\r\n" +
		":doit\r\necho update failed and restored its backup\r\nexit /b 9\r\n"
	writeTestFile(t, filepath.Join(run.root, "temp", "updater-w32"), []byte(script))
	var output bytes.Buffer
	err = finish(context.Background(), &output)
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 9 || !strings.Contains(output.String(), "restored its backup") {
		t.Fatalf("the updater failure was lost: %v; output=%s", err, output.String())
	}
}

func TestTeXSetupSelfUpdateHonorsCancellationAndOtherCommands(t *testing.T) {
	a, run := texSetupWindowsUpdateFixture(t)
	updater := filepath.Join(run.root, "temp", "updater-w32")
	writeTestFile(t, updater, []byte("existing update script"))
	for _, arguments := range [][]string{{"install", "xetex"}, {"update", "--all"}, {"--dry-run", "update", "--self"}, {"update", "--self", "--list"}} {
		finish, err := a.prepareTeXSetupSelfUpdate(run, "tlmgr", arguments)
		if err != nil || finish != nil {
			t.Fatalf("an unrelated command started an updater: %q, %v", arguments, err)
		}
		if data, err := os.ReadFile(updater); err != nil || string(data) != "existing update script" {
			t.Fatal("an unrelated command changed the updater")
		}
	}
	finish, err := a.prepareTeXSetupSelfUpdate(run, "tlmgr", []string{"update", "--self"})
	if err != nil || finish == nil {
		t.Fatal(err)
	}
	writeTestFile(t, updater, []byte("@echo off\r\n>\"%~dp0unexpected.txt\" echo ran after cancellation\r\n"))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := finish(ctx, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled update: %v", err)
	}
	assertCompiledPDFFileMissing(t, filepath.Join(run.root, "temp", "unexpected.txt"))
}

func TestTeXSetupSelfUpdateRejectsAWindowsUpdaterLinkedOutside(t *testing.T) {
	a, run := texSetupWindowsUpdateFixture(t)
	outside := filepath.Join(t.TempDir(), "outside.cmd")
	writeTestFile(t, outside, []byte("outside script"))
	if err := os.Symlink(outside, filepath.Join(run.root, "temp", "updater-w32")); err != nil {
		t.Skipf("symbolic links are unavailable: %v", err)
	}
	if finish, err := a.prepareTeXSetupSelfUpdate(run, "tlmgr", []string{"update", "--self"}); err == nil || finish != nil {
		t.Fatal("a linked updater was accepted")
	}
	if data, err := os.ReadFile(outside); err != nil || string(data) != "outside script" {
		t.Fatal("a file outside the installation was changed")
	}
}
