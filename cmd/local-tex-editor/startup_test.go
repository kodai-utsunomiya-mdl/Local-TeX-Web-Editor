package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"testing"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

func runStartupTest(t *testing.T, arguments ...string) (bool, error) {
	t.Helper()
	previousArgs, previousFlags, previousNoBrowser := os.Args, flag.CommandLine, noBrowser
	defer func() {
		os.Args, flag.CommandLine, noBrowser = previousArgs, previousFlags, previousNoBrowser
	}()
	os.Args = append([]string{"local-tex-web-editor"}, arguments...)
	flag.CommandLine = flag.NewFlagSet(os.Args[0], flag.ContinueOnError)
	err := run()
	return noBrowser, err
}

func TestDisabledStartupExitsBeforeOpeningProjectsOrSavingConnections(t *testing.T) {
	directory, project := t.TempDir(), t.TempDir()
	settings, err := json.Marshal(map[string]any{"startupEnabled": false, "recentProjects": []string{project}})
	if err != nil {
		t.Fatal(err)
	}
	settingsPath := filepath.Join(directory, "settings.json")
	if err := os.WriteFile(settingsPath, settings, 0600); err != nil {
		t.Fatal(err)
	}
	mainPath := filepath.Join(project, "main.tex")
	if err := os.WriteFile(mainPath, []byte("saved document\n"), 0600); err != nil {
		t.Fatal(err)
	}
	ready := filepath.Join(directory, "ready.json")
	hidden, err := runStartupTest(t, "--startup", "--config-dir", directory, "--project", project, "--ready-file", ready)
	if err != nil || !hidden {
		t.Fatalf("disabled login launch: noBrowser = %v, error = %v", hidden, err)
	}
	if data, err := os.ReadFile(settingsPath); err != nil || !bytes.Equal(data, settings) {
		t.Fatalf("the disabled login launch changed settings: %v", err)
	}
	if entries, err := os.ReadDir(project); err != nil || len(entries) != 1 || entries[0].Name() != "main.tex" {
		t.Fatalf("the disabled login launch changed the project: entries = %v, error = %v", entries, err)
	}
	for _, name := range []string{"connection.json", "active.json", "ready.json"} {
		if _, err := os.Stat(filepath.Join(directory, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("the disabled login launch created %s: %v", name, err)
		}
	}
	checked := make(chan error, 1)
	go func() {
		release, err := platform.AcquireAppLock(directory)
		if err == nil {
			release()
		}
		checked <- err
	}()
	if err := <-checked; err != nil {
		t.Fatalf("the disabled login launch left the instance lock in use: %v", err)
	}
}

func TestStartupReadsSettingsOnlyAfterAcquiringTheInstanceLock(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "settings.json"), []byte(`{"startupEnabled":`), 0600); err != nil {
		t.Fatal(err)
	}
	locked, unlock, finished := make(chan error, 1), make(chan struct{}), make(chan struct{})
	go func() {
		release, err := platform.AcquireAppLock(directory)
		locked <- err
		if err == nil {
			<-unlock
			release()
		}
		close(finished)
	}()
	defer func() { close(unlock); <-finished }()
	if err := <-locked; err != nil {
		t.Fatal(err)
	}
	hidden, err := runStartupTest(t, "--startup", "--config-dir", directory)
	if err != nil || !hidden {
		t.Fatalf("a login launch read settings while another instance was running: noBrowser = %v, error = %v", hidden, err)
	}
}

func TestStartupReportsInvalidSettingsBeforeOpeningAConnection(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "settings.json"), []byte(`{"startupEnabled":`), 0600); err != nil {
		t.Fatal(err)
	}
	hidden, err := runStartupTest(t, "--startup", "--config-dir", directory)
	var syntax *json.SyntaxError
	if !hidden || !errors.As(err, &syntax) {
		t.Fatalf("invalid login settings: noBrowser = %v, error = %v", hidden, err)
	}
	if _, err := os.Stat(filepath.Join(directory, "connection.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("invalid settings created a browser connection: %v", err)
	}
}
