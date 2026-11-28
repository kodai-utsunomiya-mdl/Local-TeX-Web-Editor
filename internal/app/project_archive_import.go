package app

import (
	"archive/zip"
	"context"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

type importedProjectArchive struct {
	Path string `json:"path"`
	Main string `json:"main"`
	Mode string `json:"mode"`
}

type projectArchiveUpload struct {
	file        *os.File
	size        int64
	archiveName string
	parent      string
	name        string
}

func (upload *projectArchiveUpload) close() {
	if upload.file != nil {
		name := upload.file.Name()
		_ = upload.file.Close()
		_ = os.Remove(name)
	}
}

type projectArchiveContextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (reader projectArchiveContextReader) Read(buffer []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	return reader.reader.Read(buffer)
}

func readProjectArchiveUpload(w http.ResponseWriter, r *http.Request, temporaryDirectory string) (upload projectArchiveUpload, result error) {
	defer func() {
		if result != nil {
			upload.close()
		}
	}()
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/form-data" {
		return upload, fail(http.StatusUnsupportedMediaType, "ZIP ファイルと保存先を送信してください．")
	}
	const metadataAllowance = 64 << 10
	if r.ContentLength > projectArchiveMaxSize+metadataAllowance {
		return upload, fail(http.StatusRequestEntityTooLarge, "読み込む ZIP は 512 MiB 以内にしてください．")
	}
	r.Body = http.MaxBytesReader(w, r.Body, projectArchiveMaxSize+metadataAllowance)
	reader, err := r.MultipartReader()
	if err != nil {
		return upload, fail(http.StatusBadRequest, "ZIP ファイルと保存先を読み取れませんでした．")
	}
	seen := make(map[string]bool)
	for {
		if err := r.Context().Err(); err != nil {
			return upload, err
		}
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				return upload, fail(http.StatusRequestEntityTooLarge, "読み込む ZIP は 512 MiB 以内にしてください．")
			}
			return upload, fail(http.StatusBadRequest, "ZIP ファイルと保存先を読み取れませんでした．")
		}
		field := part.FormName()
		if seen[field] || (field != "archive" && field != "parent" && field != "name") {
			return upload, fail(http.StatusBadRequest, "ZIP ファイルと保存先をそれぞれ 1 つ指定してください．")
		}
		seen[field] = true
		if field == "archive" {
			if part.FileName() == "" {
				return upload, fail(http.StatusBadRequest, "読み込む ZIP ファイルを選んでください．")
			}
			upload.archiveName = path.Base(strings.ReplaceAll(part.FileName(), `\`, "/"))
			upload.file, err = os.CreateTemp(temporaryDirectory, ".project-import-*.zip")
			if err != nil {
				return upload, err
			}
			upload.size, err = io.Copy(upload.file, io.LimitReader(projectArchiveContextReader{r.Context(), part}, projectArchiveMaxSize+1))
			var tooLarge *http.MaxBytesError
			if upload.size > projectArchiveMaxSize || errors.As(err, &tooLarge) {
				return upload, fail(http.StatusRequestEntityTooLarge, "読み込む ZIP は 512 MiB 以内にしてください．")
			}
			if err != nil {
				return upload, err
			}
		} else {
			if part.FileName() != "" {
				return upload, fail(http.StatusBadRequest, "ZIP ファイルと保存先をそれぞれ 1 つ指定してください．")
			}
			data, err := io.ReadAll(io.LimitReader(projectArchiveContextReader{r.Context(), part}, 4097))
			if err != nil {
				return upload, err
			}
			if len(data) > 4096 || !utf8.Valid(data) {
				return upload, fail(http.StatusBadRequest, "保存先のフォルダーと新しいプロジェクト名を確認してください．")
			}
			if field == "parent" {
				upload.parent = string(data)
			} else {
				upload.name = string(data)
			}
		}
		if err := part.Close(); err != nil {
			return upload, err
		}
	}
	if upload.file == nil || !seen["parent"] || !seen["name"] {
		return upload, fail(http.StatusBadRequest, "ZIP ファイル，保存先，新しいプロジェクト名を指定してください．")
	}
	return upload, nil
}

type projectArchiveImportEntry struct {
	file      *zip.File
	path      string
	directory bool
}

func projectArchiveImportPath(raw string, directory bool) (string, bool, error) {
	name := strings.ReplaceAll(raw, `\`, "/")
	if directory {
		name = strings.TrimSuffix(name, "/")
	}
	if name == "" || !utf8.ValidString(name) || strings.HasPrefix(name, "/") {
		return "", false, fail(http.StatusBadRequest, "ZIP 内に使用できないパスがあります: %s", raw)
	}
	parts := strings.Split(name, "/")
	ignored := false
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return "", false, fail(http.StatusBadRequest, "ZIP 内に使用できないパスがあります: %s", raw)
		}
		ignored = ignored || projectArchiveMetadata(part) || excludedDirectory(part)
	}
	if ignored {
		return name, true, nil
	}
	clean, err := cleanRelative(name)
	if err != nil {
		return "", false, err
	}
	for _, part := range parts {
		device := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
		superscriptDevice := false
		if strings.HasPrefix(device, "COM") || strings.HasPrefix(device, "LPT") {
			suffix := device[3:]
			superscriptDevice = suffix == "¹" || suffix == "²" || suffix == "³"
		}
		if device == "CONIN$" || device == "CONOUT$" || device == "CLOCK$" ||
			superscriptDevice {
			return "", false, fail(http.StatusBadRequest, "このファイル名は Windows が使用する名前です．")
		}
	}
	return clean, false, nil
}

func projectArchiveImportKey(name string) string {
	return strings.Map(func(character rune) rune {
		lowest := character
		for next := unicode.SimpleFold(character); next != character; next = unicode.SimpleFold(next) {
			if next < lowest {
				lowest = next
			}
		}
		return lowest
	}, name)
}

func inspectProjectArchive(reader *zip.Reader, archiveName, projectName string) ([]projectArchiveImportEntry, error) {
	if len(reader.File) > projectArchiveMaxEntries {
		return nil, fail(http.StatusRequestEntityTooLarge, "ZIP 内のファイルとフォルダーは合計 20,000 件以内にしてください．")
	}
	entries := make([]projectArchiveImportEntry, 0, len(reader.File))
	var expanded uint64
	files := 0
	for _, file := range reader.File {
		mode := file.Mode()
		directory := mode.IsDir() || strings.HasSuffix(file.Name, "/") || strings.HasSuffix(file.Name, `\`)
		name, ignored, err := projectArchiveImportPath(file.Name, directory)
		if err != nil {
			return nil, err
		}
		if ignored {
			continue
		}
		if mode&os.ModeType != 0 && mode&os.ModeType != os.ModeDir || file.ExternalAttrs&0x400 != 0 {
			return nil, fail(http.StatusBadRequest, "ZIP 内のリンクや特殊なファイルは読み込めません: %s", file.Name)
		}
		if file.Flags&1 != 0 {
			return nil, fail(http.StatusBadRequest, "暗号化された ZIP は読み込めません．パスワードを解除した ZIP を選んでください．")
		}
		if directory {
			if file.UncompressedSize64 != 0 {
				return nil, fail(http.StatusBadRequest, "ZIP 内のフォルダー情報が正しくありません: %s", file.Name)
			}
		} else {
			files++
			if files > projectArchiveMaxFiles {
				return nil, fail(http.StatusRequestEntityTooLarge, "ZIP 内のファイルは 10,000 件以内にしてください．")
			}
			if file.UncompressedSize64 > projectArchiveMaxFileSize {
				return nil, fail(http.StatusRequestEntityTooLarge, "展開後のファイルは 1 個あたり 128 MiB 以内にしてください: %s", file.Name)
			}
			expanded += file.UncompressedSize64
			if expanded > projectArchiveMaxSize {
				return nil, fail(http.StatusRequestEntityTooLarge, "ZIP を展開した内容は合計 512 MiB 以内にしてください．")
			}
		}
		entries = append(entries, projectArchiveImportEntry{file: file, path: name, directory: directory})
	}
	if len(entries) == 0 {
		return entries, nil
	}
	if err := validateProjectArchiveImportPaths(entries); err != nil {
		return nil, err
	}
	archiveBase := strings.TrimSuffix(archiveName, path.Ext(archiveName))
	wrapper := strings.SplitN(entries[0].path, "/", 2)[0]
	unwrap := strings.EqualFold(wrapper, archiveBase) || strings.EqualFold(wrapper, projectName)
	if unwrap {
		for _, entry := range entries {
			if !strings.HasPrefix(entry.path, wrapper+"/") && !(entry.directory && entry.path == wrapper) {
				unwrap = false
				break
			}
		}
	}
	if unwrap {
		withoutWrapper := entries[:0]
		for _, entry := range entries {
			if entry.directory && entry.path == wrapper {
				continue
			}
			entry.path = strings.TrimPrefix(entry.path, wrapper+"/")
			withoutWrapper = append(withoutWrapper, entry)
		}
		entries = withoutWrapper
	}
	return entries, nil
}

func validateProjectArchiveImportPaths(entries []projectArchiveImportEntry) error {
	type destination struct {
		name      string
		directory bool
		explicit  bool
		children  map[string]*destination
	}
	destinations := make(map[string]*destination)
	count := 0
	for _, entry := range entries {
		parts := strings.Split(entry.path, "/")
		level := destinations
		for index, name := range parts {
			key := projectArchiveImportKey(name)
			explicit := index == len(parts)-1
			directory := !explicit || entry.directory
			item, exists := level[key]
			if exists {
				if item.name != name || item.directory != directory || item.explicit && explicit {
					return fail(http.StatusBadRequest, "ZIP 内に重複する名前や大文字小文字だけが異なる名前があります: %s", entry.path)
				}
				item.explicit = explicit || item.explicit
			} else {
				item = &destination{name: name, directory: directory, explicit: explicit}
				level[key] = item
				count++
			}
			if count > projectArchiveMaxEntries {
				return fail(http.StatusRequestEntityTooLarge, "ZIP 内のファイルとフォルダーは合計 20,000 件以内にしてください．")
			}
			if !explicit {
				if item.children == nil {
					item.children = make(map[string]*destination)
				}
				level = item.children
			}
		}
	}
	return nil
}

func extractProjectArchive(ctx context.Context, archive io.ReaderAt, size int64, archiveName, parent, name string) (importedProjectArchive, error) {
	var result importedProjectArchive
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if size > projectArchiveMaxSize {
		return result, fail(http.StatusRequestEntityTooLarge, "読み込む ZIP は 512 MiB 以内にしてください．")
	}
	if size <= 0 {
		return result, fail(http.StatusBadRequest, "ZIP ファイルを読み取れません．正常な ZIP を選んでください．")
	}
	if !filepath.IsAbs(parent) {
		return result, fail(http.StatusBadRequest, "保存先のフォルダーを選んでください．")
	}
	parent, err := filepath.EvalSymlinks(filepath.Clean(parent))
	if err != nil {
		return result, err
	}
	info, err := os.Stat(parent)
	if err != nil || !info.IsDir() {
		return result, fail(http.StatusBadRequest, "保存先のフォルダーを選んでください．")
	}
	name = strings.TrimSpace(name)
	clean, ignored, err := projectArchiveImportPath(name, false)
	if err != nil || ignored || strings.Contains(clean, "/") {
		return result, fail(http.StatusBadRequest, "新しいプロジェクトのフォルダー名を入力してください．")
	}
	target := filepath.Join(parent, clean)
	if _, err := os.Lstat(target); err == nil {
		return result, fail(http.StatusConflict, "同じ名前の項目があります．新しいプロジェクト名を選んでください．")
	} else if !errors.Is(err, os.ErrNotExist) {
		return result, err
	}
	reader, err := zip.NewReader(archive, size)
	if err != nil {
		return result, fail(http.StatusBadRequest, "ZIP ファイルを読み取れません．正常な ZIP を選んでください．")
	}
	entries, err := inspectProjectArchive(reader, archiveName, clean)
	if err != nil {
		return result, err
	}
	stage, err := os.MkdirTemp(parent, ".local-tex-editor-project-import-*")
	if err != nil {
		return result, err
	}
	defer os.RemoveAll(stage)
	var expanded int64
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		destination := filepath.Join(stage, filepath.FromSlash(entry.path))
		if entry.directory {
			if err := os.MkdirAll(destination, 0755); err != nil {
				return result, err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0755); err != nil {
			return result, err
		}
		input, err := entry.file.Open()
		if err != nil {
			return result, fail(http.StatusBadRequest, "ZIP 内のファイルを読み取れません: %s", entry.path)
		}
		output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644|entry.file.Mode().Perm()&0111)
		if err != nil {
			_ = input.Close()
			return result, err
		}
		written, copyErr := io.Copy(output, io.LimitReader(projectArchiveContextReader{ctx, input}, projectArchiveMaxFileSize+1))
		inputErr, outputErr := input.Close(), output.Close()
		expanded += written
		if written > projectArchiveMaxFileSize || expanded > projectArchiveMaxSize {
			return result, fail(http.StatusRequestEntityTooLarge, "ZIP を展開した内容は合計 512 MiB 以内にしてください．")
		}
		if err := ctx.Err(); err != nil {
			return result, err
		}
		var fileError *os.PathError
		if errors.As(copyErr, &fileError) {
			return result, copyErr
		}
		if copyErr != nil || inputErr != nil || uint64(written) != entry.file.UncompressedSize64 {
			return result, fail(http.StatusBadRequest, "ZIP 内のファイルが破損しているか，最後まで読み取れませんでした: %s", entry.path)
		}
		if outputErr != nil {
			return result, outputErr
		}
	}
	files, _, _, err := listProjectEntries(stage)
	if err != nil {
		return result, err
	}
	result = importedProjectArchive{Path: target, Main: chooseMain(stage, files), Mode: defaultCompileMode(files)}
	if err := os.Chmod(stage, 0755); err != nil {
		return importedProjectArchive{}, err
	}
	if err := ctx.Err(); err != nil {
		return importedProjectArchive{}, err
	}
	if err := platform.MoveWithoutReplace(stage, target); err != nil {
		if _, existsErr := os.Lstat(target); existsErr == nil || errors.Is(err, os.ErrExist) {
			return importedProjectArchive{}, fail(http.StatusConflict, "同じ名前の項目があります．新しいプロジェクト名を選んでください．")
		}
		return importedProjectArchive{}, err
	}
	return result, nil
}

func (a *App) projectImportHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	upload, err := readProjectArchiveUpload(w, r, a.options.ConfigDir)
	if err != nil {
		writeError(w, err)
		return
	}
	defer upload.close()
	result, err := extractProjectArchive(r.Context(), upload.file, upload.size, upload.archiveName, upload.parent, upload.name)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, result)
}
