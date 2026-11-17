//go:build windows

package platform

import (
	"bytes"
	"context"
	"encoding/binary"
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

type interpreterResourceDirectory struct {
	VirtualAddress uint32
	Size           uint32
}

func interpreterResources(t *testing.T, data []byte) interpreterResourceDirectory {
	t.Helper()
	// Read only the image headers. UpdateResource can invalidate a Go test
	// executable's COFF debug string table, which debug/pe.NewFile also reads.
	// The child process below verifies that Windows still loads and runs the
	// updated image with UTF-8 enabled.
	if len(data) < 0x40 || string(data[:2]) != "MZ" {
		t.Fatal("the interpreter is missing its DOS header")
	}
	peOffset := uint64(binary.LittleEndian.Uint32(data[0x3c:0x40]))
	if peOffset+24 > uint64(len(data)) || string(data[peOffset:peOffset+4]) != "PE\x00\x00" {
		t.Fatal("the interpreter is missing its PE header")
	}
	optionalSize := uint64(binary.LittleEndian.Uint16(data[peOffset+20 : peOffset+22]))
	optionalStart := peOffset + 24
	if optionalSize < 2 || optionalStart+optionalSize > uint64(len(data)) {
		t.Fatal("the interpreter has a truncated optional header")
	}
	header := data[optionalStart : optionalStart+optionalSize]
	var directories int
	switch magic := binary.LittleEndian.Uint16(header[:2]); magic {
	case 0x10b: // PE32
		directories = 96
	case 0x20b: // PE32+
		directories = 112
	default:
		t.Fatalf("unexpected interpreter optional header magic: %#x", magic)
	}
	const resourceIndex = 2
	if len(header) < directories+8*(resourceIndex+1) || binary.LittleEndian.Uint32(header[directories-4:directories]) <= resourceIndex {
		t.Fatal("the interpreter has no resource directory entry")
	}
	resource := header[directories+8*resourceIndex:]
	return interpreterResourceDirectory{
		VirtualAddress: binary.LittleEndian.Uint32(resource[:4]),
		Size:           binary.LittleEndian.Uint32(resource[4:8]),
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
