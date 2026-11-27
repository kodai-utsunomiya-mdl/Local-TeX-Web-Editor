package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

func testShortcutSetupApp(t *testing.T, existingSettings bool) *App {
	t.Helper()
	directory := t.TempDir()
	if existingSettings {
		writeTestFile(t, filepath.Join(directory, "settings.json"), []byte(`{"projects":{},"recentProjects":[]}`))
	}
	a, err := New(Options{ConfigDir: directory, Token: testToken, Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	a.shortcutSetupCheck = func(configDir string) bool { return configDir == directory }
	if err := a.loadConfig(); err != nil {
		t.Fatal(err)
	}
	a.SetAddress("127.0.0.1:8765")
	t.Cleanup(func() { _ = a.Close() })
	return a
}

func TestShortcutSetupCreatesBothOnlyForNewSettings(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(map[bool]string{false: "new", true: "existing"}[existing], func(t *testing.T) {
			a := testShortcutSetupApp(t, existing)
			if a.config.ShortcutSetupPending == existing {
				t.Fatalf("pending=%v for existing settings=%v", a.config.ShortcutSetupPending, existing)
			}
			var destinations []string
			a.shortcutCreator = func(destination string) (platform.ShortcutResult, error) {
				data, err := os.ReadFile(filepath.Join(a.options.ConfigDir, "settings.json"))
				var saved configuration
				if err != nil || json.Unmarshal(data, &saved) != nil || saved.ShortcutSetupPending {
					t.Fatalf("the first-run record was not saved before creation: %s %v", data, err)
				}
				destinations = append(destinations, destination)
				return platform.ShortcutResult{}, nil
			}
			if err := a.InitializeShortcuts(); err != nil {
				t.Fatal(err)
			}
			want := []string(nil)
			if !existing {
				want = []string{"start-menu", "desktop"}
			}
			if !reflect.DeepEqual(destinations, want) {
				t.Fatalf("created %v, want %v", destinations, want)
			}
			// Removing a link later must not make the app run this setup again.
			reopened, err := New(Options{ConfigDir: a.options.ConfigDir, Token: testToken})
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			reopened.shortcutSetupCheck = a.shortcutSetupCheck
			reopened.shortcutCreator = a.shortcutCreator
			if err := reopened.InitializeShortcuts(); err != nil || !reflect.DeepEqual(destinations, want) {
				t.Fatalf("restarting repeated shortcut creation: %v %v", destinations, err)
			}
		})
	}
}

func TestStartupRegistrationKeepsTheInitialShortcutRequest(t *testing.T) {
	a := testShortcutSetupApp(t, false)
	a.startupHooks = &startupHooks{
		status: func(string) (platform.StartupState, error) {
			return platform.StartupState{Supported: true, CanEnable: true}, nil
		},
		set: func(string, bool) (platform.StartupState, error) {
			return platform.StartupState{Supported: true, Enabled: true}, nil
		},
	}
	if err := a.InitializeStartupRegistration(); err != nil {
		t.Fatal(err)
	}
	if err := a.loadConfig(); err != nil {
		t.Fatal(err)
	}
	if !a.config.ShortcutSetupPending || a.config.StartupEnabled == nil || !*a.config.StartupEnabled {
		t.Fatalf("startup registration lost the initial shortcut request: %#v", a.config)
	}
	before := cloneConfig(a.config)
	before.ShortcutSetupPending = false
	created := 0
	a.shortcutCreator = func(string) (platform.ShortcutResult, error) {
		created++
		return platform.ShortcutResult{}, nil
	}
	if err := a.InitializeShortcuts(); err != nil || created != 2 || !reflect.DeepEqual(a.config, before) {
		t.Fatalf("initial shortcuts changed other settings: created=%d error=%v config=%#v", created, err, a.config)
	}
}

func TestShortcutSetupAttemptsBothDestinationsAndLeavesManualCreationAvailable(t *testing.T) {
	a := testShortcutSetupApp(t, false)
	var destinations []string
	a.shortcutCreator = func(destination string) (platform.ShortcutResult, error) {
		destinations = append(destinations, destination)
		if destination == "start-menu" {
			return platform.ShortcutResult{}, errors.New("destination is unavailable")
		}
		return platform.ShortcutResult{}, nil
	}
	err := a.InitializeShortcuts()
	if err == nil || !strings.Contains(messages.ErrorText("en", err), "Start menu") || !reflect.DeepEqual(destinations, []string{"start-menu", "desktop"}) {
		t.Fatalf("destination failure: %v %v", destinations, err)
	}
	if err := a.InitializeShortcuts(); err != nil || len(destinations) != 2 {
		t.Fatalf("repeated automatic creation after a failure: %v %v", destinations, err)
	}
	a.shortcutCreator = func(destination string) (platform.ShortcutResult, error) {
		destinations = append(destinations, destination)
		return platform.ShortcutResult{}, nil
	}
	response := apiRequest(a, http.MethodPost, "/api/shortcuts", map[string]string{"destination": "start-menu"}, nil)
	if response.Code != http.StatusOK || len(destinations) != 3 || destinations[2] != "start-menu" {
		t.Fatalf("manual creation after the initial attempt: %d %s %v", response.Code, response.Body.String(), destinations)
	}
}

func TestShortcutSetupRequiresASavedRecordBeforeCreatingFiles(t *testing.T) {
	a := testShortcutSetupApp(t, false)
	settings := filepath.Join(a.options.ConfigDir, "settings.json")
	if err := os.Mkdir(settings, 0700); err != nil {
		t.Fatal(err)
	}
	created := 0
	a.shortcutCreator = func(string) (platform.ShortcutResult, error) {
		created++
		return platform.ShortcutResult{}, nil
	}
	if err := a.InitializeShortcuts(); err == nil || created != 0 || !a.config.ShortcutSetupPending {
		t.Fatalf("created shortcuts without saving the first-run record: created=%d error=%v", created, err)
	}
	if err := os.Remove(settings); err != nil {
		t.Fatal(err)
	}
	if err := a.InitializeShortcuts(); err != nil || created != 2 || a.config.ShortcutSetupPending {
		t.Fatalf("could not finish after settings became writable: created=%d error=%v", created, err)
	}
}

func TestShortcutSetupLeavesTemporaryConfigurationsAndPackagedAppsAlone(t *testing.T) {
	for _, kind := range []string{"temporary", "packaged", "closed"} {
		t.Run(kind, func(t *testing.T) {
			a := testShortcutSetupApp(t, false)
			switch kind {
			case "temporary":
				a.shortcutSetupCheck = nil
			case "packaged":
				a.packageIdentity = &platform.PackageIdentity{FamilyName: "LocalTeXEditor_test"}
			case "closed":
				a.closed = true
			}
			a.shortcutCreator = func(string) (platform.ShortcutResult, error) {
				t.Fatal("automatic creation ran in an unsupported app")
				return platform.ShortcutResult{}, nil
			}
			if err := a.InitializeShortcuts(); err != nil || !a.config.ShortcutSetupPending {
				t.Fatalf("unsupported setup changed the record: %v", err)
			}
		})
	}
}

func TestSettingsResetDoesNotRepeatInitialShortcutCreation(t *testing.T) {
	for _, resetSettings := range []bool{false, true} {
		t.Run(map[bool]string{false: "cache", true: "settings"}[resetSettings], func(t *testing.T) {
			a := testShortcutSetupApp(t, false)
			if err := a.saveConfig(a.config); err != nil {
				t.Fatal(err)
			}
			response := apiRequest(a, http.MethodPost, "/api/settings/reset", settingsResetOptions{Settings: resetSettings, Cache: true, Confirmation: true}, nil)
			if response.Code != http.StatusOK || a.config.ShortcutSetupPending == resetSettings {
				t.Fatalf("reset shortcut setup: %d %s pending=%v", response.Code, response.Body.String(), a.config.ShortcutSetupPending)
			}
			if err := a.loadConfig(); err != nil || a.config.ShortcutSetupPending == resetSettings {
				t.Fatalf("reset shortcut setup was not saved: %v", err)
			}
		})
	}
}
