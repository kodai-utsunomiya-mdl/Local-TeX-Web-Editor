package app

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

const (
	maxTemplateFiles = 200
	maxTemplateBytes = 32 << 20
	maxUserTemplates = 20
	maxTemplatesDisk = 128 << 20
)

type projectTemplate struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Main        string `json:"main"`
	Mode        string `json:"mode"`
	Builtin     bool   `json:"builtin"`
	FileCount   int    `json:"fileCount"`
	Bytes       int    `json:"bytes"`
}

type templateContents struct {
	projectTemplate
	Files map[string][]byte `json:"-"`
}

func builtinTemplates(language string) []templateContents {
	entry := func(id, name, englishName, description, englishDescription, main string, files map[string]string) templateContents {
		result := templateContents{projectTemplate: projectTemplate{ID: id, Name: name, Description: description, Main: main, Mode: defaultCompileMode, Builtin: true}, Files: map[string][]byte{}}
		if language == "en" {
			result.Name, result.Description = englishName, englishDescription
		}
		for path, content := range files {
			result.Files[path] = []byte(content)
			result.Bytes += len(content)
		}
		result.FileCount = len(result.Files)
		return result
	}
	return []templateContents{
		entry("builtin-japanese", "日本語の文書", "Japanese document", "LuaLaTeX と ltjsarticle を使う短い文書です．TeX Live の日本語用パッケージが必要です．", "A short LuaLaTeX document using ltjsarticle. Install the Japanese language packages in TeX Live.", "main.tex", map[string]string{
			"latexmkrc": "$pdf_mode = 4; # LuaLaTeX\n",
			"main.tex":  "\\documentclass[a4paper,11pt]{ltjsarticle}\n\\usepackage{graphicx}\n\\usepackage{amsmath}\n\\title{文書の題名}\n\\author{著者}\n\\date{\\today}\n\n\\begin{document}\n\\maketitle\n\\section{はじめに}\nここから本文を書き始めます．\n\n\\end{document}\n",
		}),
		entry("builtin-article", "英語の文書", "English article", "pdfLaTeX を使う article の文書です．", "An article document compiled with pdfLaTeX.", "main.tex", map[string]string{
			"main.tex": "\\documentclass[11pt]{article}\n\\usepackage[T1]{fontenc}\n\\usepackage{graphicx}\n\\usepackage{amsmath}\n\\title{Article title}\n\\author{Author}\n\\date{\\today}\n\n\\begin{document}\n\\maketitle\n\\begin{abstract}\nWrite the abstract here.\n\\end{abstract}\n\n\\section{Introduction}\nStart writing here.\n\n\\end{document}\n",
		}),
		entry("builtin-slides", "Beamer のスライド", "Beamer slides", "pdfLaTeX で作る英語のスライドです．TeX Live の beamer が必要です．", "English slides compiled with pdfLaTeX. The beamer package is required.", "main.tex", map[string]string{
			"main.tex": "\\documentclass{beamer}\n\\usepackage[T1]{fontenc}\n\\title{Presentation title}\n\\author{Author}\n\\date{\\today}\n\n\\begin{document}\n\\begin{frame}\n\\titlepage\n\\end{frame}\n\n\\begin{frame}{First slide}\n\\begin{itemize}\n\\item Start writing here.\n\\end{itemize}\n\\end{frame}\n\\end{document}\n",
		}),
		entry("builtin-markdown", "Markdown のメモ", "Markdown notes", "見出し，チェック項目，表を含むメモです．TeX Live を使わずに編集できます．", "Notes with headings, a checklist, and a table. Editing does not require TeX Live.", "", map[string]string{
			"notes.md": "# Notes\n\n## Tasks\n\n- [ ] First task\n- [ ] Second task\n\n## Notes\n\nWrite here.\n\n| Item | Details |\n| --- | --- |\n| Example | Details |\n",
		}),
	}
}

func templateIDValid(id string) bool {
	if len(id) != 32 {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil && id == strings.ToLower(id)
}

func templateName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" || !utf8.ValidString(name) || utf8.RuneCountInString(name) > 80 || strings.ContainsAny(name, "\r\n\x00") {
		return "", fail(http.StatusBadRequest, "テンプレートの名前は 1〜80 文字で入力してください．")
	}
	return name, nil
}

func (a *App) templateDirectory() (string, error) {
	path := filepath.Join(a.options.ConfigDir, "templates")
	if err := os.Mkdir(path, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return "", err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	linked, err := platform.IsReparsePoint(path)
	if err != nil {
		return "", err
	}
	if linked || !info.IsDir() {
		return "", fail(http.StatusForbidden, "テンプレートの保存先が通常のフォルダーではありません．")
	}
	return path, nil
}

func (a *App) readTemplateLocked(id, language string) (templateContents, error) {
	return a.readTemplateArchiveLocked(id, language, false)
}

func (a *App) readTemplateArchiveLocked(id, language string, metadataOnly bool) (templateContents, error) {
	for _, item := range builtinTemplates(language) {
		if item.ID == id {
			return item, nil
		}
	}
	if !templateIDValid(id) {
		return templateContents{}, fail(http.StatusNotFound, "テンプレートが見つかりません．")
	}
	dir, err := a.templateDirectory()
	if err != nil {
		return templateContents{}, err
	}
	path, err := safePath(dir, id+".zip", false)
	if err != nil {
		return templateContents{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		return templateContents{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return templateContents{}, err
	}
	if info.Size() > maxTemplateBytes+(1<<20) {
		return templateContents{}, fail(http.StatusRequestEntityTooLarge, "テンプレートのファイルが大きすぎます．")
	}
	reader, err := zip.NewReader(file, info.Size())
	if err != nil {
		return templateContents{}, err
	}
	return decodeTemplate(reader, id, metadataOnly)
}

func decodeTemplate(reader *zip.Reader, id string, metadataOnly bool) (templateContents, error) {
	result := templateContents{Files: map[string][]byte{}}
	if len(reader.File) > maxTemplateFiles+1 {
		return result, fail(http.StatusBadRequest, "テンプレートには 200 個までのファイルを登録できます．")
	}
	seen := map[string]bool{}
	manifest := false
	total := uint64(0)
	for _, file := range reader.File {
		if file.Mode()&os.ModeSymlink != 0 || file.FileInfo().IsDir() {
			return result, fail(http.StatusBadRequest, "テンプレートに通常のファイル以外が含まれています．")
		}
		name := file.Name
		if seen[strings.ToLower(name)] {
			return result, fail(http.StatusBadRequest, "テンプレート内のファイル名が重複しています．")
		}
		seen[strings.ToLower(name)] = true
		limit := int64(maxImportedAsset)
		if name == "template.json" {
			limit = 16 << 10
		} else {
			if !strings.HasPrefix(name, "files/") {
				return result, fail(http.StatusBadRequest, "テンプレート内のファイル名を読み取れません．")
			}
			name = strings.TrimPrefix(name, "files/")
			clean, err := cleanRelative(name)
			if err != nil || clean != name || !templateFileAllowed(name) {
				return result, fail(http.StatusBadRequest, "テンプレート内に使用できないファイル名があります．")
			}
		}
		if file.UncompressedSize64 > uint64(limit) {
			return result, fail(http.StatusRequestEntityTooLarge, "テンプレート内のファイルは 8 MiB 以内にしてください．")
		}
		if file.Name != "template.json" {
			total += file.UncompressedSize64
			if total > maxTemplateBytes {
				return result, fail(http.StatusRequestEntityTooLarge, "テンプレートの内容は合計 32 MiB 以内にしてください．")
			}
			if metadataOnly {
				result.Files[name] = nil
				continue
			}
		}
		rc, err := file.Open()
		if err != nil {
			return result, err
		}
		data, err := io.ReadAll(io.LimitReader(rc, limit+1))
		_ = rc.Close()
		if err != nil || int64(len(data)) > limit {
			return result, fail(http.StatusBadRequest, "テンプレートの内容を読み取れません．")
		}
		if file.Name == "template.json" {
			if json.Unmarshal(data, &result.projectTemplate) != nil {
				return result, fail(http.StatusBadRequest, "テンプレートの説明を読み取れません．")
			}
			manifest = true
		} else {
			result.Files[name] = data
		}
	}
	result.Bytes = int(total)
	result.FileCount = len(result.Files)
	if !manifest || result.FileCount == 0 || result.Bytes > maxTemplateBytes || !validMode(result.Mode) || result.ID != id || result.Builtin {
		return result, fail(http.StatusBadRequest, "テンプレートの内容を確認してください．")
	}
	if _, err := templateName(result.Name); err != nil {
		return result, err
	}
	if result.Main != "" {
		if _, exists := result.Files[result.Main]; !exists || !strings.EqualFold(filepath.Ext(result.Main), ".tex") {
			return result, fail(http.StatusBadRequest, "テンプレートのメイン文書が見つかりません．")
		}
	}
	return result, nil
}

func templateFileAllowed(path string) bool {
	return isTextFile(path) || assetContentType(path) != "" || strings.EqualFold(filepath.Ext(path), ".eps")
}

func templateGeneratedPDF(path string, files []ProjectFile) bool {
	if !strings.EqualFold(filepath.Ext(path), ".pdf") {
		return false
	}
	base := strings.TrimSuffix(path, filepath.Ext(path))
	for _, item := range files {
		if strings.EqualFold(filepath.Ext(item.Path), ".tex") && strings.EqualFold(strings.TrimSuffix(item.Path, filepath.Ext(item.Path)), base) {
			return true
		}
	}
	return false
}

func (a *App) userTemplateNamesLocked() ([]string, int64, error) {
	dir, err := a.templateDirectory()
	if err != nil {
		return nil, 0, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, 0, err
	}
	var names []string
	var total int64
	for _, entry := range entries {
		id := strings.TrimSuffix(entry.Name(), ".zip")
		if !strings.HasSuffix(entry.Name(), ".zip") || !templateIDValid(id) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return nil, 0, err
		}
		total += info.Size()
		names = append(names, id)
		if len(names) > maxUserTemplates {
			return nil, 0, fail(http.StatusBadRequest, "ユーザー用のテンプレートは 20 個までです．")
		}
	}
	sort.Strings(names)
	return names, total, nil
}

func (a *App) saveTemplateLocked(item templateContents, replace bool) error {
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	manifest, _ := json.Marshal(item.projectTemplate)
	entry, err := writer.Create("template.json")
	if err != nil {
		return err
	}
	if _, err := entry.Write(manifest); err != nil {
		return err
	}
	paths := make([]string, 0, len(item.Files))
	for path := range item.Files {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	for _, path := range paths {
		entry, err := writer.Create("files/" + path)
		if err != nil {
			return err
		}
		if _, err := entry.Write(item.Files[path]); err != nil {
			return err
		}
	}
	if err := writer.Close(); err != nil {
		return err
	}
	dir, err := a.templateDirectory()
	if err != nil {
		return err
	}
	names, total, err := a.userTemplateNamesLocked()
	if err != nil {
		return err
	}
	if !replace && len(names) >= maxUserTemplates {
		return fail(http.StatusBadRequest, "ユーザー用のテンプレートは 20 個までです．")
	}
	path := filepath.Join(dir, item.ID+".zip")
	if replace {
		old, err := os.Stat(path)
		if err != nil {
			return err
		}
		total -= old.Size()
	}
	if total+int64(buffer.Len()) > maxTemplatesDisk {
		return fail(http.StatusRequestEntityTooLarge, "テンプレートの合計が 128 MiB を超えます．使わないテンプレートを削除してください．")
	}
	return writeAtomicChecked(path, buffer.Bytes(), 0600, func() error {
		_, err := safePath(dir, item.ID+".zip", !replace)
		if err != nil {
			return err
		}
		if !replace {
			if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
				return fail(http.StatusConflict, "同じテンプレートがすでに登録されています．")
			}
		}
		return nil
	})
}

func (a *App) templatesHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet, http.MethodPost, http.MethodPatch, http.MethodDelete) {
		return
	}
	var input struct {
		ID          string   `json:"id"`
		Name        string   `json:"name"`
		Description string   `json:"description"`
		Paths       []string `json:"paths"`
	}
	if r.Method != http.MethodGet {
		if err := readJSON(w, r, &input); err != nil {
			writeError(w, err)
			return
		}
	}
	a.templateMu.Lock()
	defer a.templateMu.Unlock()
	language := messages.LanguageFromContext(r.Context())
	if r.Method == http.MethodGet {
		items := []projectTemplate{}
		for _, item := range builtinTemplates(language) {
			items = append(items, item.projectTemplate)
		}
		names, _, err := a.userTemplateNamesLocked()
		if err != nil {
			writeError(w, err)
			return
		}
		for _, id := range names {
			item, err := a.readTemplateArchiveLocked(id, language, true)
			if err != nil {
				writeError(w, err)
				return
			}
			items = append(items, item.projectTemplate)
		}
		writeJSON(w, http.StatusOK, map[string]any{"templates": items, "limits": map[string]int{"files": maxTemplateFiles, "bytes": maxTemplateBytes, "count": maxUserTemplates}})
		return
	}
	if r.Method == http.MethodDelete {
		if !templateIDValid(input.ID) {
			writeError(w, fail(http.StatusBadRequest, "標準のテンプレートは変更できません．"))
			return
		}
		dir, err := a.templateDirectory()
		if err == nil {
			var path string
			path, err = safePath(dir, input.ID+".zip", false)
			if err == nil {
				err = os.Remove(path)
			}
		}
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	name, err := templateName(input.Name)
	if err != nil {
		writeError(w, err)
		return
	}
	if len(input.Description) > 2000 || strings.ContainsRune(input.Description, 0) {
		writeError(w, fail(http.StatusBadRequest, "テンプレートの説明を短くしてください．"))
		return
	}
	var item templateContents
	if r.Method == http.MethodPatch {
		if !templateIDValid(input.ID) {
			writeError(w, fail(http.StatusBadRequest, "標準のテンプレートは変更できません．"))
			return
		}
		item, err = a.readTemplateLocked(input.ID, language)
	} else {
		a.mu.Lock()
		err = a.checkProjectLocked(r.Header.Get("X-Project-Root"))
		if err == nil && a.project == nil {
			err = fail(http.StatusBadRequest, "原稿フォルダーを開いてください．")
		}
		if err == nil {
			item, err = captureTemplate(*a.project, input.Paths)
		}
		a.mu.Unlock()
	}
	if err == nil {
		item.Name, item.Description = name, strings.TrimSpace(input.Description)
		err = a.saveTemplateLocked(item, r.Method == http.MethodPatch)
	}
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item.projectTemplate)
}

func captureTemplate(project Project, selected []string) (templateContents, error) {
	result := templateContents{projectTemplate: projectTemplate{Main: project.Main, Mode: project.Mode}, Files: map[string][]byte{}}
	if len(selected) == 0 || len(selected) > maxTemplateFiles {
		return result, fail(http.StatusBadRequest, "登録するファイルを 1〜200 個選んでください．")
	}
	files, err := listProjectFiles(project.Root)
	if err != nil {
		return result, err
	}
	for _, path := range selected {
		clean, err := cleanRelative(path)
		if err != nil || clean != path || !hasFile(files, path) || !templateFileAllowed(path) || templateGeneratedPDF(path, files) {
			return result, fail(http.StatusBadRequest, "登録するファイルを確認してください．生成した PDF や補助ファイルは含められません．")
		}
		if _, exists := result.Files[path]; exists {
			continue
		}
		absolute, err := safePath(project.Root, path, false)
		if err != nil {
			return result, err
		}
		data, err := readBytes(absolute)
		if err != nil {
			return result, err
		}
		result.Files[path] = data
		result.Bytes += len(data)
		if result.Bytes > maxTemplateBytes {
			return result, fail(http.StatusRequestEntityTooLarge, "テンプレートの内容は合計 32 MiB 以内にしてください．")
		}
	}
	if _, exists := result.Files[result.Main]; !exists {
		result.Main = ""
	}
	result.FileCount = len(result.Files)
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return result, err
	}
	result.ID = hex.EncodeToString(id[:])
	return result, nil
}

func createTemplateProject(parent, name string, item templateContents) (string, error) {
	if !filepath.IsAbs(parent) {
		return "", fail(http.StatusBadRequest, "保存先のフォルダーを選んでください．")
	}
	parent, err := filepath.EvalSymlinks(filepath.Clean(parent))
	if err != nil {
		return "", err
	}
	info, err := os.Stat(parent)
	if err != nil || !info.IsDir() {
		return "", fail(http.StatusBadRequest, "保存先のフォルダーを選んでください．")
	}
	clean, err := cleanRelative(strings.TrimSpace(name))
	if err != nil || strings.Contains(clean, "/") {
		return "", fail(http.StatusBadRequest, "新しいプロジェクトのフォルダー名を入力してください．")
	}
	root := filepath.Join(parent, clean)
	if err := os.Mkdir(root, 0755); err != nil {
		if errors.Is(err, os.ErrExist) {
			return "", fail(http.StatusConflict, "同じ名前のフォルダーがあります．新しい名前を選んでください．")
		}
		return "", err
	}
	created := []string{}
	directories := []string{root}
	success := false
	defer func() {
		if success {
			return
		}
		for _, path := range created {
			_ = os.Remove(path)
		}
		for index := len(directories) - 1; index >= 0; index-- {
			_ = os.Remove(directories[index])
		}
	}()
	paths := make([]string, 0, len(item.Files))
	for path := range item.Files {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	for _, path := range paths {
		if clean, err := cleanRelative(path); err != nil || clean != path {
			return "", fail(http.StatusBadRequest, "テンプレート内に使用できないファイル名があります．")
		}
		current := root
		parts := strings.Split(path, "/")
		for _, part := range parts[:len(parts)-1] {
			current = filepath.Join(current, part)
			if err := os.Mkdir(current, 0755); err == nil {
				directories = append(directories, current)
			} else if !errors.Is(err, os.ErrExist) {
				return "", err
			}
		}
		absolute, err := safePath(root, path, true)
		if err != nil {
			return "", err
		}
		file, err := os.OpenFile(absolute, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
		if err != nil {
			return "", err
		}
		created = append(created, absolute)
		_, writeErr := file.Write(item.Files[path])
		closeErr := file.Close()
		if writeErr != nil {
			return "", writeErr
		}
		if closeErr != nil {
			return "", closeErr
		}
	}
	success = true
	return root, nil
}

func (a *App) templateProjectHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var input struct {
		ID     string `json:"id"`
		Parent string `json:"parent"`
		Name   string `json:"name"`
	}
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	a.templateMu.Lock()
	item, err := a.readTemplateLocked(input.ID, messages.LanguageFromContext(r.Context()))
	a.templateMu.Unlock()
	var root string
	if err == nil {
		root, err = createTemplateProject(input.Parent, input.Name, item)
	}
	if err == nil {
		a.mu.Lock()
		config := cloneConfig(a.config)
		config.Projects[root] = projectSettings{Main: item.Main, Mode: item.Mode, DocumentDefaultApplied: true}
		err = a.saveConfig(config)
		if err == nil {
			a.config = config
		}
		a.mu.Unlock()
	}
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"path": root, "main": item.Main, "mode": item.Mode})
}
