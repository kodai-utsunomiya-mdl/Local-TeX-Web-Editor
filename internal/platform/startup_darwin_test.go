//go:build darwin

package platform

import (
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
