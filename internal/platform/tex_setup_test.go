package platform

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestTeXSetupLockUsesTheActualInstallation(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "tex")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	release, err := AcquireTeXSetupLock(path)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	try := func(path string) error {
		result := make(chan error, 1)
		go func() {
			unlock, err := AcquireTeXSetupLock(path)
			if err == nil {
				unlock()
			}
			result <- err
		}()
		return <-result
	}
	if err := try(path); !errors.Is(err, ErrLocked) {
		t.Fatalf("second operation in the same directory: %v", err)
	}
	other := filepath.Join(root, "other-tex")
	if err := os.Mkdir(other, 0700); err != nil {
		t.Fatal(err)
	}
	if err := try(other); err != nil {
		t.Fatalf("an unrelated installation was locked: %v", err)
	}
	link := filepath.Join(root, "link-to-tex")
	if err := os.Symlink(path, link); err == nil {
		if err := try(link); !errors.Is(err, ErrLocked) {
			t.Fatalf("a second path bypassed the installation lock: %v", err)
		}
	}
	release()
	if err := try(path); err != nil {
		t.Fatalf("the completed operation left a lock: %v", err)
	}
}
