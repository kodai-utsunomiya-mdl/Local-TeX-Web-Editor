package app

import (
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
)

type ProjectStatus struct {
	Path    string `json:"path"`
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
}

// Projects are recorded with their actual paths when opened. Recheck that path
// before using it, since a folder can disappear or become a link between visits.
func inspectProjectFolder(root string) (string, error) {
	if !filepath.IsAbs(root) || strings.ContainsRune(root, '\x00') {
		return "unavailable", fail(http.StatusBadRequest, "プロジェクトの場所を確認できません．フォルダーを選び直してください．")
	}
	info, err := os.Stat(root)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "missing", fail(http.StatusNotFound, "この場所にプロジェクトフォルダーがありません．移動先を選ぶか，ドライブの接続を確認してください．")
		}
		return "unavailable", messages.Errorf("プロジェクトフォルダーを読み取れません．アクセス権やドライブの接続を確認してください: %w", err)
	}
	if !info.IsDir() {
		return "not-directory", fail(http.StatusBadRequest, "プロジェクトの場所にファイルがあります．原稿を含むフォルダーを選び直してください．")
	}
	actual, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "unavailable", messages.Errorf("プロジェクトフォルダーを読み取れません．アクセス権やドライブの接続を確認してください: %w", err)
	}
	if !samePath(actual, root) {
		return "changed", fail(http.StatusConflict, "プロジェクトの場所が別のフォルダーへのリンクに変わりました．実際の場所を選び直してください．")
	}
	directory, err := os.Open(root)
	if err != nil {
		return "unavailable", messages.Errorf("プロジェクトフォルダーを読み取れません．アクセス権やドライブの接続を確認してください: %w", err)
	}
	_, readErr := directory.Readdirnames(1)
	closeErr := directory.Close()
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return "unavailable", messages.Errorf("プロジェクトフォルダーを読み取れません．アクセス権やドライブの接続を確認してください: %w", readErr)
	}
	if closeErr != nil {
		return "unavailable", messages.Errorf("プロジェクトフォルダーを読み取れません．アクセス権やドライブの接続を確認してください: %w", closeErr)
	}
	return "available", nil
}

func projectFolderStatus(root, language string) ProjectStatus {
	status, err := inspectProjectFolder(root)
	return ProjectStatus{Path: root, Status: status, Message: messages.ErrorText(language, err)}
}

func (a *App) refreshProjectStatusLocked(refresh bool, language string) *ProjectStatus {
	if a.project == nil {
		return nil
	}
	status := projectFolderStatus(a.project.Root, language)
	if status.Status == "available" && refresh {
		files, directories, modifiedAt, err := listProjectEntries(a.project.Root)
		if err == nil {
			a.project.Files, a.project.Directories, a.project.DirectoryModifiedAt = files, directories, modifiedAt
		} else {
			status = projectFolderStatus(a.project.Root, language)
			if status.Status == "available" {
				status.Status = "unavailable"
				status.Message = messages.ErrorText(language, err)
			}
		}
	}
	if status.Status != "available" {
		a.project.Files = []ProjectFile{}
		a.project.Directories = []string{}
		a.project.DirectoryModifiedAt = nil
	}
	return &status
}

func (a *App) recentProjectStatusesLocked(current *ProjectStatus, language string) []ProjectStatus {
	result := make([]ProjectStatus, 0, len(a.config.RecentProjects))
	for _, path := range a.config.RecentProjects {
		duplicate := false
		for _, previous := range result {
			if samePath(previous.Path, path) {
				duplicate = true
				break
			}
		}
		if duplicate {
			continue
		}
		if current != nil && samePath(current.Path, path) {
			result = append(result, *current)
		} else {
			result = append(result, projectFolderStatus(path, language))
		}
	}
	return result
}

func (a *App) recentProjectHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodDelete) {
		return
	}
	var input struct {
		Path string `json:"path"`
	}
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	if !filepath.IsAbs(input.Path) || strings.ContainsRune(input.Path, '\x00') {
		writeError(w, fail(http.StatusBadRequest, "フォルダーの絶対パスを入力してください．"))
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	config := cloneConfig(a.config)
	config.RecentProjects = []string{}
	removed := false
	for _, path := range a.config.RecentProjects {
		if samePath(path, input.Path) {
			removed = true
		} else {
			config.RecentProjects = append(config.RecentProjects, path)
		}
	}
	if removed {
		if err := a.saveConfig(config); err != nil {
			writeError(w, messages.Errorf("最近のプロジェクトの一覧を保存できません: %w", err))
			return
		}
		a.config = config
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"path": input.Path, "removed": removed,
		"state": a.stateLocked(true, messages.LanguageFromContext(r.Context())),
	})
}
