//go:build windows

package app

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestWindowsSaveWaitsForReaderAndChecksExternalEdits(t *testing.T) {
	for _, externalEdit := range []bool{false, true} {
		name := "save after reader closes"
		if externalEdit {
			name = "external edit while waiting"
		}
		t.Run(name, func(t *testing.T) {
			a, root := testApp(t)
			path := filepath.Join(root, "main.tex")
			document, err := readDocument(root, "main.tex")
			if err != nil {
				t.Fatal(err)
			}
			original := document.Content
			document.Content += "% saved after the reader closes\n"
			wide, err := syscall.UTF16PtrFromString(path)
			if err != nil {
				t.Fatal(err)
			}
			handle, err := syscall.CreateFile(wide, syscall.GENERIC_READ, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE,
				nil, syscall.OPEN_EXISTING, 0, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				if handle != syscall.InvalidHandle {
					_ = syscall.CloseHandle(handle)
				}
			}()
			type saveResult struct {
				status int
				body   []byte
			}
			result := make(chan saveResult, 1)
			go func() {
				response := apiRequest(a, http.MethodPut, "/api/file", document, map[string]string{"X-Project-Root": root})
				result <- saveResult{status: response.Code, body: response.Body.Bytes()}
			}()
			select {
			case saved := <-result:
				t.Fatalf("save returned while the reader was still open: HTTP %d, %s", saved.status, saved.body)
			case <-time.After(150 * time.Millisecond):
			}
			if data, err := os.ReadFile(path); err != nil || string(data) != original {
				t.Fatalf("original document changed while waiting: %q, %v", data, err)
			}
			want := document.Content
			if externalEdit {
				want = "% edited by another application\n"
				writeTestFile(t, path, []byte(want))
			}
			if err := syscall.CloseHandle(handle); err != nil {
				t.Fatal(err)
			}
			handle = syscall.InvalidHandle
			select {
			case saved := <-result:
				status := http.StatusOK
				if externalEdit {
					status = http.StatusConflict
				}
				if saved.status != status {
					t.Fatalf("save returned HTTP %d, want %d: %s", saved.status, status, saved.body)
				}
				if !externalEdit {
					var actual FileDocument
					if err := json.Unmarshal(saved.body, &actual); err != nil {
						t.Fatal(err)
					}
					if actual.Content != want || actual.Revision != revision([]byte(want)) {
						t.Fatalf("unexpected saved document: %+v", actual)
					}
				}
			case <-time.After(5 * time.Second):
				t.Fatal("save did not finish after the reader closed")
			}
			if data, err := os.ReadFile(path); err != nil || string(data) != want {
				t.Fatalf("saved document = %q, %v; want %q", data, err, want)
			}
			staged, err := filepath.Glob(filepath.Join(root, ".local-tex-editor-save-*"))
			if err != nil || len(staged) != 0 {
				t.Fatalf("temporary saves remain: %v, %v", staged, err)
			}
		})
	}
}

func TestWindowsSaveLeavesReadOnlyDocumentUnchanged(t *testing.T) {
	a, root := testApp(t)
	path := filepath.Join(root, "main.tex")
	document, err := readDocument(root, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	original := document.Content
	document.Content += "% must not overwrite a read-only document\n"
	if err := os.Chmod(path, 0400); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0600) })
	response := apiRequest(a, http.MethodPut, "/api/file", document, map[string]string{"X-Project-Root": root})
	if response.Code != http.StatusForbidden {
		t.Fatalf("save returned HTTP %d: %s", response.Code, response.Body.String())
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != original {
		t.Fatalf("read-only document changed: %q, %v", data, err)
	}
	wide, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	attributes, err := syscall.GetFileAttributes(wide)
	if err != nil || attributes&syscall.FILE_ATTRIBUTE_READONLY == 0 {
		t.Fatalf("the read-only attribute changed: attributes = %#x, error = %v", attributes, err)
	}
	staged, err := filepath.Glob(filepath.Join(root, ".local-tex-editor-save-*"))
	if err != nil || len(staged) != 0 {
		t.Fatalf("temporary saves remain: %v, %v", staged, err)
	}
}
