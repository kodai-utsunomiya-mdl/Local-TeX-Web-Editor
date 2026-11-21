package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestArchivedTeXRepositoryRequiresTheManagerReleaseError(t *testing.T) {
	message := "tlmgr: Local TeX Live (2025) is older than remote repository (2026).\n"
	archive := "https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2025/tlnet-final"
	for _, test := range []struct{ repository, output, want string }{
		{"ctan", message, archive},
		{"CTAN", message, archive},
		{"Ctan", message, archive},
		{"https://mirror.ctan.org/systems/texlive/tlnet", message, archive},
		{"https://ftp.fau.de/ctan/systems/texlive/tlnet/", message, archive},
		{"https://mirror.example/ctan/systems/texlive/tlnet/tlpkg/", message, archive},
		{"https://mirror.ctan.org/systems/texlive/tlnet", "unable to connect", ""},
		{"https://mirror.ctan.org/systems/texlive/tlnet", "Local TeX Live (2026) is older than remote repository (2025)", ""},
		{archive, message, ""},
		{"/mnt/texlive/tlnet", message, ""},
		{"https://tex.example/private", message, ""},
		{"https://mirror.ctan.org/systems/texlive/tlnet#main https://tex.example/addons#extra", message, ""},
		{"https://mirror.ctan.org/systems/texlive/tlnet?frozen=1", message, ""},
	} {
		if got := archivedTeXRepository(test.repository, test.output); got != test.want {
			t.Errorf("archivedTeXRepository(%q, %q) = %q, want %q", test.repository, test.output, got, test.want)
		}
	}
}

func TestInstalledTeXRepositoryUsesOnlyInstallationRecord(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "tlpkg"), 0700); err != nil {
		t.Fatal(err)
	}
	database := "name 00texlive.config\r\ndepend opt_location:wrong\r\n\r\nname 00texlive.installation\r\ndepend opt_location:https://tex.example/systems/texlive/tlnet\r\n\r\nname example\r\ndepend opt_location:wrong-again\r\n"
	if err := os.WriteFile(filepath.Join(root, "tlpkg", "texlive.tlpdb"), []byte(database), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := installedTeXRepository(root)
	if err != nil || got != "https://tex.example/systems/texlive/tlnet" {
		t.Fatalf("repository = %q, error = %v", got, err)
	}
}

func TestSelectedTeXRepositoryUsesThisCommandsSingleRepository(t *testing.T) {
	const mirror = "https://mirrors.example/CTAN/systems/texlive/tlnet"
	const multiple = "https://mirror.ctan.org/systems/texlive/tlnet#main https://packages.example/custom#extra"
	for _, test := range []struct{ repository, output, want string }{
		{"ctan", "tlmgr: package repository " + mirror + " (verified)\n", mirror},
		{"https://mirror.ctan.org/systems/texlive/tlnet", "tlmgr.pl: package repository " + mirror + " (not verified: pubkey missing)\r\n", mirror},
		{"ctan", "location-url\t" + mirror + "\nend-of-header\n", mirror},
		{"/local/repository", "location-url\t" + mirror + "\n", "/local/repository"},
		{multiple, "tlmgr: package repository " + mirror + " (verified)\n", multiple},
		{"https://packages.example/custom?frozen=1", "location-url\t" + mirror + "\n", "https://packages.example/custom?frozen=1"},
		{"ctan", "tlmgr: package repository https://user:password@example.org/tlnet (verified)\n", "ctan"},
		{"ctan", "repository unavailable\n", "ctan"},
	} {
		if got := resolvedSelectedTeXRepository(test.repository, test.output); got != test.want {
			t.Errorf("resolved repository = %q, want %q", got, test.want)
		}
	}
}

func TestSelectedTeXPackageAdditionCompletesRequiredManagerUpdates(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the repository fixture uses POSIX executables; Windows has separate updater and elevation execution tests")
	}
	const mirror = "https://mirrors.example/CTAN/systems/texlive/tlnet"
	const custom = "https://packages.example/custom"
	const multiple = "https://mirror.ctan.org/systems/texlive/tlnet#main https://packages.example/custom#extra"
	const archive = "https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2025/tlnet-final"
	for _, test := range []struct {
		name, mode, repository string
		want                   []string
		failure, staleLog      bool
	}{
		{"current manager", "success", "ctan", []string{"install\t<configured>"}, false, false},
		{"same release needs the manager update", "update", "ctan", []string{"install\t<configured>", "update\t" + mirror, "install\t" + mirror}, false, false},
		{"a custom repository needs the manager update", "update", custom, []string{"install\t<configured>", "update\t" + custom, "install\t" + custom}, false, false},
		{"multiple repositories keep their tags", "update", multiple, []string{"install\t<configured>", "update\t" + multiple, "install\t" + multiple}, false, false},
		{"an older release also needs the manager update", "older", "ctan", []string{"install\t<configured>", "install\t" + archive, "update\t" + archive, "install\t" + archive}, false, false},
		{"the release changes before the manager update", "update-older", "ctan", []string{"install\t<configured>", "update\t" + mirror, "update\t" + archive, "install\t" + archive}, false, false},
		{"failed manager update stops installation", "update-fails", "ctan", []string{"install\t<configured>", "update\t" + mirror}, true, false},
		{"a previous release error does not change an update failure", "update-fails", "ctan", []string{"install\t<configured>", "update\t" + mirror}, true, true},
		{"a repeated update warning stops after one update", "always-update", "ctan", []string{"install\t<configured>", "update\t" + mirror, "install\t" + mirror}, true, false},
		{"a network error does not update the manager", "network", "ctan", []string{"install\t<configured>"}, true, true},
		{"a private release mismatch leaves its repository in place", "older", custom, []string{"install\t<configured>"}, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			a, run, trace := selectedTeXRepositoryFixture(t, test.repository, test.mode)
			if test.staleLog {
				a.texSetupLog(run, "tlmgr itself needs to be updated.\nLocal TeX Live (2025) is older than remote repository (2026).\n")
			}
			err := a.addSelectedTeXPackages(run)
			if (err != nil) != test.failure {
				t.Fatalf("package addition returned %v; log=%s", err, run.log)
			}
			data, err := os.ReadFile(trace)
			if err != nil {
				t.Fatal(err)
			}
			got := strings.Split(strings.TrimSpace(string(data)), "\n")
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("commands = %q, want %q; log=%s", got, test.want, run.log)
			}
			stored, err := installedTeXRepository(run.root)
			if err != nil || stored != test.repository || a.config.TexBin != run.bin {
				t.Fatalf("changed the selected environment or its repository: %q %v", stored, err)
			}
		})
	}
}

func TestSelectedTeXPackageAdditionStopsAfterCancellingTheManagerUpdate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fixture uses POSIX executables")
	}
	a, run, trace := selectedTeXRepositoryFixture(t, "ctan", "cancel-update")
	ctx, cancel := context.WithCancel(run.ctx)
	defer cancel()
	run.ctx = ctx
	done := make(chan error, 1)
	go func() { done <- a.addSelectedTeXPackages(run) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		data, _ := os.ReadFile(trace)
		if strings.Contains(string(data), "update\t") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the manager update did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("the update did not return cancellation: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the cancelled update did not stop")
	}
	data, err := os.ReadFile(trace)
	if err != nil || strings.Count(string(data), "install\t") != 1 {
		t.Fatalf("package installation continued after cancellation: %s %v", data, err)
	}
}

func selectedTeXRepositoryFixture(t *testing.T, repository, mode string) (*App, *texSetupRun, string) {
	t.Helper()
	a, _ := testApp(t)
	root, bin, _ := externalTeXTestTree(t)
	root, _ = filepath.EvalSymlinks(root)
	bin, _ = filepath.EvalSymlinks(bin)
	database := "name 00texlive.installation\ndepend opt_location:" + repository + "\n\nname texlive.infra\nrevision 1\n\n"
	writeTestFile(t, filepath.Join(root, "tlpkg", "texlive.tlpdb"), []byte(database))
	variables := "#!/bin/sh\ncase \"$1\" in\n" +
		"-var-value=TEXMFROOT) printf '%s\\n' " + posixLiteral(root) + ";;\n" +
		"-var-value=TEXMFSYSVAR) printf '%s\\n' " + posixLiteral(filepath.Join(root, "texmf-var")) + ";;\n" +
		"-var-value=TEXMFSYSCONFIG) printf '%s\\n' " + posixLiteral(filepath.Join(root, "texmf-config")) + ";;\n" +
		"*) exit 2;;\nesac\n"
	for name, content := range map[string]string{"kpsewhich": variables, "tlmgr": selectedTeXPackageManagerFixture} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(content), 0700); err != nil {
			t.Fatal(err)
		}
	}
	trace := filepath.Join(t.TempDir(), "commands.txt")
	t.Setenv("LOCAL_TEX_SELECTED_REPOSITORY_TRACE", trace)
	t.Setenv("LOCAL_TEX_SELECTED_REPOSITORY", repository)
	t.Setenv("LOCAL_TEX_SELECTED_REPOSITORY_MODE", mode)
	a.config.TexBin = bin
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	environment, err := inspectExternalTeX(ctx, bin)
	if err != nil {
		t.Fatal(err)
	}
	run := &texSetupRun{ctx: ctx, root: root, bin: bin, configuredBin: bin, external: &environment, reinstall: true,
		state: TeXSetupState{Operation: "packages", Packages: []string{"siunitx", "blindtext"}, Environment: &environment}}
	return a, run, trace
}

const selectedTeXPackageManagerFixture = `#!/bin/sh
set -eu
trace=$LOCAL_TEX_SELECTED_REPOSITORY_TRACE
repository=$LOCAL_TEX_SELECTED_REPOSITORY
mode=$LOCAL_TEX_SELECTED_REPOSITORY_MODE
reported='<configured>'
machine=
if [ "$1" = --machine-readable ]; then machine=1; shift; fi
if [ "$1" = --repository ]; then repository=$2; reported=$2; shift 2; fi
action=$1
shift
printf '%s\t%s\n' "$action" "$reported" >> "$trace"
if [ "$repository" = ctan ]; then repository=https://mirrors.example/CTAN/systems/texlive/tlnet; fi
archive=
case "$repository" in */tlnet-final) archive=1 ;; esac
mismatch() { printf 'Local TeX Live (2025) is older than remote repository (2026).\n' >&2; exit 2; }
if [ "$action" = update ]; then
  [ "$machine" = 1 ] && [ "$#" = 1 ] && [ "$1" = --self ]
  case "$mode" in
    update-fails) printf 'update download failed\n' >&2; exit 7 ;;
    update-older) [ "$archive" = 1 ] || mismatch ;;
    cancel-update) while :; do sleep 1; done ;;
  esac
  : > "$trace.updated"
  printf 'location-url\t%s\nend-of-header\nend-of-updates\n' "$repository"
  exit 0
fi
[ "$action" = install ] && [ -z "$machine" ]
[ "$#" = 3 ] && [ "$1" = --reinstall ] && [ "$2" = siunitx ] && [ "$3" = blindtext ]
printf 'tlmgr.pl: package repository %s (verified)\n' "$repository"
case "$mode" in
  success) exit 0 ;;
  network) printf 'repository connection failed\n' >&2; exit 3 ;;
  older) [ "$archive" = 1 ] || mismatch ;;
esac
if [ "$mode" = always-update ] || [ ! -f "$trace.updated" ]; then
  printf 'tlmgr itself needs to be updated.\n' >&2
  exit 2
fi
`
