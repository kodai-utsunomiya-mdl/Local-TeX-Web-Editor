package platform

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStartupLaunchAgentUsesTheApplicationPathAndBackgroundArgument(t *testing.T) {
	executable := "/Users/test/Applications/文章 & TeX.app/Contents/MacOS/local-tex-web-editor"
	data := startupLaunchAgent(executable)
	actual, err := startupLaunchAgentExecutable(data)
	if err != nil || actual != executable {
		t.Fatalf("read startup application: %q %v", actual, err)
	}
	if !bytes.Contains(data, []byte("文章 &amp; TeX.app")) || bytes.Contains(data, []byte("KeepAlive")) {
		t.Fatalf("unexpected launch agent: %s", data)
	}
	for _, change := range []struct{ from, to string }{
		{startupAgentLabel, "another.application"},
		{"--background", "--other"},
		{"<true/>", "<false/>"},
		{"local-tex-web-editor</string>", "another-program</string>"},
		{"<key>Label</key>", "<key>Label</key><string>duplicate</string><key>Label</key>"},
	} {
		if _, err := startupLaunchAgentExecutable(bytes.Replace(data, []byte(change.from), []byte(change.to), 1)); !errors.Is(err, ErrStartupConflict) {
			t.Fatalf("accepted changed registration %q: %v", change.from, err)
		}
	}
}

func TestStartupLaunchAgentAcceptsTheNativeLauncherAndMigratesTheOldPath(t *testing.T) {
	directory := t.TempDir()
	registration := filepath.Join(directory, "editor.plist")
	legacy := "/Applications/Local TeX Web Editor.app/Contents/MacOS/local-tex-web-editor"
	launcher := "/Applications/Local TeX Web Editor.app/Contents/MacOS/LocalTeXWebEditor"
	if err := writeStartupFile(registration, startupLaunchAgent(legacy), false); err != nil {
		t.Fatal(err)
	}
	for _, executable := range []string{legacy, launcher} {
		if err := writeStartupFile(registration, startupLaunchAgent(executable), true); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(registration)
		if err != nil {
			t.Fatal(err)
		}
		actual, err := startupLaunchAgentExecutable(data)
		if err != nil || actual != executable {
			t.Fatalf("read registered launcher: %q %v", actual, err)
		}
	}
}

func TestStartupFileUpdatesOnlyTheReviewedRegularFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "LaunchAgents", startupAgentLabel+".plist")
	first := startupLaunchAgent("/Applications/Local TeX Web Editor.app/Contents/MacOS/local-tex-web-editor")
	if err := writeStartupFile(path, first, false); err != nil {
		t.Fatal(err)
	}
	if err := writeStartupFile(path, []byte("other"), false); !errors.Is(err, ErrStartupConflict) {
		t.Fatalf("replaced an existing file without a review: %v", err)
	}
	second := bytes.Replace(first, []byte("/Applications/"), []byte("/Users/test/Applications/"), 1)
	if err := writeStartupFile(path, second, true); err != nil {
		t.Fatal(err)
	}
	actual, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(actual, second) {
		t.Fatalf("updated file: %s %v", actual, err)
	}
	for _, executable := range []string{"relative/Editor.app/Contents/MacOS/local-tex-web-editor", "/tmp/local-tex-web-editor", "/Applications/Editor.app/Contents/Resources/local-tex-web-editor"} {
		if validStartupMacExecutable(executable) {
			t.Fatalf("accepted an unsupported application path: %s", executable)
		}
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(entries) != 1 || strings.HasPrefix(entries[0].Name(), ".local-tex-startup-") {
		t.Fatalf("temporary startup files were left behind: %v %v", entries, err)
	}
}
