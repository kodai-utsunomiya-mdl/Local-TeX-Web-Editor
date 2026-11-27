package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

func TestStartupAPIUsesTheAppConfigurationAndOSState(t *testing.T) {
	a, _ := testApp(t)
	enabled, opened := false, false
	status := func(directory string) (platform.StartupState, error) {
		if directory != a.options.ConfigDir {
			t.Fatalf("unexpected configuration: %s", directory)
		}
		return platform.StartupState{Supported: true, Enabled: enabled, CanEnable: !enabled, CanDisable: enabled, CanOpenSettings: true, Status: "ready", Message: "ログイン時の自動起動は無効です．"}, nil
	}
	a.startupHooks = &startupHooks{
		status: status,
		set: func(directory string, value bool) (platform.StartupState, error) {
			enabled = value
			return status(directory)
		},
		open: func() error { opened = true; return nil },
	}
	response := apiRequest(a, http.MethodGet, "/api/startup", nil, map[string]string{"Accept-Language": "en"})
	var state platform.StartupState
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &state) != nil || state.Enabled || state.Message != "Start at login is disabled." {
		t.Fatalf("startup state: %d %s", response.Code, response.Body.String())
	}
	for _, value := range []bool{true, false} {
		response := apiRequest(a, http.MethodPost, "/api/startup", map[string]bool{"enabled": value}, nil)
		if response.Code != http.StatusOK || enabled != value || opened {
			t.Fatalf("set startup: %d %s; enabled=%v opened=%v", response.Code, response.Body.String(), enabled, opened)
		}
		reopened, err := New(Options{ConfigDir: a.options.ConfigDir, Token: testToken})
		if err != nil {
			t.Fatal(err)
		}
		if reopened.config.StartupEnabled == nil || *reopened.config.StartupEnabled != value {
			t.Fatalf("startup choice was not saved: %#v", reopened.config.StartupEnabled)
		}
		reopened.startupHooks = &startupHooks{set: func(string, bool) (platform.StartupState, error) {
			t.Fatal("restarting changed the saved startup choice")
			return platform.StartupState{}, nil
		}}
		if err := reopened.InitializeStartupRegistration(); err != nil {
			t.Fatal(err)
		}
		_ = reopened.Close()
	}
	response = apiRequest(a, http.MethodPost, "/api/startup/settings", map[string]any{}, nil)
	if response.Code != http.StatusOK || !opened {
		t.Fatalf("open system settings: %d %s", response.Code, response.Body.String())
	}
	for _, input := range []any{map[string]any{}, map[string]string{"enabled": "true"}, map[string]any{"enabled": nil}} {
		response := apiRequest(a, http.MethodPost, "/api/startup", input, nil)
		if response.Code != http.StatusBadRequest || enabled {
			t.Fatalf("accepted invalid startup input: %d %s", response.Code, response.Body.String())
		}
	}
}

func TestStartupDefaultsToEnabledForNewAndExistingSettings(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(map[bool]string{false: "new", true: "existing"}[existing], func(t *testing.T) {
			directory := t.TempDir()
			if existing {
				writeTestFile(t, filepath.Join(directory, "settings.json"), []byte(`{"projects":{},"recentProjects":[]}`))
			}
			a, err := New(Options{ConfigDir: directory, Token: testToken})
			if err != nil {
				t.Fatal(err)
			}
			defer a.Close()
			enabled, changes := false, 0
			hooks := &startupHooks{
				status: func(string) (platform.StartupState, error) {
					return platform.StartupState{Supported: true, Enabled: enabled, CanEnable: !enabled, CanDisable: enabled}, nil
				},
				set: func(_ string, value bool) (platform.StartupState, error) {
					changes++
					enabled = value
					return platform.StartupState{Supported: true, Enabled: enabled, CanDisable: enabled}, nil
				},
			}
			a.startupHooks = hooks
			if err := a.InitializeStartupRegistration(); err != nil || !enabled || changes != 1 {
				t.Fatalf("initial startup default: enabled=%v changes=%d error=%v", enabled, changes, err)
			}
			// The user can change the registration in the OS after the first run.
			enabled = false
			reopened, err := New(Options{ConfigDir: directory, Token: testToken})
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			reopened.startupHooks = hooks
			if reopened.config.StartupEnabled == nil || !*reopened.config.StartupEnabled {
				t.Fatal("the initial setting was not saved")
			}
			if err := reopened.InitializeStartupRegistration(); err != nil || enabled || changes != 1 {
				t.Fatalf("restarting changed the OS setting: enabled=%v changes=%d error=%v", enabled, changes, err)
			}
		})
	}
}

func TestStartupDefaultUsesTheAvailableOSActions(t *testing.T) {
	for _, state := range []platform.StartupState{
		{Supported: true, Enabled: true, CanDisable: true, Status: "enabled"},
		{Supported: true, Status: "disabled-by-user"},
		{Supported: true, Status: "disabled-by-policy"},
		{Supported: true, Status: "requires-approval"},
	} {
		t.Run(state.Status, func(t *testing.T) {
			a, _ := testApp(t)
			a.startupHooks = &startupHooks{
				status: func(string) (platform.StartupState, error) { return state, nil },
				set: func(string, bool) (platform.StartupState, error) {
					t.Fatal("initialization changed the OS registration")
					return platform.StartupState{}, nil
				},
			}
			if err := a.InitializeStartupRegistration(); err != nil {
				t.Fatal(err)
			}
			if a.config.StartupEnabled == nil || !*a.config.StartupEnabled {
				t.Fatal("the default setting was not recorded")
			}
		})
	}
}

func TestStartupDefaultWaitsForASupportedInstallation(t *testing.T) {
	a, _ := testApp(t)
	supported, changes := false, 0
	a.startupHooks = &startupHooks{
		status: func(string) (platform.StartupState, error) {
			return platform.StartupState{Supported: supported, CanEnable: supported}, nil
		},
		set: func(string, bool) (platform.StartupState, error) {
			changes++
			return platform.StartupState{Supported: true, Enabled: true}, nil
		},
	}
	if err := a.InitializeStartupRegistration(); err != nil || a.config.StartupEnabled != nil || changes != 0 {
		t.Fatalf("unsupported installation: %v; changes=%d", err, changes)
	}
	supported = true
	if err := a.InitializeStartupRegistration(); err != nil || changes != 1 {
		t.Fatalf("supported installation: %v; changes=%d", err, changes)
	}
}

func TestStartupDefaultLeavesATemporaryConfigurationUnregistered(t *testing.T) {
	a, _ := testApp(t)
	state, err := platform.StartupStatus(a.options.ConfigDir)
	if err != nil || state.Supported {
		t.Fatalf("temporary configuration startup status: %#v %v", state, err)
	}
	if err := a.InitializeStartupRegistration(); err != nil || a.config.StartupEnabled != nil {
		t.Fatalf("temporary configuration registered for startup: %v", err)
	}
}

func TestStartupRequestIsSavedBeforeChangingTheOS(t *testing.T) {
	a, _ := testApp(t)
	changes := 0
	a.startupHooks = &startupHooks{
		status: func(string) (platform.StartupState, error) {
			return platform.StartupState{Supported: true, CanEnable: true}, nil
		},
		set: func(string, bool) (platform.StartupState, error) {
			changes++
			return platform.StartupState{}, errors.New("OS request interrupted")
		},
	}
	if err := a.InitializeStartupRegistration(); err == nil || changes != 1 {
		t.Fatalf("OS failure: error=%v changes=%d", err, changes)
	}
	if err := a.InitializeStartupRegistration(); err != nil || changes != 1 {
		t.Fatalf("repeated an interrupted OS request: error=%v changes=%d", err, changes)
	}
	if err := os.Remove(filepath.Join(a.options.ConfigDir, "settings.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(a.options.ConfigDir, "settings.json"), 0700); err != nil {
		t.Fatal(err)
	}
	a.config.StartupEnabled = nil
	if err := a.InitializeStartupRegistration(); err == nil || changes != 1 {
		t.Fatalf("changed the OS without saving the choice: error=%v changes=%d", err, changes)
	}
}

func TestImportedStartupPreferenceAppliesToThePackageOnce(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(map[bool]string{false: "disabled", true: "enabled"}[enabled], func(t *testing.T) {
			a, _ := testApp(t)
			a.config.StartupEnabled = &enabled
			a.config.StartupRegistration = "windows"
			a.packageIdentity = &platform.PackageIdentity{FamilyName: "LocalTeXEditor_test"}
			changes := 0
			a.startupHooks = &startupHooks{
				status: func(string) (platform.StartupState, error) {
					return platform.StartupState{Supported: true, CanEnable: true}, nil
				},
				set: func(_ string, value bool) (platform.StartupState, error) {
					if !value {
						t.Fatal("an imported setting disabled the package")
					}
					changes++
					return platform.StartupState{Supported: true, Enabled: true}, nil
				},
			}
			for attempt := 0; attempt < 2; attempt++ {
				if err := a.InitializeStartupRegistration(); err != nil {
					t.Fatal(err)
				}
			}
			if (changes == 1) != enabled || changes > 1 {
				t.Fatalf("imported preference %v made %d OS requests", enabled, changes)
			}
		})
	}
}

func TestSettingsResetEnablesStartupOnlyWhenSettingsAreSelected(t *testing.T) {
	for _, resetSettings := range []bool{false, true} {
		t.Run(map[bool]string{false: "cache", true: "settings"}[resetSettings], func(t *testing.T) {
			fixture := setupSettingsResetTest(t)
			a := fixture.app
			disabled := false
			a.config.StartupEnabled = &disabled
			changes := 0
			a.startupHooks = &startupHooks{
				status: func(string) (platform.StartupState, error) {
					return platform.StartupState{Supported: true, CanEnable: true}, nil
				},
				set: func(_ string, enabled bool) (platform.StartupState, error) {
					if !enabled {
						t.Fatal("reset disabled startup")
					}
					changes++
					return platform.StartupState{Supported: true, Enabled: true, CanDisable: true}, nil
				},
			}
			response := apiRequest(a, http.MethodPost, "/api/settings/reset", settingsResetOptions{Settings: resetSettings, Cache: true, Confirmation: true}, nil)
			if response.Code != http.StatusOK || (changes == 1) != resetSettings {
				t.Fatalf("reset startup: %d %s; changes=%d", response.Code, response.Body.String(), changes)
			}
			if a.config.StartupEnabled == nil || *a.config.StartupEnabled != resetSettings {
				t.Fatalf("reset startup preference: %#v", a.config.StartupEnabled)
			}
		})
	}
}

func TestSettingsResetWaitsForASupportedStartupInstallation(t *testing.T) {
	fixture := setupSettingsResetTest(t)
	a := fixture.app
	supported, changes := false, 0
	hooks := &startupHooks{
		status: func(string) (platform.StartupState, error) {
			return platform.StartupState{Supported: supported, CanEnable: supported}, nil
		},
		set: func(string, bool) (platform.StartupState, error) {
			changes++
			return platform.StartupState{Supported: true, Enabled: true}, nil
		},
	}
	a.startupHooks = hooks
	response := apiRequest(a, http.MethodPost, "/api/settings/reset", settingsResetOptions{Settings: true, Confirmation: true}, nil)
	if response.Code != http.StatusOK || changes != 0 {
		t.Fatalf("reset in an unsupported location: %d %s; changes=%d", response.Code, response.Body.String(), changes)
	}
	if a.config.StartupEnabled == nil || !*a.config.StartupEnabled || a.config.StartupRegistration != "" {
		t.Fatalf("reset did not leave the default ready for registration: %#v", a.config)
	}
	reopened, err := New(Options{ConfigDir: a.options.ConfigDir, Token: testToken})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	supported = true
	reopened.startupHooks = hooks
	if err := reopened.InitializeStartupRegistration(); err != nil || changes != 1 {
		t.Fatalf("startup after moving to a supported location: error=%v changes=%d", err, changes)
	}
}
