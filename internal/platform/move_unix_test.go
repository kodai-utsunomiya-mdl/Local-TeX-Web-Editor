//go:build darwin || linux

package platform

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestMoveWithoutReplaceDoesNotLoseConcurrentSave(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source.tex")
	destination := filepath.Join(root, "renamed.tex")
	replacement := filepath.Join(root, "saving.tex")
	for attempt := 0; attempt < 256; attempt++ {
		if err := os.WriteFile(source, []byte("earlier text"), 0644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(replacement, []byte("newly saved text"), 0644); err != nil {
			t.Fatal(err)
		}
		moved := make(chan error, 1)
		go func() { moved <- MoveWithoutReplace(source, destination) }()
		// An external editor may finish an atomic save as soon as the renamed
		// path appears. The newer text must survive under either name.
		for {
			if _, err := os.Lstat(destination); err == nil {
				break
			} else if !os.IsNotExist(err) {
				t.Fatal(err)
			}
			select {
			case err := <-moved:
				if err != nil {
					t.Fatal(err)
				}
				moved <- nil
			default:
			}
			runtime.Gosched()
		}
		if err := os.Rename(replacement, source); err != nil {
			t.Fatal(err)
		}
		if err := <-moved; err != nil {
			t.Fatal(err)
		}
		original, sourceErr := os.ReadFile(source)
		if sourceErr != nil && !os.IsNotExist(sourceErr) {
			t.Fatal(sourceErr)
		}
		renamed, err := os.ReadFile(destination)
		if err != nil {
			t.Fatal(err)
		}
		if string(original) != "newly saved text" && string(renamed) != "newly saved text" {
			t.Fatalf("concurrent save was lost: source=%q destination=%q", original, renamed)
		}
		if err := os.Remove(destination); err != nil {
			t.Fatal(err)
		}
	}
}
