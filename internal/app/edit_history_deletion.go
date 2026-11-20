package app

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
)

type historyDeletionResult struct {
	Deleted  []string        `json:"deleted"`
	Entries  []historyEntry  `json:"entries"`
	Settings historySettings `json:"settings"`
}

type historyDeletionFile struct {
	relative string
	info     os.FileInfo
}

type historyDeletionRecord struct {
	id    string
	files []historyDeletionFile
}

func historyChangedBeforeDeletion() error {
	return fail(http.StatusConflict, "履歴の保存先が変更されました．一覧を読み直してから操作してください．")
}

func (a *App) deleteHistoryHandler(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Path string   `json:"path"`
		IDs  []string `json:"ids"`
	}
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	if len(input.IDs) == 0 || len(input.IDs) > historyMaxVersions {
		writeError(w, fail(http.StatusBadRequest, "削除する履歴を 1～50 件選んでください．"))
		return
	}
	for _, id := range input.IDs {
		if !historyIDPattern.MatchString(id) {
			writeError(w, fail(http.StatusBadRequest, "履歴の項目を選び直してください．"))
			return
		}
	}

	// Use the same lock order as saving and renaming a document. The checked
	// project stays current until all selected versions have been removed.
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
	clean, _, err := projectFilePath(a.project.Root, input.Path, true)
	if err != nil {
		writeError(w, err)
		return
	}
	editHistoryMu.Lock()
	defer editHistoryMu.Unlock()
	result, err := a.deleteHistoryEntries(a.project.Root, clean, input.IDs)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// The caller holds both the App and history locks. Version IDs refer to
// immutable records, so a new record does not change the requested deletion.
func (a *App) deleteHistoryEntries(root, path string, ids []string) (historyDeletionResult, error) {
	settings, err := a.readHistorySettings()
	result := historyDeletionResult{Deleted: []string{}, Entries: []historyEntry{}, Settings: settings}
	if err != nil {
		return result, err
	}
	directory, err := a.historyDirectory(root, path, false)
	if errors.Is(err, os.ErrNotExist) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	base, err := filepath.EvalSymlinks(a.options.ConfigDir)
	if err != nil {
		return result, err
	}
	relative := "history/" + filepath.Base(directory)
	directory, directoryInfo, err := entryTreePath(base, relative)
	if err != nil {
		return result, err
	}
	if !directoryInfo.IsDir() {
		return result, historyChangedBeforeDeletion()
	}
	// Inspect both paths for every selected ID before removing any files. A
	// previous attempt may have removed only one of the two files, so retries
	// also remove a remaining metadata or compressed-text file.
	records := []historyDeletionRecord{}
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		record := historyDeletionRecord{id: id}
		for _, suffix := range []string{".gz", ".json"} {
			fileRelative := relative + "/" + id + suffix
			_, info, err := entryTreePath(base, fileRelative)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return result, err
			}
			if !info.Mode().IsRegular() {
				return result, historyChangedBeforeDeletion()
			}
			record.files = append(record.files, historyDeletionFile{relative: fileRelative, info: info})
		}
		records = append(records, record)
	}
	for _, record := range records {
		removed := false
		for _, file := range record.files {
			_, currentDirectory, err := entryTreePath(base, relative)
			if err != nil {
				return result, err
			}
			if !os.SameFile(directoryInfo, currentDirectory) {
				return result, historyChangedBeforeDeletion()
			}
			full, current, err := entryTreePath(base, file.relative)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return result, err
			}
			if !sameEntryInfo(file.info, current) {
				return result, historyChangedBeforeDeletion()
			}
			if err := os.Remove(full); err != nil {
				if errors.Is(err, os.ErrNotExist) {
					continue
				}
				return result, err
			}
			removed = true
		}
		if removed {
			result.Deleted = append(result.Deleted, record.id)
		}
	}
	// Pruning is left to the existing recording, listing, and settings paths.
	// This request removes only the IDs that the user selected.
	directory, currentDirectory, err := entryTreePath(base, relative)
	if errors.Is(err, os.ErrNotExist) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	if !os.SameFile(directoryInfo, currentDirectory) {
		return result, historyChangedBeforeDeletion()
	}
	result.Entries, err = readHistoryEntries(directory)
	return result, err
}
