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

type projectEntryItem struct {
	Path            string `json:"path"`
	Directory       bool   `json:"directory"`
	Size            int64  `json:"size"`
	ContentRevision string `json:"contentRevision,omitempty"`
	info            os.FileInfo
}

type projectEntry struct {
	Path            string             `json:"path"`
	Directory       bool               `json:"directory"`
	Empty           bool               `json:"empty"`
	Revision        string             `json:"revision"`
	ContentRevision string             `json:"contentRevision,omitempty"`
	Entries         []projectEntryItem `json:"entries"`
	FileCount       int                `json:"fileCount"`
	DirectoryCount  int                `json:"directoryCount"`
	Size            int64              `json:"size"`
	files           []string
	info            os.FileInfo
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
	clean, _, err := projectEntryPath(root, relative, false)
	if err != nil {
		return projectEntry{}, err
	}
	return inspectEntryTree(ctx, root, clean)
}

// A tree may contain hidden files that the editor does not list. Every real
// child is included in the confirmation, while links and special files stop it.
// An empty relative path is reserved for the project deletion handler.
func entryTreePath(root, relative string) (string, os.FileInfo, error) {
	parts := []string{}
	if relative != "" {
		if !filepath.IsLocal(filepath.FromSlash(relative)) {
			return "", nil, fail(http.StatusBadRequest, "プロジェクト内の相対パスを指定してください．")
		}
		parts = strings.Split(relative, "/")
		for _, part := range parts {
			if part == "" || part == "." || part == ".." {
				return "", nil, fail(http.StatusBadRequest, "このパスは開けません．")
			}
		}
	}
	current := root
	for index := 0; index <= len(parts); index++ {
		if index > 0 {
			current = filepath.Join(current, parts[index-1])
		}
		info, err := os.Lstat(current)
		if err != nil {
			return "", nil, err
		}
		linked, err := platform.IsReparsePoint(current)
		if err != nil {
			return "", nil, err
		}
		if linked || info.Mode()&os.ModeSymlink != 0 {
			return "", nil, fail(http.StatusForbidden, "リンクを経由したファイルは開けません．実際の原稿フォルダーを選んでください．")
		}
		if index < len(parts) && !info.IsDir() {
			return "", nil, fail(http.StatusBadRequest, "途中のパスがフォルダーではありません．")
		}
		if index == len(parts) {
			if !info.IsDir() {
				regular, err := platform.IsRegularFile(current, info)
				if err != nil {
					return "", nil, err
				}
				if !regular {
					return "", nil, fail(http.StatusBadRequest, "通常のファイルを選んでください．")
				}
			}
			return current, info, nil
		}
	}
	return "", nil, fail(http.StatusBadRequest, "このパスは開けません．")
}

func sameEntryInfo(before, after os.FileInfo) bool {
	return before != nil && after != nil && os.SameFile(before, after) && before.Mode() == after.Mode() && before.Size() == after.Size() && before.ModTime().Equal(after.ModTime())
}

func entryChangedError() error {
	return fail(http.StatusConflict, "ファイルやフォルダーの内容が変更されました．現在の項目を確認してから，もう一度操作してください．")
}

func entryContentRevision(ctx context.Context, path string, info os.FileInfo) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return "", err
	}
	if !sameEntryInfo(info, opened) {
		return "", entryChangedError()
	}
	hash := sha256.New()
	buffer := make([]byte, 64*1024)
	var written int64
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		n, readErr := file.Read(buffer)
		if n > 0 {
			_, _ = hash.Write(buffer[:n])
			written += int64(n)
		}
		if readErr != nil {
			if readErr != io.EOF {
				return "", readErr
			}
			break
		}
		if written > info.Size() {
			return "", entryChangedError()
		}
	}
	after, err := file.Stat()
	if err != nil {
		return "", err
	}
	current, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if written != info.Size() || !sameEntryInfo(info, after) || !sameEntryInfo(info, current) {
		return "", entryChangedError()
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func inspectEntryTree(ctx context.Context, root, relative string) (projectEntry, error) {
	path, info, err := entryTreePath(root, relative)
	if err != nil {
		return projectEntry{}, err
	}
	entry := projectEntry{Path: relative, Directory: info.IsDir(), Empty: true, Entries: []projectEntryItem{}, info: info}
	hash := sha256.New()
	_, _ = fmt.Fprintf(hash, "%s\x00%d\x00%d\x00%d\n", relative, info.Mode(), info.Size(), info.ModTime().UnixNano())
	if !info.IsDir() {
		if info.Size() > maxAssetSize {
			return entry, fail(http.StatusRequestEntityTooLarge, "128 MiB を超えるファイルのコピー，名前変更，削除は，OS のファイル管理画面で行ってください．")
		}
		entry.ContentRevision, err = entryContentRevision(ctx, path, info)
		if err != nil {
			return entry, err
		}
		entry.files = []string{relative}
		entry.FileCount = 1
		entry.Size = info.Size()
		_, _ = io.WriteString(hash, entry.ContentRevision)
	} else {
		err = filepath.WalkDir(path, func(child string, _ fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			if child == path {
				return nil
			}
			if len(entry.Entries) >= 50000 {
				return fail(http.StatusBadRequest, "フォルダー内の項目が多いため，OS のファイル管理画面で操作してください．")
			}
			rel, err := filepath.Rel(root, child)
			if err != nil {
				return err
			}
			rel = filepath.ToSlash(rel)
			childPath, childInfo, err := entryTreePath(root, rel)
			if err != nil {
				return err
			}
			childEntry := projectEntryItem{Path: rel, Directory: childInfo.IsDir(), info: childInfo}
			if childInfo.IsDir() {
				entry.DirectoryCount++
			} else {
				childEntry.ContentRevision, err = entryContentRevision(ctx, childPath, childInfo)
				if err != nil {
					return err
				}
				childEntry.Size = childInfo.Size()
				entry.files = append(entry.files, rel)
				entry.FileCount++
				entry.Size += childInfo.Size()
			}
			entry.Entries = append(entry.Entries, childEntry)
			_, _ = fmt.Fprintf(hash, "%s\x00%d\x00%d\x00%d\x00%s\n", rel, childInfo.Mode(), childInfo.Size(), childInfo.ModTime().UnixNano(), childEntry.ContentRevision)
			return nil
		})
		if err != nil {
			return entry, err
		}
		entry.Empty = len(entry.Entries) == 0
		// Changes during traversal require another confirmation as well.
		for _, child := range entry.Entries {
			_, current, err := entryTreePath(root, child.Path)
			if err != nil {
				return entry, err
			}
			if !sameEntryInfo(child.info, current) {
				return entry, entryChangedError()
			}
		}
	}
	_, current, err := entryTreePath(root, relative)
	if err != nil {
		return entry, err
	}
	if !sameEntryInfo(info, current) {
		return entry, entryChangedError()
	}
	if err := ctx.Err(); err != nil {
		return entry, err
	}
	entry.Revision = hex.EncodeToString(hash.Sum(nil))
	return entry, nil
}

// Delete exactly the inspected paths. Removing directories with os.Remove
// makes a newly added child stop deletion instead of deleting that child too.
func removeInspectedEntry(root string, entry projectEntry) error {
	current, err := inspectEntryTree(context.Background(), root, entry.Path)
	if err != nil {
		return err
	}
	if entry.Revision == "" || current.Revision != entry.Revision || entry.info == nil || !os.SameFile(entry.info, current.info) {
		return entryChangedError()
	}
	entries := append([]projectEntryItem{{Path: entry.Path, Directory: entry.Directory, ContentRevision: current.ContentRevision, info: current.info}}, current.Entries...)
	for index := len(entries) - 1; index >= 0; index-- {
		item := entries[index]
		path, info, err := entryTreePath(root, item.Path)
		if err != nil {
			return err
		}
		if !os.SameFile(item.info, info) || item.info.Mode() != info.Mode() || (!item.Directory && !sameEntryInfo(item.info, info)) {
			return entryChangedError()
		}
		if !item.Directory {
			revision, err := entryContentRevision(context.Background(), path, item.info)
			if err != nil {
				return err
			}
			if revision != item.ContentRevision {
				return entryChangedError()
			}
			_, latest, err := entryTreePath(root, item.Path)
			if err != nil {
				return err
			}
			if !sameEntryInfo(item.info, latest) {
				return entryChangedError()
			}
		} else {
			children, err := os.ReadDir(path)
			if err != nil {
				return err
			}
			if len(children) != 0 {
				return entryChangedError()
			}
		}
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	return nil
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
		Action   string `json:"action"`
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
		if input.Action == "copy" {
			a.copyEntryLocked(w, r, input.Path, input.NewPath, input.Revision)
			return
		}
		if input.Action != "" {
			writeError(w, fail(http.StatusBadRequest, "ファイルの操作を確認してください．"))
			return
		}
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
		if r.Method == http.MethodDelete {
			writeJSON(w, http.StatusConflict, map[string]any{
				"error": messages.ErrorText(messages.LanguageFromContext(r.Context()), entryChangedError()),
				"entry": entry, "reviewRequired": true,
			})
		} else {
			writeError(w, fail(http.StatusConflict, "ファイルの内容が変更されました．一覧を更新してから操作してください．"))
		}
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
		containsMain := entry.Path == a.project.Main || (entry.Directory && strings.HasPrefix(a.project.Main, entry.Path+"/"))
		config := a.config
		if containsMain {
			config = cloneConfig(a.config)
			config.Projects[root] = projectSettings{Main: "", Mode: a.project.Mode}
			if err = a.saveConfig(config); err != nil {
				writeError(w, err)
				return
			}
		}
		if err = removeInspectedEntry(root, entry); err != nil {
			if containsMain {
				if _, mainErr := os.Lstat(filepath.Join(root, filepath.FromSlash(a.project.Main))); errors.Is(mainErr, os.ErrNotExist) {
					a.config = config
					a.project.Main = ""
				} else {
					_ = a.saveConfig(a.config)
				}
			}
			if remaining, inspectErr := inspectProjectEntry(r.Context(), root, entry.Path); inspectErr == nil {
				writeJSON(w, http.StatusConflict, map[string]any{
					"error": messages.ErrorText(messages.LanguageFromContext(r.Context()), messages.Errorf("削除を完了できませんでした．残っている項目を確認してから，もう一度操作してください: %v", err)),
					"entry": remaining, "reviewRequired": true,
				})
			} else {
				writeError(w, messages.Errorf("削除できません: %w", err))
			}
			return
		}
		if containsMain {
			a.config = config
			a.project.Main = ""
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
