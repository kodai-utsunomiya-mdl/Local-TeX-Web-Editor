package app

import (
	"encoding/json"
	"net/http"
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

func TestSettingsResetDisablesStartupOnlyWhenSettingsAreSelected(t *testing.T) {
	for _, resetSettings := range []bool{false, true} {
		t.Run(map[bool]string{false: "cache", true: "settings"}[resetSettings], func(t *testing.T) {
			fixture := setupSettingsResetTest(t)
			a := fixture.app
			changes := 0
			a.startupHooks = &startupHooks{
				status: func(string) (platform.StartupState, error) {
					return platform.StartupState{Supported: true, Enabled: true, CanDisable: true}, nil
				},
				set: func(_ string, enabled bool) (platform.StartupState, error) {
					if enabled {
						t.Fatal("reset enabled startup")
					}
					changes++
					return platform.StartupState{Supported: true, CanEnable: true}, nil
				},
			}
			response := apiRequest(a, http.MethodPost, "/api/settings/reset", settingsResetOptions{Settings: resetSettings, Cache: true, Confirmation: true}, nil)
			if response.Code != http.StatusOK || (changes == 1) != resetSettings {
				t.Fatalf("reset startup: %d %s; changes=%d", response.Code, response.Body.String(), changes)
			}
		})
	}
}
