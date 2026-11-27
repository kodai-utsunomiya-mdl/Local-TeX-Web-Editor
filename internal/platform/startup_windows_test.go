//go:build windows

package platform

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/branding"
)

func TestWindowsStartupCreatesUpdatesAndRemovesOnlyItsOwnLink(t *testing.T) {
	root := t.TempDir()
	local, folder := filepath.Join(root, "Local"), filepath.Join(root, "Startup")
	if err := os.MkdirAll(local, 0700); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "Downloads", "editor.exe")
	writeShortcutTestFile(t, source, []byte("MZ first app"))
	state, err := setWindowsStartupAt(source, local, folder, true)
	if err != nil || !state.Enabled || !state.CanDisable || state.CanEnable {
		t.Fatalf("enable startup: %#v %v", state, err)
	}
	linkPath := filepath.Join(folder, shortcutName)
	link, err := readShellShortcut(linkPath)
	if err != nil || link.Arguments != "--startup" || !startupPathsEqual(link.Target, state.Executable) {
		t.Fatalf("startup link: %#v %v", link, err)
	}
	icon, err := os.ReadFile(link.IconPath)
	if err != nil || !bytes.Equal(icon, branding.Icon) {
		t.Fatalf("startup icon: %v", err)
	}
	if err := writeShellShortcutWithArguments(linkPath, link.Target, link.IconPath, "--background"); err != nil {
		t.Fatal(err)
	}
	if state, err := windowsStartupStatusAt(local, folder); err != nil || !state.Enabled {
		t.Fatalf("legacy startup link: %#v %v", state, err)
	}
	newer := filepath.Join(root, "New Download", "editor.exe")
	writeShortcutTestFile(t, newer, []byte("MZ second app"))
	if err := refreshWindowsStartupAt(newer, local, folder); err != nil {
		t.Fatal(err)
	}
	if updated, err := readShellShortcut(linkPath); err != nil || updated.Arguments != "--startup" {
		t.Fatalf("updated startup argument: %#v %v", updated, err)
	}
	installed, err := os.ReadFile(state.Executable)
	if err != nil || string(installed) != "MZ second app" {
		t.Fatalf("startup app was not updated: %q %v", installed, err)
	}
	state, err = setWindowsStartupAt(newer, local, folder, false)
	if err != nil || state.Enabled || !state.CanEnable || state.CanDisable {
		t.Fatalf("disable startup: %#v %v", state, err)
	}
	if _, err := os.Stat(linkPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("startup link remains: %v", err)
	}
	if _, err := os.Stat(link.Target); err != nil {
		t.Fatalf("disabling startup removed the application: %v", err)
	}
	if err := refreshWindowsStartupAt(newer, local, folder); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(linkPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("refresh recreated the disabled startup link: %v", err)
	}
}

func TestWindowsStartupLeavesAnotherLinkUnchanged(t *testing.T) {
	root := t.TempDir()
	local, folder := filepath.Join(root, "Local"), filepath.Join(root, "Startup")
	for _, directory := range []string{local, folder} {
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
	}
	source, other := filepath.Join(root, "source.exe"), filepath.Join(root, "other.exe")
	writeShortcutTestFile(t, source, []byte("MZ source"))
	writeShortcutTestFile(t, other, []byte("MZ other"))
	link := filepath.Join(folder, shortcutName)
	if err := writeShellShortcutWithArguments(link, other, other, "--background"); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(link)
	for _, enabled := range []bool{true, false} {
		if _, err := setWindowsStartupAt(source, local, folder, enabled); !errors.Is(err, ErrStartupConflict) {
			t.Fatalf("changed another startup link: %v", err)
		}
	}
	after, _ := os.ReadFile(link)
	if !bytes.Equal(before, after) {
		t.Fatal("another startup link was rewritten")
	}
}

func TestStoreStartupStateRespectsUserAndPolicyChoices(t *testing.T) {
	for _, expected := range []struct {
		value                    int32
		enabled, enable, disable bool
		status                   string
	}{
		{0, false, true, false, "disabled"},
		{1, false, false, false, "disabled-by-user"},
		{2, true, false, true, "enabled"},
		{3, false, false, false, "disabled-by-policy"},
		{4, true, false, false, "enabled-by-policy"},
	} {
		actual := windowsStoreStartupState(expected.value)
		if !actual.Supported || !actual.CanOpenSettings || actual.Enabled != expected.enabled || actual.CanEnable != expected.enable || actual.CanDisable != expected.disable || actual.Status != expected.status || actual.Message == "" {
			t.Fatalf("state %d: %#v", expected.value, actual)
		}
	}
}
