package app

import (
	"archive/zip"
	"compress/flate"
	"context"
	"errors"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

const (
	projectArchiveMaxSize     = 512 << 20
	projectArchiveMaxFileSize = 128 << 20
	projectArchiveMaxFiles    = 10000
	projectArchiveMaxEntries  = 20000
)

// Import and export both omit application state and metadata created by an OS.
// Other dotfiles, including .latexmkrc, remain part of the project.
func projectArchiveMetadata(name string) bool {
	name = strings.ToLower(name)
	if strings.HasPrefix(name, "._") {
		return true
	}
	switch name {
	case ".git", ".local-tex-editor", "__macosx", ".ds_store", "thumbs.db", "desktop.ini":
		return true
	default:
		return false
	}
}

type projectArchiveEntry struct {
	name string
	info os.FileInfo
}

type projectArchiveSnapshot struct {
	root    os.FileInfo
	entries []projectArchiveEntry
}

// Auxiliary files can be inputs: xr reads .aux, some bibliographies use .bbl,
// and an .ist can be a custom style. PDF figures must also travel with the
// manuscript. Only other known output suffixes with a neighbouring TeX source
// are omitted, so files such as data/results.log remain in the archive.
func projectArchiveGenerated(name string, texFiles map[string]bool) bool {
	lower := strings.ToLower(name)
	for _, suffix := range []string{
		".synctex.gz", ".synctex", ".run.xml", ".fdb_latexmk", ".fls",
		".log", ".toc", ".lof", ".lot", ".bcf", ".blg", ".nav", ".snm",
		".out", ".vrb", ".ind", ".ilg", ".glg", ".gls", ".glo", ".acn", ".acr", ".alg",
	} {
		if strings.HasSuffix(lower, suffix) && texFiles[projectArchiveImportKey(strings.TrimSuffix(lower, suffix)+".tex")] {
			return true
		}
	}
	return false
}

func projectArchiveEntryInfo(root, relative string) (os.FileInfo, error) {
	path, _, err := entryTreePath(root, relative)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	// File.Stat records the open handle's identity on Windows. Information
	// obtained only from a path may look up that identity after a replacement.
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	_, current, err := entryTreePath(root, relative)
	if err != nil || !sameEntryInfo(info, current) {
		return nil, entryChangedError()
	}
	return info, nil
}

func inspectProjectArchiveSources(ctx context.Context, root, temporary string) (projectArchiveSnapshot, error) {
	rootInfo, err := projectArchiveEntryInfo(root, "")
	if err != nil {
		return projectArchiveSnapshot{}, err
	}
	if !rootInfo.IsDir() {
		return projectArchiveSnapshot{}, fail(http.StatusBadRequest, "原稿フォルダーを開いてください．")
	}
	snapshot := projectArchiveSnapshot{root: rootInfo}
	var entries []projectArchiveEntry
	texFiles := make(map[string]bool)
	visited := 0
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if path == root || temporary != "" && samePath(path, temporary) {
			return nil
		}
		visited++
		if visited > 50000 {
			return fail(http.StatusRequestEntityTooLarge, "ZIP に含める項目が多すぎます．原稿を含むフォルダーを直接選んでください．")
		}
		if projectArchiveMetadata(entry.Name()) || entry.IsDir() && excludedDirectory(entry.Name()) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		linked, err := platform.IsReparsePoint(path)
		if err != nil {
			return err
		}
		if linked || entry.Type()&os.ModeSymlink != 0 {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if clean, ignored, err := projectArchiveImportPath(relative, entry.IsDir()); err != nil || ignored || clean != relative {
			return fail(http.StatusBadRequest, "ZIP に含めるファイル名を確認してください: %s", relative)
		}
		observed, err := entry.Info()
		if err != nil {
			return err
		}
		if !observed.IsDir() {
			regular, err := platform.IsRegularFile(path, observed)
			if err != nil {
				return err
			}
			// Opening a named pipe can wait for another process. Special files
			// must be skipped before acquiring a handle to the source.
			if !regular {
				return nil
			}
		}
		info, err := projectArchiveEntryInfo(root, relative)
		if err != nil {
			return err
		}
		if !info.IsDir() {
			regular, err := platform.IsRegularFile(path, info)
			if err != nil {
				return err
			}
			if !regular {
				return nil
			}
			if strings.EqualFold(filepath.Ext(relative), ".tex") {
				texFiles[projectArchiveImportKey(relative)] = true
			}
		}
		entries = append(entries, projectArchiveEntry{name: relative, info: info})
		return nil
	})
	if err != nil {
		return projectArchiveSnapshot{}, err
	}
	var total int64
	files := 0
	names := make(map[string]string)
	for _, entry := range entries {
		if !entry.info.IsDir() {
			if projectArchiveGenerated(entry.name, texFiles) {
				continue
			}
			if entry.info.Size() > projectArchiveMaxFileSize {
				return projectArchiveSnapshot{}, fail(http.StatusRequestEntityTooLarge, "ZIP に含める 1 ファイルは 128 MiB 以内にしてください: %s", entry.name)
			}
			total += entry.info.Size()
			files++
			if total > projectArchiveMaxSize || files > projectArchiveMaxFiles {
				return projectArchiveSnapshot{}, fail(http.StatusRequestEntityTooLarge, "ZIP に含めるファイルは合計 512 MiB，10,000 件以内にしてください．")
			}
		}
		key := projectArchiveImportKey(entry.name)
		if previous, exists := names[key]; exists {
			return projectArchiveSnapshot{}, fail(http.StatusBadRequest, "ZIP に含める名前が大文字小文字の違いで重複しています: %s / %s", previous, entry.name)
		}
		names[key] = entry.name
		snapshot.entries = append(snapshot.entries, entry)
		if len(snapshot.entries) > projectArchiveMaxEntries {
			return projectArchiveSnapshot{}, fail(http.StatusRequestEntityTooLarge, "ZIP に含めるファイルとフォルダーは合計 20,000 件以内にしてください．")
		}
	}
	return snapshot, nil
}

func sameProjectArchive(before, after projectArchiveSnapshot) bool {
	if !os.SameFile(before.root, after.root) || before.root.Mode() != after.root.Mode() || len(before.entries) != len(after.entries) {
		return false
	}
	for index, entry := range before.entries {
		current := after.entries[index]
		if entry.name != current.name {
			return false
		}
		if entry.info.IsDir() {
			// Changes inside excluded directories do not change the exported files.
			if !os.SameFile(entry.info, current.info) || entry.info.Mode() != current.info.Mode() {
				return false
			}
		} else if !sameEntryInfo(entry.info, current.info) {
			return false
		}
	}
	return true
}

type projectArchiveReader struct {
	ctx context.Context
	io.Reader
}

func (reader projectArchiveReader) Read(data []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	return reader.Reader.Read(data)
}

type projectArchiveWriter struct {
	file *os.File
	size int64
}

func (writer *projectArchiveWriter) Write(data []byte) (int, error) {
	if int64(len(data)) > projectArchiveMaxSize-writer.size {
		return 0, fail(http.StatusRequestEntityTooLarge, "作成する ZIP は 512 MiB 以内にしてください．")
	}
	n, err := writer.file.Write(data)
	writer.size += int64(n)
	return n, err
}

type projectArchiveSource struct{ *fileExportSource }

func (source *projectArchiveSource) close() {
	source.fileExportSource.close()
	_ = os.Remove(source.path)
}

func addProjectArchiveFile(ctx context.Context, archive *zip.Writer, root string, entry projectArchiveEntry, buffer []byte) error {
	path, current, err := entryTreePath(root, entry.name)
	if err != nil || !sameEntryInfo(entry.info, current) {
		return entryChangedError()
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !sameEntryInfo(entry.info, opened) {
		return entryChangedError()
	}
	header, err := zip.FileInfoHeader(entry.info)
	if err != nil {
		return err
	}
	header.Name, header.Method = entry.name, zip.Deflate
	header.SetMode(entry.info.Mode().Perm())
	destination, err := archive.CreateHeader(header)
	if err != nil {
		return err
	}
	written, err := io.CopyBuffer(destination, projectArchiveReader{ctx, io.LimitReader(file, entry.info.Size()+1)}, buffer)
	if err != nil {
		return err
	}
	after, err := file.Stat()
	if err != nil || written != entry.info.Size() || !sameEntryInfo(entry.info, after) {
		return entryChangedError()
	}
	_, current, err = entryTreePath(root, entry.name)
	if err != nil || !sameEntryInfo(entry.info, current) {
		return entryChangedError()
	}
	return nil
}

func createProjectArchive(ctx context.Context, root string, snapshot projectArchiveSnapshot) (_ *projectArchiveSource, resultErr error) {
	file, err := os.CreateTemp("", "local-tex-editor-project-*.zip")
	if err != nil {
		return nil, err
	}
	defer func() {
		if resultErr != nil {
			_ = file.Close()
			_ = os.Remove(file.Name())
		}
	}()
	archive := zip.NewWriter(&projectArchiveWriter{file: file})
	archive.RegisterCompressor(zip.Deflate, func(writer io.Writer) (io.WriteCloser, error) {
		return flate.NewWriter(writer, flate.BestSpeed)
	})
	buffer := make([]byte, 64<<10)
	for _, entry := range snapshot.entries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if entry.info.IsDir() {
			header := &zip.FileHeader{Name: entry.name + "/", Method: zip.Store, Modified: entry.info.ModTime()}
			header.SetMode(os.ModeDir | entry.info.Mode().Perm())
			if _, err := archive.CreateHeader(header); err != nil {
				return nil, err
			}
			continue
		}
		if err := addProjectArchiveFile(ctx, archive, root, entry, buffer); err != nil {
			return nil, err
		}
	}
	if err := archive.Close(); err != nil {
		return nil, err
	}
	current, err := inspectProjectArchiveSources(ctx, root, file.Name())
	if err != nil || !sameProjectArchive(snapshot, current) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return nil, entryChangedError()
	}
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	name := filepath.Base(root)
	if name == "." || name == string(filepath.Separator) || name == "" {
		name = "project"
	}
	return &projectArchiveSource{&fileExportSource{
		name: name + ".zip", path: file.Name(), root: root,
		file: file, info: info, size: info.Size(), reader: io.NewSectionReader(file, 0, info.Size()),
	}}, nil
}

func (a *App) prepareProjectArchive(r *http.Request) (*projectArchiveSource, error) {
	if r.Header.Get("X-Project-Root") == "" {
		return nil, fail(http.StatusBadRequest, "ZIP にするプロジェクトを開いてから，もう一度操作してください．")
	}
	a.mu.Lock()
	err := a.checkProjectLocked(r.Header.Get("X-Project-Root"))
	project := a.project
	if err == nil && project == nil {
		err = fail(http.StatusBadRequest, "原稿フォルダーを開いてください．")
	}
	var root string
	if project != nil {
		root = project.Root
	}
	a.mu.Unlock()
	if err != nil {
		return nil, err
	}
	snapshot, err := inspectProjectArchiveSources(r.Context(), root, "")
	if err != nil {
		return nil, err
	}
	source, err := createProjectArchive(r.Context(), root, snapshot)
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	current := a.project == project
	a.mu.Unlock()
	if !current {
		source.close()
		return nil, fail(http.StatusConflict, "別の画面でプロジェクトが切り替わりました．編集中の内容を確認してから，この画面を開き直してください．")
	}
	return source, nil
}

func (a *App) projectDownloadHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var input struct{}
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	source, err := a.prepareProjectArchive(r)
	if err != nil {
		writeError(w, err)
		return
	}
	defer source.close()
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": source.name}))
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	http.ServeContent(w, r, source.name, time.Time{}, source.reader)
}

func (a *App) projectSaveAsHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var input struct{}
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	source, err := a.prepareProjectArchive(r)
	if err != nil {
		writeError(w, err)
		return
	}
	defer source.close()
	a.mu.Lock()
	picker := a.saveFilePicker
	a.mu.Unlock()
	if picker == nil {
		picker = platform.PickSaveFile
	}
	selected, err := picker(r.Context(), source.name)
	if err != nil {
		if !errors.Is(err, context.Canceled) {
			writeError(w, err)
		}
		return
	}
	if selected == "" {
		writeJSON(w, http.StatusOK, map[string]bool{"cancelled": true})
		return
	}
	if !strings.EqualFold(filepath.Ext(selected), ".zip") || samePath(selected, source.path) {
		writeError(w, fail(http.StatusBadRequest, "ZIP の保存先には .zip ファイル名を指定してください．"))
		return
	}
	destination, parent, previous, err := exportDestination(selected)
	if err != nil {
		writeError(w, err)
		return
	}
	a.mu.Lock()
	err = a.checkProjectLocked(r.Header.Get("X-Project-Root"))
	a.mu.Unlock()
	if err == nil {
		err = writeExport(r.Context(), source.fileExportSource, destination, parent, previous)
	}
	if err != nil {
		writeError(w, messages.Errorf("プロジェクトの ZIP を保存できません: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": destination})
}
