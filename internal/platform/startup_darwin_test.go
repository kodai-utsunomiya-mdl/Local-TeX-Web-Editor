//go:build darwin

package platform

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestMacStartupReadsARegistrationWithoutLaunchingAnApplication(t *testing.T) {
	path := filepath.Join(t.TempDir(), "LaunchAgents", startupAgentLabel+".plist")
	state, err := macStartupStateAt(path)
	if err != nil || state.Enabled || !state.CanEnable {
		t.Fatalf("unregistered state: %#v %v", state, err)
	}
	executable := "/Applications/Local TeX Web Editor.app/Contents/MacOS/local-tex-web-editor"
	if err := writeStartupFile(path, startupLaunchAgent(executable), false); err != nil {
		t.Fatal(err)
	}
	state, err = macStartupStateAt(path)
	if err != nil || !state.Enabled || !state.CanDisable || state.Executable != executable {
		t.Fatalf("registered state: %#v %v", state, err)
	}
	if err := os.WriteFile(path, []byte("another application"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := macStartupStateAt(path); !errors.Is(err, ErrStartupConflict) {
		t.Fatalf("accepted another registration: %v", err)
	}
}

func TestMacStartupRefreshUpdatesTheLegacyArgumentWithoutChangingThePath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "LaunchAgents", startupAgentLabel+".plist")
	executable := "/Applications/Local TeX Web Editor.app/Contents/MacOS/LocalTeXWebEditor"
	legacy := bytes.Replace(startupLaunchAgent(executable), []byte("--startup"), []byte("--background"), 1)
	if err := writeStartupFile(path, legacy, false); err != nil {
		t.Fatal(err)
	}
	if err := refreshMacStartupRegistrationAt(path, executable); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(data, startupLaunchAgent(executable)) {
		t.Fatalf("legacy argument was not updated: %s %v", data, err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := refreshMacStartupRegistrationAt(path, executable); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("refresh recreated a removed registration: %v", err)
	}
}
