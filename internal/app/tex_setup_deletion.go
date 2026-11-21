package app

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

type texSetupDeletionInput struct {
	Directory    string `json:"directory"`
	Revision     string `json:"revision"`
	Confirmation string `json:"confirmation"`
}

func (a *App) inspectSelectedTeXDeletion(ctx context.Context, environment TeXEnvironment) (texSetupDeletionInspection, error) {
	a.mu.Lock()
	protected := append([]string{a.options.ConfigDir}, a.config.RecentProjects...)
	if a.project != nil {
		protected = append(protected, a.project.Root)
	}
	a.mu.Unlock()
	if err := validateExternalTeXDeletionPaths(environment, protected...); err != nil {
		return texSetupDeletionInspection{}, err
	}
	if !environment.Managed {
		return inspectExternalTeXDeletion(ctx, environment)
	}
	a.mu.Lock()
	record, ok := a.selectedManagedTeXLocked()
	a.mu.Unlock()
	if !ok || !samePath(record.Directory, environment.Directory) {
		return texSetupDeletionInspection{}, entryChangedError()
	}
	return inspectTeXSetupDeletion(ctx, record)
}

func writeTeXDeletionConflict(w http.ResponseWriter, r *http.Request, inspection texSetupDeletionInspection) {
	writeJSON(w, http.StatusConflict, map[string]any{
		"error":      messages.Text(messages.LanguageFromContext(r.Context()), "TeX の削除予定が変更されました．内容をもう一度確認してください．"),
		"inspection": inspection,
	})
}

func (a *App) texSetupDeleteHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet, http.MethodDelete) {
		return
	}
	var input texSetupDeletionInput
	if r.Method == http.MethodDelete {
		if err := readJSON(w, r, &input); err != nil {
			writeError(w, err)
			return
		}
	}
	if !a.texSetupMu.TryLock() {
		writeError(w, texManagementBusyError())
		return
	}
	defer a.texSetupMu.Unlock()
	if err := a.checkTeXManagementAvailable(); err != nil {
		writeError(w, err)
		return
	}
	environment, err := a.currentTeXEnvironment(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	if r.Method == http.MethodDelete && input.Confirmation != filepath.Base(environment.Directory) {
		writeError(w, fail(http.StatusBadRequest, "削除する TeX のフォルダー名を正確に入力してください．"))
		return
	}
	release, err := platform.AcquireTeXSetupLock(environment.Directory)
	if err != nil {
		writeError(w, err)
		return
	}
	defer release()
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	inspection, err := a.inspectSelectedTeXDeletion(ctx, environment)
	if err != nil {
		writeError(w, err)
		return
	}
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, inspection)
		return
	}
	if !samePath(input.Directory, inspection.Directory) || input.Revision == "" || input.Revision != inspection.Revision || !inspection.CanDelete {
		writeTeXDeletionConflict(w, r, inspection)
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.isRunningLocked() || a.isTeXSetupRunningLocked() {
		writeError(w, texManagementBusyError())
		return
	}
	if a.closed {
		writeError(w, fail(http.StatusServiceUnavailable, "アプリは終了しています．"))
		return
	}
	if !sameTeXSetupLocation(texPackageBin(a.config.TexBin), environment.Bin) {
		writeError(w, entryChangedError())
		return
	}
	id, err := randomID()
	if err != nil {
		writeError(w, err)
		return
	}
	jobContext, jobCancel := context.WithTimeout(context.Background(), texSetupTimeout)
	run := &texSetupRun{ctx: jobContext, cancel: jobCancel, done: make(chan struct{}), configuredBin: a.config.TexBin,
		root: environment.Directory, bin: environment.Bin, rootInfo: inspection.rootInfo, deletion: &inspection,
		state: TeXSetupState{Supported: true, Status: "running", Operation: "uninstall", ID: id, Stage: "checking", Release: texSetupRelease,
			Parent: filepath.Dir(environment.Directory), Directory: environment.Directory, Bin: environment.Bin, Managed: environment.Managed, Cancelable: true, Packages: []string{}, Environment: &environment},
	}
	if environment.Managed {
		record := inspection.record
		run.reused = &record
		run.state.Parent = record.Parent
	} else {
		run.external = &environment
	}
	a.texSetup = run
	a.workers.Add(1)
	go a.runTeXSetup(run, false)
	writeJSON(w, http.StatusOK, a.texSetupSnapshotLocked(messages.LanguageFromContext(r.Context())))
}

func (a *App) performTeXUninstall(run *texSetupRun) error {
	if run.deletion == nil {
		return entryChangedError()
	}
	release, err := platform.AcquireTeXSetupLock(run.root)
	if err != nil {
		return err
	}
	defer release()
	if err := a.validateTeXSetupSelection(run); err != nil {
		return err
	}
	inspection, err := a.inspectSelectedTeXDeletion(run.ctx, *run.state.Environment)
	if err != nil {
		return err
	}
	if inspection.Revision != run.deletion.Revision || !inspection.CanDelete || !os.SameFile(inspection.rootInfo, run.rootInfo) {
		return entryChangedError()
	}
	a.mu.Lock()
	if err := run.ctx.Err(); err != nil {
		a.mu.Unlock()
		return err
	}
	if !samePath(a.config.TexBin, run.configuredBin) {
		a.mu.Unlock()
		return entryChangedError()
	}
	run.state.Cancelable, run.state.Stage = false, "deleting"
	a.mu.Unlock()
	a.texSetupLog(run, "[directory] %s\n[files] %d\n", run.root, inspection.FileCount)
	if run.external != nil {
		if a.texSetupHooks != nil && a.texSetupHooks.uninstall != nil {
			err = a.texSetupHooks.uninstall(run.ctx, *run.external, texSetupOutput{a, run})
		} else {
			err = runExternalTeXUninstall(run.ctx, *run.external, texSetupOutput{a, run})
		}
	} else {
		err = removeInspectedTeXSetup(inspection)
	}
	if err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	config := cloneConfig(a.config)
	config.TeXInstallations = nil
	for _, value := range a.config.TeXInstallations {
		if !samePath(value.Directory, run.root) {
			config.TeXInstallations = append(config.TeXInstallations, value)
		}
	}
	if samePath(config.TexBin, run.configuredBin) {
		config.TexBin = ""
		a.texEnvironment = nil
	}
	if err := a.saveConfig(config); err != nil {
		return messages.Errorf("TeX の削除後に設定を保存できません: %w", err)
	}
	a.config = config
	run.state.Managed = false
	run.state.Bin = ""
	run.state.Environment = nil
	if a.build != nil {
		a.build.result.SourceChanged = true
	}
	if a.lastPDFID != "" {
		a.lastPDFChanged = true
	}
	a.noteCompiledPDFSettingsChangedLocked()
	return nil
}

func (a *App) texPackageManagerHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var input struct{}
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	if !a.texSetupMu.TryLock() {
		writeError(w, texManagementBusyError())
		return
	}
	defer a.texSetupMu.Unlock()
	if err := a.checkTeXManagementAvailable(); err != nil {
		writeError(w, err)
		return
	}
	environment, err := a.currentTeXEnvironment(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	if environment.Managed || environment.ManagerApplication == "" {
		writeError(w, fail(http.StatusBadRequest, "選択した TeX の公式の管理画面が見つかりません．"))
		return
	}
	if err := openExternalTeXManager(r.Context(), environment); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"opened": true, "environment": environment})
}

func (a *App) texSetupUninstallerHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var input texSetupDeletionInput
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	if !a.texSetupMu.TryLock() {
		writeError(w, texManagementBusyError())
		return
	}
	defer a.texSetupMu.Unlock()
	if err := a.checkTeXManagementAvailable(); err != nil {
		writeError(w, err)
		return
	}
	environment, err := a.currentTeXEnvironment(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	if environment.Managed || !environment.UninstallInSettings {
		writeError(w, fail(http.StatusBadRequest, "選択した TeX は，この画面の削除操作から確認してください．"))
		return
	}
	inspection, err := a.inspectSelectedTeXDeletion(r.Context(), environment)
	if err != nil {
		writeError(w, err)
		return
	}
	if !samePath(input.Directory, inspection.Directory) || input.Revision == "" || input.Revision != inspection.Revision {
		writeTeXDeletionConflict(w, r, inspection)
		return
	}
	if err := openExternalTeXUninstaller(r.Context(), environment); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"opened": true, "environment": environment})
}
