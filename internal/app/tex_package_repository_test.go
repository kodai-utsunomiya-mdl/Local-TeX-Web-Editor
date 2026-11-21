package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestArchivedTeXRepositoryRequiresTheManagerReleaseError(t *testing.T) {
	message := "tlmgr: Local TeX Live (2025) is older than remote repository (2026).\n"
	archive := "https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2025/tlnet-final"
	for _, test := range []struct{ repository, output, want string }{
		{"ctan", message, archive},
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
