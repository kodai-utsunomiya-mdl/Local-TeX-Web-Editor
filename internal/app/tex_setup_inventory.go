package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

const managedTeXInventory = ".local-tex-editor-files.json"
const maxTeXSetupFiles = 2000000

type managedTeXFiles struct {
	Format int      `json:"format"`
	ID     string   `json:"id"`
	Paths  []string `json:"paths"`
}

func readManagedTeXFiles(record managedTeXInstallation) (map[string]bool, error) {
	path := filepath.Join(record.Directory, managedTeXInventory)
	if _, err := os.Lstat(path); err != nil {
		return nil, err
	}
	data, err := readCacheFile(path, 256<<20)
	if err != nil {
		return nil, messages.Errorf("導入時のファイル一覧を読み取れません．TeX の場所を確認してください: %w", err)
	}
	var value managedTeXFiles
	if json.Unmarshal(data, &value) != nil || value.Format != 1 || value.ID != record.ID || len(value.Paths) > maxTeXSetupFiles {
		return nil, messages.Errorf("導入時のファイル一覧と TeX の記録が一致しません．")
	}
	paths := map[string]bool{managedTeXInventory: true, managedTeXMarker: true}
	for _, path := range value.Paths {
		if !filepath.IsLocal(filepath.FromSlash(path)) || strings.Contains(path, "\\") {
			return nil, messages.Errorf("導入時のファイル一覧と TeX の記録が一致しません．")
		}
		paths[path] = true
	}
	return paths, nil
}

func managedTeXPaths(ctx context.Context, root string) ([]string, error) {
	paths := []string{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if path == root {
			return nil
		}
		if len(paths) >= maxTeXSetupFiles {
			return messages.Errorf("TeX 環境の項目が多いため，フォルダーの内容を確認してください．")
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		paths = append(paths, filepath.ToSlash(relative))
		linked, err := platform.IsReparsePoint(path)
		if err != nil {
			return err
		}
		if linked && entry.IsDir() {
			return filepath.SkipDir
		}
		return nil
	})
	return paths, err
}

func unknownManagedTeXFiles(ctx context.Context, record managedTeXInstallation) ([]string, error) {
	known, err := readManagedTeXFiles(record)
	if err != nil {
		return nil, err
	}
	paths, err := managedTeXPaths(ctx, record.Directory)
	if err != nil {
		return nil, err
	}
	unknown := []string{}
	for _, path := range paths {
		if !known[path] && !generatedTeXCacheFile(record.Directory, path) {
			unknown = append(unknown, path)
		}
	}
	return unknown, nil
}

func generatedTeXCacheFile(root, relative string) bool {
	if !strings.HasPrefix(relative, "texmf-var/luatex-cache/") && !strings.HasPrefix(relative, "texmf-var/fonts/") {
		return false
	}
	info, err := os.Lstat(filepath.Join(root, filepath.FromSlash(relative)))
	if err != nil || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	if info.IsDir() {
		return true
	}
	switch strings.ToLower(filepath.Ext(relative)) {
	case ".lua", ".luc", ".tma", ".tmc", ".gz", ".tfm", ".pk", ".gf", ".mf", ".log":
		return true
	}
	return false
}

func writeManagedTeXFiles(ctx context.Context, record managedTeXInstallation, excluded []string) error {
	if err := validateManagedTeX(record); err != nil {
		return err
	}
	paths, err := managedTeXPaths(ctx, record.Directory)
	if err != nil {
		return err
	}
	previous, previousErr := readManagedTeXFiles(record)
	if previousErr != nil && !errors.Is(previousErr, os.ErrNotExist) {
		return previousErr
	}
	var packaged map[string]bool
	if previousErr == nil {
		packaged, err = externalTeXKnownFiles(ctx, managedTeXEnvironment(record))
		if err != nil {
			return err
		}
	}
	known := paths[:0]
	for _, path := range paths {
		if path == managedTeXInventory {
			continue
		}
		include := true
		if previousErr == nil && !previous[path] && !packaged[path] {
			include = false
		}
		for _, unknown := range excluded {
			if path == unknown || strings.HasPrefix(path, unknown+"/") {
				include = false
				break
			}
		}
		if include {
			known = append(known, path)
		}
	}
	sort.Strings(known)
	data, err := json.Marshal(managedTeXFiles{Format: 1, ID: record.ID, Paths: known})
	if err != nil {
		return err
	}
	return writeAtomicChecked(filepath.Join(record.Directory, managedTeXInventory), append(data, '\n'), 0600, func() error { return validateManagedTeX(record) })
}

type texSetupTreeEntry struct {
	path, content, link string
	directory           bool
	info                os.FileInfo
}

type texSetupDeletionInspection struct {
	Directory      string         `json:"directory"`
	Bin            string         `json:"bin"`
	Revision       string         `json:"revision"`
	Confirmation   string         `json:"confirmation"`
	FileCount      int            `json:"fileCount"`
	DirectoryCount int            `json:"directoryCount"`
	Size           int64          `json:"size"`
	UnknownFiles   []string       `json:"unknownFiles"`
	CanDelete      bool           `json:"canDelete"`
	Environment    TeXEnvironment `json:"environment"`
	record         managedTeXInstallation
	entries        []texSetupTreeEntry
	rootInfo       os.FileInfo
}

func inspectTeXSetupDeletion(ctx context.Context, record managedTeXInstallation) (texSetupDeletionInspection, error) {
	if err := validateManagedTeX(record); err != nil {
		return texSetupDeletionInspection{}, err
	}
	known, err := readManagedTeXFiles(record)
	if err != nil {
		return texSetupDeletionInspection{}, err
	}
	result, err := inspectTeXSetupTree(ctx, managedTeXEnvironment(record), known)
	result.record = record
	if err != nil {
		return result, err
	}
	if err := validateManagedTeX(record); err != nil {
		return result, err
	}
	result.CanDelete = len(result.UnknownFiles) == 0
	return result, nil
}

func inspectTeXSetupTree(ctx context.Context, environment TeXEnvironment, known map[string]bool) (texSetupDeletionInspection, error) {
	root := environment.Directory
	result := texSetupDeletionInspection{Directory: root, Bin: environment.Bin, Environment: environment, Confirmation: filepath.Base(root), UnknownFiles: []string{}}
	var err error
	_, result.rootInfo, err = entryTreePath(root, "")
	if err != nil {
		return result, err
	}
	hash := sha256.New()
	fmt.Fprintf(hash, "%s\x00%s\x00", root, environment.Bin)
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if path == root {
			return nil
		}
		if len(result.entries) >= maxTeXSetupFiles {
			return messages.Errorf("TeX 環境の項目が多いため，フォルダーの内容を確認してください．")
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		parent := filepath.ToSlash(filepath.Dir(filepath.FromSlash(relative)))
		if parent == "." {
			parent = ""
		}
		if _, _, err := entryTreePath(root, parent); err != nil {
			return err
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		item := texSetupTreeEntry{path: relative, directory: info.IsDir(), info: info}
		linked, err := platform.IsReparsePoint(path)
		if err != nil {
			return err
		}
		if linked || info.Mode()&os.ModeSymlink != 0 {
			item.link, err = os.Readlink(path)
			if err != nil {
				return err
			}
			item.directory, item.content = false, "link:"+item.link
		} else if !info.IsDir() {
			regular, err := platform.IsRegularFile(path, info)
			if err != nil || !regular {
				return messages.Errorf("TeX 環境に通常のファイルではない項目があります: %s", relative)
			}
			item.content, err = entryContentRevision(ctx, path, info)
			if err != nil {
				return err
			}
		}
		if item.directory {
			result.DirectoryCount++
		} else {
			result.FileCount++
			result.Size += info.Size()
		}
		if known != nil && !known[relative] && !(environment.Managed && generatedTeXCacheFile(root, relative)) {
			result.UnknownFiles = append(result.UnknownFiles, relative)
		}
		result.entries = append(result.entries, item)
		if item.directory {
			// Checking write access can change a directory's time without changing
			// its contents. Child paths and file revisions describe the deletion.
			fmt.Fprintf(hash, "%s\x00%d\x00directory\x00", relative, info.Mode())
		} else {
			fmt.Fprintf(hash, "%s\x00%d\x00%d\x00%d\x00%s\x00", relative, info.Mode(), info.Size(), info.ModTime().UnixNano(), item.content)
		}
		if linked && entry.IsDir() {
			return filepath.SkipDir
		}
		return nil
	})
	if err != nil {
		return result, err
	}
	_, current, err := entryTreePath(root, "")
	if err != nil || !sameEntryInfo(result.rootInfo, current) {
		return result, entryChangedError()
	}
	result.Revision = hex.EncodeToString(hash.Sum(nil))
	result.CanDelete = len(result.UnknownFiles) == 0
	return result, nil
}

func externalTeXKnownFiles(ctx context.Context, environment TeXEnvironment) (map[string]bool, error) {
	data, err := readCacheFile(filepath.Join(environment.Directory, "tlpkg", "texlive.tlpdb"), 64<<20)
	if err != nil {
		return nil, err
	}
	known := make(map[string]bool)
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, " ") {
			continue
		}
		path := strings.TrimSpace(line)
		if !filepath.IsLocal(filepath.FromSlash(path)) || strings.Contains(path, "\\") {
			continue
		}
		for path != "." {
			known[path] = true
			path = filepath.ToSlash(filepath.Dir(filepath.FromSlash(path)))
		}
	}
	for _, path := range []string{".tinytex", "LICENSE.CTAN", "LICENSE.TL", "release-texlive.txt", "texmf.cnf", "texmfcnf.lua", "texlive.profile", "install-tl.log", "install-tl", "tl-tray-menu.exe", "tlpkg", "texmf-var", "texmf-config", "texmf-local", "texmf-dist", "bin"} {
		known[path] = true
	}
	paths, err := managedTeXPaths(ctx, environment.Directory)
	if err != nil {
		return nil, err
	}
	for _, path := range paths {
		if (strings.HasPrefix(path, "tlpkg/") || strings.HasPrefix(path, "texmf-var/") || strings.HasPrefix(path, "texmf-config/")) && !unrecordedTeXDocument(path) || path == "texmf-dist/ls-R" || path == "texmf-local/ls-R" {
			known[path] = true
		}
		if strings.HasPrefix(path, "texmf-local/") {
			if info, err := os.Lstat(filepath.Join(environment.Directory, filepath.FromSlash(path))); err == nil && info.IsDir() {
				known[path] = true
			}
		}
	}
	return known, nil
}

func unrecordedTeXDocument(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".tex", ".bib", ".md", ".markdown", ".txt", ".rst", ".org", ".doc", ".docx", ".odt", ".pdf", ".png", ".jpg", ".jpeg", ".svg", ".webp", ".tif", ".tiff", ".gif", ".bmp", ".eps", ".ps", ".csv", ".xls", ".xlsx", ".ods", ".ppt", ".pptx", ".odp", ".ipynb", ".rmd", ".qmd", ".lyx", ".typ":
		return true
	}
	return false
}

func externalTeXSystemFiles(ctx context.Context, root string) (map[string]bool, error) {
	paths, err := managedTeXPaths(ctx, root)
	if err != nil {
		return nil, err
	}
	known := make(map[string]bool, len(paths))
	for _, path := range paths {
		if !unrecordedTeXDocument(path) {
			known[path] = true
			continue
		}
		if info, err := os.Lstat(filepath.Join(root, filepath.FromSlash(path))); err == nil && info.IsDir() {
			known[path] = true
		}
	}
	return known, nil
}

func inspectExternalTeXDeletion(ctx context.Context, environment TeXEnvironment) (texSetupDeletionInspection, error) {
	current, err := validateExternalTeXEnvironment(ctx, environment)
	if err != nil {
		return texSetupDeletionInspection{}, err
	}
	known, err := externalTeXKnownFiles(ctx, current)
	if err != nil {
		return texSetupDeletionInspection{}, err
	}
	result, err := inspectTeXSetupTree(ctx, current, known)
	if err != nil {
		return result, err
	}
	hash := sha256.New()
	encoded, err := json.Marshal(current)
	if err != nil {
		return result, err
	}
	_, _ = hash.Write(encoded)
	fmt.Fprint(hash, result.Revision)
	if current.Uninstaller != "" {
		for index, root := range current.SystemDirectories {
			if samePath(root, current.Directory) || pathInExternalTeX(current.Directory, root) {
				continue
			}
			covered := false
			for otherIndex, other := range current.SystemDirectories {
				if index != otherIndex && pathInExternalTeX(other, root) {
					covered = true
					break
				}
			}
			if covered {
				continue
			}
			if _, err := os.Lstat(root); os.IsNotExist(err) {
				fmt.Fprintf(hash, "\x00%s:missing", root)
				continue
			}
			partEnvironment := current
			partEnvironment.Directory = root
			known, err := externalTeXSystemFiles(ctx, root)
			if err != nil {
				return result, err
			}
			part, err := inspectTeXSetupTree(ctx, partEnvironment, known)
			if err != nil {
				return result, err
			}
			fmt.Fprint(hash, part.Revision)
			result.FileCount += part.FileCount
			result.DirectoryCount += part.DirectoryCount + 1
			result.Size += part.Size
			for _, path := range part.UnknownFiles {
				result.UnknownFiles = append(result.UnknownFiles, filepath.Join(root, filepath.FromSlash(path)))
			}
		}
	}
	result.Revision = hex.EncodeToString(hash.Sum(nil))
	result.CanDelete = current.CanUninstall && len(result.UnknownFiles) == 0
	return result, nil
}

func removeInspectedTeXSetup(inspection texSetupDeletionInspection) error {
	root := inspection.Directory
	entries := append([]texSetupTreeEntry{}, inspection.entries...)
	// Keep the ownership records until all other children have been removed.
	sort.Slice(entries, func(i, j int) bool {
		left, right := entries[i], entries[j]
		leftRecord := left.path == managedTeXInventory || left.path == managedTeXMarker
		rightRecord := right.path == managedTeXInventory || right.path == managedTeXMarker
		if leftRecord != rightRecord {
			return !leftRecord
		}
		return left.path > right.path
	})
	for _, item := range entries {
		_, rootInfo, err := entryTreePath(root, "")
		if err != nil || !os.SameFile(inspection.rootInfo, rootInfo) {
			return entryChangedError()
		}
		parent := filepath.ToSlash(filepath.Dir(filepath.FromSlash(item.path)))
		if parent == "." {
			parent = ""
		}
		if _, _, err := entryTreePath(root, parent); err != nil {
			return err
		}
		path := filepath.Join(root, filepath.FromSlash(item.path))
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if !os.SameFile(item.info, info) || item.info.Mode() != info.Mode() {
			return entryChangedError()
		}
		if item.link != "" {
			link, err := os.Readlink(path)
			if err != nil || link != item.link {
				return entryChangedError()
			}
		} else if item.directory {
			children, err := os.ReadDir(path)
			if err != nil {
				return err
			}
			if len(children) != 0 {
				return entryChangedError()
			}
		} else {
			content, err := entryContentRevision(context.Background(), path, item.info)
			if err != nil {
				return err
			}
			if content != item.content {
				return entryChangedError()
			}
		}
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	_, info, err := entryTreePath(root, "")
	if err != nil || !os.SameFile(inspection.rootInfo, info) {
		return entryChangedError()
	}
	if err := os.Remove(root); err != nil {
		return err
	}
	// A user may have added a sibling to TinyTeX. os.Remove leaves it in place.
	if err := os.Remove(filepath.Dir(root)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return nil
}
