package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStartupEnabledReadsTheSavedPreferenceWithoutWriting(t *testing.T) {
	for _, test := range []struct {
		name, settings string
		want           bool
	}{
		{name: "missing", want: true},
		{name: "unset", settings: `{}`, want: true},
		{name: "null", settings: `{"startupEnabled":null}`, want: true},
		{name: "enabled", settings: `{"startupEnabled":true}`, want: true},
		{name: "disabled", settings: `{"startupEnabled":false}`, want: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			directory := t.TempDir()
			path := filepath.Join(directory, "settings.json")
			if test.settings != "" {
				writeTestFile(t, path, []byte(test.settings))
			}
			enabled, err := StartupEnabled(directory)
			if err != nil || enabled != test.want {
				t.Fatalf("enabled = %v, error = %v", enabled, err)
			}
			data, err := os.ReadFile(path)
			if test.settings == "" {
				if !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("checking the default created settings: %v", err)
				}
			} else if err != nil || !bytes.Equal(data, []byte(test.settings)) {
				t.Fatalf("checking the saved preference changed settings: %v", err)
			}
		})
	}
}

func TestStartupEnabledReadsTheLatestSavedChoice(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "settings.json")
	for _, choice := range []bool{true, false, true} {
		data, err := json.Marshal(map[string]bool{"startupEnabled": choice})
		if err != nil {
			t.Fatal(err)
		}
		writeTestFile(t, path, data)
		if enabled, err := StartupEnabled(directory); err != nil || enabled != choice {
			t.Fatalf("saved choice = %v, enabled = %v, error = %v", choice, enabled, err)
		}
	}
}

func TestStartupEnabledReportsInvalidSettings(t *testing.T) {
	for _, test := range []struct {
		name, settings, kind string
	}{
		{name: "incomplete JSON", settings: `{"startupEnabled":false`, kind: "syntax"},
		{name: "invalid preference", settings: `{"startupEnabled":"false"}`, kind: "type"},
		{name: "invalid project settings", settings: `{"startupEnabled":false,"projects":[]}`, kind: "type"},
		{name: "too large", settings: strings.Repeat(" ", (1<<20)+1), kind: "size"},
		{name: "unreadable file", kind: "path"},
	} {
		t.Run(test.name, func(t *testing.T) {
			directory := t.TempDir()
			path := filepath.Join(directory, "settings.json")
			if test.kind == "path" {
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			} else {
				writeTestFile(t, path, []byte(test.settings))
			}
			enabled, err := StartupEnabled(directory)
			if err == nil || enabled {
				t.Fatalf("invalid settings allowed a login launch: enabled = %v, error = %v", enabled, err)
			}
			var syntax *json.SyntaxError
			var valueType *json.UnmarshalTypeError
			var pathError *os.PathError
			switch test.kind {
			case "syntax":
				if !errors.As(err, &syntax) {
					t.Fatalf("expected a JSON syntax error: %v", err)
				}
			case "type":
				if !errors.As(err, &valueType) {
					t.Fatalf("expected a JSON type error: %v", err)
				}
			case "path":
				if !errors.As(err, &pathError) {
					t.Fatalf("expected a file read error: %v", err)
				}
			case "size":
				if !strings.Contains(err.Error(), "設定ファイルが大きすぎます") {
					t.Fatalf("expected the settings size limit: %v", err)
				}
			}
		})
	}
}
