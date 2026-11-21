//go:build darwin

package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestExternalTeXMacNativeCancellationUsesTheAppleScriptErrorNumber(t *testing.T) {
	failure := errors.New("osascript exited with status 1")
	for _, text := range []string{"0:12: execution error: User canceled. (-128)\n", "0:12: 実行エラー: ユーザによってキャンセルされました。 (-128)\n"} {
		if err := externalTeXAppleScriptError(failure, text); !errors.Is(err, context.Canceled) {
			t.Fatalf("did not recognize native cancellation: %v", err)
		}
	}
	if err := externalTeXAppleScriptError(failure, "TeX log contains (-128)\n0:12: execution error: command failed (1)\n"); err != failure {
		t.Fatalf("changed the command's error to cancellation: %v", err)
	}
}

func TestExternalTeXMacTinyTeXOnlyRemovesItsOwnPathRegistration(t *testing.T) {
	environment := externalTeXCommandFixture(t)
	destination := t.TempDir()
	selectedLink := filepath.Join(destination, "tlmgr")
	if err := os.Symlink(environment.Manager, selectedLink); err != nil {
		t.Fatal(err)
	}
	otherTarget := filepath.Join(t.TempDir(), "pdflatex")
	writeTestFile(t, otherTarget, []byte("other TeX"))
	otherLink := filepath.Join(destination, "pdflatex")
	if err := os.Symlink(otherTarget, otherLink); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(environment.Bin, "pdflatex"), []byte("selected TeX"))
	writeTestFile(t, filepath.Join(environment.Directory, "tlpkg", "texlive.tlpdb"), []byte("depend opt_sys_bin:"+destination+"\n"))
	pathFile := filepath.Join(t.TempDir(), "TinyTeX")
	writeTestFile(t, pathFile, []byte(environment.Bin+"\n"))
	registration, err := inspectExternalTeXMacRegistration(environment, pathFile)
	if err != nil {
		t.Fatal(err)
	}
	if len(registration.Links) != 1 || registration.Links[0].Path != selectedLink || registration.PathFile != pathFile {
		t.Fatalf("wrong registration: %#v", registration)
	}
	// The fixture command records the same path removal made by tlmgr. It
	// leaves the other installation's command untouched.
	script := "#!/bin/sh\n[ \"$1\" = path ] && [ \"$2\" = remove ] || exit 9\n/bin/rm " + quoteExternalTeXShellArgument(selectedLink) + "\n"
	if err := os.WriteFile(environment.Manager, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	if err := unregisterExternalTeXMac(context.Background(), environment, registration, nil); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{selectedLink, pathFile} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("registration was not removed: %s (%v)", path, err)
		}
	}
	if target, err := os.Readlink(otherLink); err != nil || target != otherTarget {
		t.Fatalf("changed another installation: %q, %v", target, err)
	}
	if err := restoreExternalTeXMacRegistration(context.Background(), registration, nil); err != nil {
		t.Fatal(err)
	}
	if target, err := os.Readlink(selectedLink); err != nil || target != environment.Manager {
		t.Fatalf("did not restore canceled removal: %q, %v", target, err)
	}
	data, err := os.ReadFile(pathFile)
	if err != nil || string(data) != environment.Bin+"\n" {
		t.Fatalf("did not restore PATH entry: %q, %v", data, err)
	}
	writeTestFile(t, pathFile, []byte(filepath.Dir(otherTarget)+"\n"))
	registration, err = inspectExternalTeXMacRegistration(environment, pathFile)
	if err != nil || registration.PathFile != "" {
		t.Fatalf("claimed another installation's PATH entry: %#v, %v", registration, err)
	}
}

func TestExternalTeXMacCancelDoesNotOverwriteNewRegistration(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "tlmgr")
	newTarget := filepath.Join(directory, "new-manager")
	if err := os.Symlink(newTarget, path); err != nil {
		t.Fatal(err)
	}
	pathFile := filepath.Join(directory, "TinyTeX")
	writeTestFile(t, pathFile, []byte("new registration\n"))
	registration := externalTeXMacRegistration{Links: []externalTeXMacLink{{Path: path, Target: filepath.Join(directory, "old-manager")}}, PathFile: pathFile, PathData: "old registration\n"}
	if err := restoreExternalTeXMacRegistration(context.Background(), registration, nil); err != nil {
		t.Fatal(err)
	}
	if target, err := os.Readlink(path); err != nil || target != newTarget {
		t.Fatalf("overwrote a new link: %q, %v", target, err)
	}
	if data, err := os.ReadFile(pathFile); err != nil || string(data) != "new registration\n" {
		t.Fatalf("overwrote a new PATH entry: %q, %v", data, err)
	}
}
