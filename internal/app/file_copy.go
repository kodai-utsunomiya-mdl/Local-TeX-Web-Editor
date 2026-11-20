package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

type entryCopyPath struct {
	path string
	info os.FileInfo
	mode os.FileMode
}

// A copy uses an existing parent directory. Comparing the parent identities
// also catches a directory replaced while its files are being copied.
func entryCopyParents(root, destination string, source projectEntry) ([]entryCopyPath, error) {
	parent := filepath.ToSlash(filepath.Dir(filepath.FromSlash(destination)))
	paths := []string{""}
	if parent != "." {
		parts := strings.Split(parent, "/")
		for index := range parts {
			paths = append(paths, strings.Join(parts[:index+1], "/"))
		}
	}
	parents := make([]entryCopyPath, 0, len(paths))
	for _, relative := range paths {
		_, info, err := entryTreePath(root, relative)
		if err != nil {
			return nil, err
		}
		if !info.IsDir() {
			return nil, fail(http.StatusBadRequest, "途中のパスがフォルダーではありません．")
		}
		if source.Directory && os.SameFile(source.info, info) {
			return nil, fail(http.StatusBadRequest, "コピー先には，元のフォルダーの外にある新しい名前を指定してください．")
		}
		parents = append(parents, entryCopyPath{path: relative, info: info})
	}
	return parents, nil
}

func checkEntryCopyParents(root string, parents []entryCopyPath) error {
	for _, parent := range parents {
		_, current, err := entryTreePath(root, parent.path)
		if err != nil {
			return err
		}
		if !current.IsDir() || !os.SameFile(parent.info, current) {
			return fail(http.StatusConflict, "コピー先のフォルダーが変更されました．保存先をもう一度確認してください．")
		}
	}
	return nil
}

func checkEntryCopyStage(root, stage, parent string, directories map[string]os.FileInfo) error {
	for {
		expected := directories[parent]
		_, current, err := entryTreePath(root, parent)
		if err != nil {
			return err
		}
		if expected == nil || !current.IsDir() || !os.SameFile(expected, current) {
			return fail(http.StatusConflict, "コピー先のフォルダーが変更されました．保存先をもう一度確認してください．")
		}
		if parent == stage {
			return nil
		}
		if !strings.HasPrefix(parent, stage+"/") {
			return fail(http.StatusBadRequest, "このパスは開けません．")
		}
		parent = filepath.ToSlash(filepath.Dir(filepath.FromSlash(parent)))
	}
}

// Cleanup visits only entries created for this copy. A new, unrelated child
// prevents removal of its directory rather than being removed recursively.
func removeEntryCopy(root string, created []entryCopyPath) {
	for _, item := range created {
		path, current, err := entryTreePath(root, item.path)
		if err == nil && current.IsDir() && os.SameFile(item.info, current) {
			_ = os.Chmod(path, 0700)
		}
	}
	for index := len(created) - 1; index >= 0; index-- {
		item := created[index]
		path, current, err := entryTreePath(root, item.path)
		if err != nil || !os.SameFile(item.info, current) {
			continue
		}
		if !current.IsDir() {
			_ = os.Chmod(path, 0600)
		}
		_ = os.Remove(path)
	}
}

func copyEntryFile(ctx context.Context, root string, item projectEntryItem, destination *os.File) error {
	path, current, err := entryTreePath(root, item.Path)
	if err != nil {
		return err
	}
	if !sameEntryInfo(item.info, current) {
		return entryChangedError()
	}
	source, err := os.Open(path)
	if err != nil {
		return err
	}
	defer source.Close()
	opened, err := source.Stat()
	if err != nil {
		return err
	}
	if !sameEntryInfo(item.info, opened) {
		return entryChangedError()
	}
	hash := sha256.New()
	buffer := make([]byte, 64*1024)
	var written int64
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, readErr := source.Read(buffer)
		if n > 0 {
			written += int64(n)
			if written > item.Size {
				return entryChangedError()
			}
			if _, err := destination.Write(buffer[:n]); err != nil {
				return err
			}
			_, _ = hash.Write(buffer[:n])
		}
		if readErr != nil {
			if readErr != io.EOF {
				return readErr
			}
			break
		}
	}
	after, err := source.Stat()
	if err != nil {
		return err
	}
	_, current, err = entryTreePath(root, item.Path)
	if err != nil {
		return err
	}
	if written != item.Size || hex.EncodeToString(hash.Sum(nil)) != item.ContentRevision || !sameEntryInfo(item.info, after) || !sameEntryInfo(item.info, current) {
		return entryChangedError()
	}
	return destination.Sync()
}

func copyInspectedEntry(ctx context.Context, root string, entry projectEntry, newPath string) (string, error) {
	clean, destination, err := projectEntryPath(root, newPath, true)
	if err != nil {
		return "", err
	}
	parents, err := entryCopyParents(root, clean, entry)
	if err != nil {
		return "", err
	}
	if _, err := os.Lstat(destination); err == nil {
		return "", fail(http.StatusConflict, "同じ名前のファイルまたはフォルダーがすでにあります．")
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := checkEntryCopyParents(root, parents); err != nil {
		return "", err
	}
	stage, err := os.MkdirTemp(filepath.Dir(destination), ".local-tex-editor-copy-*")
	if err != nil {
		return "", err
	}
	stageRelative, err := filepath.Rel(root, stage)
	if err != nil {
		_ = os.Remove(stage)
		return "", err
	}
	stageRelative = filepath.ToSlash(stageRelative)
	stageInfo, err := os.Lstat(stage)
	if err != nil {
		_ = os.Remove(stage)
		return "", err
	}
	created := []entryCopyPath{{path: stageRelative, info: stageInfo, mode: 0700}}
	directories := map[string]os.FileInfo{stageRelative: stageInfo}
	defer func() { removeEntryCopy(root, created) }()
	items := append([]projectEntryItem{{Path: entry.Path, Directory: entry.Directory, Size: entry.Size, ContentRevision: entry.ContentRevision, info: entry.info}}, entry.Entries...)
	payload := filepath.Join(stage, "item")
	for _, item := range items {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if err := checkEntryCopyParents(root, parents); err != nil {
			return "", err
		}
		_, current, err := entryTreePath(root, item.Path)
		if err != nil {
			return "", err
		}
		if !sameEntryInfo(item.info, current) {
			return "", entryChangedError()
		}
		relative := stageRelative + "/item"
		if item.Path != entry.Path {
			relative += "/" + strings.TrimPrefix(item.Path, entry.Path+"/")
		}
		parent := filepath.ToSlash(filepath.Dir(filepath.FromSlash(relative)))
		if err := checkEntryCopyStage(root, stageRelative, parent, directories); err != nil {
			return "", err
		}
		path := filepath.Join(root, filepath.FromSlash(relative))
		var file *os.File
		if item.Directory {
			err = os.Mkdir(path, 0700)
		} else {
			file, err = os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		}
		if err != nil {
			return "", err
		}
		info, statErr := os.Lstat(path)
		if statErr != nil {
			if file != nil {
				_ = file.Close()
			}
			return "", statErr
		}
		created = append(created, entryCopyPath{path: relative, info: info, mode: item.info.Mode().Perm()})
		if item.Directory {
			directories[relative] = info
		}
		if file != nil {
			err = copyEntryFile(ctx, root, item, file)
			closeErr := file.Close()
			if err == nil {
				err = closeErr
			}
			if err != nil {
				return "", err
			}
		}
	}
	current, err := inspectProjectEntry(ctx, root, entry.Path)
	if err != nil {
		return "", err
	}
	if current.Revision != entry.Revision || !sameEntryInfo(entry.info, current.info) || len(current.Entries) != len(entry.Entries) {
		return "", entryChangedError()
	}
	for index, item := range entry.Entries {
		if item.Path != current.Entries[index].Path || !sameEntryInfo(item.info, current.Entries[index].info) {
			return "", entryChangedError()
		}
	}
	for index := len(created) - 1; index > 0; index-- {
		item := created[index]
		path, info, err := entryTreePath(root, item.path)
		if err != nil {
			return "", err
		}
		if !os.SameFile(item.info, info) {
			return "", entryChangedError()
		}
		if err := os.Chmod(path, item.mode); err != nil {
			return "", err
		}
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := checkEntryCopyParents(root, parents); err != nil {
		return "", err
	}
	if err := checkEntryCopyStage(root, stageRelative, stageRelative, directories); err != nil {
		return "", err
	}
	_, payloadInfo, err := entryTreePath(root, stageRelative+"/item")
	if err != nil {
		return "", err
	}
	if !os.SameFile(created[1].info, payloadInfo) {
		return "", entryChangedError()
	}
	if err := platform.MoveWithoutReplace(payload, destination); err != nil {
		if errors.Is(err, os.ErrExist) {
			err = fail(http.StatusConflict, "同じ名前のファイルまたはフォルダーがすでにあります．")
		}
		return "", err
	}
	return clean, nil
}

// The entry handler has checked the project and holds a.mu throughout the copy.
func (a *App) copyEntryLocked(w http.ResponseWriter, r *http.Request, path, newPath, expected string) {
	root := a.project.Root
	entry, err := inspectProjectEntry(r.Context(), root, path)
	if err != nil {
		writeError(w, err)
		return
	}
	writeReview := func(current projectEntry) {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": messages.ErrorText(messages.LanguageFromContext(r.Context()), entryChangedError()),
			"entry": current, "reviewRequired": true,
		})
	}
	if expected == "" || entry.Revision != expected {
		writeReview(entry)
		return
	}
	newPath, err = copyInspectedEntry(r.Context(), root, entry, newPath)
	if err != nil {
		var known *apiError
		if errors.As(err, &known) && known.status == http.StatusConflict {
			if current, inspectErr := inspectProjectEntry(r.Context(), root, path); inspectErr == nil && current.Revision != entry.Revision {
				writeReview(current)
				return
			}
		}
		writeError(w, messages.Errorf("コピーを作成できません: %w", err))
		return
	}
	a.noteSavedSourceLocked(newPath)
	if a.build != nil {
		a.build.result.SourceChanged = true
	}
	if a.lastPDFID != "" {
		a.lastPDFChanged = true
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"copied": true, "path": newPath, "directory": entry.Directory,
		"state": a.stateLocked(true, messages.LanguageFromContext(r.Context())),
	})
}
