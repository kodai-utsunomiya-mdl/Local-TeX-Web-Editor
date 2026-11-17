//go:build windows

package platform

import (
	"bytes"
	"context"
	"debug/pe"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
	"unsafe"
)

func TestUTF8InterpreterCopyAcceptsUnicodePathsThroughANSIAPIs(t *testing.T) {
	original, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(original)
	if err != nil {
		t.Fatal(err)
	}
	if resources := interpreterResources(t, data); resources.VirtualAddress != 0 || resources.Size != 0 {
		t.Fatalf("this fixture must exercise a PE without resources: %#v", resources)
	}
	directory := t.TempDir()
	executable := filepath.Join(directory, "interpreter.exe")
	if err := os.WriteFile(executable, data, 0700); err != nil {
		t.Fatal(err)
	}
	initialCodePage, _, _ := kernel32.NewProc("GetACP").Call()
	if err := EnableUTF8CodePage(executable); err != nil {
		t.Fatal(err)
	}
	updated, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	if resources := interpreterResources(t, updated); resources.VirtualAddress == 0 || resources.Size == 0 {
		t.Fatalf("the first resource was not added to the interpreter: %#v", resources)
	}
	// A second update exercises enumeration and replacement of the manifest
	// now present in the copy, before checking the process's actual code page.
	if err := EnableUTF8CodePage(executable); err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(directory, "別の 原稿-🎓.tex")
	if err := os.WriteFile(filename, []byte("document"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, "-test.v", "-test.run=^TestUTF8InterpreterChild$", filename)
	command.Env = append(os.Environ(), "LOCAL_TEX_EDITOR_TEST_UTF8_PROCESS=1")
	PrepareCommand(command)
	output, err := command.CombinedOutput()
	if err != nil || !bytes.Contains(output, []byte("UTF-8 process verified")) {
		t.Fatalf("UTF-8 interpreter: %v\n%s", err, output)
	}
	currentCodePage, _, _ := kernel32.NewProc("GetACP").Call()
	if currentCodePage != initialCodePage {
		t.Fatalf("the application's code page changed from %d to %d", initialCodePage, currentCodePage)
	}
}

func interpreterResources(t *testing.T, data []byte) pe.DataDirectory {
	t.Helper()
	image, err := pe.NewFile(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	defer image.Close()
	switch header := image.OptionalHeader.(type) {
	case *pe.OptionalHeader32:
		return header.DataDirectory[pe.IMAGE_DIRECTORY_ENTRY_RESOURCE]
	case *pe.OptionalHeader64:
		return header.DataDirectory[pe.IMAGE_DIRECTORY_ENTRY_RESOURCE]
	default:
		t.Fatalf("unexpected interpreter PE header: %T", header)
		return pe.DataDirectory{}
	}
}

func TestUTF8InterpreterChild(t *testing.T) {
	if os.Getenv("LOCAL_TEX_EDITOR_TEST_UTF8_PROCESS") != "1" {
		return
	}
	codePage, _, _ := kernel32.NewProc("GetACP").Call()
	if codePage != 65001 {
		t.Fatalf("the interpreter uses code page %d instead of UTF-8", codePage)
	}
	filename := os.Args[len(os.Args)-1]
	address, _, callErr := kernel32.NewProc("GetCommandLineA").Call()
	if address == 0 {
		t.Fatal(callErr)
	}
	var raw []byte
	for offset := uintptr(0); offset < 32768; offset++ {
		value := *(*byte)(unsafe.Pointer(address + offset))
		if value == 0 {
			break
		}
		raw = append(raw, value)
	}
	if !strings.Contains(string(raw), filename) {
		t.Fatalf("the ANSI command line lost the filename: %q", raw)
	}
	name := append([]byte(filename), 0)
	handle, _, callErr := kernel32.NewProc("CreateFileA").Call(uintptr(unsafe.Pointer(&name[0])), 0x80000000, 1, 0, 3, 0, 0)
	runtime.KeepAlive(name)
	if handle == ^uintptr(0) {
		t.Fatalf("the ANSI file API cannot open the Unicode filename: %v", callErr)
	}
	kernel32.NewProc("CloseHandle").Call(handle)
	t.Log("UTF-8 process verified")
}
