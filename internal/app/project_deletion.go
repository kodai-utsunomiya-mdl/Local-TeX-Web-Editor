package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

type projectDeletion struct {
	Path            string             `json:"path"`
	Name            string             `json:"name"`
	FileCount       int                `json:"fileCount"`
	DirectoryCount  int                `json:"directoryCount"`
	Size            int64              `json:"size"`
	Entries         []projectEntryItem `json:"entries"`
	Revision        string             `json:"revision"`
	DraftPaths      []string           `json:"draftPaths"`
	entry           projectEntry
	projects        []string
	draftRevisions  map[string]string
}

func projectTreeContains(root, path string) bool {
	if samePath(root, path) {
		return true
	}
	relative, err := filepath.Rel(root, path)
	return err == nil && filepath.IsLocal(relative)
}

// Deletion starts with a path already recorded by the application. Check every
// component again because a previously opened folder may have been replaced.
func validateDeletionRoot(root string) error {
	current := filepath.Clean(root)
	for {
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		linked, err := platform.IsReparsePoint(current)
		if err != nil {
			return err
		}
		if linked || info.Mode()&os.ModeSymlink != 0 {
			return fail(http.StatusForbidden, "リンクを経由したフォルダーは削除できません．実際のプロジェクトを開いてから操作してください．")
		}
		if !info.IsDir() {
			return fail(http.StatusBadRequest, "削除するプロジェクトのフォルダーが見つかりません．")
		}
		parent := filepath.Dir(current)
		if samePath(parent, current) {
			return nil
		}
		current = parent
	}
}

func (a *App) protectedProjectDeletionRoot(root string) bool {
	if samePath(root, filepath.Dir(root)) {
		return true
	}
	protected := []string{a.options.ConfigDir}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		protected = append(protected, home)
	}
	if executable, err := os.Executable(); err == nil && executable != "" {
		protected = append(protected, executable)
	}
	for _, path := range protected {
		if projectTreeContains(root, path) {
			return true
		}
		if canonical, err := filepath.EvalSymlinks(path); err == nil && projectTreeContains(root, canonical) {
			return true
		}
	}
	// App-owned settings below the configuration folder cannot be registered as
	// disposable manuscript folders either.
	if projectTreeContains(a.options.ConfigDir, root) {
		return true
	}
	if canonical, err := filepath.EvalSymlinks(a.options.ConfigDir); err == nil && projectTreeContains(canonical, root) {
		return true
	}
	return false
}

func (a *App) projectDeletionRootLocked(raw string) (string, error) {
	if !filepath.IsAbs(raw) || strings.ContainsRune(raw, '\x00') {
		return "", fail(http.StatusBadRequest, "フォルダーの絶対パスを入力してください．")
	}
	root := ""
	if a.project != nil && samePath(a.project.Root, raw) {
		root = a.project.Root
	} else {
		for _, recent := range a.config.RecentProjects {
			if samePath(recent, raw) {
				root = recent
				break
			}
		}
	}
	if root == "" {
		return "", fail(http.StatusForbidden, "開いているプロジェクトか，最近使ったプロジェクトを選んでください．")
	}
	root = filepath.Clean(root)
	if a.protectedProjectDeletionRoot(root) {
		return "", fail(http.StatusForbidden, "ホーム，設定，アプリのフォルダーを含む場所は削除できません．原稿だけを含むプロジェクトを選んでください．")
	}
	if a.project != nil && !samePath(root, a.project.Root) && (projectTreeContains(root, a.project.Root) || projectTreeContains(a.project.Root, root)) {
		return "", fail(http.StatusConflict, "開いている別のプロジェクトとフォルダーが重なっています．削除するプロジェクトを開いてから操作してください．")
	}
	if err := validateDeletionRoot(root); err != nil {
		return "", err
	}
	return root, nil
}

func (a *App) deletedProjectRootsLocked(root string) []string {
	registered := map[string]bool{root: true}
	for _, recent := range a.config.RecentProjects {
		if projectTreeContains(root, recent) {
			registered[recent] = true
		}
	}
	for project := range a.config.Projects {
		if projectTreeContains(root, project) {
			registered[project] = true
		}
	}
	roots := make([]string, 0, len(registered))
	for project := range registered {
		roots = append(roots, project)
	}
	sort.Strings(roots)
	return roots
}

func (a *App) checkedProjectStoragePath(key string) (string, error) {
	path, err := a.storagePath(key)
	if err != nil {
		return "", err
	}
	base, err := filepath.EvalSymlinks(a.options.ConfigDir)
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(a.options.ConfigDir, path)
	if err != nil {
		return "", err
	}
	checked, info, err := entryTreePath(base, filepath.ToSlash(relative))
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fail(http.StatusInternalServerError, "保存した草稿や編集位置のファイルを読み取れません．")
	}
	return checked, nil
}

func projectDraftPaths(value json.RawMessage) ([]string, error) {
	result := []string{}
	if len(value) == 0 || string(value) == "null" {
		return result, nil
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(value, &object); err != nil {
		return nil, fail(http.StatusInternalServerError, "保存した草稿のファイル名を読み取れません．草稿を確認してから削除してください．")
	}
	if entries, ok := object["entries"]; ok {
		var drafts []struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal(entries, &drafts); err != nil {
			return nil, fail(http.StatusInternalServerError, "保存した草稿のファイル名を読み取れません．草稿を確認してから削除してください．")
		}
		for _, draft := range drafts {
			path := strings.ReplaceAll(draft.Path, `\`, "/")
			if path == "" || strings.ContainsRune(path, '\x00') || !filepath.IsLocal(filepath.FromSlash(path)) {
				return nil, fail(http.StatusInternalServerError, "保存した草稿のファイル名を読み取れません．草稿を確認してから削除してください．")
			}
			result = append(result, path)
		}
	} else {
		// Earlier versions stored drafts in an object keyed by the file path.
		for path, data := range object {
			var draft map[string]json.RawMessage
			if json.Unmarshal(data, &draft) == nil && len(draft["content"]) > 0 {
				result = append(result, strings.ReplaceAll(path, `\`, "/"))
			}
		}
	}
	return result, nil
}

// Callers hold both a.mu and a.uiMu. Draft content is part of the revision, so
// a new draft after the preview requires the same confirmation as a new file.
func (a *App) inspectProjectDeletionLocked(ctx context.Context, root string) (projectDeletion, error) {
	entry, err := inspectEntryTree(ctx, root, "")
	if err != nil {
		return projectDeletion{}, err
	}
	result := projectDeletion{
		Path: root, Name: filepath.Base(root), FileCount: entry.FileCount, DirectoryCount: entry.DirectoryCount,
		Size: entry.Size, Entries: append([]projectEntryItem{}, entry.Entries...), DraftPaths: []string{},
		entry: entry, projects: a.deletedProjectRootsLocked(root), draftRevisions: map[string]string{},
	}
	hash := sha256.New()
	_, _ = fmt.Fprintf(hash, "%s\x00%s\n", root, entry.Revision)
	paths := map[string]bool{}
	for _, project := range result.projects {
		key := "drafts:" + project
		path, pathErr := a.checkedProjectStoragePath(key)
		var value json.RawMessage
		if pathErr == nil {
			value, err = readStoredUIValue(path, key)
			if err != nil {
				return result, err
			}
		} else if !errors.Is(pathErr, os.ErrNotExist) {
			return result, pathErr
		}
		result.draftRevisions[project] = revision(value)
		_, _ = fmt.Fprintf(hash, "%s\x00%s\n", project, result.draftRevisions[project])
		drafts, err := projectDraftPaths(value)
		if err != nil {
			return result, err
		}
		prefix, err := filepath.Rel(root, project)
		if err != nil {
			return result, err
		}
		for _, draft := range drafts {
			if prefix == "." {
				paths[draft] = true
			} else {
				paths[filepath.ToSlash(prefix)+"/"+draft] = true
			}
		}
	}
	for path := range paths {
		result.DraftPaths = append(result.DraftPaths, path)
	}
	sort.Strings(result.DraftPaths)
	result.Revision = hex.EncodeToString(hash.Sum(nil))
	return result, nil
}

func (a *App) clearDeletedProjectLocked() {
	a.project = nil
	a.build = nil
	a.lastPDF, a.lastPDFID, a.lastPDFMain = "", "", ""
	a.lastPDFChanged = false
	a.lastPDFMarkdownInputs = nil
	a.pdfVersions = make(map[string]string)
	a.pdfOrder = nil
	a.synctexVersions = make(map[string]*synctexVersion)
}

func (a *App) removeDeletedProjectCache(root string) error {
	base, err := filepath.EvalSymlinks(a.options.ConfigDir)
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(a.options.ConfigDir, a.projectCacheDirectory(root))
	if err != nil {
		return err
	}
	a.cacheMu.Lock()
	defer a.cacheMu.Unlock()
	entry, err := inspectEntryTree(context.Background(), base, filepath.ToSlash(relative))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return removeInspectedEntry(base, entry)
}

func (a *App) removeDeletedProjectStateLocked(inspection projectDeletion) error {
	config := cloneConfig(a.config)
	config.RecentProjects = []string{}
	for _, root := range a.config.RecentProjects {
		if !projectTreeContains(inspection.Path, root) {
			config.RecentProjects = append(config.RecentProjects, root)
		}
	}
	for root := range config.Projects {
		if projectTreeContains(inspection.Path, root) {
			delete(config.Projects, root)
		}
	}
	a.config = config
	if a.project != nil && samePath(a.project.Root, inspection.Path) {
		a.clearDeletedProjectLocked()
	}
	var failures []error
	if err := a.saveConfig(config); err != nil {
		failures = append(failures, err)
	}
	for _, root := range inspection.projects {
		if err := a.removeDeletedProjectCache(root); err != nil {
			failures = append(failures, err)
		}
		for _, prefix := range []string{"drafts:", "session:"} {
			key := prefix + root
			path, err := a.checkedProjectStoragePath(key)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				failures = append(failures, err)
				continue
			}
			if prefix == "drafts:" {
				value, err := readStoredUIValue(path, key)
				if err != nil {
					failures = append(failures, err)
					continue
				}
				if revision(value) != inspection.draftRevisions[root] {
					failures = append(failures, messages.Errorf("確認後に草稿が変更されたため，その草稿を残しました．"))
					continue
				}
			}
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				failures = append(failures, err)
			}
		}
	}
	return errors.Join(failures...)
}

func (a *App) projectDeleteHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet, http.MethodDelete) {
		return
	}
	var input struct {
		Path         string `json:"path"`
		Revision     string `json:"revision"`
		Confirmation string `json:"confirmation"`
	}
	if r.Method == http.MethodGet {
		input.Path = r.URL.Query().Get("path")
	} else if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	root, err := a.projectDeletionRootLocked(input.Path)
	if err != nil {
		writeError(w, err)
		return
	}
	if r.Method == http.MethodDelete {
		if input.Confirmation != filepath.Base(root) {
			writeError(w, fail(http.StatusBadRequest, "削除するプロジェクトのフォルダー名を正確に入力してください．"))
			return
		}
		if a.project != nil && samePath(root, a.project.Root) && a.isRunningLocked() {
			writeError(w, fail(http.StatusConflict, "コンパイルが終了してからプロジェクトを削除してください．"))
			return
		}
	}
	a.uiMu.Lock()
	defer a.uiMu.Unlock()
	inspection, err := a.inspectProjectDeletionLocked(r.Context(), root)
	if err != nil {
		if r.Method == http.MethodDelete {
			if current, inspectErr := a.inspectProjectDeletionLocked(r.Context(), root); inspectErr == nil {
				writeJSON(w, http.StatusConflict, map[string]any{
					"error": messages.Text(messages.LanguageFromContext(r.Context()), "プロジェクトの内容や草稿が変更されました．現在の項目を確認してから，もう一度削除してください．"),
					"project": current,
				})
				return
			}
		}
		writeError(w, err)
		return
	}
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, inspection)
		return
	}
	language := messages.LanguageFromContext(r.Context())
	if input.Revision == "" || input.Revision != inspection.Revision {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": messages.Text(language, "プロジェクトの内容や草稿が変更されました．現在の項目を確認してから，もう一度削除してください．"),
			"project": inspection,
		})
		return
	}
	if err := validateDeletionRoot(root); err != nil {
		writeError(w, err)
		return
	}
	if err := removeInspectedEntry(root, inspection.entry); err != nil {
		if current, inspectErr := a.inspectProjectDeletionLocked(r.Context(), root); inspectErr == nil {
			writeJSON(w, http.StatusConflict, map[string]any{"error": messages.ErrorText(language, err), "project": current})
		} else {
			writeError(w, err)
		}
		return
	}
	cleanupErr := a.removeDeletedProjectStateLocked(inspection)
	result := map[string]any{
		"deleted": true, "path": root, "removedProjects": inspection.projects,
		"state": a.stateLocked(false, language),
	}
	if cleanupErr != nil {
		result["warning"] = messages.Text(language, "プロジェクトを削除しましたが，一部の設定，草稿，PDF の記録を消去できませんでした: %v", cleanupErr)
	}
	writeJSON(w, http.StatusOK, result)
}
