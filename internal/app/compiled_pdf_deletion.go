package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

type compiledPDFDeletionEntry struct {
	Area      string `json:"area"`
	Path      string `json:"path"`
	Directory bool   `json:"directory"`
	Size      int64  `json:"size"`
	root      string
	relative  string
	content   string
	info      os.FileInfo
}

type compiledPDFDeletionParent struct {
	root, relative string
	info           os.FileInfo
}

type compiledPDFDeletion struct {
	ProjectRoot  string                     `json:"projectRoot"`
	Main         string                     `json:"main"`
	Name         string                     `json:"name"`
	BuildID      string                     `json:"buildId"`
	Revision     string                     `json:"revision"`
	VersionCount int                        `json:"versionCount"`
	FileCount    int                        `json:"fileCount"`
	Size         int64                      `json:"size"`
	Entries      []compiledPDFDeletionEntry `json:"entries"`
	ids          []string
	parents      map[string]compiledPDFDeletionParent
}

func compiledPDFDeletionChanged() error {
	return fail(http.StatusConflict, "コンパイル結果や補助ファイルが変更されました．現在の内容を確認してから，もう一度削除してください．")
}

func validPDFCacheID(id string) bool {
	if id == "" || strings.ContainsAny(id, "/\\") {
		return false
	}
	name := "pdf-" + id + ".json"
	clean, err := cleanRelative(name)
	return err == nil && clean == name
}

// main.tex shares its output directory with the directories of other documents.
// Reserve every document directory, including results absent from this cache.
func compiledPDFDocumentDirectory(name string) bool {
	if len(name) != 36 || !strings.EqualFold(name[:4], "doc-") {
		return false
	}
	_, err := hex.DecodeString(name[4:])
	return err == nil
}

func (inspection *compiledPDFDeletion) rememberParents(root, relative string) error {
	parent := filepath.ToSlash(filepath.Dir(filepath.FromSlash(relative)))
	if parent == "." {
		parent = ""
	}
	for {
		key := root + "\x00" + parent
		if _, exists := inspection.parents[key]; !exists {
			_, info, err := entryTreePath(root, parent)
			if err != nil {
				return err
			}
			if !info.IsDir() {
				return compiledPDFDeletionChanged()
			}
			inspection.parents[key] = compiledPDFDeletionParent{root: root, relative: parent, info: info}
		}
		if parent == "" {
			return nil
		}
		parent = filepath.ToSlash(filepath.Dir(filepath.FromSlash(parent)))
		if parent == "." {
			parent = ""
		}
	}
}

func (inspection *compiledPDFDeletion) addTree(ctx context.Context, root, relative, area, display string) error {
	path, _, err := entryTreePath(root, relative)
	if err != nil {
		return err
	}
	return filepath.WalkDir(path, func(child string, _ fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if len(inspection.Entries) >= 50000 {
			return fail(http.StatusBadRequest, "コンパイル結果の項目が多いため，出力先のファイルを確認してください．")
		}
		rel, err := filepath.Rel(root, child)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		checked, info, err := entryTreePath(root, rel)
		if err != nil {
			return err
		}
		item := compiledPDFDeletionEntry{Area: area, Path: display + strings.TrimPrefix(rel, relative), Directory: info.IsDir(), root: root, relative: rel, info: info}
		if !item.Directory {
			item.content, err = entryContentRevision(ctx, checked, info)
			if err != nil {
				return err
			}
			item.Size = info.Size()
			inspection.FileCount++
			inspection.Size += item.Size
		}
		if err := inspection.rememberParents(root, rel); err != nil {
			return err
		}
		inspection.Entries = append(inspection.Entries, item)
		return nil
	})
}

// The caller holds a.mu and cacheMu. Sources can have been renamed or removed;
// ownership comes from the completed build and its saved cache records.
func (a *App) inspectCompiledPDFDeletionLocked(ctx context.Context, main string) (compiledPDFDeletion, error) {
	current, exists := a.compiledPDFs[compiledPDFKey(main)]
	if !exists {
		return compiledPDFDeletion{}, fail(http.StatusConflict, "選択した PDF が一覧から変更されました．一覧を読み直してから操作してください．")
	}
	result := compiledPDFDeletion{ProjectRoot: a.project.Root, Main: current.Main, Name: current.Name, BuildID: current.BuildID,
		Entries: []compiledPDFDeletionEntry{}, parents: make(map[string]compiledPDFDeletionParent)}
	ids := map[string]bool{current.BuildID: true}
	for id, owner := range a.pdfMains {
		if compiledPDFKey(owner) == compiledPDFKey(current.Main) {
			ids[id] = true
		}
	}
	base, err := filepath.EvalSymlinks(a.options.ConfigDir)
	if err != nil {
		return result, err
	}
	cacheRelative, err := filepath.Rel(a.options.ConfigDir, a.projectCacheDirectory(result.ProjectRoot))
	if err != nil {
		return result, err
	}
	cacheRelative = filepath.ToSlash(cacheRelative)
	cache, cacheInfo, err := entryTreePath(base, cacheRelative)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return result, err
	}
	if err == nil {
		if !cacheInfo.IsDir() {
			return result, compiledPDFDeletionChanged()
		}
		entries, err := os.ReadDir(cache)
		if err != nil {
			return result, err
		}
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return result, err
			}
			name := entry.Name()
			if !strings.HasPrefix(name, "pdf-") || !strings.HasSuffix(name, ".json") {
				continue
			}
			id := strings.TrimSuffix(strings.TrimPrefix(name, "pdf-"), ".json")
			if !validPDFCacheID(id) {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				return result, err
			}
			regular, err := platform.IsRegularFile(filepath.Join(cache, name), info)
			if err != nil {
				return result, err
			}
			if !regular {
				continue
			}
			path, info, err := entryTreePath(base, cacheRelative+"/"+name)
			if err != nil {
				return result, err
			}
			data, err := readCacheFile(path, maxTextSize)
			if err != nil {
				return result, err
			}
			content, err := entryContentRevision(ctx, path, info)
			if err != nil {
				return result, err
			}
			sum := sha256.Sum256(data)
			if content != hex.EncodeToString(sum[:]) {
				return result, compiledPDFDeletionChanged()
			}
			var value cachedBuild
			if json.Unmarshal(data, &value) != nil || value.Format != 1 || value.ID != id || !validMode(value.Mode) {
				continue
			}
			clean, err := cleanRelative(value.Main)
			if err != nil || clean != value.Main || !strings.EqualFold(filepath.Ext(clean), ".tex") {
				continue
			}
			if compiledPDFKey(value.Main) == compiledPDFKey(current.Main) {
				ids[id] = true
			} else if ids[id] {
				return result, compiledPDFDeletionChanged()
			}
		}
	}
	for id := range ids {
		if !validPDFCacheID(id) {
			return result, compiledPDFDeletionChanged()
		}
		for _, other := range a.compiledPDFs {
			if other.BuildID == id && compiledPDFKey(other.Main) != compiledPDFKey(current.Main) {
				return result, compiledPDFDeletionChanged()
			}
		}
		if owner, known := a.pdfMains[id]; known && compiledPDFKey(owner) != compiledPDFKey(current.Main) {
			return result, compiledPDFDeletionChanged()
		}
		result.ids = append(result.ids, id)
		for _, extension := range []string{".pdf", ".json", ".synctex.gz", ".synctex"} {
			name := "pdf-" + id + extension
			relative := cacheRelative + "/" + name
			_, info, err := entryTreePath(base, relative)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return result, err
			}
			if info.IsDir() {
				return result, compiledPDFDeletionChanged()
			}
			if err := result.addTree(ctx, base, relative, "cache", name); err != nil {
				return result, err
			}
		}
	}
	for _, output := range compiledBuildDirectories(current.Main) {
		if err := result.addBuildOutput(ctx, output); err != nil {
			return result, err
		}
	}
	sort.Strings(result.ids)
	result.VersionCount = len(result.ids)
	sort.Slice(result.Entries, func(i, j int) bool {
		left, right := result.Entries[i], result.Entries[j]
		if left.Area != right.Area {
			return left.Area < right.Area
		}
		return left.Path < right.Path
	})
	hash := sha256.New()
	fmt.Fprintf(hash, "%s\x00%s\x00%s\x00%s\x00", result.ProjectRoot, result.Main, result.Name, result.BuildID)
	for _, id := range result.ids {
		fmt.Fprintf(hash, "%s\x00", id)
	}
	for _, item := range result.Entries {
		_, info, err := entryTreePath(item.root, item.relative)
		if err != nil {
			return result, err
		}
		if !sameEntryInfo(item.info, info) {
			return result, compiledPDFDeletionChanged()
		}
		fmt.Fprintf(hash, "%s\x00%s\x00%d\x00%d\x00%d\x00%s\x00", item.Area, item.Path, item.info.Mode(), item.Size, item.info.ModTime().UnixNano(), item.content)
	}
	result.Revision = hex.EncodeToString(hash.Sum(nil))
	return result, nil
}

func checkCompiledPDFDeletionParents(inspection compiledPDFDeletion, item compiledPDFDeletionEntry) error {
	parent := filepath.ToSlash(filepath.Dir(filepath.FromSlash(item.relative)))
	if parent == "." {
		parent = ""
	}
	for {
		expected, exists := inspection.parents[item.root+"\x00"+parent]
		_, info, err := entryTreePath(item.root, parent)
		if err != nil {
			return err
		}
		if !exists || !info.IsDir() || !os.SameFile(expected.info, info) {
			return compiledPDFDeletionChanged()
		}
		if parent == "" {
			return nil
		}
		parent = filepath.ToSlash(filepath.Dir(filepath.FromSlash(parent)))
		if parent == "." {
			parent = ""
		}
	}
}

// Delete only the confirmed paths. New children make os.Remove fail on their
// directory, and every file is checked again immediately before removal.
func (a *App) removeCompiledPDFDeletionLocked(ctx context.Context, inspection compiledPDFDeletion) error {
	current, err := a.inspectCompiledPDFDeletionLocked(ctx, inspection.Main)
	if err != nil {
		return err
	}
	if inspection.Revision == "" || current.Revision != inspection.Revision || len(current.Entries) != len(inspection.Entries) {
		return compiledPDFDeletionChanged()
	}
	for index, item := range current.Entries {
		if !os.SameFile(inspection.Entries[index].info, item.info) {
			return compiledPDFDeletionChanged()
		}
		if err := checkCompiledPDFDeletionParents(inspection, item); err != nil {
			return err
		}
	}
	items := append([]compiledPDFDeletionEntry{}, current.Entries...)
	sort.Slice(items, func(i, j int) bool {
		left, right := items[i], items[j]
		if left.Area != right.Area {
			return left.Area == "build"
		}
		if left.Area == "cache" {
			leftJSON, rightJSON := strings.HasSuffix(left.Path, ".json"), strings.HasSuffix(right.Path, ".json")
			if leftJSON != rightJSON {
				return !leftJSON
			}
		}
		return left.Path > right.Path
	})
	for _, item := range items {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := checkCompiledPDFDeletionParents(current, item); err != nil {
			return err
		}
		path, info, err := entryTreePath(item.root, item.relative)
		if err != nil {
			return err
		}
		if !os.SameFile(item.info, info) || item.info.Mode() != info.Mode() {
			return compiledPDFDeletionChanged()
		}
		if item.Directory {
			children, err := os.ReadDir(path)
			if err != nil {
				return err
			}
			if len(children) != 0 {
				return compiledPDFDeletionChanged()
			}
		} else {
			content, err := entryContentRevision(ctx, path, item.info)
			if err != nil {
				return err
			}
			if content != item.content {
				return compiledPDFDeletionChanged()
			}
		}
		if err := checkCompiledPDFDeletionParents(current, item); err != nil {
			return err
		}
		_, latest, err := entryTreePath(item.root, item.relative)
		if err != nil {
			return err
		}
		if !os.SameFile(item.info, latest) || (!item.Directory && !sameEntryInfo(item.info, latest)) {
			return compiledPDFDeletionChanged()
		}
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	remaining, err := a.inspectCompiledPDFDeletionLocked(ctx, inspection.Main)
	if err != nil {
		return err
	}
	if len(remaining.Entries) != 0 {
		return compiledPDFDeletionChanged()
	}
	return nil
}

func (a *App) forgetCompiledPDFLocked(inspection compiledPDFDeletion) {
	removed := make(map[string]bool, len(inspection.ids))
	for _, id := range inspection.ids {
		removed[id] = true
		delete(a.pdfVersions, id)
		delete(a.pdfMains, id)
		delete(a.synctexVersions, id)
	}
	delete(a.compiledPDFs, compiledPDFKey(inspection.Main))
	order := a.pdfOrder[:0]
	for _, id := range a.pdfOrder {
		if !removed[id] {
			order = append(order, id)
		}
	}
	a.pdfOrder = order
	if !removed[a.lastPDFID] && compiledPDFKey(a.lastPDFMain) != compiledPDFKey(inspection.Main) {
		return
	}
	a.lastPDF, a.lastPDFID, a.lastPDFMain = "", "", ""
	a.lastPDFChanged, a.lastPDFMarkdownInputs = false, nil
	var latest CompiledPDF
	for _, value := range a.compiledPDFs {
		if a.pdfVersions[value.BuildID] == "" {
			continue
		}
		if latest.BuildID == "" || value.ModifiedAt.After(latest.ModifiedAt) || (value.ModifiedAt.Equal(latest.ModifiedAt) && value.BuildID > latest.BuildID) {
			latest = value
		}
	}
	if latest.BuildID != "" {
		a.lastPDF, a.lastPDFID, a.lastPDFMain = a.pdfVersions[latest.BuildID], latest.BuildID, latest.Main
		a.lastPDFChanged, a.lastPDFMarkdownInputs = latest.SourceChanged, markdownInputSet(latest.MarkdownInputs)
	}
}

// A document can have been compiled using different ancestor configuration files.
func compiledBuildDirectories(main string) []string {
	outputs := []string{buildDirectoryRelative(main)}
	for parent := filepath.Dir(main); parent != "." && filepath.IsLocal(parent); parent = filepath.Dir(parent) {
		outputs = append(outputs, filepath.ToSlash(filepath.Join(parent, nestedBuildDirectory(main))))
	}
	return outputs
}

func (result *compiledPDFDeletion) addBuildOutput(ctx context.Context, output string) error {
	directory, info, err := entryTreePath(result.ProjectRoot, output)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil {
		if !info.IsDir() {
			return compiledPDFDeletionChanged()
		}
		if output == buildRelative {
			entries, err := os.ReadDir(directory)
			if err != nil {
				return err
			}
			for _, entry := range entries {
				if compiledPDFDocumentDirectory(entry.Name()) {
					continue
				}
				relative := output + "/" + entry.Name()
				if err := result.addTree(ctx, result.ProjectRoot, relative, "build", relative); err != nil {
					return err
				}
			}
		} else if err := result.addTree(ctx, result.ProjectRoot, output, "build", output); err != nil {
			return err
		}
	}
	return nil
}

func acquireCompiledPDFDeletionLock(root string) (func(), error) {
	parent := ".local-tex-editor"
	_, info, err := entryTreePath(root, parent)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.Mkdir(filepath.Join(root, parent), 0700); err != nil && !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		_, info, err = entryTreePath(root, parent)
	}
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, compiledPDFDeletionChanged()
	}
	release, err := platform.AcquireProjectLock(root)
	if errors.Is(err, platform.ErrLocked) {
		return nil, fail(http.StatusConflict, "別の画面でコンパイルしています．完了後に PDF の一覧を読み直してください．")
	}
	if err != nil {
		return nil, err
	}
	_, current, err := entryTreePath(root, parent)
	if err != nil || !os.SameFile(info, current) {
		release()
		return nil, compiledPDFDeletionChanged()
	}
	return release, nil
}

func (a *App) compiledPDFDeleteHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet, http.MethodDelete) {
		return
	}
	var input struct {
		Main     string `json:"main"`
		BuildID  string `json:"buildId"`
		Revision string `json:"revision"`
	}
	if r.Method == http.MethodGet {
		input.Main, input.BuildID = r.URL.Query().Get("main"), r.URL.Query().Get("build")
	} else if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	main, err := cleanRelative(input.Main)
	if err != nil || !strings.EqualFold(filepath.Ext(main), ".tex") {
		writeError(w, fail(http.StatusBadRequest, "コンパイルした PDF の TeX ファイルを選んでください．"))
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.checkProjectLocked(r.Header.Get("X-Project-Root")); err != nil {
		writeError(w, err)
		return
	}
	if a.closed {
		writeError(w, fail(http.StatusServiceUnavailable, "アプリは終了しています．"))
		return
	}
	if a.project == nil {
		writeError(w, fail(http.StatusBadRequest, "原稿フォルダーを開いてください．"))
		return
	}
	language := messages.LanguageFromContext(r.Context())
	conflict := func(err error, inspection *compiledPDFDeletion) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": messages.ErrorText(language, err), "reviewRequired": true,
			"inspection": inspection, "state": a.stateLocked(false, language)})
	}
	if a.isRunningLocked() {
		conflict(fail(http.StatusConflict, "コンパイルが終了してから PDF を削除してください．"), nil)
		return
	}
	if r.Method == http.MethodDelete {
		release, err := acquireCompiledPDFDeletionLock(a.project.Root)
		if err != nil {
			var failure *apiError
			if errors.As(err, &failure) && failure.status == http.StatusConflict {
				conflict(err, nil)
			} else {
				writeError(w, err)
			}
			return
		}
		defer release()
	}
	a.cacheMu.Lock()
	defer a.cacheMu.Unlock()
	inspection, err := a.inspectCompiledPDFDeletionLocked(r.Context(), main)
	if err != nil {
		var failure *apiError
		if errors.As(err, &failure) && failure.status == http.StatusConflict {
			conflict(err, nil)
		} else {
			writeError(w, err)
		}
		return
	}
	if (input.BuildID != "" && input.BuildID != inspection.BuildID) || (r.Method == http.MethodDelete && (input.BuildID == "" || input.Revision == "" || input.Revision != inspection.Revision)) {
		conflict(compiledPDFDeletionChanged(), &inspection)
		return
	}
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, inspection)
		return
	}
	if err := a.removeCompiledPDFDeletionLocked(r.Context(), inspection); err != nil {
		if current, inspectErr := a.inspectCompiledPDFDeletionLocked(r.Context(), main); inspectErr == nil {
			conflict(err, &current)
		} else {
			conflict(err, nil)
		}
		return
	}
	a.forgetCompiledPDFLocked(inspection)
	writeJSON(w, http.StatusOK, map[string]any{"main": inspection.Main, "deletedBuildIds": inspection.ids, "state": a.stateLocked(false, language)})
}
