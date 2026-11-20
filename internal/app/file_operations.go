package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

type projectEntry struct {
	Path            string `json:"path"`
	Directory       bool   `json:"directory"`
	Empty           bool   `json:"empty"`
	Revision        string `json:"revision"`
	ContentRevision string `json:"contentRevision,omitempty"`
	files           []string
}

// Entry paths may end in a directory, but every existing component must remain
// inside the project and must be a normal file or folder.
func projectEntryPath(root, raw string, missing bool) (string, string, error) {
	clean, err := cleanRelative(raw)
	if err != nil {
		return "", "", err
	}
	current := root
	parts := strings.Split(clean, "/")
	for index, part := range parts {
		current = filepath.Join(current, part)
		info, statErr := os.Lstat(current)
		if missing && index == len(parts)-1 && errors.Is(statErr, os.ErrNotExist) {
			return clean, current, nil
		}
		if statErr != nil {
			return "", "", statErr
		}
		linked, linkErr := platform.IsReparsePoint(current)
		if linkErr != nil {
			return "", "", linkErr
		}
		if linked || info.Mode()&os.ModeSymlink != 0 {
			return "", "", fail(http.StatusForbidden, "リンクを経由したファイルは開けません．実際の原稿フォルダーを選んでください．")
		}
		if index < len(parts)-1 && !info.IsDir() {
			return "", "", fail(http.StatusBadRequest, "途中のパスがフォルダーではありません．")
		}
		if !info.IsDir() {
			regular, regularErr := platform.IsRegularFile(current, info)
			if regularErr != nil {
				return "", "", regularErr
			}
			if !regular {
				return "", "", fail(http.StatusBadRequest, "通常のファイルを選んでください．")
			}
		}
	}
	return clean, current, nil
}

func inspectProjectEntry(ctx context.Context, root, relative string) (projectEntry, error) {
	clean, path, err := projectEntryPath(root, relative, false)
	if err != nil {
		return projectEntry{}, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return projectEntry{}, err
	}
	entry := projectEntry{Path: clean, Directory: info.IsDir(), Empty: true}
	hash := sha256.New()
	_, _ = fmt.Fprintf(hash, "%s\x00%d\x00%d\x00%d\n", clean, info.Mode(), info.Size(), info.ModTime().UnixNano())
	if !info.IsDir() {
		entry.files = []string{clean}
		if info.Size() > maxAssetSize {
			return entry, fail(http.StatusRequestEntityTooLarge, "128 MiB を超えるファイルの名前変更と削除は，OS のファイル管理画面で行ってください．")
		}
		file, openErr := os.Open(path)
		if openErr != nil {
			return entry, openErr
		}
		contentHash := sha256.New()
		written, readErr := io.Copy(contentHash, io.LimitReader(file, maxAssetSize+1))
		closeErr := file.Close()
		if readErr != nil {
			return entry, readErr
		}
		if closeErr != nil {
			return entry, closeErr
		}
		if written != info.Size() {
			return entry, fail(http.StatusConflict, "ファイルの内容が変更されました．一覧を更新してから操作してください．")
		}
		entry.ContentRevision = hex.EncodeToString(contentHash.Sum(nil))
		_, _ = io.WriteString(hash, entry.ContentRevision)
	} else {
		count := 0
		err = filepath.WalkDir(path, func(child string, item fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			if child == path {
				return nil
			}
			entry.Empty = false
			count++
			if count > 50000 {
				return fail(http.StatusBadRequest, "フォルダー内の項目が多いため，OS のファイル管理画面で名前を変更してください．")
			}
			rel, relErr := filepath.Rel(root, child)
			if relErr != nil {
				return relErr
			}
			if _, _, safeErr := projectEntryPath(root, filepath.ToSlash(rel), false); safeErr != nil {
				return safeErr
			}
			childInfo, infoErr := item.Info()
			if infoErr != nil {
				return infoErr
			}
			if !childInfo.IsDir() {
				entry.files = append(entry.files, filepath.ToSlash(rel))
			}
			_, _ = fmt.Fprintf(hash, "%s\x00%d\x00%d\x00%d\n", filepath.ToSlash(rel), childInfo.Mode(), childInfo.Size(), childInfo.ModTime().UnixNano())
			return nil
		})
		if err != nil {
			return entry, err
		}
	}
	if err := ctx.Err(); err != nil {
		return entry, err
	}
	entry.Revision = hex.EncodeToString(hash.Sum(nil))
	return entry, nil
}

func changedEntryPath(path, from, to string, directory bool) string {
	if path == from {
		return to
	}
	if directory && strings.HasPrefix(path, from+"/") {
		return to + strings.TrimPrefix(path, from)
	}
	return path
}

func (a *App) moveEntryHistory(root, from, to string, directory bool, paths []string) error {
	editHistoryMu.Lock()
	defer editHistoryMu.Unlock()
	for _, path := range paths {
		source, err := a.historyDirectory(root, path, false)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		entries, err := readHistoryEntries(source)
		if err != nil {
			return err
		}
		if len(entries) == 0 {
			continue
		}
		destination, err := a.historyDirectory(root, changedEntryPath(path, from, to, directory), true)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			oldData, newData := filepath.Join(source, entry.ID+".gz"), filepath.Join(destination, entry.ID+".gz")
			if err := platform.MoveWithoutReplace(oldData, newData); err != nil {
				return err
			}
			if err := platform.MoveWithoutReplace(filepath.Join(source, entry.ID+".json"), filepath.Join(destination, entry.ID+".json")); err != nil {
				_ = platform.MoveWithoutReplace(newData, oldData)
				return err
			}
		}
		_ = os.Remove(source)
	}
	return nil
}

func (a *App) entryHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet, http.MethodPost, http.MethodPatch, http.MethodDelete) {
		return
	}
	var input struct {
		Path     string `json:"path"`
		NewPath  string `json:"newPath"`
		Revision string `json:"revision"`
	}
	if r.Method == http.MethodGet {
		input.Path = r.URL.Query().Get("path")
	} else if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.checkProjectLocked(r.Header.Get("X-Project-Root")); err != nil {
		writeError(w, err)
		return
	}
	if a.project == nil {
		writeError(w, fail(http.StatusBadRequest, "原稿フォルダーを開いてください．"))
		return
	}
	if r.Method != http.MethodGet && a.isRunningLocked() {
		writeError(w, fail(http.StatusConflict, "コンパイルが終了してからファイルを操作してください．"))
		return
	}
	root := a.project.Root
	if r.Method == http.MethodGet {
		entry, err := inspectProjectEntry(r.Context(), root, input.Path)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, entry)
		return
	}
	if r.Method == http.MethodPost {
		clean, path, err := projectEntryPath(root, input.Path, true)
		if err != nil {
			writeError(w, err)
			return
		}
		if err := os.Mkdir(path, 0755); err != nil {
			if errors.Is(err, os.ErrExist) {
				err = fail(http.StatusConflict, "同じ名前のファイルまたはフォルダーがすでにあります．")
			}
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"path": clean, "directory": true, "state": a.stateLocked(true, messages.LanguageFromContext(r.Context()))})
		return
	}
	entry, err := inspectProjectEntry(r.Context(), root, input.Path)
	if err != nil {
		writeError(w, err)
		return
	}
	if input.Revision == "" || entry.Revision != input.Revision {
		writeError(w, fail(http.StatusConflict, "ファイルの内容が変更されました．一覧を更新してから操作してください．"))
		return
	}
	_, source, err := projectEntryPath(root, entry.Path, false)
	if err != nil {
		writeError(w, err)
		return
	}
	newPath := ""
	historyWarning := ""
	if r.Method == http.MethodPatch {
		var destination string
		newPath, destination, err = projectEntryPath(root, input.NewPath, true)
		if err != nil {
			writeError(w, err)
			return
		}
		if newPath == entry.Path || (entry.Directory && strings.HasPrefix(newPath, entry.Path+"/")) {
			writeError(w, fail(http.StatusBadRequest, "変更先には別の名前を指定してください．"))
			return
		}
		if !entry.Directory && isTextFile(entry.Path) && !isTextFile(newPath) {
			writeError(w, fail(http.StatusBadRequest, "編集できるテキスト形式の拡張子を指定してください．"))
			return
		}
		if _, err = os.Lstat(destination); err == nil && !samePath(source, destination) {
			writeError(w, fail(http.StatusConflict, "同じ名前のファイルまたはフォルダーがすでにあります．"))
			return
		} else if err != nil && !errors.Is(err, os.ErrNotExist) {
			writeError(w, err)
			return
		}
		if err = platform.MoveWithoutReplace(source, destination); err != nil {
			writeError(w, messages.Errorf("名前を変更できません: %w", err))
			return
		}
		main := changedEntryPath(a.project.Main, entry.Path, newPath, entry.Directory)
		if main != "" && !strings.EqualFold(filepath.Ext(main), ".tex") {
			main = ""
		}
		if main != a.project.Main {
			config := cloneConfig(a.config)
			config.Projects[root] = projectSettings{Main: main, Mode: a.project.Mode}
			if err = a.saveConfig(config); err != nil {
				_ = platform.MoveWithoutReplace(destination, source)
				writeError(w, err)
				return
			}
			a.config = config
			a.project.Main = main
		}
		if historyErr := a.moveEntryHistory(root, entry.Path, newPath, entry.Directory, entry.files); historyErr != nil {
			historyWarning = messages.ErrorText(messages.LanguageFromContext(r.Context()), messages.Errorf("名前を変更しましたが，一部の編集履歴を移動できませんでした: %v", historyErr))
		}
	} else {
		if entry.Directory && !entry.Empty {
			writeError(w, fail(http.StatusConflict, "中に項目があるフォルダーは削除できません．空にしてから操作してください．"))
			return
		}
		if entry.Path == a.project.Main {
			config := cloneConfig(a.config)
			config.Projects[root] = projectSettings{Main: "", Mode: a.project.Mode}
			if err = a.saveConfig(config); err != nil {
				writeError(w, err)
				return
			}
			if err = os.Remove(source); err != nil {
				_ = a.saveConfig(a.config)
				writeError(w, err)
				return
			}
			a.config = config
			a.project.Main = ""
		} else if err = os.Remove(source); err != nil {
			writeError(w, messages.Errorf("削除できません: %w", err))
			return
		}
	}
	a.noteSavedSourceLocked(entry.Path)
	if newPath != "" {
		a.noteSavedSourceLocked(newPath)
	}
	if a.build != nil {
		a.build.result.SourceChanged = true
	}
	if a.lastPDFID != "" {
		a.lastPDFChanged = true
	}
	writeJSON(w, http.StatusOK, map[string]any{"oldPath": entry.Path, "path": newPath, "directory": entry.Directory, "removed": r.Method == http.MethodDelete, "historyWarning": historyWarning, "state": a.stateLocked(true, messages.LanguageFromContext(r.Context()))})
}
