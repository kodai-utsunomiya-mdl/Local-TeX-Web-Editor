//go:build windows

package app

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"unsafe"
)

func TestExternalTeXWindowsArgumentsRoundTripThroughTheNativeParser(t *testing.T) {
	want := []string{"tool.exe", "", `quote"here`, `C:\path with spaces\`, "日本語", "';&%PATH%$()", "one\ntwo"}
	line, err := syscall.UTF16PtrFromString(externalTeXWindowsArguments(want))
	if err != nil {
		t.Fatal(err)
	}
	var count int32
	arguments, _, callErr := externalTeXShell32.NewProc("CommandLineToArgvW").Call(uintptr(unsafe.Pointer(line)), uintptr(unsafe.Pointer(&count)))
	if arguments == 0 {
		t.Fatal(callErr)
	}
	defer externalTeXKernel32.NewProc("LocalFree").Call(arguments)
	var got []string
	for _, pointer := range unsafe.Slice((**uint16)(unsafe.Pointer(arguments)), int(count)) {
		var wide []uint16
		for index := 0; index < 32768; index++ {
			character := *(*uint16)(unsafe.Add(unsafe.Pointer(pointer), index*2))
			if character == 0 {
				break
			}
			wide = append(wide, character)
		}
		got = append(got, syscall.UTF16ToString(wide))
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestExternalTeXWindowsNativeStructLayouts(t *testing.T) {
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		t.Skip("64-bit Windows layout")
	}
	if got := unsafe.Sizeof(externalTeXShellExecuteInfo{}); got != 112 {
		t.Fatalf("SHELLEXECUTEINFO size = %d, want 112", got)
	}
	if got := unsafe.Sizeof(externalTeXFileOperation{}); got != 56 {
		t.Fatalf("SHFILEOPSTRUCT size = %d, want 56", got)
	}
}

func TestExternalTeXWindowsUninstallerChecksItsRecordedLocations(t *testing.T) {
	environment := externalTeXCommandFixture(t)
	environment.Uninstaller = filepath.Join(environment.Directory, "tlpkg", "installer", "uninst.bat")
	environment.SystemDirectories = []string{filepath.Join(environment.Directory, "texmf-var"), filepath.Join(environment.Directory, "texmf-config")}
	first := "setlocal\r\npath " + environment.Directory + `\tlpkg\tlperl\bin;` + environment.Directory + "\\bin\\windows;%path%\r\n"
	second := "rmdir /s /q \"" + environment.Directory + "\\bin\"\r\nrem del /q \"" + environment.Directory + "\\texlive.profile\"\r\nrd \"" + environment.Directory + "\"\r\ndel \"%0\"\r\n"
	writeTestFile(t, environment.Uninstaller, []byte(first))
	secondPath := filepath.Join(filepath.Dir(environment.Uninstaller), "uninst2.bat")
	writeTestFile(t, secondPath, []byte(second))
	if err := checkExternalTeXWindowsUninstaller(environment); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, secondPath, []byte(second+"rmdir /s /q \""+filepath.Join(filepath.Dir(environment.Directory), "other-year")+"\"\r\n"))
	if err := checkExternalTeXWindowsUninstaller(environment); err == nil {
		t.Fatal("accepted removal of a different installation")
	}
	writeTestFile(t, secondPath, []byte(second))
	writeTestFile(t, environment.Uninstaller, []byte(strings.ReplaceAll(first, environment.Directory, filepath.Join(filepath.Dir(environment.Directory), "moved-from"))))
	if err := checkExternalTeXWindowsUninstaller(environment); err == nil {
		t.Fatal("accepted an uninstaller aimed at the old installation path")
	}
}

func TestExternalTeXWindowsOfficialUninstallReportsRemainingSettings(t *testing.T) {
	environment := externalTeXCommandFixture(t)
	kpsewhich := filepath.Join(environment.Bin, "kpsewhich.exe")
	database := filepath.Join(environment.Directory, "tlpkg", "texlive.tlpdb")
	profile := filepath.Join(environment.Directory, "texlive.profile")
	writeTestFile(t, kpsewhich, []byte("tool"))
	writeTestFile(t, database, []byte("database"))
	writeTestFile(t, profile, []byte("settings"))
	if err := externalTeXWindowsUninstallResult(context.Background(), environment, context.Canceled, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("lost a canceled uninstall: %v", err)
	}
	for _, path := range []string{kpsewhich, database, environment.Manager} {
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
	}
	var output bytes.Buffer
	if err := externalTeXWindowsUninstallResult(context.Background(), environment, nil, &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), profile) {
		t.Fatalf("remaining settings were not reported: %s", output.String())
	}
	if _, err := os.Stat(profile); err != nil {
		t.Fatal(err)
	}
}

func TestExternalTeXWindowsStoreCannotStartElevatedCommands(t *testing.T) {
	environment := externalTeXCommandFixture(t)
	environment.StoreEdition, environment.Shared = true, true
	if err := runElevatedTeXCommand(context.Background(), environment, environment.Manager, []string{"install", "amsmath"}, environment.Directory, nil); err == nil {
		t.Fatal("accepted direct elevation from the Store edition")
	}
	if err := runExternalTeXUninstall(context.Background(), environment, nil); err == nil {
		t.Fatal("accepted a shared uninstall from the Store edition")
	}
	if _, err := os.Stat(environment.Manager); err != nil {
		t.Fatal(err)
	}
}
