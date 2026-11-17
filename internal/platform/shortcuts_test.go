package platform

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func writeShortcutTestFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func writeLegacyShortcutInstallation(t *testing.T, root string, contents []byte) string {
	t.Helper()
	directory, err := shortcutInstallDirectory(root)
	if err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(directory, "local-tex-editor.exe")
	writeShortcutTestFile(t, executable, contents)
	hash := sha256.Sum256(contents)
	manifest := fmt.Sprintf(`{"application":"github.com/kodai-utsunomiya-mdl/local-tex-editor","format":1,"sha256":"%x"}`, hash)
	writeShortcutTestFile(t, filepath.Join(directory, "installation.json"), []byte(manifest))
	return executable
}

func TestRenamedShortcutInstallationUpdatesExistingLaunchPaths(t *testing.T) {
	for _, interrupted := range []bool{false, true} {
		t.Run(fmt.Sprintf("previous installation update interrupted=%v", interrupted), func(t *testing.T) {
			root := t.TempDir()
			legacy := writeLegacyShortcutInstallation(t, root, []byte("MZ version 0.1.3"))
			directory := filepath.Dir(legacy)
			source := filepath.Join(root, "Downloads", "local-tex-web-editor.exe")
			newBytes := []byte("MZ Local TeX Web Editor version 0.1.4")
			writeShortcutTestFile(t, source, newBytes)
			if interrupted {
				// The new executable may already have been placed when an update
				// stops before refreshing the previous launch path and its record.
				writeShortcutTestFile(t, filepath.Join(directory, "local-tex-web-editor.exe"), newBytes)
			}
			installed, err := installShortcutExecutable(source, directory)
			if err != nil || installed != filepath.Join(root, "Programs", "LocalTeXEditor", "local-tex-web-editor.exe") {
				t.Fatalf("renamed installation: %s (%v)", installed, err)
			}
			check := func(want []byte) {
				t.Helper()
				for _, path := range []string{installed, legacy} {
					data, err := os.ReadFile(path)
					if err != nil || !bytes.Equal(data, want) {
						t.Fatalf("launch path %s did not receive the update: %q (%v)", path, data, err)
					}
				}
				manifest, err := readShortcutInstallation(filepath.Join(directory, shortcutManifestName))
				hash := sha256.Sum256(want)
				if err != nil || manifest == nil || manifest.SHA256 != fmt.Sprintf("%x", hash) {
					t.Fatalf("updated installation record: %#v (%v)", manifest, err)
				}
			}
			check(newBytes)
			if _, err := installShortcutExecutable(legacy, directory); err != nil {
				t.Fatalf("starting from a previous shortcut: %v", err)
			}
			// A later version must refresh both names again, including when they
			// refer to the same file through a hard link.
			newBytes = []byte("MZ Local TeX Web Editor next version")
			writeShortcutTestFile(t, source, newBytes)
			if _, err := installShortcutExecutable(source, directory); err != nil {
				t.Fatal(err)
			}
			check(newBytes)
		})
	}
}

func TestRenamedInstallationLeavesAnUnrecognizedLegacyExecutable(t *testing.T) {
	for _, registered := range []bool{false, true} {
		t.Run(fmt.Sprintf("registered=%v", registered), func(t *testing.T) {
			root := t.TempDir()
			legacy := writeLegacyShortcutInstallation(t, root, []byte("MZ previous version"))
			directory := filepath.Dir(legacy)
			if !registered {
				if err := os.Remove(filepath.Join(directory, shortcutManifestName)); err != nil {
					t.Fatal(err)
				}
			}
			foreign := []byte("a different file now uses this filename")
			writeShortcutTestFile(t, legacy, foreign)
			source := filepath.Join(root, "download.exe")
			writeShortcutTestFile(t, source, []byte("MZ new application"))
			_, err := installShortcutExecutable(source, directory)
			if registered && !errors.Is(err, ErrShortcutConflict) || !registered && err != nil {
				t.Fatalf("unexpected installation result: %v", err)
			}
			if data, err := os.ReadFile(legacy); err != nil || !bytes.Equal(data, foreign) {
				t.Fatalf("changed an unrecognized file: %q (%v)", data, err)
			}
		})
	}
}

func TestShortcutInstallationCopiesAndUpdatesItsOwnExecutable(t *testing.T) {
	root := t.TempDir()
	directory, err := shortcutInstallDirectory(root)
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "Downloads", "日本語のアプリ with spaces.exe")
	first := []byte("first executable contents\n")
	writeShortcutTestFile(t, source, first)
	installed, err := installShortcutExecutable(source, directory)
	if err != nil {
		t.Fatal(err)
	}
	if installed != filepath.Join(root, "Programs", "LocalTeXEditor", shortcutExecutableName) {
		t.Fatalf("installation path = %s", installed)
	}
	data, err := os.ReadFile(installed)
	if err != nil || !bytes.Equal(data, first) {
		t.Fatalf("installed bytes = %q, error = %v", data, err)
	}
	before, err := os.Stat(installed)
	if err != nil {
		t.Fatal(err)
	}
	for _, current := range []string{source, installed} {
		if _, err := installShortcutExecutable(current, directory); err != nil {
			t.Fatalf("same executable: %v", err)
		}
		after, err := os.Stat(installed)
		if err != nil || !os.SameFile(before, after) || !before.ModTime().Equal(after.ModTime()) {
			t.Fatalf("identical executable was replaced: %v", err)
		}
	}
	updated := filepath.Join(root, "Downloads", "next version.exe")
	second := []byte("updated executable contents\n")
	writeShortcutTestFile(t, updated, second)
	if _, err := installShortcutExecutable(updated, directory); err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile(installed)
	if err != nil || !bytes.Equal(data, second) {
		t.Fatalf("updated bytes = %q, error = %v", data, err)
	}
	manifest, err := readShortcutInstallation(filepath.Join(directory, shortcutManifestName))
	hash, hashErr := shortcutFileHash(installed)
	if err != nil || hashErr != nil || manifest == nil || manifest.SHA256 != hash {
		t.Fatalf("installation record does not describe the updated executable: %#v %v %v", manifest, err, hashErr)
	}
	if data, err := os.ReadFile(source); err != nil || !bytes.Equal(data, first) {
		t.Fatalf("the original download was changed: %v", err)
	}
}

func TestShortcutInstallationLeavesUnrelatedFilesUntouched(t *testing.T) {
	for _, scenario := range []string{"unregistered executable", "changed executable", "unrelated manifest"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			directory, err := shortcutInstallDirectory(root)
			if err != nil {
				t.Fatal(err)
			}
			source := filepath.Join(root, "download.exe")
			writeShortcutTestFile(t, source, []byte("this application\n"))
			target := filepath.Join(directory, shortcutExecutableName)
			protected := target
			foreign := []byte("a different file\n")
			if scenario == "changed executable" {
				if _, err := installShortcutExecutable(source, directory); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "unrelated manifest" {
				protected = filepath.Join(directory, shortcutManifestName)
				foreign = []byte(`{"belongsTo":"another application"}`)
			}
			writeShortcutTestFile(t, protected, foreign)
			_, err = installShortcutExecutable(source, directory)
			if !errors.Is(err, ErrShortcutConflict) {
				t.Fatalf("expected a conflict, got %v", err)
			}
			data, readErr := os.ReadFile(protected)
			if readErr != nil || !bytes.Equal(data, foreign) {
				t.Fatalf("unrelated file was changed: %q %v", data, readErr)
			}
		})
	}
}

func TestShortcutInstallationRejectsLinkedDestinations(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "Programs")); err != nil {
		t.Skipf("symlink creation is unavailable: %v", err)
	}
	if _, err := shortcutInstallDirectory(root); !errors.Is(err, ErrShortcutConflict) {
		t.Fatalf("linked Programs directory was accepted: %v", err)
	}
	root = t.TempDir()
	directory, err := shortcutInstallDirectory(root)
	if err != nil {
		t.Fatal(err)
	}
	protected := filepath.Join(outside, "other.exe")
	foreign := []byte("external executable\n")
	writeShortcutTestFile(t, protected, foreign)
	if err := os.Symlink(protected, filepath.Join(directory, shortcutExecutableName)); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "download.exe")
	writeShortcutTestFile(t, source, []byte("this application\n"))
	if _, err := installShortcutExecutable(source, directory); !errors.Is(err, ErrShortcutConflict) {
		t.Fatalf("linked executable was accepted: %v", err)
	}
	if data, err := os.ReadFile(protected); err != nil || !bytes.Equal(data, foreign) {
		t.Fatalf("external executable was changed: %v", err)
	}
}

func TestShortcutCreationCannotReplaceAnUnexpectedNewFile(t *testing.T) {
	root := t.TempDir()
	staged, target := filepath.Join(root, "staged.tmp"), filepath.Join(root, "target.exe")
	writeShortcutTestFile(t, staged, []byte("new contents\n"))
	writeShortcutTestFile(t, target, []byte("file created by another operation\n"))
	if err := commitShortcutFile(staged, target, false); err == nil {
		t.Fatal("new-file placement replaced an existing file")
	}
	if data, err := os.ReadFile(target); err != nil || string(data) != "file created by another operation\n" {
		t.Fatalf("existing file was changed: %q %v", data, err)
	}
}
