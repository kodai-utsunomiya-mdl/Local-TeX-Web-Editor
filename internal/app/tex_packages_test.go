package app

import (
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
	status := texPackagesStatus(bin)
	if status.Manager != filepath.Join(bin, managerName) || status.Year != 2025 || status.Bin != bin {
		t.Fatalf("package manager information: %#v", status)
	}
	if status.Repository != texLiveRepository(2025, time.Now().Year()) || !strings.Contains(status.CommandPrefix, "tlmgr") {
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
	repository, command := texPackageCommand(windows, 2025, 2026, "windows")
	if repository != "https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2025/tlnet-final" || !strings.HasPrefix(command, "& 'C:\\TeX files\\author''s $(program)\\tlmgr.bat'") {
		t.Fatalf("PowerShell quoting: %q, %q", repository, command)
	}
	mac := "/Users/author's $(program)/TeX tools/tlmgr"
	repository, command = texPackageCommand(mac, 2026, 2026, "darwin")
	if repository != "https://mirror.ctan.org/systems/texlive/tlnet" || !strings.HasPrefix(command, "'/Users/author'\"'\"'s $(program)/TeX tools/tlmgr'") || strings.Contains(command, "sudo") {
		t.Fatalf("POSIX quoting: %q, %q", repository, command)
	}
	for _, year := range []int{0, 2027} {
		repository, command = texPackageCommand(mac, year, 2026, "darwin")
		if repository != "" || command != posixLiteral(mac) {
			t.Fatalf("year %d changed the configured repository: %q, %q", year, repository, command)
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
	alias := filepath.Join(t.TempDir(), "texbin")
	if err := os.Symlink(bin, alias); err != nil {
		t.Fatal(err)
	}
	if got := texLiveYear(alias); got != 2025 {
		t.Fatalf("the MacTeX path returned year %d", got)
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
