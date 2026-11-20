package app

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

const (
	historyMaxFileBytes = 2 << 20
	historyMaxVersions = 50
	historyMaxRecords  = 2000
	historyInterval    = time.Minute
)

var editHistoryMu sync.Mutex
var historyIDPattern = regexp.MustCompile(`^[0-9]{19}-[a-f0-9]{16}$`)

type historySettings struct {
	Enabled         bool  `json:"enabled"`
	Days            int   `json:"days"`
	MaxBytes        int64 `json:"maxBytes"`
	MaxFileBytes    int   `json:"maxFileBytes"`
	MaxVersions     int   `json:"maxVersions"`
	IntervalSeconds int   `json:"intervalSeconds"`
}

type historyEntry struct {
	ID         string    `json:"id"`
	CreatedAt  time.Time `json:"createdAt"`
	Label      string    `json:"label"`
	Revision   string    `json:"revision"`
	LineEnding string    `json:"lineEnding"`
	Bytes      int       `json:"bytes"`
	Hash       string    `json:"hash"`
}

func defaultHistorySettings() historySettings {
	return historySettings{Enabled: true, Days: 30, MaxBytes: 50 << 20, MaxFileBytes: historyMaxFileBytes, MaxVersions: historyMaxVersions, IntervalSeconds: int(historyInterval / time.Second)}
}

func (a *App) readHistorySettings() (historySettings, error) {
	settings := defaultHistorySettings()
	data, err := os.ReadFile(filepath.Join(a.options.ConfigDir, "history-settings.json"))
	if errors.Is(err, os.ErrNotExist) {
		return settings, nil
	}
	if err != nil {
		return settings, err
	}
	if len(data) > 4096 {
		return settings, errors.New("history settings are too large")
	}
	if err := json.Unmarshal(data, &settings); err != nil {
		return settings, err
	}
	if settings.Days < 1 || settings.Days > 365 || settings.MaxBytes < 5<<20 || settings.MaxBytes > 200<<20 {
		return defaultHistorySettings(), errors.New("history settings are outside their allowed range")
	}
	settings.MaxFileBytes, settings.MaxVersions, settings.IntervalSeconds = historyMaxFileBytes, historyMaxVersions, int(historyInterval/time.Second)
	return settings, nil
}

func (a *App) historyDirectory(root, path string, create bool) (string, error) {
	base := filepath.Join(a.options.ConfigDir, "history")
	name := revision([]byte(root + "\x00" + path))
	for _, directory := range []string{base, filepath.Join(base, name)} {
		if create {
			if err := os.Mkdir(directory, 0700); err != nil && !errors.Is(err, os.ErrExist) {
				return "", err
			}
		}
		info, err := os.Lstat(directory)
		if err != nil {
			return "", err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("history folder is not a regular directory")
		}
		linked, err := platform.IsReparsePoint(directory)
		if err != nil { return "", err }
		if linked { return "", errors.New("history folder must not be a link") }
	}
	return filepath.Join(base, name), nil
}

func readHistoryEntries(directory string) ([]historyEntry, error) {
	entries := []historyEntry{}
	files, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return entries, nil
	}
	if err != nil {
		return entries, err
	}
	for _, file := range files {
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".json") || !historyIDPattern.MatchString(strings.TrimSuffix(file.Name(), ".json")) {
			continue
		}
		info, err := file.Info()
		if err != nil || !info.Mode().IsRegular() || info.Size() > 4096 {
			continue
		}
		linked, err := platform.IsReparsePoint(filepath.Join(directory, file.Name()))
		if err != nil || linked { continue }
		data, err := os.ReadFile(filepath.Join(directory, file.Name()))
		if err != nil {
			continue
		}
		var entry historyEntry
		if json.Unmarshal(data, &entry) != nil || entry.ID+".json" != file.Name() {
			continue
		}
		dataPath := filepath.Join(directory, entry.ID+".gz")
		dataInfo, err := os.Lstat(dataPath)
		if err != nil || !dataInfo.Mode().IsRegular() {
			continue
		}
		if linked, err := platform.IsReparsePoint(dataPath); err != nil || linked { continue }
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].CreatedAt.After(entries[j].CreatedAt) })
	return entries, nil
}

func (a *App) historyDue(root, path string, now time.Time) (bool, error) {
	settings, err := a.readHistorySettings()
	if err != nil || !settings.Enabled {
		return false, err
	}
	directory, err := a.historyDirectory(root, path, false)
	if errors.Is(err, os.ErrNotExist) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	entries, err := readHistoryEntries(directory)
	return len(entries) == 0 || now.Sub(entries[0].CreatedAt) >= historyInterval, err
}

// saveDocumentWithHistoryLocked is used while the App lock serializes saves.
// History is optional: a failed history write is returned as a warning alongside
// the successfully saved document, so it cannot turn a save into a false failure.
func (a *App) saveDocumentWithHistoryLocked(input FileDocument, language ...string) (FileDocument, error) {
	editHistoryMu.Lock()
	defer editHistoryMu.Unlock()
	now := time.Now()
	due, historyErr := a.historyDue(a.project.Root, input.Path, now)
	var previous FileDocument
	if due {
		_, path, err := projectFilePath(a.project.Root, input.Path, true)
		if err == nil {
			if info, err := os.Stat(path); err == nil && info.Size() <= historyMaxFileBytes {
				previous, historyErr = readDocument(a.project.Root, input.Path)
			} else { due = false }
		} else { due = false }
	}
	saved, err := saveDocument(a.project.Root, input)
	if err != nil {
		return saved, err
	}
	if due && previous.Path != "" && previous.Content != saved.Content {
		_, historyErr = a.recordHistory(a.project.Root, previous, "", now, false)
	}
	if historyErr != nil {
		selected := "en"
		if len(language) > 0 { selected = language[0] }
		saved.HistoryWarning = messages.ErrorText(selected, messages.Errorf("原稿は保存しましたが，編集履歴を記録できませんでした: %v", historyErr))
	}
	return saved, nil
}

func (a *App) recordHistory(root string, document FileDocument, label string, now time.Time, force bool) (historyEntry, error) {
	settings, err := a.readHistorySettings()
	if err != nil {
		return historyEntry{}, err
	}
	if !settings.Enabled {
		return historyEntry{}, fail(http.StatusBadRequest, "編集履歴の記録はオフになっています．")
	}
	if len(document.Content) > historyMaxFileBytes {
		return historyEntry{}, fail(http.StatusRequestEntityTooLarge, "2 MiB を超える原稿は編集履歴の対象外です．")
	}
	if !utf8.ValidString(document.Content) || strings.ContainsRune(document.Content, 0) || len([]rune(label)) > 100 {
		return historyEntry{}, fail(http.StatusBadRequest, "履歴の名前は 100 文字以内，原稿は UTF-8 で指定してください．")
	}
	directory, err := a.historyDirectory(root, document.Path, true)
	if err != nil {
		return historyEntry{}, err
	}
	entries, err := readHistoryEntries(directory)
	if err != nil {
		return historyEntry{}, err
	}
	hash := revision([]byte(document.Content))
	if len(entries) > 0 && !force && (entries[0].Hash == hash || now.Sub(entries[0].CreatedAt) < historyInterval) {
		return entries[0], nil
	}
	entry := historyEntry{ID: fmt.Sprintf("%019d-%s", now.UnixNano(), hash[:16]), CreatedAt: now.UTC(), Label: strings.TrimSpace(label), Revision: document.Revision, LineEnding: document.LineEnding, Bytes: len(document.Content), Hash: hash}
	var compressed bytes.Buffer
	writer, err := gzip.NewWriterLevel(&compressed, gzip.BestSpeed)
	if err != nil {
		return historyEntry{}, err
	}
	if _, err := writer.Write([]byte(document.Content)); err != nil {
		return historyEntry{}, err
	}
	if err := writer.Close(); err != nil {
		return historyEntry{}, err
	}
	if err := writeAtomic(filepath.Join(directory, entry.ID+".gz"), compressed.Bytes(), 0600); err != nil {
		return historyEntry{}, err
	}
	metadata, err := json.Marshal(entry)
	if err == nil {
		err = writeAtomic(filepath.Join(directory, entry.ID+".json"), metadata, 0600)
	}
	if err != nil {
		_ = os.Remove(filepath.Join(directory, entry.ID+".gz"))
		return historyEntry{}, err
	}
	if err := a.pruneHistory(settings, now); err != nil {
		return entry, err
	}
	return entry, nil
}

func (a *App) pruneHistory(settings historySettings, now time.Time) error {
	base := filepath.Join(a.options.ConfigDir, "history")
	info, err := os.Lstat(base)
	if errors.Is(err, os.ErrNotExist) { return nil }
	if err != nil { return err }
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 { return errors.New("history folder is not a regular directory") }
	if linked, err := platform.IsReparsePoint(base); err != nil { return err } else if linked { return errors.New("history folder must not be a link") }
	folders, err := os.ReadDir(base)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	type stored struct { directory string; entry historyEntry; size int64 }
	all := []stored{}
	var total int64
	remove := func(item stored) error {
		for _, suffix := range []string{".gz", ".json"} {
			if err := os.Remove(filepath.Join(item.directory, item.entry.ID+suffix)); err != nil && !errors.Is(err, os.ErrNotExist) { return err }
		}
		return nil
	}
	cutoff := now.Add(-time.Duration(settings.Days) * 24 * time.Hour)
	for _, folder := range folders {
		if !folder.IsDir() || len(folder.Name()) != 64 || strings.Trim(folder.Name(), "0123456789abcdef") != "" { continue }
		directory := filepath.Join(base, folder.Name())
		if linked, err := platform.IsReparsePoint(directory); err != nil || linked { continue }
		entries, err := readHistoryEntries(directory)
		if err != nil { return err }
		known := make(map[string]bool, len(entries))
		for _, entry := range entries { known[entry.ID] = true }
		files, err := os.ReadDir(directory)
		if err != nil { return err }
		for _, file := range files {
			name := file.Name()
			id := strings.TrimSuffix(strings.TrimSuffix(name, ".json"), ".gz")
			if !file.IsDir() && historyIDPattern.MatchString(id) && !known[id] {
				if err := os.Remove(filepath.Join(directory, name)); err != nil && !errors.Is(err, os.ErrNotExist) { return err }
			}
		}
		for index, entry := range entries {
			item := stored{directory: directory, entry: entry}
			if index >= historyMaxVersions || entry.CreatedAt.Before(cutoff) {
				if err := remove(item); err != nil { return err }
				continue
			}
			for _, suffix := range []string{".gz", ".json"} {
				if info, err := os.Stat(filepath.Join(directory, entry.ID+suffix)); err == nil { item.size += info.Size() }
			}
			total += item.size
			all = append(all, item)
		}
	}
	sort.Slice(all, func(i, j int) bool { return all[i].entry.CreatedAt.Before(all[j].entry.CreatedAt) })
	remaining := len(all)
	for _, item := range all {
		if total <= settings.MaxBytes && remaining <= historyMaxRecords { break }
		if err := remove(item); err != nil { return err }
		total -= item.size
		remaining--
	}
	for _, folder := range folders {
		if folder.IsDir() { _ = os.Remove(filepath.Join(base, folder.Name())) }
	}
	return nil
}

func (a *App) historySettingsHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet, http.MethodPut) { return }
	editHistoryMu.Lock()
	defer editHistoryMu.Unlock()
	settings, err := a.readHistorySettings()
	if err != nil { writeError(w, err); return }
	if r.Method == http.MethodPut {
		var input struct { Enabled bool `json:"enabled"`; Days int `json:"days"`; MaxBytes int64 `json:"maxBytes"` }
		if err := readJSON(w, r, &input); err != nil { writeError(w, err); return }
		if input.Days < 1 || input.Days > 365 || input.MaxBytes < 5<<20 || input.MaxBytes > 200<<20 {
			writeError(w, fail(http.StatusBadRequest, "履歴を保存する期間は 1～365 日，容量は 5～200 MiB で指定してください．")); return
		}
		settings.Enabled, settings.Days, settings.MaxBytes = input.Enabled, input.Days, input.MaxBytes
		data, _ := json.Marshal(settings)
		if err := writeAtomic(filepath.Join(a.options.ConfigDir, "history-settings.json"), data, 0600); err != nil { writeError(w, err); return }
		if err := a.pruneHistory(settings, time.Now()); err != nil { writeError(w, err); return }
	}
	writeJSON(w, http.StatusOK, settings)
}

func (a *App) historyHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet, http.MethodPost, http.MethodDelete) { return }
	if r.Method == http.MethodDelete { a.deleteHistoryHandler(w, r); return }
	var input struct { Path string `json:"path"`; Content string `json:"content"`; Revision string `json:"revision"`; Label string `json:"label"` }
	input.Path = r.URL.Query().Get("path")
	if r.Method == http.MethodPost {
		if err := readJSON(w, r, &input); err != nil { writeError(w, err); return }
	}
	a.mu.Lock()
	err := a.checkProjectLocked(r.Header.Get("X-Project-Root"), r.Method == http.MethodGet)
	root := ""
	if a.project != nil { root = a.project.Root }
	a.mu.Unlock()
	if err != nil { writeError(w, err); return }
	if root == "" { writeError(w, fail(http.StatusBadRequest, "原稿フォルダーを開いてください．")); return }
	clean, err := cleanRelative(input.Path)
	if err == nil && !isTextFile(clean) { err = fail(http.StatusUnsupportedMediaType, "この種類のファイルはテキストとして編集できません．") }
	if err == nil && r.Method != http.MethodGet { clean, _, err = projectFilePath(root, clean, true) }
	if err != nil { writeError(w, err); return }
	editHistoryMu.Lock()
	defer editHistoryMu.Unlock()
	if r.Method == http.MethodPost {
		document := FileDocument{Path: clean, Content: input.Content, Revision: input.Revision, LineEnding: "lf"}
		entry, err := a.recordHistory(root, document, input.Label, time.Now(), true)
		if err != nil { writeError(w, err); return }
		writeJSON(w, http.StatusCreated, entry); return
	}
	settings, err := a.readHistorySettings()
	if err != nil { writeError(w, err); return }
	if err := a.pruneHistory(settings, time.Now()); err != nil { writeError(w, err); return }
	directory, err := a.historyDirectory(root, clean, false)
	if errors.Is(err, os.ErrNotExist) {
		writeJSON(w, http.StatusOK, map[string]any{"entries": []historyEntry{}, "settings": settings}); return
	}
	if err != nil { writeError(w, err); return }
	entries, err := readHistoryEntries(directory)
	if err != nil { writeError(w, err); return }
	id := r.URL.Query().Get("id")
	if id == "" { writeJSON(w, http.StatusOK, map[string]any{"entries": entries, "settings": settings}); return }
	if !historyIDPattern.MatchString(id) { writeError(w, fail(http.StatusBadRequest, "履歴の項目を選び直してください．")); return }
	var selected *historyEntry
	for index := range entries { if entries[index].ID == id { selected = &entries[index]; break } }
	if selected == nil { writeError(w, fail(http.StatusNotFound, "この履歴は保存期間または容量の上限により削除されました．")); return }
	file, err := os.Open(filepath.Join(directory, id+".gz"))
	if err != nil { writeError(w, err); return }
	defer file.Close()
	reader, err := gzip.NewReader(file)
	if err != nil { writeError(w, err); return }
	defer reader.Close()
	content, err := io.ReadAll(io.LimitReader(reader, historyMaxFileBytes+1))
	if err != nil || len(content) > historyMaxFileBytes || !utf8.Valid(content) || revision(content) != selected.Hash {
		writeError(w, fail(http.StatusBadRequest, "この履歴を読み取れません．別の版を選んでください．")); return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entry": selected, "content": string(content), "path": clean})
}
