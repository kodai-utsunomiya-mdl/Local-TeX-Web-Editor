package app

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func writePackageTool(t *testing.T, path string) {
	t.Helper()
	writeTestFile(t, path, []byte("this file must not be executed while reading package information\n"))
	if err := os.Chmod(path, 0755); err != nil {
		t.Fatal(err)
	}
}

func TestTeXPackageStatusUsesTheSelectedInstallationAndFindsMissingPrograms(t *testing.T) {
	root := filepath.Join(t.TempDir(), "author's TeX", "2025")
	bin := filepath.Join(root, "bin", "test-platform")
	managerName, extension := "tlmgr", ""
	if runtime.GOOS == "windows" {
		managerName, extension = "tlmgr.bat", ".exe"
	}
	writePackageTool(t, filepath.Join(bin, managerName))
	writePackageTool(t, filepath.Join(bin, "synctex"+extension))
	writeTestFile(t, filepath.Join(root, "release-texlive.txt"), []byte("TeX Live version 2025\n"))
	writeTestFile(t, filepath.Join(root, "tlpkg", "texlive.tlpdb"), []byte("name 00texlive.installation\ndepend opt_location:https://mirror.ctan.org/systems/texlive/tlnet\n"))
	status := texPackagesStatus(bin)
	if status.Manager != filepath.Join(bin, managerName) || status.Year != 2025 || status.Bin != bin {
		t.Fatalf("package manager information: %#v", status)
	}
	if status.Repository != texSetupCTANRepository || !strings.Contains(status.CommandPrefix, "tlmgr") || strings.Contains(status.CommandPrefix, "--repository") {
		t.Fatalf("package command: %#v", status)
	}
	programs := map[string]TeXProgramStatus{}
	for _, program := range status.Programs {
		programs[program.Name] = program
	}
	if programs["latexmk"].Available || programs["latexmk"].Path != filepath.Join(bin, "latexmk"+extension) || !programs["synctex"].Available {
		t.Fatalf("program availability: %#v", programs)
	}
	if len(programs["uplatex"].Packages) == 0 || len(programs["lualatex"].Packages) == 0 {
		t.Fatal("missing engines need package names for the install command")
	}
	other := filepath.Join(t.TempDir(), "different TeX")
	missing := texPackagesStatus(other)
	if missing.Bin != other || missing.Manager != "" || missing.CommandPrefix != "" {
		t.Fatalf("a missing selected installation fell back to another: %#v", missing)
	}
}

func TestTeXPackageCommandsQuotePathsAndKeepUnknownRepositories(t *testing.T) {
	windows := `C:\TeX files\author's $(program)\tlmgr.bat`
	command := texPackageCommand(windows, "windows")
	if command != "& 'C:\\TeX files\\author''s $(program)\\tlmgr.bat'" {
		t.Fatalf("PowerShell quoting: %q", command)
	}
	mac := "/Users/author's $(program)/TeX tools/tlmgr"
	command = texPackageCommand(mac, "darwin")
	if command != "'/Users/author'\"'\"'s $(program)/TeX tools/tlmgr'" {
		t.Fatalf("POSIX quoting: %q", command)
	}
	if command := texPackageCommand("", "darwin"); command != "" {
		t.Fatalf("a missing manager produced a command: %q", command)
	}
}

func TestTeXPackageStatusReportsTheConfiguredRepositoryAcrossCalendarYears(t *testing.T) {
	for _, repository := range []string{
		texSetupCTANRepository,
		"https://tex.example/private",
		"/local/tex-repository",
		"https://mirror.ctan.org/systems/texlive/tlnet#main https://tex.example/addons#extra",
		"https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2025/tlnet-final",
	} {
		for _, year := range []int{time.Now().Year() - 1, time.Now().Year(), time.Now().Year() + 1} {
			root := t.TempDir()
			bin := filepath.Join(root, "bin", "test-platform")
			manager := "tlmgr"
			if runtime.GOOS == "windows" {
				manager += ".bat"
			}
			writePackageTool(t, filepath.Join(bin, manager))
			writeTestFile(t, filepath.Join(root, "release-texlive.txt"), []byte(fmt.Sprintf("TeX Live version %d\n", year)))
			writeTestFile(t, filepath.Join(root, "tlpkg", "texlive.tlpdb"), []byte("name 00texlive.installation\ndepend opt_location:"+repository+"\n\nname amsmath\n"))
			status := texPackagesStatus(bin)
			if status.Year != year || status.Repository != repository || status.CommandPrefix == "" || strings.Contains(status.CommandPrefix, "--repository") {
				t.Fatalf("year %d, configured repository %q: %+v", year, repository, status)
			}
		}
	}
}

func TestTeXLiveYearFollowsTheMacTeXDirectoryLink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("directory symlinks may require a Windows privilege")
	}
	root := filepath.Join(t.TempDir(), "actual-installation")
	bin := filepath.Join(root, "bin", "universal-darwin")
	if err := os.MkdirAll(bin, 0755); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(root, "release-texlive.txt"), []byte("TeX Live version 2025\n"))
	writePackageTool(t, filepath.Join(bin, "tlmgr"))
	writeTestFile(t, filepath.Join(root, "tlpkg", "texlive.tlpdb"), []byte("name 00texlive.installation\ndepend opt_location:https://tex.example/private\n"))
	alias := filepath.Join(t.TempDir(), "texbin")
	if err := os.Symlink(bin, alias); err != nil {
		t.Fatal(err)
	}
	if got := texLiveYear(alias); got != 2025 {
		t.Fatalf("the MacTeX path returned year %d", got)
	}
	if status := texPackagesStatus(alias); status.Repository != "https://tex.example/private" || !strings.Contains(status.CommandPrefix, alias) {
		t.Fatalf("the MacTeX link did not use the selected settings: %+v", status)
	}
}

func TestTeXPackageManagerCanBeFoundBeforeLatexmkIsInstalled(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "minimal TeX")
	manager := "tlmgr"
	if runtime.GOOS == "windows" {
		manager = "tlmgr.bat"
		t.Setenv("PATHEXT", ".COM;.EXE;.BAT;.CMD")
	}
	writePackageTool(t, filepath.Join(bin, manager))
	t.Setenv("PATH", bin)
	status := texPackagesStatus("")
	if status.Manager != filepath.Join(bin, manager) || status.Bin != bin || status.Year != 0 || status.Repository != "" || status.CommandPrefix == "" {
		t.Fatalf("minimal installation: %#v", status)
	}
	for _, program := range status.Programs {
		if program.Available {
			t.Fatalf("a program absent from the selected installation was available: %#v", program)
		}
	}
}
