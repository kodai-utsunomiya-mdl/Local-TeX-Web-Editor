package app

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

type installedTeXPackage struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Category    string `json:"category"`
	Revision    int64  `json:"revision"`
	Size        int64  `json:"size"`
	Protected   bool   `json:"protected"`
}

type installedTeXPackages struct {
	Managed     bool                  `json:"managed"`
	Directory   string                `json:"directory"`
	Bin         string                `json:"bin"`
	Revision    string                `json:"revision"`
	Environment TeXEnvironment        `json:"environment"`
	Packages    []installedTeXPackage `json:"packages"`
}

type texPackageRemoval struct {
	Name     string `json:"name"`
	Revision int64  `json:"revision"`
	Size     int64  `json:"size"`
}

type texPackageRemovalPreview struct {
	Directory   string              `json:"directory"`
	Bin         string              `json:"bin"`
	Revision    string              `json:"revision"`
	Packages    []string            `json:"packages"`
	Removals    []texPackageRemoval `json:"removals"`
	Log         string              `json:"log"`
	Environment TeXEnvironment      `json:"environment"`
}

func protectedTeXPackage(name string) bool {
	for _, essential := range []string{"texlive.infra", "kpathsea", "texlive-scripts"} {
		if name == essential || strings.HasPrefix(name, essential+".") {
			return true
		}
	}
	return false
}

func parseInstalledTeXPackages(data []byte) ([]installedTeXPackage, error) {
	result := []installedTeXPackage{}
	var current installedTeXPackage
	finish := func() {
		if current.Name != "" && !strings.HasPrefix(current.Name, "00texlive.") {
			current.Protected = protectedTeXPackage(current.Name)
			result = append(result, current)
		}
		current = installedTeXPackage{}
	}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 64<<10), 1<<20)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			finish()
			continue
		}
		key, value, found := strings.Cut(line, " ")
		if !found {
			continue
		}
		switch key {
		case "name":
			if current.Name != "" {
				finish()
			}
			if !texSetupPackageName.MatchString(value) {
				return nil, errors.New("invalid package name in TeX Live database")
			}
			current.Name = value
		case "shortdesc":
			current.Description = value
		case "category":
			current.Category = value
		case "revision":
			current.Revision, _ = strconv.ParseInt(value, 10, 64)
		case "runfiles", "docfiles", "srcfiles", "binfiles":
			for _, field := range strings.Fields(value) {
				if strings.HasPrefix(field, "size=") {
					blocks, err := strconv.ParseInt(strings.TrimPrefix(field, "size="), 10, 64)
					if err != nil || blocks < 0 || blocks > 1<<30 {
						return nil, errors.New("invalid package size in TeX Live database")
					}
					current.Size += blocks * 4096
				}
			}
		}
	}
	finish()
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}

func readInstalledTeXPackages(environment TeXEnvironment) (installedTeXPackages, error) {
	result := installedTeXPackages{Managed: environment.Managed, Directory: environment.Directory, Bin: environment.Bin, Environment: environment}
	data, err := readCacheFile(filepath.Join(environment.Directory, "tlpkg", "texlive.tlpdb"), 64<<20)
	if err != nil {
		return result, err
	}
	result.Packages, err = parseInstalledTeXPackages(data)
	if err != nil {
		return result, err
	}
	hash := sha256.New()
	fmt.Fprintf(hash, "%s\x00%s\x00", environment.Directory, environment.Bin)
	_, _ = hash.Write(data)
	result.Revision = hex.EncodeToString(hash.Sum(nil))
	return result, nil
}

func managedTeXEnvironment(record managedTeXInstallation) TeXEnvironment {
	manager := "tlmgr"
	if runtime.GOOS == "windows" {
		manager += ".bat"
	}
	return TeXEnvironment{Directory: record.Directory, Bin: record.Bin, Manager: filepath.Join(record.Bin, manager), Format: "tinytex", Managed: true, Writable: true,
		CanInstallPackages: true, CanRemovePackages: true, CanUninstall: true, SystemDirectories: []string{filepath.Join(record.Directory, "texmf-var"), filepath.Join(record.Directory, "texmf-config")}}
}

// Discovery may execute the selected kpsewhich. It runs only for an explicit
// management request, and never while a.mu is held or State is being read.
func (a *App) currentTeXEnvironment(ctx context.Context) (TeXEnvironment, error) {
	a.mu.Lock()
	bin := a.config.TexBin
	managed, own := a.selectedManagedTeXLocked()
	for _, record := range a.config.TeXInstallations {
		if !own && (samePath(record.Bin, bin) || sameTeXSetupLocation(record.Bin, bin)) {
			a.texEnvironment = nil
			a.mu.Unlock()
			return TeXEnvironment{}, fail(http.StatusConflict, "アプリから導入した TeX の記録とフォルダーが一致しません．設定を確認してください．")
		}
	}
	a.mu.Unlock()
	var environment TeXEnvironment
	var err error
	if own {
		environment = managedTeXEnvironment(managed)
	} else {
		environment, err = inspectExternalTeX(ctx, bin)
	}
	if err != nil {
		a.mu.Lock()
		if samePath(bin, a.config.TexBin) {
			a.texEnvironment = nil
		}
		a.mu.Unlock()
		return environment, fail(http.StatusBadRequest, "TeX の環境を確認できません: %v", err)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if !samePath(bin, a.config.TexBin) {
		return environment, fail(http.StatusConflict, "TeX の設定が変更されました．選択した環境を確認してください．")
	}
	a.texEnvironment = &environment
	return environment, nil
}

func texManagementBusyError() error {
	return fail(http.StatusConflict, "TeX の処理またはコンパイルが終了してから操作してください．")
}

func (a *App) checkTeXManagementAvailable() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return fail(http.StatusServiceUnavailable, "アプリは終了しています．")
	}
	if a.isTeXSetupRunningLocked() || a.isRunningLocked() {
		return texManagementBusyError()
	}
	return nil
}

func (a *App) texPackagesHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	if !a.texSetupMu.TryLock() {
		writeError(w, texManagementBusyError())
		return
	}
	defer a.texSetupMu.Unlock()
	a.mu.Lock()
	busy := a.isTeXSetupRunningLocked()
	a.mu.Unlock()
	if busy {
		writeError(w, fail(http.StatusConflict, "TeX の導入が進行中です．完了を待つか停止してください．"))
		return
	}
	environment, err := a.currentTeXEnvironment(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	result, err := readInstalledTeXPackages(environment)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

type texManagementOutput struct {
	data []byte
	full bool
}

func (output *texManagementOutput) Write(data []byte) (int, error) {
	n := len(data)
	remaining := maxLogBytes - len(output.data)
	if len(data) > remaining {
		data = data[:remaining]
		output.full = true
	}
	output.data = append(output.data, data...)
	return n, nil
}

func (a *App) dryRunTeXPackageRemoval(ctx context.Context, environment TeXEnvironment, names []string, exact bool) ([]texPackageRemoval, string, error) {
	arguments := []string{"--machine-readable", "remove", "--dry-run"}
	if exact {
		arguments = append(arguments, "--no-depends-at-all")
	}
	arguments = append(arguments, names...)
	if a.texSetupHooks != nil && a.texSetupHooks.removalPreview != nil {
		return a.texSetupHooks.removalPreview(ctx, environment, names, exact)
	}
	command, cleanup, err := texSetupToolCommand(ctx, environment.Bin, a.options.ConfigDir, environment.Managed, "tlmgr", arguments...)
	if err != nil {
		return nil, "", err
	}
	defer cleanup()
	command.Dir = environment.Directory
	platform.PrepareCommand(command)
	command.Cancel = func() error { return platform.StopProcess(command.Process) }
	command.WaitDelay = 2 * time.Second
	var stdout, stderr texManagementOutput
	command.Stdout, command.Stderr = &stdout, &stderr
	err = command.Run()
	log := readableLog(stdout.data, true) + readableLog(stderr.data, true)
	if ctx.Err() != nil {
		return nil, log, ctx.Err()
	}
	if err != nil {
		return nil, log, messages.Errorf("TeX パッケージの削除予定を取得できません．依存関係とログを確認してください: %v\n%s", err, log)
	}
	if stdout.full || stderr.full {
		return nil, log, messages.Errorf("TeX パッケージの削除予定が大きすぎます．項目を減らして確認してください．")
	}
	removals, err := parseTeXPackageRemovals(stdout.data)
	return removals, log, err
}

func parseTeXPackageRemovals(data []byte) ([]texPackageRemoval, error) {
	result := []texPackageRemoval{}
	started, finished := false, false
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSuffix(line, "\r")
		if line == "end-of-header" {
			started = true
			continue
		}
		if line == "end-of-updates" {
			finished = true
			break
		}
		if !started || strings.TrimSpace(line) == "" {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) < 5 || fields[1] != "d" || !texSetupPackageName.MatchString(fields[0]) {
			return nil, messages.Errorf("TeX パッケージの削除予定を読み取れません．ログを確認してください．")
		}
		revision, err := strconv.ParseInt(fields[2], 10, 64)
		if err != nil {
			return nil, err
		}
		size, err := strconv.ParseInt(fields[4], 10, 64)
		if err != nil || size < 0 {
			return nil, messages.Errorf("TeX パッケージの削除予定を読み取れません．ログを確認してください．")
		}
		result = append(result, texPackageRemoval{Name: fields[0], Revision: revision, Size: size})
	}
	if !started || !finished {
		return nil, messages.Errorf("TeX パッケージの削除予定を読み取れません．ログを確認してください．")
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}

func (a *App) previewTeXPackageRemoval(ctx context.Context, environment TeXEnvironment, names []string) (texPackageRemovalPreview, error) {
	preview := texPackageRemovalPreview{Directory: environment.Directory, Bin: environment.Bin, Environment: environment}
	if !environment.CanRemovePackages {
		return preview, fail(http.StatusForbidden, "この TeX のパッケージは公式の管理画面から変更してください．")
	}
	var err error
	preview.Packages, err = cleanTeXSetupPackages(names)
	if err != nil {
		return preview, err
	}
	installed, err := readInstalledTeXPackages(environment)
	if err != nil {
		return preview, err
	}
	available := make(map[string]installedTeXPackage, len(installed.Packages))
	for _, value := range installed.Packages {
		available[value.Name] = value
	}
	for _, name := range preview.Packages {
		value, ok := available[name]
		if !ok {
			return preview, fail(http.StatusConflict, "選択した TeX パッケージが一覧にありません．一覧を読み直してください: %s", name)
		}
		if value.Protected {
			return preview, fail(http.StatusBadRequest, "TeX の管理に必要なパッケージはここから削除できません: %s", name)
		}
	}
	preview.Removals, preview.Log, err = a.dryRunTeXPackageRemoval(ctx, environment, preview.Packages, false)
	if err != nil {
		return preview, err
	}
	for _, removal := range preview.Removals {
		if protectedTeXPackage(removal.Name) {
			return preview, fail(http.StatusBadRequest, "TeX の管理に必要なパッケージが削除予定に含まれています: %s", removal.Name)
		}
		if value, exists := available[removal.Name]; !exists || value.Revision != removal.Revision {
			return preview, entryChangedError()
		}
	}
	if len(preview.Removals) == 0 {
		return preview, fail(http.StatusConflict, "削除できる TeX パッケージがありません．一覧と依存関係を確認してください．")
	}
	hash := sha256.New()
	fmt.Fprintf(hash, "%s\x00%s\x00", installed.Revision, strings.Join(preview.Packages, "\x00"))
	for _, removal := range preview.Removals {
		fmt.Fprintf(hash, "%s\x00%d\x00%d\x00", removal.Name, removal.Revision, removal.Size)
	}
	preview.Revision = hex.EncodeToString(hash.Sum(nil))
	return preview, nil
}

func (a *App) texPackageRemovalPreviewHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var input struct {
		Packages []string `json:"packages"`
	}
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	if !a.texSetupMu.TryLock() {
		writeError(w, texManagementBusyError())
		return
	}
	defer a.texSetupMu.Unlock()
	a.mu.Lock()
	busy := a.isTeXSetupRunningLocked() || a.isRunningLocked()
	a.mu.Unlock()
	if busy {
		writeError(w, fail(http.StatusConflict, "TeX の処理が終了してから削除予定を確認してください．"))
		return
	}
	environment, err := a.currentTeXEnvironment(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	release, err := platform.AcquireTeXSetupLock(environment.Directory)
	if err != nil {
		writeError(w, err)
		return
	}
	defer release()
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	preview, err := a.previewTeXPackageRemoval(ctx, environment, input.Packages)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, preview)
}

var _ io.Writer = (*texManagementOutput)(nil)

func (a *App) validateTeXSetupSelection(run *texSetupRun) error {
	a.mu.Lock()
	selected := samePath(a.config.TexBin, run.configuredBin)
	a.mu.Unlock()
	if !selected {
		return fail(http.StatusConflict, "TeX の設定が変更されました．選択した環境を確認してください．")
	}
	if run.reused != nil {
		if err := validateManagedTeX(*run.reused); err != nil {
			return err
		}
	} else if run.external != nil {
		if _, err := validateExternalTeXEnvironment(run.ctx, *run.external); err != nil {
			return err
		}
	}
	_, info, err := entryTreePath(run.root, "")
	if err != nil {
		return err
	}
	if run.rootInfo == nil {
		run.rootInfo = info
	} else if !os.SameFile(run.rootInfo, info) {
		return entryChangedError()
	}
	return run.ctx.Err()
}

func (a *App) finishTeXPackageChange(run *texSetupRun) error {
	if run.reused != nil {
		if err := writeManagedTeXFiles(run.ctx, *run.reused, run.unknownFiles); err != nil {
			return err
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if !samePath(a.config.TexBin, run.configuredBin) {
		return fail(http.StatusConflict, "TeX の設定が変更されました．選択した環境を確認してください．")
	}
	if a.build != nil {
		a.build.result.SourceChanged = true
	}
	if a.lastPDFID != "" {
		a.lastPDFChanged = true
	}
	a.noteCompiledPDFSettingsChangedLocked()
	return nil
}

func (a *App) performTeXPackageChange(run *texSetupRun) error {
	release, err := platform.AcquireTeXSetupLock(run.root)
	if err != nil {
		return err
	}
	defer release()
	if err := a.validateTeXSetupSelection(run); err != nil {
		return err
	}
	environment := *run.state.Environment
	before, err := readInstalledTeXPackages(environment)
	if err != nil {
		return err
	}
	if run.reused != nil {
		run.unknownFiles, err = unknownManagedTeXFiles(run.ctx, *run.reused)
		if err != nil {
			return err
		}
		run.inventoryStarted = true
	}
	if run.state.Operation == "remove-packages" {
		preview, err := a.previewTeXPackageRemoval(run.ctx, environment, run.state.Packages)
		if err != nil {
			return err
		}
		if run.removalPlan == nil || preview.Revision != run.removalRevision {
			return fail(http.StatusConflict, "TeX の削除予定が変更されました．内容をもう一度確認してください．")
		}
		names := make([]string, 0, len(preview.Removals))
		for _, value := range preview.Removals {
			names = append(names, value.Name)
		}
		exact, log, err := a.dryRunTeXPackageRemoval(run.ctx, environment, names, true)
		a.texSetupLog(run, "%s\n", log)
		if err != nil {
			return err
		}
		if fmt.Sprint(exact) != fmt.Sprint(preview.Removals) {
			return fail(http.StatusConflict, "TeX の削除予定が変更されました．内容をもう一度確認してください．")
		}
		if err := a.validateTeXSetupSelection(run); err != nil {
			return err
		}
		current, err := readInstalledTeXPackages(environment)
		if err != nil {
			return err
		}
		if current.Revision != before.Revision {
			return entryChangedError()
		}
		if a.texSetupHooks != nil && a.texSetupHooks.removePackages != nil {
			err = a.texSetupHooks.removePackages(run.ctx, run, names)
		} else {
			err = a.texSetupTool(run.ctx, run, run.root, "tlmgr", append([]string{"remove", "--no-depends-at-all"}, names...)...)
		}
		if err != nil {
			return err
		}
		after, err := readInstalledTeXPackages(environment)
		if err != nil {
			return err
		}
		for _, value := range after.Packages {
			for _, name := range names {
				if value.Name == name {
					return messages.Errorf("削除した TeX パッケージが一覧に残っています: %s", name)
				}
			}
		}
	} else {
		if run.removalRevision != "" && run.removalRevision != before.Revision {
			return fail(http.StatusConflict, "TeX の環境とパッケージの一覧を確認してから操作してください．")
		}
		if a.texSetupHooks != nil && a.texSetupHooks.packages != nil {
			err = a.texSetupHooks.packages(run.ctx, run)
		} else {
			err = a.addSelectedTeXPackages(run)
		}
		if err != nil {
			return err
		}
		if a.texSetupHooks == nil || a.texSetupHooks.packages == nil {
			after, err := readInstalledTeXPackages(environment)
			if err != nil {
				return err
			}
			present := make(map[string]bool, len(after.Packages))
			for _, value := range after.Packages {
				present[value.Name] = true
			}
			for _, name := range run.state.Packages {
				if !present[name] {
					return messages.Errorf("追加した TeX パッケージを一覧で確認できません: %s", name)
				}
			}
		}
	}
	return a.finishTeXPackageChange(run)
}
