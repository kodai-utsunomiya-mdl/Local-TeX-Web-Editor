package app

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

func externalTeXTestTree(t *testing.T) (root, bin, manager string) {
	t.Helper()
	root = filepath.Join(t.TempDir(), "TeX environment")
	bin = filepath.Join(root, "bin", "test-platform")
	manager = filepath.Join(bin, "tlmgr")
	for _, directory := range []string{bin, filepath.Join(root, "tlpkg"), filepath.Join(root, "texmf-dist", "web2c"), filepath.Join(root, "texmf-var"), filepath.Join(root, "texmf-config")} {
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for path, content := range map[string]string{
		filepath.Join(root, "release-texlive.txt"):              "TeX Live version 2026\n",
		filepath.Join(root, "tlpkg", "texlive.tlpdb"):           "name 00texlive.installation\ndepend opt_w32_multi_user:1\n",
		filepath.Join(root, "texmf-dist", "web2c", "texmf.cnf"): "TEXMFROOT = $SELFAUTOPARENT\n",
		filepath.Join(root, ".tinytex"):                         "",
		manager:                                                 "#!/bin/sh\nexit 0\n",
	} {
		if err := os.WriteFile(path, []byte(content), 0700); err != nil {
			t.Fatal(err)
		}
	}
	return root, bin, manager
}

func TestExternalTeXRequiresOneInstallationTree(t *testing.T) {
	root, bin, manager := externalTeXTestTree(t)
	kpsewhich := filepath.Join(bin, "kpsewhich")
	if err := validateExternalTeXPaths(root, kpsewhich, manager); err != nil {
		t.Fatal(err)
	}
	for _, paths := range [][3]string{
		{root, filepath.Join(filepath.Dir(root), "other", "kpsewhich"), manager},
		{root, kpsewhich, filepath.Join(root+"-other", "tlmgr")},
		{filepath.VolumeName(root) + string(filepath.Separator), kpsewhich, manager},
	} {
		if err := validateExternalTeXPaths(paths[0], paths[1], paths[2]); err == nil {
			t.Fatalf("accepted an unrelated installation: %q", paths)
		}
	}
	if err := os.Remove(filepath.Join(root, "tlpkg", "texlive.tlpdb")); err != nil {
		t.Fatal(err)
	}
	if err := validateExternalTeXPaths(root, kpsewhich, manager); err == nil {
		t.Fatal("accepted a tree without its TeX Live package database")
	}
}

func TestExternalTeXAcceptsShortAndLongNamesOfTheSameInstallation(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows provides short path names")
	}
	root, bin, manager := externalTeXTestTree(t)
	kpsewhich := filepath.Join(bin, "kpsewhich.exe")
	writeTestFile(t, kpsewhich, []byte("test executable"))
	longRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	shortRoot, err := platform.ShortPath(root)
	if err != nil {
		t.Skipf("short paths unavailable: %v", err)
	}
	if samePath(longRoot, shortRoot) {
		t.Skip("this volume does not provide a different short path")
	}
	relativeBin, err := filepath.Rel(root, bin)
	if err != nil {
		t.Fatal(err)
	}
	for _, pair := range [][2]string{{shortRoot, longRoot}, {longRoot, shortRoot}} {
		actualBin := filepath.Join(pair[1], relativeBin)
		if err := validateExternalTeXPaths(pair[0], filepath.Join(actualBin, filepath.Base(kpsewhich)), filepath.Join(actualBin, filepath.Base(manager))); err != nil {
			t.Fatalf("equivalent installation names were rejected: %v", err)
		}
		if !pathInExternalTeX(pair[0], filepath.Join(pair[1], "texmf-var", "not-created", "cache")) {
			t.Fatal("the existing parent of a new cache directory did not resolve")
		}
	}
	if pathInExternalTeX(shortRoot, filepath.Join(filepath.Dir(longRoot), "other-tex", "bin", "kpsewhich.exe")) {
		t.Fatal("an unrelated installation was accepted")
	}
}

func TestExternalTeXResolvesExistingParentsOfCacheDirectories(t *testing.T) {
	root, _, _ := externalTeXTestTree(t)
	alias := filepath.Join(t.TempDir(), "selected TeX")
	if err := os.Symlink(root, alias); err != nil {
		t.Skipf("symbolic links unavailable: %v", err)
	}
	if !pathInExternalTeX(root, filepath.Join(alias, "new-cache", "web2c")) || !pathInExternalTeX(alias, filepath.Join(root, "new-cache", "web2c")) {
		t.Fatal("a not-yet-created cache lost its existing installation parent")
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "external-cache")); err != nil {
		t.Fatal(err)
	}
	if pathInExternalTeX(root, filepath.Join(root, "external-cache", "new-cache")) {
		t.Fatal("a cache linked outside the installation was accepted")
	}
}

func TestExternalTeXUsesSelectedToolsAndActualRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the test fixture uses a POSIX executable; the installed Windows tools are exercised in CI")
	}
	root, bin, _ := externalTeXTestTree(t)
	root, _ = filepath.EvalSymlinks(root)
	bin, _ = filepath.EvalSymlinks(bin)
	script := "#!/bin/sh\ncase \"$1\" in\n" +
		"-var-value=TEXMFROOT) printf '%s\\n' " + posixLiteral(root) + ";;\n" +
		"-var-value=TEXMFSYSVAR) printf '%s\\n' " + posixLiteral(filepath.Join(root, "texmf-var")) + ";;\n" +
		"-var-value=TEXMFSYSCONFIG) printf '%s\\n' " + posixLiteral(filepath.Join(root, "texmf-config")) + ";;\n" +
		"*) exit 2;;\nesac\n"
	if err := os.WriteFile(filepath.Join(bin, "kpsewhich"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "selected bin")
	if err := os.Symlink(bin, link); err != nil {
		t.Fatal(err)
	}
	environment, err := inspectExternalTeX(context.Background(), link)
	if err != nil {
		t.Fatal(err)
	}
	if !samePath(environment.Directory, root) || !samePath(environment.Bin, bin) || environment.Managed || environment.Format != "tinytex" || !environment.Writable || !environment.CanInstallPackages || !environment.CanRemovePackages || environment.RequiresElevation || !environment.Shared {
		t.Fatalf("incorrect external environment: %+v", environment)
	}
	if len(environment.SystemDirectories) != 2 {
		t.Fatalf("missing system directories: %+v", environment)
	}
	if _, err := validateExternalTeXEnvironment(context.Background(), environment); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, ".tinytex")); err != nil {
		t.Fatal(err)
	}
	if _, err := validateExternalTeXEnvironment(context.Background(), environment); err == nil {
		t.Fatal("accepted changed installation metadata")
	}
}

func TestExternalTeXDoesNotFollowConfigurationOutsideRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating symbolic links requires an optional Windows privilege")
	}
	root, bin, manager := externalTeXTestTree(t)
	configuration := filepath.Join(root, "texmf-dist", "web2c", "texmf.cnf")
	outside := filepath.Join(t.TempDir(), "texmf.cnf")
	if err := os.WriteFile(outside, []byte("external configuration"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(configuration); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, configuration); err != nil {
		t.Fatal(err)
	}
	if err := validateExternalTeXPaths(root, filepath.Join(bin, "kpsewhich"), manager); err == nil {
		t.Fatal("accepted configuration linked outside the installation")
	}
}

func TestExternalTeXDeletionRejectsUserDataAndProjects(t *testing.T) {
	root, bin, manager := externalTeXTestTree(t)
	root, _ = filepath.EvalSymlinks(root)
	environment := TeXEnvironment{Directory: root, Bin: bin, Manager: manager, Format: "tinytex"}
	if err := validateExternalTeXDeletionPaths(environment); err != nil {
		t.Fatal(err)
	}
	for _, protected := range []string{filepath.Join(root, "personal-project"), filepath.Join(root, "app-settings")} {
		if err := validateExternalTeXDeletionPaths(environment, protected); err == nil {
			t.Fatalf("accepted an environment containing %s", protected)
		}
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		environment.Directory = home
		if err := validateExternalTeXDeletionPaths(environment); err == nil {
			t.Fatal("accepted the user's home folder as an uninstall target")
		}
	}
	if runtime.GOOS == "windows" {
		environment.Directory = root
		environment.Uninstaller = filepath.Join(root, "tlpkg", "installer", "uninst.bat")
		environment.SystemDirectories = []string{filepath.Dir(root)}
		if err := validateExternalTeXDeletionPaths(environment); err == nil {
			t.Fatal("accepted the installation's parent as a system cache to remove")
		}
	}
}
