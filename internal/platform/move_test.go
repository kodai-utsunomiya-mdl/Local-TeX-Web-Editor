package platform

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMoveWithoutReplaceProtectsFilesAndFolders(t *testing.T) {
	for _, folder := range []bool{false, true} {
		root := t.TempDir()
		source, destination := filepath.Join(root, "source"), filepath.Join(root, "destination")
		if folder {
			if err := os.Mkdir(source, 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(source, "child"), []byte("source"), 0644); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(destination, 0755); err != nil {
				t.Fatal(err)
			}
		} else {
			if err := os.WriteFile(source, []byte("source"), 0644); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(destination, []byte("destination"), 0644); err != nil {
				t.Fatal(err)
			}
		}
		if err := MoveWithoutReplace(source, destination); err == nil {
			t.Fatal("an occupied destination was replaced")
		}
		if _, err := os.Stat(source); err != nil {
			t.Fatalf("the source was removed: %v", err)
		}
		if !folder {
			contents, err := os.ReadFile(destination)
			if err != nil || string(contents) != "destination" {
				t.Fatalf("destination changed: %q %v", contents, err)
			}
		}
		if err := os.Remove(destination); err != nil {
			t.Fatal(err)
		}
		if err := MoveWithoutReplace(source, destination); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(source); !os.IsNotExist(err) {
			t.Fatalf("old path remains: %v", err)
		}
		final := destination
		if folder {
			final = filepath.Join(destination, "child")
		}
		contents, err := os.ReadFile(final)
		if err != nil || string(contents) != "source" {
			t.Fatalf("moved content: %q %v", contents, err)
		}
	}
}
