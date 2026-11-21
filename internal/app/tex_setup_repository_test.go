package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestResolvedTeXSetupRepositoryUsesTheManagersActualMirror(t *testing.T) {
	fallback := "https://mirror.ctan.org/systems/texlive/tlnet"
	mirror := "https://mirrors.mit.edu/CTAN/systems/texlive/tlnet"
	for _, test := range []struct{ output, want string }{
		{"location-url\t" + mirror + "\r\nend-of-header\r\n", mirror},
		{"notice\nlocation-url\t" + mirror + "/\n", mirror},
		{"location-url\tfile:///local/repository\n", fallback},
		{"location-url\thttps://user:password@mirror.example/tlnet\n", fallback},
		{"location-url\thttps://one.example/tlnet https://two.example/tlnet\n", fallback},
		{"unable to connect\n", fallback},
	} {
		if got := resolvedTeXSetupRepository(fallback, test.output); got != test.want {
			t.Errorf("repository = %q, want %q", got, test.want)
		}
	}
}

func TestTeXSetupPackageSourceStartsAtCTANAfterNewYearsDay(t *testing.T) {
	a, parent, _ := fakeTeXSetup(t)
	startTeXSetupForTest(t, a, texSetupInput{Consent: true, Operation: "install", Parent: parent})
	installed := waitTeXSetupForTest(t, a, "succeeded")
	writeTestFile(t, filepath.Join(installed.Directory, "release-texlive.txt"), []byte(fmt.Sprintf("TeX Live version %d\n", time.Now().Year()-1)))
	startTeXSetupForTest(t, a, texSetupInput{Consent: true, Operation: "packages", Packages: []string{"siunitx"}})
	state := waitTeXSetupForTest(t, a, "succeeded")
	if state.Source != texSetupCTANRepository {
		t.Fatalf("the initial source used a calendar-based archive: %+v", state)
	}
}

func TestTeXSetupSelectsRepositoriesFromTheManagerResponse(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("this command fixture uses POSIX scripts; Windows CI also runs setup with the real distribution")
	}
	const ctan = "https://mirror.ctan.org/systems/texlive/tlnet"
	const mirror = "https://mirrors.example/CTAN/systems/texlive/tlnet"
	const fau = "https://ftp.fau.de/ctan/systems/texlive/tlnet"
	const tug = "https://tug.ctan.org/systems/texlive/tlnet"
	// Use an earlier calendar year so this test catches the old date-based
	// selection every year, including the period before the next TL release.
	year := time.Now().Year() - 1
	archive := fmt.Sprintf("https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/%d/tlnet-final", year)
	for _, test := range []struct {
		name, mode, status, repository string
		updates, installs              []string
		staleLog, reinstall            bool
	}{
		{"the same release after New Year's Day", "same", "succeeded", mirror, []string{ctan}, []string{mirror}, false, false},
		{"the repository has advanced to the next release", "older", "succeeded", archive, []string{ctan, archive}, []string{archive}, false, false},
		{"the first mirror is temporarily unavailable", "first-network", "succeeded", fau, []string{ctan, fau}, []string{fau}, false, false},
		{"all mirrors are unavailable", "all-network", "failed", "", []string{ctan, fau, tug}, nil, false, false},
		{"a previous release error does not change a network retry", "all-network", "failed", "", []string{ctan, fau, tug}, nil, true, false},
		{"the release changes between update and install", "install-release", "succeeded", archive, []string{ctan, archive}, []string{mirror, archive}, false, false},
		{"infrastructure changes on the selected mirror", "install-infrastructure", "succeeded", mirror, []string{ctan, mirror}, []string{mirror, mirror}, false, false},
		{"a package download is retried on the same mirror", "install-network", "succeeded", mirror, []string{ctan}, []string{mirror, mirror}, false, true},
		{"an unavailable archive is tried only once", "archive-network", "failed", "", []string{ctan, archive, fau, tug}, nil, false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			a, parent, _ := fakeTeXSetup(t)
			trace := filepath.Join(t.TempDir(), "commands.txt")
			t.Setenv("LOCAL_TEX_SETUP_REPOSITORY_TRACE", trace)
			t.Setenv("LOCAL_TEX_SETUP_REPOSITORY_MODE", test.mode)
			t.Setenv("LOCAL_TEX_SETUP_REPOSITORY_YEAR", fmt.Sprint(year))
			extract := a.texSetupHooks.extract
			a.texSetupHooks.extract = func(ctx context.Context, run *texSetupRun, path string) error {
				if err := extract(ctx, run, path); err != nil {
					return err
				}
				if err := os.WriteFile(filepath.Join(run.root, "release-texlive.txt"), []byte(fmt.Sprintf("TeX Live version %d\n", year)), 0600); err != nil {
					return err
				}
				for _, name := range []string{"tlmgr", "mktexlsr", "updmap-sys", "fmtutil-sys"} {
					if err := os.WriteFile(filepath.Join(texSetupBinDirectory(run.root), name), []byte(texSetupRepositoryFixture), 0700); err != nil {
						return err
					}
				}
				return nil
			}
			a.texSetupHooks.packages = func(ctx context.Context, run *texSetupRun) error {
				if test.staleLog {
					a.texSetupLog(run, "Local TeX Live (%d) is older than remote repository (%d).\n", year, year+1)
				}
				run.reinstall = test.reinstall
				return a.installTeXSetupPackages(ctx, run)
			}
			startTeXSetupForTest(t, a, texSetupInput{Consent: true, Operation: "install", Parent: parent})
			state := waitTeXSetupForTest(t, a, test.status)
			data, err := os.ReadFile(trace)
			if err != nil {
				t.Fatal(err)
			}
			var updates, installs []string
			stored := ""
			for _, line := range strings.Split(string(data), "\n") {
				action, value, _ := strings.Cut(line, "\t")
				switch action {
				case "update":
					updates = append(updates, value)
				case "install":
					installs = append(installs, value)
				case "option":
					stored = value
				}
			}
			if !reflect.DeepEqual(updates, test.updates) || !reflect.DeepEqual(installs, test.installs) || stored != test.repository {
				t.Fatalf("updates=%q installs=%q stored=%q; want updates=%q installs=%q stored=%q\n%s", updates, installs, stored, test.updates, test.installs, test.repository, state.Log)
			}
			if test.status == "failed" {
				if a.config.TexBin != "" || strings.Contains(string(data), "fmtutil-sys") {
					t.Fatal("a failed repository operation completed setup")
				}
			} else {
				if a.config.TexBin != state.Bin || !strings.Contains(string(data), "fmtutil-sys") {
					t.Fatal("setup did not complete after package installation")
				}
				if test.reinstall && !strings.Contains(string(data), "packages\t--reinstall ") {
					t.Fatal("the package retry omitted --reinstall")
				}
			}
		})
	}
}

const texSetupRepositoryFixture = `#!/bin/sh
set -eu
trace=$LOCAL_TEX_SETUP_REPOSITORY_TRACE
mode=$LOCAL_TEX_SETUP_REPOSITORY_MODE
year=$LOCAL_TEX_SETUP_REPOSITORY_YEAR
tool=${0##*/}
if [ "$tool" != tlmgr ]; then
  printf '%s\n' "$tool" >> "$trace"
  exit 0
fi
machine=
if [ "$1" = --machine-readable ]; then machine=1; shift; fi
if [ "$1" = option ]; then
  [ "$2" = repository ]
  printf 'option\t%s\n' "$3" >> "$trace"
  exit 0
fi
if [ "$1" = postaction ]; then exit 0; fi
[ "$1" = --repository ]
repository=$2
shift 2
action=$1
shift
printf '%s\t%s\n' "$action" "$repository" >> "$trace"
archive=
case "$repository" in */tlnet-final) archive=1 ;; esac
mismatch() {
  printf 'Local TeX Live (%s) is older than remote repository (%s).\n' "$year" "$((year + 1))" >&2
  exit 2
}
network() { printf 'repository connection failed\n' >&2; exit 3; }
if [ "$action" = update ]; then
  [ "$machine" = 1 ] && [ "$1" = --self ]
  case "$mode" in
    all-network) network ;;
    first-network)
      case "$repository" in https://mirror.ctan.org/*) network ;; esac ;;
    older) [ "$archive" = 1 ] || mismatch ;;
    archive-network)
      if [ "$archive" = 1 ]; then network; else mismatch; fi ;;
  esac
  if [ -f "$trace.infrastructure" ]; then : > "$trace.updated"; fi
  case "$repository" in
    https://mirror.ctan.org/*) repository=https://mirrors.example/CTAN/systems/texlive/tlnet ;;
  esac
  printf 'location-url\t%s\nend-of-header\nend-of-updates\n' "$repository"
  exit 0
fi
[ "$action" = install ]
printf 'packages\t%s\n' "$*" >> "$trace"
case " $* " in *' amsmath '*) ;; *) exit 65 ;; esac
case " $* " in *' collection-langjapanese '*) ;; *) exit 66 ;; esac
case "$mode" in
  install-release) [ "$archive" = 1 ] || mismatch ;;
  install-infrastructure)
    if [ ! -f "$trace.updated" ]; then
      : > "$trace.infrastructure"
      printf 'tlmgr itself needs to be updated.\n' >&2
      exit 2
    fi ;;
  install-network)
    if [ ! -f "$trace.retry" ]; then : > "$trace.retry"; network; fi ;;
esac
`
