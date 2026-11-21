package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func externalTeXCommandFixture(t *testing.T) TeXEnvironment {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(root, "bin", "test-platform")
	if err := os.MkdirAll(bin, 0700); err != nil {
		t.Fatal(err)
	}
	manager := filepath.Join(bin, "tlmgr")
	if err := os.WriteFile(manager, []byte("#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"$@\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	return TeXEnvironment{Directory: root, Bin: bin, Manager: manager, CanUninstall: true, Writable: true, Format: "tinytex"}
}

func TestExternalTeXCommandRejectsPathsOutsideTheSelectedInstallation(t *testing.T) {
	environment := externalTeXCommandFixture(t)
	if err := checkExternalTeXCommandPaths(environment, environment.Manager, environment.Directory); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "tool")
	if err := os.WriteFile(outside, []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, paths := range [][2]string{{outside, environment.Directory}, {environment.Manager, filepath.Dir(outside)}, {environment.Manager, "."}} {
		if err := checkExternalTeXCommandPaths(environment, paths[0], paths[1]); err == nil {
			t.Fatalf("accepted paths %q", paths)
		}
	}
	t.Run("changed link", func(t *testing.T) {
		linked := filepath.Join(environment.Bin, "linked-manager")
		if err := os.Symlink(outside, linked); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		if err := checkExternalTeXCommandPaths(environment, linked, environment.Directory); err == nil {
			t.Fatal("accepted a link to a different installation")
		}
	})
}

func TestExternalTeXShellCommandPassesEveryArgumentLiterally(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell command")
	}
	environment := externalTeXCommandFixture(t)
	path := filepath.Join(environment.Bin, "tlmgr's $tool")
	if err := os.Rename(environment.Manager, path); err != nil {
		t.Fatal(err)
	}
	environment.Manager = path
	arguments := []string{"install", "space and quote ' \" ; $(false) `false` $HOME", "", "日本語", "one\ntwo"}
	script, err := elevatedExternalTeXShellCommand(environment, path, arguments, environment.Directory)
	if err != nil {
		t.Fatal(err)
	}
	data, err := exec.Command("/bin/sh", "-c", script).Output()
	if err != nil {
		t.Fatal(err)
	}
	want := environment.Directory + "\n" + strings.Join(arguments, "\n") + "\n"
	if string(data) != want {
		t.Fatalf("got %q, want %q", data, want)
	}
	if _, err := elevatedExternalTeXShellCommand(environment, path, []string{"bad\x00argument"}, environment.Directory); err == nil {
		t.Fatal("accepted a NUL in an argument")
	}
	other := filepath.Join(environment.Bin, "other")
	if err := os.WriteFile(other, []byte("#!/bin/sh\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := elevatedExternalTeXShellCommand(environment, other, nil, environment.Directory); err == nil {
		t.Fatal("accepted a different program for elevated execution")
	}
}

func TestExternalTeXInstallCheckUsesTheOriginalPackageArguments(t *testing.T) {
	archive := "https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2025/tlnet-final"
	for _, test := range []struct {
		arguments []string
		want      []string
	}{
		{nil, nil},
		{[]string{"install", "amsmath", "blindtext"}, []string{"install", "--dry-run", "amsmath", "blindtext"}},
		{[]string{"install", "--reinstall", "amsmath"}, []string{"install", "--dry-run", "--reinstall", "amsmath"}},
		{[]string{"--repository", archive, "install", "amsmath"}, nil},
		{[]string{"remove", "--no-depends-at-all", "blindtext"}, nil},
	} {
		original := append([]string(nil), test.arguments...)
		if got := externalTeXInstallCheckArguments(test.arguments); !reflect.DeepEqual(got, test.want) {
			t.Errorf("check arguments = %#v, want %#v", got, test.want)
		}
		if !reflect.DeepEqual(test.arguments, original) {
			t.Fatalf("changed the arguments for the actual operation: %#v", test.arguments)
		}
	}
}

func TestExternalTeXInstallCheckProcess(t *testing.T) {
	switch os.Getenv("LOCAL_TEX_INSTALL_CHECK_TEST") {
	case "mismatch":
		fmt.Fprintln(os.Stdout, "tlmgr: package repository https://mirror.ctan.org/systems/texlive/tlnet")
		fmt.Fprintln(os.Stderr, "Local TeX Live (2025) is older than remote repository (2026).")
		os.Exit(23)
	case "network":
		fmt.Fprintln(os.Stderr, "tlmgr: unable to connect to the repository")
		os.Exit(17)
	case "success":
		fmt.Fprintln(os.Stdout, "tlmgr install: dry run, no changes will be made")
		os.Exit(0)
	}
}

func TestExternalTeXInstallCheckReturnsTheRepositoryErrorAndOutput(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	archive := "https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2025/tlnet-final"
	for _, test := range []struct {
		name, mode, repository, archive string
		code                            int
	}{
		{"older CTAN installation", "mismatch", "https://mirror.ctan.org/systems/texlive/tlnet", archive, 23},
		{"custom repository", "mismatch", "https://tex.example/private", "", 23},
		{"network error", "network", "ctan", "", 17},
		{"same release", "success", "ctan", "", 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, executable, "-test.run=^TestExternalTeXInstallCheckProcess$")
			command.Env = append(os.Environ(), "LOCAL_TEX_INSTALL_CHECK_TEST="+test.mode)
			var output bytes.Buffer
			err := runExternalTeXInstallCheck(ctx, command, &output)
			if test.code == 0 {
				if err != nil {
					t.Fatal(err)
				}
			} else {
				var exitError *exec.ExitError
				if !errors.As(err, &exitError) || exitError.ExitCode() != test.code {
					t.Fatalf("exit error = %v, want code %d", err, test.code)
				}
			}
			if !strings.Contains(output.String(), "[command] ") || !strings.Contains(output.String(), "tlmgr") {
				t.Fatalf("command output did not reach the application: %s", output.String())
			}
			if got := archivedTeXRepository(test.repository, output.String()); got != test.archive {
				t.Fatalf("archive = %q, want %q; output: %s", got, test.archive, output.String())
			}
		})
	}
}

func TestExternalTeXInstallCheckHonorsCancellationBeforeStarting(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	command := exec.CommandContext(ctx, "must-not-start")
	var output bytes.Buffer
	if err := runExternalTeXInstallCheck(ctx, command, &output); !errors.Is(err, context.Canceled) {
		t.Fatalf("lost cancellation: %v", err)
	}
	if command.Process != nil || output.Len() != 0 {
		t.Fatal("started a check after cancellation")
	}
}

func TestExternalTeXNativeWaitProcess(t *testing.T) {
	if os.Getenv("LOCAL_TEX_NATIVE_WAIT_TEST") != "1" {
		return
	}
	fmt.Fprintln(os.Stdout, "native-command-ready")
	var data [1]byte
	_, _ = os.Stdin.Read(data[:])
	os.Exit(0)
}

type externalTeXReadyOutput struct {
	bytes.Buffer
	ready chan struct{}
	once  sync.Once
}

func (output *externalTeXReadyOutput) Write(data []byte) (int, error) {
	if bytes.Contains(data, []byte("native-command-ready")) {
		output.once.Do(func() { close(output.ready) })
	}
	return output.Buffer.Write(data)
}

func TestExternalTeXWaitsForNativeCompletionAfterCancellation(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(executable, "-test.run=^TestExternalTeXNativeWaitProcess$")
	command.Env = append(os.Environ(), "LOCAL_TEX_NATIVE_WAIT_TEST=1")
	input, release := io.Pipe()
	defer input.Close()
	defer release.Close()
	command.Stdin = input
	output := &externalTeXReadyOutput{ready: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan error, 1)
	go func() { finished <- waitNativeTeXCommand(ctx, command, output) }()
	select {
	case <-output.ready:
	case err := <-finished:
		t.Fatalf("command ended before it was ready: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("command did not start")
	}
	cancel()
	select {
	case err := <-finished:
		t.Fatalf("released the operation while its child was running: %v", err)
	default:
	}
	_, _ = release.Write([]byte("x"))
	_ = release.Close()
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("command did not finish")
	}
	if !strings.Contains(output.String(), "native-command-ready") {
		t.Fatal("native output was not returned")
	}
}

func TestExternalTeXUninstallRequiresTheTrashOperationToRemoveTheRoot(t *testing.T) {
	environment := externalTeXCommandFixture(t)
	if err := externalTeXUninstallResult(environment, nil); err == nil {
		t.Fatal("reported an existing root as removed")
	}
	if err := externalTeXUninstallResult(environment, context.Canceled); !errors.Is(err, context.Canceled) {
		t.Fatalf("lost cancellation: %v", err)
	}
	if err := os.Rename(environment.Directory, environment.Directory+"-trashed"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(environment.Directory + "-trashed") })
	if err := externalTeXUninstallResult(environment, nil); err != nil {
		t.Fatal(err)
	}
}
