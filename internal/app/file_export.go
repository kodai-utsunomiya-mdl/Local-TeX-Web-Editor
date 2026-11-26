package app

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

type fileSavePicker func(context.Context, string) (string, error)

type fileExportInput struct {
	Path       string  `json:"path"`
	BuildID    string  `json:"buildId"`
	Content    *string `json:"content,omitempty"`
	Revision   string  `json:"revision,omitempty"`
	LineEnding string  `json:"lineEnding,omitempty"`
}

type fileExportSource struct {
	name, path, root string
	reader           io.ReadSeeker
	file             *os.File
	info             os.FileInfo
	size             int64
}

func (source *fileExportSource) close() {
	if source.file != nil {
		_ = source.file.Close()
		source.file = nil
	}
}

func (source *fileExportSource) check() error {
	if source.file == nil {
		return nil
	}
	current, err := source.file.Stat()
	if err != nil {
		return err
	}
	if !sameEntryInfo(source.info, current) {
		return entryChangedError()
	}
	return nil
}

func (a *App) prepareFileExport(r *http.Request, input fileExportInput) (*fileExportSource, error) {
	if (input.Path == "") == (input.BuildID == "") || input.BuildID != "" && input.Content != nil {
		return nil, fail(http.StatusBadRequest, "ダウンロードまたは保存するファイルを 1 個選んでください．")
	}
	a.mu.Lock()
	err := a.checkProjectLocked(r.Header.Get("X-Project-Root"), input.BuildID != "")
	source := &fileExportSource{}
	if err == nil && a.project == nil {
		err = fail(http.StatusBadRequest, "原稿フォルダーを開いてください．")
	}
	if err == nil {
		source.root = a.project.Root
		if input.BuildID != "" {
			source.path = a.pdfVersions[input.BuildID]
			if input.BuildID == a.lastPDFID {
				source.path = a.lastPDF
			}
			for _, entry := range a.compiledPDFs {
				if entry.BuildID == input.BuildID {
					source.name = entry.Name
					if source.name == "" {
						source.name = strings.TrimSuffix(filepath.Base(entry.Main), filepath.Ext(entry.Main)) + ".pdf"
					}
					break
				}
			}
			if source.path == "" {
				err = fail(http.StatusGone, "この版の PDF はキャッシュから削除されました．最新の PDF を開き直してください．")
			}
			if source.name == "" {
				source.name = "document.pdf"
			}
		}
	}
	a.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if input.Path != "" {
		clean, path, err := projectEntryPath(source.root, input.Path, input.Content != nil)
		if err != nil {
			return nil, err
		}
		source.path, source.name = path, filepath.Base(clean)
		if input.Content != nil {
			if !isTextFile(clean) || len(*input.Content) > maxTextSize || !utf8.ValidString(*input.Content) || strings.ContainsRune(*input.Content, 0) {
				return nil, fail(http.StatusBadRequest, "保存するテキストは 8 MiB 以内の UTF-8 にしてください．")
			}
			old, err := readBytes(path)
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				return nil, err
			}
			text := strings.ReplaceAll(*input.Content, "\r\n", "\n")
			if input.LineEnding == "crlf" {
				text = strings.ReplaceAll(text, "\n", "\r\n")
			}
			data := []byte(text)
			if bytes.HasPrefix(old, []byte{0xef, 0xbb, 0xbf}) {
				data = append([]byte{0xef, 0xbb, 0xbf}, data...)
			}
			if len(data) > maxTextSize {
				return nil, fail(http.StatusRequestEntityTooLarge, "保存するファイルが 8 MiB を超えています．")
			}
			source.reader, source.size = bytes.NewReader(data), int64(len(data))
			return source, nil
		}
	}
	file, err := os.Open(source.path)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err == nil {
		var regular bool
		regular, err = platform.IsRegularFile(source.path, info)
		if err == nil && !regular {
			err = fail(http.StatusBadRequest, "通常のファイルを選んでください．")
		}
		if err == nil && input.Path != "" {
			var current os.FileInfo
			_, current, err = entryTreePath(source.root, filepath.ToSlash(input.Path))
			if err == nil && !sameEntryInfo(info, current) {
				err = entryChangedError()
			}
		}
	}
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	source.file, source.info, source.size = file, info, info.Size()
	source.reader = io.NewSectionReader(file, 0, info.Size())
	return source, nil
}

func (a *App) fileDownloadHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet, http.MethodHead, http.MethodPost) {
		return
	}
	input := fileExportInput{Path: r.URL.Query().Get("path"), BuildID: r.URL.Query().Get("build")}
	if r.Method == http.MethodPost {
		if err := readJSON(w, r, &input); err != nil {
			writeError(w, err)
			return
		}
	}
	source, err := a.prepareFileExport(r, input)
	if err != nil {
		writeError(w, err)
		return
	}
	defer source.close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": source.name}))
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	http.ServeContent(w, r, source.name, time.Time{}, source.reader)
}

func exportDestination(path string) (string, os.FileInfo, os.FileInfo, error) {
	if !filepath.IsAbs(path) {
		return "", nil, nil, fail(http.StatusBadRequest, "保存先の絶対パスを指定してください．")
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil {
		return "", nil, nil, err
	}
	destination := filepath.Join(parent, filepath.Base(path))
	parentInfo, err := os.Stat(parent)
	if err != nil {
		return "", nil, nil, err
	}
	if !parentInfo.IsDir() {
		return "", nil, nil, fail(http.StatusBadRequest, "保存先には通常のフォルダーを選んでください．")
	}
	info, err := os.Lstat(destination)
	if errors.Is(err, os.ErrNotExist) {
		return destination, parentInfo, nil, nil
	}
	if err != nil {
		return "", nil, nil, err
	}
	linked, err := platform.IsReparsePoint(destination)
	if err != nil {
		return "", nil, nil, err
	}
	regular, err := platform.IsRegularFile(destination, info)
	if err != nil {
		return "", nil, nil, err
	}
	if linked || !regular {
		return "", nil, nil, fail(http.StatusBadRequest, "保存先には通常のファイル名を選んでください．")
	}
	return destination, parentInfo, info, nil
}

func writeExport(ctx context.Context, source *fileExportSource, destination string, parent, previous os.FileInfo) error {
	temp, err := os.CreateTemp(filepath.Dir(destination), ".local-tex-editor-export-*")
	if err != nil {
		return err
	}
	name := temp.Name()
	defer func() {
		if err := os.Remove(name); errors.Is(err, os.ErrPermission) {
			if os.Chmod(name, 0600) == nil {
				_ = os.Remove(name)
			}
		}
	}()
	defer temp.Close()
	mode := os.FileMode(0644)
	if previous != nil {
		mode = previous.Mode().Perm()
	}
	buffer := make([]byte, 64<<10)
	var written int64
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, readErr := source.reader.Read(buffer)
		if n > 0 {
			if _, err := temp.Write(buffer[:n]); err != nil {
				return err
			}
			written += int64(n)
		}
		if readErr != nil {
			if readErr != io.EOF {
				return readErr
			}
			break
		}
	}
	if written != source.size {
		return entryChangedError()
	}
	if err := source.check(); err != nil {
		return err
	}
	if err := temp.Chmod(mode); err != nil {
		return err
	}
	if err := temp.Sync(); err != nil {
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	check := func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		checked, currentParent, current, err := exportDestination(destination)
		if err != nil || !samePath(checked, destination) || !os.SameFile(parent, currentParent) || (previous == nil) != (current == nil) || previous != nil && !sameEntryInfo(previous, current) {
			return fail(http.StatusConflict, "保存先が変更されました．名前を付けて保存をもう一度選び，保存先を確認してください．")
		}
		return nil
	}
	if previous == nil {
		if err := check(); err != nil {
			return err
		}
		return platform.MoveWithoutReplace(name, destination)
	}
	return platform.ReplaceFileChecked(name, destination, check)
}

func (a *App) fileSaveAsHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var input fileExportInput
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	source, err := a.prepareFileExport(r, input)
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
	if err := r.Context().Err(); err != nil {
		return
	}
	destination, parent, previous, err := exportDestination(selected)
	if err != nil {
		writeError(w, err)
		return
	}
	a.mu.Lock()
	if err := r.Context().Err(); err != nil {
		a.mu.Unlock()
		return
	}
	if a.project == nil || !samePath(a.project.Root, source.root) {
		a.mu.Unlock()
		writeError(w, fail(http.StatusConflict, "別の画面でプロジェクトが切り替わりました．編集中の内容を確認してから，この画面を開き直してください．"))
		return
	}
	var saved *FileDocument
	if input.Path != "" && samePath(source.path, destination) && input.Content != nil {
		var document FileDocument
		document, err = a.saveDocumentWithHistoryLocked(FileDocument{Path: input.Path, Content: *input.Content, Revision: input.Revision}, messages.LanguageFromContext(r.Context()))
		if err == nil {
			saved = &document
			a.noteSavedSourceLocked(document.Path)
		}
	}
	a.mu.Unlock()
	if err == nil && saved == nil && !samePath(source.path, destination) {
		err = writeExport(r.Context(), source, destination, parent, previous)
	}
	if err != nil {
		writeError(w, messages.Errorf("ファイルを保存できません: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Path     string        `json:"path"`
		Document *FileDocument `json:"document,omitempty"`
	}{Path: destination, Document: saved})
}
