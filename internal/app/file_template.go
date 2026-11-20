package app

import (
	"net/http"
	"path/filepath"
	"sort"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
)

type fileTemplateEntry struct {
	Path  string `json:"path"`
	Name  string `json:"name"`
	Bytes int    `json:"bytes"`
}

func fileTemplateText(item templateContents, path string) (FileDocument, error) {
	clean, err := cleanRelative(path)
	if err != nil {
		return FileDocument{}, err
	}
	if clean != path {
		return FileDocument{}, fail(http.StatusBadRequest, "このパスは開けません．")
	}
	data, exists := item.Files[path]
	if !exists {
		return FileDocument{}, fail(http.StatusNotFound, "テンプレート内に選んだファイルがありません．")
	}
	if !isTextFile(path) {
		return FileDocument{}, fail(http.StatusUnsupportedMediaType, "この種類のファイルはテキストとして編集できません．")
	}
	if len(data) > maxTextSize {
		return FileDocument{}, fail(http.StatusRequestEntityTooLarge, "このテキストは 8 MiB を超えているため，エディタで開けません．")
	}
	return documentFromBytes(path, data)
}

func (a *App) fileTemplateHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	a.templateMu.Lock()
	defer a.templateMu.Unlock()
	if err := r.Context().Err(); err != nil {
		writeError(w, err)
		return
	}
	id := r.URL.Query().Get("id")
	item, err := a.readTemplateLocked(id, messages.LanguageFromContext(r.Context()))
	if err != nil {
		writeError(w, err)
		return
	}
	if r.URL.Query().Has("path") {
		document, err := fileTemplateText(item, r.URL.Query().Get("path"))
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"id": id, "path": document.Path, "name": filepath.Base(filepath.FromSlash(document.Path)),
			"content": document.Content, "lineEnding": document.LineEnding,
		})
		return
	}
	files := make([]fileTemplateEntry, 0, len(item.Files))
	for path, data := range item.Files {
		if _, err := fileTemplateText(item, path); err == nil {
			files = append(files, fileTemplateEntry{Path: path, Name: filepath.Base(filepath.FromSlash(path)), Bytes: len(data)})
		}
	}
	sort.Slice(files, func(i, j int) bool {
		if files[i].Path == item.Main || files[j].Path == item.Main {
			return files[i].Path == item.Main
		}
		return files[i].Path < files[j].Path
	})
	writeJSON(w, http.StatusOK, map[string]any{"template": item.projectTemplate, "files": files})
}
