//go:build windows

package platform

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func holdReplacementReader(t *testing.T, path string) func() {
	t.Helper()
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := syscall.CreateFile(name, syscall.GENERIC_READ, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE,
		nil, syscall.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	closeReader := func() {
		if handle != syscall.InvalidHandle {
			if err := syscall.CloseHandle(handle); err != nil {
				t.Error(err)
			}
			handle = syscall.InvalidHandle
		}
	}
	t.Cleanup(closeReader)
	return closeReader
}

func replacementFiles(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	src, dst := filepath.Join(root, "temporary.tex"), filepath.Join(root, "原稿 with spaces.tex")
	for path, content := range map[string]string{src: "new document\n", dst: "original document\n"} {
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return src, dst
}

func expectReplacementContent(t *testing.T, path, want string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil || string(data) != want {
		t.Fatalf("contents of %s = %q, %v; want %q", path, data, err, want)
	}
}

func TestReplaceFileRechecksAfterReader(t *testing.T) {
	for _, changed := range []bool{false, true} {
		name := "reader closes"
		if changed {
			name = "another editor changes the file"
		}
		t.Run(name, func(t *testing.T) {
			src, dst := replacementFiles(t)
			closeReader := holdReplacementReader(t, dst)
			conflict := errors.New("the destination changed")
			checks := 0
			err := ReplaceFileChecked(src, dst, func() error {
				checks++
				if checks != 2 {
					return nil
				}
				expectReplacementContent(t, dst, "original document\n")
				if changed {
					if err := os.WriteFile(dst, []byte("external edit\n"), 0600); err != nil {
						t.Fatal(err)
					}
				}
				closeReader()
				if changed {
					return conflict
				}
				return nil
			})
			if checks < 2 {
				t.Fatalf("the open reader did not cause a retry: checks = %d, error = %v", checks, err)
			}
			if changed {
				if !errors.Is(err, conflict) {
					t.Fatalf("expected the check's error, got %v", err)
				}
				expectReplacementContent(t, dst, "external edit\n")
				expectReplacementContent(t, src, "new document\n")
			} else {
				if err != nil {
					t.Fatal(err)
				}
				expectReplacementContent(t, dst, "new document\n")
				if _, err := os.Stat(src); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("the temporary file remains after replacement: %v", err)
				}
			}
		})
	}
}

func TestReplaceFileStopsWhenReaderStaysOpen(t *testing.T) {
	src, dst := replacementFiles(t)
	holdReplacementReader(t, dst)
	started := time.Now()
	err := ReplaceFile(src, dst)
	if !errors.Is(err, syscall.ERROR_ACCESS_DENIED) && !errors.Is(err, syscall.Errno(32)) {
		t.Fatalf("expected a Windows sharing error, got %v", err)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("replacement took %v with a reader still open", elapsed)
	}
	expectReplacementContent(t, dst, "original document\n")
	expectReplacementContent(t, src, "new document\n")
}

func TestReplaceFileLeavesReadOnlyDestinationUnchanged(t *testing.T) {
	src, dst := replacementFiles(t)
	if err := os.Chmod(dst, 0400); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dst, 0600) })
	if err := ReplaceFile(src, dst); !errors.Is(err, os.ErrPermission) {
		t.Fatalf("expected a permission error, got %v", err)
	}
	name, err := syscall.UTF16PtrFromString(dst)
	if err != nil {
		t.Fatal(err)
	}
	attributes, err := syscall.GetFileAttributes(name)
	if err != nil || attributes&syscall.FILE_ATTRIBUTE_READONLY == 0 {
		t.Fatalf("the read-only attribute changed: attributes = %#x, error = %v", attributes, err)
	}
	expectReplacementContent(t, dst, "original document\n")
	expectReplacementContent(t, src, "new document\n")
}
