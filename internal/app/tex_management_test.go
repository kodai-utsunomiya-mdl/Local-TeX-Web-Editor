package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func installedTeXForTest(t *testing.T) (*App, TeXSetupState) {
	t.Helper()
	a, parent, _ := fakeTeXSetup(t)
	startTeXSetupForTest(t, a, texSetupInput{Consent: true, Operation: "install", Parent: parent})
	return a, waitTeXSetupForTest(t, a, "succeeded")
}

func teXDeletionForTest(t *testing.T, a *App) texSetupDeletionInspection {
	t.Helper()
	response := apiRequest(a, http.MethodGet, "/api/tex/setup/delete", nil, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("delete inspection: %d %s", response.Code, response.Body.String())
	}
	var inspection texSetupDeletionInspection
	if err := json.Unmarshal(response.Body.Bytes(), &inspection); err != nil {
		t.Fatal(err)
	}
	return inspection
}

func teXPackagesForTest(t *testing.T, a *App) installedTeXPackages {
	t.Helper()
	response := apiRequest(a, http.MethodGet, "/api/tex/packages", nil, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("package list: %d %s", response.Code, response.Body.String())
	}
	var list installedTeXPackages
	if err := json.Unmarshal(response.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	return list
}

func TestTeXManagementReadsLocalPackageDataAndRemovalPlan(t *testing.T) {
	packages, err := parseInstalledTeXPackages([]byte("name 00texlive.installation\n\nname siunitx\ncategory Package\nrevision 42\nshortdesc Units and numbers\nrunfiles size=3\n texmf-dist/tex/siunitx.sty\ndocfiles size=2\n\nname texlive.infra.windows\nrevision 3\nbinfiles arch=windows size=4\n bin/windows/tlmgr.bat\n\nname collection-langjapanese\nrevision 4\n"))
	if err != nil || len(packages) != 3 {
		t.Fatalf("packages: %+v %v", packages, err)
	}
	if packages[0].Protected || packages[1].Size != 5*4096 || packages[1].Description != "Units and numbers" || !packages[2].Protected {
		t.Fatalf("package data: %+v", packages)
	}
	removals, err := parseTeXPackageRemovals([]byte("total-bytes\t8192\nend-of-header\nsiunitx\td\t42\t-\t8192\t-\t-\nend-of-updates\n"))
	if err != nil || len(removals) != 1 || removals[0].Name != "siunitx" || removals[0].Revision != 42 || removals[0].Size != 8192 {
		t.Fatalf("removal data: %+v %v", removals, err)
	}
	for _, data := range []string{"siunitx\td\t42\t-\t8192", "end-of-header\nsiunitx\tu\t42\t-\t8192\nend-of-updates"} {
		if _, err := parseTeXPackageRemovals([]byte(data)); err == nil {
			t.Fatal("accepted an incomplete or non-removal result")
		}
	}
}

func TestTeXManagementRemovesOnlyTheConfirmedPackages(t *testing.T) {
	a, installed := installedTeXForTest(t)
	database := filepath.Join(installed.Directory, "tlpkg", "texlive.tlpdb")
	var calls atomic.Int32
	a.texSetupHooks.removalPreview = func(_ context.Context, environment TeXEnvironment, names []string, exact bool) ([]texPackageRemoval, string, error) {
		if environment.Directory != installed.Directory || fmt.Sprint(names) != "[siunitx]" {
			return nil, "", errors.New("unexpected removal target")
		}
		list, err := readInstalledTeXPackages(environment)
		if err != nil {
			return nil, "", err
		}
		for _, entry := range list.Packages {
			if entry.Name == "siunitx" {
				return []texPackageRemoval{{Name: entry.Name, Revision: entry.Revision, Size: entry.Size}}, "dry-run\n", nil
			}
		}
		return nil, "", errors.New("package missing")
	}
	a.texSetupHooks.removePackages = func(_ context.Context, run *texSetupRun, names []string) error {
		calls.Add(1)
		if run.root != installed.Directory || fmt.Sprint(names) != "[siunitx]" {
			return errors.New("an unconfirmed package reached the command")
		}
		data, err := os.ReadFile(database)
		if err != nil {
			return err
		}
		text, _, _ := strings.Cut(string(data), "name siunitx\n")
		return os.WriteFile(database, []byte(text), 0600)
	}
	previewResponse := apiRequest(a, http.MethodPost, "/api/tex/packages/remove-preview", map[string]any{"packages": []string{"siunitx"}}, nil)
	if previewResponse.Code != http.StatusOK {
		t.Fatalf("preview: %d %s", previewResponse.Code, previewResponse.Body.String())
	}
	var preview texPackageRemovalPreview
	if err := json.Unmarshal(previewResponse.Body.Bytes(), &preview); err != nil {
		t.Fatal(err)
	}
	input := texSetupInput{Consent: true, Operation: "remove-packages", Packages: []string{"siunitx"}, Directory: installed.Directory, Revision: preview.Revision}
	data, err := os.ReadFile(database)
	if err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, database, []byte(strings.Replace(string(data), "revision 3", "revision 4", 1)))
	response := apiRequest(a, http.MethodPost, "/api/tex/setup", input, nil)
	if response.Code != http.StatusConflict || calls.Load() != 0 {
		t.Fatal("a changed package database allowed removal")
	}
	var conflict struct {
		Preview texPackageRemovalPreview `json:"preview"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &conflict); err != nil || conflict.Preview.Revision == "" || conflict.Preview.Revision == preview.Revision {
		t.Fatalf("fresh removal plan: %s %v", response.Body.String(), err)
	}
	input.Revision = conflict.Preview.Revision
	startTeXSetupForTest(t, a, input)
	state := waitTeXSetupForTest(t, a, "succeeded")
	if calls.Load() != 1 || state.Operation != "remove-packages" || !state.Managed {
		t.Fatalf("removal result: %+v", state)
	}
	list := teXPackagesForTest(t, a)
	if len(list.Packages) != 2 || list.Packages[0].Name != "latexmk" || list.Packages[1].Name != "texlive.infra" {
		t.Fatalf("remaining packages: %+v", list.Packages)
	}
	response = apiRequest(a, http.MethodPost, "/api/tex/packages/remove-preview", map[string]any{"packages": []string{"texlive.infra"}}, nil)
	if response.Code != http.StatusBadRequest {
		t.Fatal("the package manager was removable")
	}
}

func TestTeXManagementUninstallChecksContentAndUnknownFiles(t *testing.T) {
	a, installed := installedTeXForTest(t)
	outside := filepath.Join(filepath.Dir(installed.Directory), "keep-this-document.tex")
	writeTestFile(t, outside, []byte("outside"))
	unknown := filepath.Join(installed.Directory, "my-manuscript.tex")
	writeTestFile(t, unknown, []byte("a personal manuscript"))
	inspection := teXDeletionForTest(t, a)
	if inspection.CanDelete || fmt.Sprint(inspection.UnknownFiles) != "[my-manuscript.tex]" {
		t.Fatalf("unknown files: %+v", inspection)
	}
	input := texSetupDeletionInput{Directory: installed.Directory, Revision: inspection.Revision, Confirmation: "TinyTeX"}
	response := apiRequest(a, http.MethodDelete, "/api/tex/setup/delete", input, nil)
	if response.Code != http.StatusConflict {
		t.Fatalf("unknown files: %d %s", response.Code, response.Body.String())
	}
	if err := os.Remove(unknown); err != nil {
		t.Fatal(err)
	}
	inspection = teXDeletionForTest(t, a)
	input.Revision = inspection.Revision
	input.Confirmation = ""
	if response := apiRequest(a, http.MethodDelete, "/api/tex/setup/delete", input, nil); response.Code != http.StatusBadRequest {
		t.Fatal("deletion did not require the exact folder name")
	}
	input.Confirmation = "TinyTeX"
	path := filepath.Join(installed.Directory, "release-texlive.txt")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, path, []byte("TeX Live version 2025\n"))
	if err := os.Chtimes(path, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	response = apiRequest(a, http.MethodDelete, "/api/tex/setup/delete", input, nil)
	if response.Code != http.StatusConflict {
		t.Fatal("changed contents with the same size and time allowed deletion")
	}
	inspection = teXDeletionForTest(t, a)
	input.Revision = inspection.Revision
	response = apiRequest(a, http.MethodDelete, "/api/tex/setup/delete", input, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("start uninstall: %d %s", response.Code, response.Body.String())
	}
	state := waitTeXSetupForTest(t, a, "succeeded")
	if state.Managed || state.Operation != "uninstall" || state.Cancelable || a.config.TexBin != "" || len(a.config.TeXInstallations) != 0 {
		t.Fatalf("uninstall state: %+v", state)
	}
	assertCompiledPDFFileMissing(t, installed.Directory)
	if data, err := os.ReadFile(outside); err != nil || string(data) != "outside" {
		t.Fatal("uninstall changed the parent directory")
	}
	if _, err := os.Stat(a.project.Root); err != nil {
		t.Fatal("uninstall changed the project")
	}
	restarted := reopenCompiledPDFProjectForTest(t, a)
	if restarted.config.TexBin != "" || len(restarted.config.TeXInstallations) != 0 {
		t.Fatal("a deleted installation returned after restart")
	}
	startTeXSetupForTest(t, a, texSetupInput{Consent: true, Operation: "install", Parent: installed.Parent})
	again := waitTeXSetupForTest(t, a, "succeeded")
	if again.Directory == installed.Directory {
		t.Fatal("the next install reused a removed directory")
	}
}

func TestTeXManagementKeepsUnknownFilesUnknownAfterAddingPackages(t *testing.T) {
	a, installed := installedTeXForTest(t)
	writeTestFile(t, filepath.Join(installed.Directory, "notes", "document.tex"), []byte("notes"))
	startTeXSetupForTest(t, a, texSetupInput{Consent: true, Operation: "packages", Packages: []string{"siunitx"}})
	waitTeXSetupForTest(t, a, "succeeded")
	inspection := teXDeletionForTest(t, a)
	if inspection.CanDelete || !strings.Contains(strings.Join(inspection.UnknownFiles, "\n"), "notes/document.tex") {
		t.Fatal("adding a package registered a personal manuscript as part of TeX")
	}
}

func TestTeXManagementDeletesLinksWithoutFollowingThem(t *testing.T) {
	a, installed := installedTeXForTest(t)
	outside := filepath.Join(t.TempDir(), "keep.tex")
	writeTestFile(t, outside, []byte("outside document"))
	if err := os.Symlink(outside, filepath.Join(installed.Directory, "external-link")); err != nil {
		t.Skipf("symbolic links unavailable: %v", err)
	}
	if err := os.Symlink("release-texlive.txt", filepath.Join(installed.Directory, "internal-link")); err != nil {
		t.Fatal(err)
	}
	// These links belong to this installation fixture, like links in an archive.
	if err := os.Remove(filepath.Join(installed.Directory, managedTeXInventory)); err != nil {
		t.Fatal(err)
	}
	if err := writeManagedTeXFiles(context.Background(), a.config.TeXInstallations[0], nil); err != nil {
		t.Fatal(err)
	}
	inspection := teXDeletionForTest(t, a)
	response := apiRequest(a, http.MethodDelete, "/api/tex/setup/delete", texSetupDeletionInput{Directory: installed.Directory, Revision: inspection.Revision, Confirmation: "TinyTeX"}, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("start uninstall: %d %s", response.Code, response.Body.String())
	}
	waitTeXSetupForTest(t, a, "succeeded")
	if data, err := os.ReadFile(outside); err != nil || string(data) != "outside document" {
		t.Fatal("uninstall followed a link")
	}
}

func TestTeXManagementDoesNotRegisterAFileWrittenDuringPackageChanges(t *testing.T) {
	a, installed := installedTeXForTest(t)
	a.texSetupHooks.packages = func(context.Context, *texSetupRun) error {
		return os.WriteFile(filepath.Join(installed.Directory, "manuscript-during-install.tex"), []byte("personal manuscript"), 0600)
	}
	startTeXSetupForTest(t, a, texSetupInput{Consent: true, Operation: "packages", Packages: []string{"siunitx"}})
	waitTeXSetupForTest(t, a, "succeeded")
	inspection := teXDeletionForTest(t, a)
	if inspection.CanDelete || fmt.Sprint(inspection.UnknownFiles) != "[manuscript-during-install.tex]" {
		t.Fatalf("a new manuscript became a recorded package file: %+v", inspection)
	}
}

func TestTeXManagementRecognizesGeneratedFontCaches(t *testing.T) {
	a, installed := installedTeXForTest(t)
	cache := filepath.Join(installed.Directory, "texmf-var", "luatex-cache", "generic", "fonts", "otl", "haranoaji.luc")
	writeTestFile(t, cache, []byte("generated font cache"))
	// The archive normally creates these parents before its initial inventory.
	record := a.config.TeXInstallations[0]
	if err := writeManagedTeXFiles(context.Background(), record, nil); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(filepath.Dir(cache), "another-font.lua"), []byte("generated later"))
	inspection := teXDeletionForTest(t, a)
	if !inspection.CanDelete {
		t.Fatalf("a generated font cache blocked deletion: %v", inspection.UnknownFiles)
	}
	writeTestFile(t, filepath.Join(filepath.Dir(cache), "personal.tex"), []byte("personal manuscript"))
	inspection = teXDeletionForTest(t, a)
	if inspection.CanDelete || !strings.HasSuffix(inspection.UnknownFiles[0], "personal.tex") {
		t.Fatalf("a manuscript in a cache directory was accepted: %v", inspection.UnknownFiles)
	}
}

func TestTeXManagementExternalInspectionFindsDocumentsInGeneratedDirectories(t *testing.T) {
	root, bin, manager := externalTeXTestTree(t)
	root, _ = filepath.EvalSymlinks(root)
	for _, relative := range []string{"texmf-var/my-paper.tex", "texmf-config/references.bib", "tlpkg/notes.md", "texmf-var/figure.png"} {
		writeTestFile(t, filepath.Join(root, filepath.FromSlash(relative)), []byte("personal document"))
	}
	writeTestFile(t, filepath.Join(root, "texmf-var", "web2c", "latex.fmt"), []byte("generated format"))
	environment := TeXEnvironment{Directory: root, Bin: bin, Manager: manager}
	known, err := externalTeXKnownFiles(context.Background(), environment)
	if err != nil {
		t.Fatal(err)
	}
	inspection, err := inspectTeXSetupTree(context.Background(), environment, known)
	if err != nil {
		t.Fatal(err)
	}
	unknown := strings.Join(inspection.UnknownFiles, "\n")
	for _, relative := range []string{"texmf-var/my-paper.tex", "texmf-config/references.bib", "tlpkg/notes.md", "texmf-var/figure.png"} {
		if !strings.Contains(unknown, relative) {
			t.Fatalf("unregistered document was accepted: %s; %s", relative, unknown)
		}
	}
	if strings.Contains(unknown, "latex.fmt") {
		t.Fatal("a generated TeX format was treated as a manuscript")
	}
}

func TestTeXManagementExternalSystemDirectoryFindsUnregisteredDocuments(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "web2c", "latex.fmt"), []byte("format"))
	writeTestFile(t, filepath.Join(root, "paper.tex"), []byte("manuscript"))
	writeTestFile(t, filepath.Join(root, "figures", "plot.pdf"), []byte("figure"))
	known, err := externalTeXSystemFiles(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	inspection, err := inspectTeXSetupTree(context.Background(), TeXEnvironment{Directory: root}, known)
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(inspection.UnknownFiles) != "[figures/plot.pdf paper.tex]" || inspection.CanDelete {
		t.Fatalf("external system files: %+v", inspection)
	}
}

func TestTeXManagementExternalPackagesUseTheSelectedTree(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fixture uses POSIX scripts; real Windows tools are exercised in CI")
	}
	a, owned := installedTeXForTest(t)
	root, bin, _ := externalTeXTestTree(t)
	root, _ = filepath.EvalSymlinks(root)
	bin, _ = filepath.EvalSymlinks(bin)
	script := "#!/bin/sh\ncase \"$1\" in\n-var-value=TEXMFROOT) printf '%s\\n' " + posixLiteral(root) + ";;\n-var-value=TEXMFSYSVAR) printf '%s\\n' " + posixLiteral(filepath.Join(root, "texmf-var")) + ";;\n-var-value=TEXMFSYSCONFIG) printf '%s\\n' " + posixLiteral(filepath.Join(root, "texmf-config")) + ";;\n*) exit 2;;\nesac\n"
	writeTestFile(t, filepath.Join(bin, "kpsewhich"), []byte(script))
	if err := os.Chmod(filepath.Join(bin, "kpsewhich"), 0700); err != nil {
		t.Fatal(err)
	}
	if response := apiRequest(a, http.MethodPut, "/api/settings", map[string]any{"texBin": bin}, nil); response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	list := teXPackagesForTest(t, a)
	if list.Managed || list.Directory != root || !list.Environment.CanInstallPackages {
		t.Fatalf("external list: %+v", list)
	}
	var calls atomic.Int32
	a.texSetupHooks.packages = func(_ context.Context, run *texSetupRun) error {
		calls.Add(1)
		if run.external == nil || run.root != root || run.bin != bin || run.reused != nil {
			return errors.New("package command selected another tree")
		}
		return nil
	}
	a.texSetupHooks.check = func(context.Context, *texSetupRun) error {
		return errors.New("external packages should not require all four engines")
	}
	input := texSetupInput{Consent: true, Operation: "packages", Packages: []string{"siunitx"}, Directory: root, Revision: list.Revision}
	bad := input
	bad.Directory = owned.Directory
	if response := apiRequest(a, http.MethodPost, "/api/tex/setup", bad, nil); response.Code != http.StatusConflict {
		t.Fatal("a different root was accepted")
	}
	startTeXSetupForTest(t, a, input)
	state := waitTeXSetupForTest(t, a, "succeeded")
	if state.Managed || calls.Load() != 1 || a.config.TexBin != bin || len(a.config.TeXInstallations) != 1 {
		t.Fatalf("external package result: %+v", state)
	}
	if _, err := os.Stat(filepath.Join(root, managedTeXMarker)); !os.IsNotExist(err) {
		t.Fatal("an external environment received an ownership record")
	}
	if _, err := os.Stat(owned.Directory); err != nil {
		t.Fatal("the app installation was changed")
	}
}

func TestTeXManagementShutdownWaitsForAnOperationThatCannotBeCancelled(t *testing.T) {
	a, _ := installedTeXForTest(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	run := &texSetupRun{ctx: ctx, cancel: cancel, done: make(chan struct{}), state: TeXSetupState{ID: "native-operation", Status: "running", Operation: "uninstall", Stage: "deleting", Cancelable: false}}
	a.mu.Lock()
	a.texSetup = run
	a.mu.Unlock()
	response := apiRequest(a, http.MethodPost, "/api/shutdown", map[string]any{}, nil)
	if response.Code != http.StatusConflict || ctx.Err() != nil {
		t.Fatal("shutdown interrupted an operation that cannot be cancelled")
	}
	closed := make(chan error, 1)
	go func() { closed <- a.Close() }()
	select {
	case err := <-closed:
		t.Fatalf("Close returned while the native operation was running: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	if ctx.Err() != nil {
		t.Fatal("Close cancelled the native operation")
	}
	a.mu.Lock()
	run.state.Status = "succeeded"
	a.mu.Unlock()
	close(run.done)
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Close did not finish after the operation ended")
	}
}

// Set this only when intentionally checking an existing test installation.
// The calls below read its local database and use tlmgr's dry-run command.
func TestTeXManagementInstalledEnvironment(t *testing.T) {
	bin := os.Getenv("LOCAL_TEX_MANAGEMENT_BIN")
	if bin == "" {
		t.Skip("no test installation was selected")
	}
	a, _ := testApp(t)
	a.config.TexBin = bin
	environment, err := a.currentTeXEnvironment(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	list, err := readInstalledTeXPackages(environment)
	if err != nil || len(list.Packages) < 100 {
		t.Fatalf("installed packages: %d %v", len(list.Packages), err)
	}
	preview, err := a.previewTeXPackageRemoval(context.Background(), environment, []string{"needspace"})
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, value := range preview.Removals {
		names = append(names, value.Name)
	}
	exact, _, err := a.dryRunTeXPackageRemoval(context.Background(), environment, names, true)
	if err != nil || fmt.Sprint(exact) != fmt.Sprint(preview.Removals) {
		t.Fatalf("exact plan: %+v %v", exact, err)
	}
	first, err := a.inspectSelectedTeXDeletion(context.Background(), environment)
	if err != nil {
		t.Fatal(err)
	}
	second, err := a.inspectSelectedTeXDeletion(context.Background(), environment)
	if err != nil || first.Revision != second.Revision {
		t.Fatalf("unchanged environment has different deletion revisions: %v", err)
	}
	if len(first.UnknownFiles) != 0 {
		t.Fatalf("unrecognized distribution files: %v", first.UnknownFiles)
	}
	t.Logf("read %d packages and %d files (%d bytes); removal preview and repeated deletion review agree", len(list.Packages), first.FileCount, first.Size)
}
