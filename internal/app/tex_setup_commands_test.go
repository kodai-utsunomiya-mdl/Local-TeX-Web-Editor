package app

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestTeXSetupChecksPDFCreationFromAnInstallationWithSpaces(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("this command fixture uses POSIX scripts; CI also installs and compiles with the Windows distribution")
	}
	for _, failure := range []bool{false, true} {
		name := "all engines produce PDFs"
		if failure {
			name = "the XDV converter fails"
		}
		t.Run(name, func(t *testing.T) {
			a, parent, _ := fakeTeXSetup(t)
			parent = filepath.Join(parent, "TeX installation")
			if err := os.Mkdir(parent, 0700); err != nil {
				t.Fatal(err)
			}
			extract := a.texSetupHooks.extract
			a.texSetupHooks.extract = func(ctx context.Context, run *texSetupRun, archive string) error {
				if err := extract(ctx, run, archive); err != nil {
					return err
				}
				bin := texSetupBinDirectory(run.root)
				files, err := os.ReadDir(bin)
				if err != nil {
					return err
				}
				for _, file := range files {
					if err := os.WriteFile(filepath.Join(bin, file.Name()), []byte(texSetupCompilerFixture), 0700); err != nil {
						return err
					}
				}
				return nil
			}
			a.texSetupHooks.check = a.checkTeXSetup
			if failure {
				t.Setenv("LOCAL_TEX_SETUP_CONVERTER_FAILURE", "1")
			} else {
				t.Setenv("LOCAL_TEX_SETUP_CONVERTER_FAILURE", "")
			}
			startTeXSetupForTest(t, a, texSetupInput{Consent: true, Operation: "install", Parent: parent})
			if failure {
				state := waitTeXSetupForTest(t, a, "failed")
				if !strings.Contains(state.Log, "fixture converter failure") || strings.Contains(state.Log, "[checked] xelatex") || a.config.TexBin != "" {
					t.Fatalf("a failed PDF converter completed setup: %+v", state)
				}
				assertCompiledPDFFileMissing(t, filepath.Dir(state.Directory))
				return
			}
			state := waitTeXSetupForTest(t, a, "succeeded")
			for _, engine := range []string{"pdflatex", "lualatex", "xelatex", "uplatex"} {
				if !strings.Contains(state.Log, "[checked] "+engine) {
					t.Fatalf("the %s PDF was not checked: %s", engine, state.Log)
				}
			}
		})
	}
}

// XeTeX can write XDV in a directory with spaces even when its built-in PDF
// driver cannot start. The fixture requires a separate converter invocation
// and creates a PDF only after that converter has read the intermediate file.
const texSetupCompilerFixture = `#!/bin/sh
set -eu
tool=${0##*/}
case "$tool" in
  latexmk|synctex|bibtex|upbibtex|biber|upmendex) exit 0 ;;
  pdflatex|lualatex)
    for source do :; done
    printf '%%PDF-1.7\nfixture\n' > "${source%.tex}.pdf" ;;
  xelatex)
    case " $* " in *" -no-pdf "*) ;; *) exit 65 ;; esac
    for source do :; done
    printf 'fixture XDV\n' > "${source%.tex}.xdv" ;;
  xdvipdfmx)
    if [ "${LOCAL_TEX_SETUP_CONVERTER_FAILURE:-}" = 1 ]; then
      printf 'fixture converter failure\n' >&2
      exit 66
    fi
    [ "$1" = -E ] && [ "$2" = -o ] && [ -f "$4" ]
    printf '%%PDF-1.7\nfixture\n' > "$3" ;;
  uplatex)
    for source do :; done
    printf 'fixture DVI\n' > "${source%.tex}.dvi" ;;
  dvipdfmx)
    [ "$1" = -o ] && [ -f "$3" ]
    printf '%%PDF-1.7\nfixture\n' > "$2" ;;
  *) exit 67 ;;
esac
`

// This optional check compiles with a selected test installation. Use a
// disposable copy: the engines can update their format and font caches.
func TestTeXSetupInstalledCompilers(t *testing.T) {
	bin := os.Getenv("LOCAL_TEX_SETUP_CHECK_BIN")
	if bin == "" {
		t.Skip("no test installation was selected")
	}
	a, _ := testApp(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	run := &texSetupRun{bin: bin, root: filepath.Dir(filepath.Dir(bin))}
	if err := a.checkTeXSetup(ctx, run); err != nil {
		t.Fatalf("the installed engines could not create PDFs: %v\n%s", err, run.log)
	}
	a.config.TexBin = bin
	a.project.Mode = "xelatex"
	response := apiRequest(a, http.MethodPost, "/api/build", map[string]string{}, nil)
	if response.Code != http.StatusAccepted {
		t.Fatalf("build request: %d %s", response.Code, response.Body.String())
	}
	a.workers.Wait()
	response = apiRequest(a, http.MethodGet, "/api/state", nil, nil)
	var state State
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &state) != nil {
		t.Fatalf("completed build state: %d %s", response.Code, response.Body.String())
	}
	if state.Build == nil || state.Build.Status != "success" || state.Build.PDFBuildID == "" || !strings.Contains(state.Build.Log, "xdvipdfmx") || !strings.Contains(state.Build.Log, "-no-pdf") {
		t.Fatalf("latexmk did not complete the XDV-to-PDF sequence: %+v", state.Build)
	}
}
