package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

type fileImportTarget struct {
	Path        string `json:"path"`
	Exists      bool   `json:"exists"`
	Directory   bool   `json:"directory"`
	Size        int64  `json:"size"`
	Revision    string `json:"revision,omitempty"`
	Alternative string `json:"alternative,omitempty"`
	Replaceable bool   `json:"replaceable"`
}

func inspectFileImport(ctx context.Context, root, relative string) (fileImportTarget, error) {
	clean, path, err := projectEntryPath(root, relative, true)
	if err != nil {
		return fileImportTarget{}, err
	}
	result := fileImportTarget{Path: clean}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	result.Exists = true
	result.Directory = info.IsDir()
	result.Size = info.Size()
	if !info.IsDir() && info.Size() <= maxAssetSize {
		entry, err := inspectProjectEntry(ctx, root, clean)
		if err != nil {
			return result, err
		}
		result.Revision = entry.Revision
		result.Replaceable = true
	}
	ext := filepath.Ext(clean)
	base := strings.TrimSuffix(clean, ext)
	for number := 2; number <= 1000; number++ {
		candidate := fmt.Sprintf("%s-%d%s", base, number, ext)
		if _, err := os.Lstat(filepath.Join(root, filepath.FromSlash(candidate))); errors.Is(err, os.ErrNotExist) {
			result.Alternative = candidate
			break
		} else if err != nil {
			return result, err
		}
	}
	return result, nil
}

func checkFileImport(ctx context.Context, root, relative, expected string) (fileImportTarget, error) {
	target, err := inspectFileImport(ctx, root, relative)
	if err != nil {
		return target, err
	}
	if target.Exists {
		if !target.Replaceable || expected == "" || target.Revision != expected {
			return target, fail(http.StatusConflict, "同じ名前の項目があります．保存先と置き換える内容を確認してください．")
		}
	} else if expected != "" {
		return target, fail(http.StatusConflict, "コピー先の内容が変更されました．保存先をもう一度確認してください．")
	}
	return target, nil
}

func (a *App) fileImportHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet, http.MethodPost) {
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
	root, relative := a.project.Root, r.URL.Query().Get("path")
	if r.Method == http.MethodGet {
		target, err := inspectFileImport(r.Context(), root, relative)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, target)
		return
	}
	if a.isRunningLocked() {
		writeError(w, fail(http.StatusConflict, "コンパイルが終了してからファイルを操作してください．"))
		return
	}
	if r.ContentLength > maxAssetSize {
		writeError(w, fail(http.StatusRequestEntityTooLarge, "追加するファイルは 1 個あたり 128 MiB 以内にしてください．"))
		return
	}
	expected := r.Header.Get("X-File-Revision")
	target, err := checkFileImport(r.Context(), root, relative, expected)
	writeFailure := func(err error) {
		var known *apiError
		if errors.As(err, &known) && known.status == http.StatusConflict {
			if current, inspectErr := inspectFileImport(r.Context(), root, relative); inspectErr == nil {
				writeJSON(w, http.StatusConflict, map[string]any{
					"error": messages.ErrorText(messages.LanguageFromContext(r.Context()), err),
					"target": current, "reviewRequired": true,
				})
				return
			}
		}
		writeError(w, err)
	}
	if err != nil {
		writeFailure(err)
		return
	}
	_, destination, err := projectEntryPath(root, target.Path, true)
	if err != nil {
		writeFailure(err)
		return
	}
	temp, err := os.CreateTemp(filepath.Dir(destination), ".local-tex-editor-import-*")
	if err != nil {
		writeFailure(err)
		return
	}
	temporary := temp.Name()
	defer func() {
		_ = temp.Close()
		if err := os.Remove(temporary); errors.Is(err, os.ErrPermission) {
			if err := os.Chmod(temporary, 0600); err == nil {
				_ = os.Remove(temporary)
			}
		}
	}()
	written, err := io.Copy(temp, http.MaxBytesReader(w, r.Body, maxAssetSize))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			err = fail(http.StatusRequestEntityTooLarge, "追加するファイルは 1 個あたり 128 MiB 以内にしてください．")
		}
		writeFailure(err)
		return
	}
	mode := os.FileMode(0644)
	if target.Exists {
		if info, statErr := os.Stat(destination); statErr == nil {
			mode = info.Mode().Perm()
		}
	}
	if err = temp.Chmod(mode); err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = r.Context().Err()
	}
	if err != nil {
		writeFailure(err)
		return
	}
	check := func() error {
		_, err := checkFileImport(r.Context(), root, target.Path, expected)
		return err
	}
	if target.Exists {
		err = platform.ReplaceFileChecked(temporary, destination, check)
	} else {
		if err = check(); err == nil {
			err = platform.MoveWithoutReplace(temporary, destination)
			if errors.Is(err, os.ErrExist) {
				err = fail(http.StatusConflict, "同じ名前の項目があります．保存先と置き換える内容を確認してください．")
			}
		}
	}
	if err != nil {
		writeFailure(err)
		return
	}
	a.noteSavedSourceLocked(target.Path)
	if a.build != nil {
		a.build.result.SourceChanged = true
	}
	if a.lastPDFID != "" {
		a.lastPDFChanged = true
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"path": target.Path, "kind": projectFileKind(target.Path), "bytes": written, "replaced": target.Exists,
		"state": a.stateLocked(true, messages.LanguageFromContext(r.Context())),
	})
}
