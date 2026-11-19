package app

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

const maxImportedAsset = 8 << 20

type importedAsset struct {
	Path  string `json:"path"`
	Kind  string `json:"kind"`
	Bytes int    `json:"bytes"`
}

func importAssetType(data []byte, name string) (string, error) {
	if len(data) == 0 || len(data) > maxImportedAsset {
		return "", fail(http.StatusRequestEntityTooLarge, "画像は 8 MiB 以内にしてください．")
	}
	ext := strings.ToLower(filepath.Ext(name))
	if ext == ".pdf" {
		end := data
		if len(end) > 2048 {
			end = end[len(end)-2048:]
		}
		if !bytes.HasPrefix(data, []byte("%PDF-")) || !bytes.Contains(end, []byte("%%EOF")) {
			return "", fail(http.StatusUnsupportedMediaType, "PDF の内容を読み取れません．")
		}
		return "pdf", nil
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (format != "png" && format != "jpeg") || config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > 40_000_000 {
		return "", fail(http.StatusUnsupportedMediaType, "PNG または JPEG の画像を選んでください (最大 4000 万画素)．")
	}
	if (format == "png" && ext != ".png") || (format == "jpeg" && ext != ".jpg" && ext != ".jpeg") {
		return "", fail(http.StatusBadRequest, "画像の形式とファイル名の拡張子を合わせてください．")
	}
	return "image", nil
}

// makeImportDirectories walks one component at a time so a project link cannot
// redirect an image or a template file outside the selected directory.
func makeImportDirectories(root, relative string) error {
	if relative == "" || relative == "." {
		return nil
	}
	clean, err := cleanRelative(relative)
	if err != nil {
		return err
	}
	current := root
	for _, component := range strings.Split(clean, "/") {
		current = filepath.Join(current, component)
		if err := os.Mkdir(current, 0755); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		linked, err := platform.IsReparsePoint(current)
		if err != nil {
			return err
		}
		if linked || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fail(http.StatusForbidden, "画像やテンプレートの保存先には通常のフォルダーを選んでください．")
		}
	}
	return nil
}

func importAsset(root, relative string, data []byte) (importedAsset, error) {
	clean, err := cleanRelative(strings.TrimSpace(relative))
	if err != nil {
		return importedAsset{}, err
	}
	if strings.ContainsAny(clean, "{}%#&$^~") {
		return importedAsset{}, fail(http.StatusBadRequest, "画像の保存先には，文字，数字，空白，ハイフン，アンダースコアを使ってください．")
	}
	kind, err := importAssetType(data, clean)
	if err != nil {
		return importedAsset{}, err
	}
	if err := makeImportDirectories(root, filepath.ToSlash(filepath.Dir(clean))); err != nil {
		return importedAsset{}, err
	}
	ext := filepath.Ext(clean)
	base := strings.TrimSuffix(clean, ext)
	for attempt := 0; attempt < 1000; attempt++ {
		candidate := clean
		if attempt > 0 {
			candidate = fmt.Sprintf("%s-%d%s", base, attempt+1, ext)
		}
		path, err := safePath(root, candidate, true)
		if err != nil {
			return importedAsset{}, err
		}
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return importedAsset{}, err
		}
		_, writeErr := file.Write(data)
		if writeErr == nil {
			writeErr = file.Sync()
		}
		closeErr := file.Close()
		if writeErr != nil || closeErr != nil {
			_ = os.Remove(path)
			if writeErr != nil {
				return importedAsset{}, writeErr
			}
			return importedAsset{}, closeErr
		}
		return importedAsset{Path: candidate, Kind: kind, Bytes: len(data)}, nil
	}
	return importedAsset{}, fail(http.StatusConflict, "同じ名前の画像が多いため，別の名前を指定してください．")
}

func (a *App) assetImportHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var input struct {
		Path string `json:"path"`
		Data string `json:"data"`
	}
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	if len(input.Data) > base64.StdEncoding.EncodedLen(maxImportedAsset) {
		writeError(w, fail(http.StatusRequestEntityTooLarge, "画像は 8 MiB 以内にしてください．"))
		return
	}
	data, err := io.ReadAll(io.LimitReader(base64.NewDecoder(base64.StdEncoding, strings.NewReader(input.Data)), maxImportedAsset+1))
	if err != nil {
		writeError(w, fail(http.StatusBadRequest, "画像のデータを読み取れません．"))
		return
	}
	a.mu.Lock()
	err = a.checkProjectLocked(r.Header.Get("X-Project-Root"))
	var result importedAsset
	if err == nil && a.project == nil {
		err = fail(http.StatusBadRequest, "原稿フォルダーを開いてください．")
	}
	if err == nil {
		result, err = importAsset(a.project.Root, input.Path, data)
		if err == nil {
			a.noteSavedSourceLocked(result.Path)
			if files, directories, listErr := listProjectEntries(a.project.Root); listErr == nil {
				a.project.Files, a.project.Directories = files, directories
			}
		}
	}
	a.mu.Unlock()
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, result)
}
