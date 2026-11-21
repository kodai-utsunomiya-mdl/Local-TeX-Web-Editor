package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
)

const settingsResetPrefix = ".settings-reset-"
const settingsResetJournalName = "reset.json"

var settingsResetIDPattern = regexp.MustCompile(`^[0-9]{8}T[0-9]{6}\.[0-9]{9}-[a-f0-9]{16}$`)

type settingsResetFile struct {
	relative string
	info     os.FileInfo
}

type settingsResetInspection struct {
	settingsResetSummary
	files []settingsResetFile
}

func resetHexName(name string, length int) bool {
	return len(name) == length && strings.Trim(name, "0123456789abcdef") == ""
}

func resetCacheFileName(name string) bool {
	if !strings.HasPrefix(name, "pdf-") {
		return false
	}
	for _, suffix := range []string{".synctex.gz", ".synctex", ".json", ".pdf"} {
		if strings.HasSuffix(name, suffix) {
			return settingsResetIDPattern.MatchString(strings.TrimSuffix(strings.TrimPrefix(name, "pdf-"), suffix))
		}
	}
	return false
}

func resetHistoryFileName(name string) bool {
	for _, suffix := range []string{".json", ".gz"} {
		if strings.HasSuffix(name, suffix) {
			return historyIDPattern.MatchString(strings.TrimSuffix(name, suffix))
		}
	}
	return false
}

func settingsResetFileAllowed(relative string) bool {
	parts := strings.Split(relative, "/")
	if len(parts) == 1 {
		return relative == "settings.json" || relative == "history-settings.json"
	}
	if len(parts) == 2 {
		return parts[0] == "ui-state" && strings.HasSuffix(parts[1], ".json") && resetHexName(strings.TrimSuffix(parts[1], ".json"), 64) ||
			parts[0] == "templates" && strings.HasSuffix(parts[1], ".zip") && templateIDValid(strings.TrimSuffix(parts[1], ".zip"))
	}
	if len(parts) == 3 {
		return parts[0] == "history" && resetHexName(parts[1], 64) && resetHistoryFileName(parts[2]) ||
			parts[0] == "cache" && resetHexName(parts[1], 32) && resetCacheFileName(parts[2])
	}
	return false
}

func settingsResetDirectoryEntries(base, relative string) ([]os.DirEntry, error) {
	path, info, err := entryTreePath(base, relative)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fail(http.StatusBadRequest, "保存情報の場所が通常のフォルダーではありません: %s", path)
	}
	return os.ReadDir(path)
}

// Only the app's known files are counted. No project paths from settings or
// UI records are followed, and unrelated children remain in their folders.
func inspectSettingsReset(ctx context.Context, directory string, selected settingsResetOptions) (settingsResetInspection, error) {
	base, err := filepath.EvalSymlinks(directory)
	result := settingsResetInspection{settingsResetSummary: settingsResetSummary{Directory: base}}
	if err != nil {
		return result, err
	}
	if _, _, err := entryTreePath(base, ""); err != nil {
		return result, err
	}
	add := func(relative string, area *settingsResetSize) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if len(result.files) >= 50000 {
			return fail(http.StatusRequestEntityTooLarge, "保存情報の項目が多いため，設定フォルダーの内容を確認してください．")
		}
		_, info, err := entryTreePath(base, relative)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.IsDir() || !settingsResetFileAllowed(relative) {
			return fail(http.StatusBadRequest, "保存情報のファイルを確認できません: %s", filepath.Join(base, filepath.FromSlash(relative)))
		}
		area.Files++
		area.Bytes += info.Size()
		result.files = append(result.files, settingsResetFile{relative, info})
		return nil
	}
	if selected.Settings {
		for _, name := range []string{"settings.json", "history-settings.json"} {
			if err := add(name, &result.Settings); err != nil {
				return result, err
			}
		}
	}
	if selected.Settings || selected.Drafts {
		entries, err := settingsResetDirectoryEntries(base, "ui-state")
		if err != nil {
			return result, err
		}
		for _, entry := range entries {
			name := entry.Name()
			if !strings.HasSuffix(name, ".json") || !resetHexName(strings.TrimSuffix(name, ".json"), 64) {
				continue
			}
			relative := "ui-state/" + name
			if name == revision([]byte("preferences"))+".json" {
				if selected.Settings {
					if err := add(relative, &result.Settings); err != nil {
						return result, err
					}
				}
				continue
			}
			path, _, err := entryTreePath(base, relative)
			if err != nil {
				return result, err
			}
			data, _, err := readSettingsImportFile(path, 2*maxTextSize)
			if err != nil {
				return result, err
			}
			var record storedUIValue
			if json.Unmarshal(data, &record) != nil || revision([]byte(record.Key))+".json" != name {
				continue
			}
			if strings.HasPrefix(record.Key, "session:") && selected.Settings {
				err = add(relative, &result.Settings)
			} else if strings.HasPrefix(record.Key, "drafts:") && selected.Drafts {
				err = add(relative, &result.Drafts)
			}
			if err != nil {
				return result, err
			}
		}
	}
	if selected.Templates {
		entries, err := settingsResetDirectoryEntries(base, "templates")
		if err != nil {
			return result, err
		}
		for _, entry := range entries {
			name := entry.Name()
			if strings.HasSuffix(name, ".zip") && templateIDValid(strings.TrimSuffix(name, ".zip")) {
				if err := add("templates/"+name, &result.Templates); err != nil {
					return result, err
				}
			}
		}
	}
	for _, area := range []struct {
		name     string
		selected bool
		length   int
		valid    func(string) bool
		size     *settingsResetSize
	}{
		{"history", selected.History, 64, resetHistoryFileName, &result.History},
		{"cache", selected.Cache, 32, resetCacheFileName, &result.Cache},
	} {
		if !area.selected {
			continue
		}
		folders, err := settingsResetDirectoryEntries(base, area.name)
		if err != nil {
			return result, err
		}
		for _, folder := range folders {
			if !resetHexName(folder.Name(), area.length) {
				continue
			}
			relative := area.name + "/" + folder.Name()
			entries, err := settingsResetDirectoryEntries(base, relative)
			if err != nil {
				return result, err
			}
			for _, entry := range entries {
				if area.valid(entry.Name()) {
					if err := add(relative+"/"+entry.Name(), area.size); err != nil {
						return result, err
					}
				}
			}
		}
	}
	return result, ctx.Err()
}

type settingsResetJournal struct {
	Version    int      `json:"version"`
	Generation string   `json:"generation"`
	Paths      []string `json:"paths"`
}

func readSettingsResetJournal(directory string) (settingsResetJournal, error) {
	data, exists, err := readSettingsImportFile(filepath.Join(directory, settingsResetJournalName), 16<<20)
	var journal settingsResetJournal
	if err != nil {
		return journal, err
	}
	if !exists {
		return journal, os.ErrNotExist
	}
	if json.Unmarshal(data, &journal) != nil || journal.Version != 1 || !settingsResetIDPattern.MatchString(journal.Generation) || len(journal.Paths) > 50001 {
		return journal, messages.Errorf("前回の初期化の記録を読み取れません: %s", directory)
	}
	seen := make(map[string]bool)
	for _, relative := range journal.Paths {
		if !settingsResetFileAllowed(relative) || seen[relative] {
			return journal, messages.Errorf("前回の初期化の記録を読み取れません: %s", directory)
		}
		seen[relative] = true
	}
	return journal, nil
}

func removeSettingsResetStage(stage string, journal settingsResetJournal) error {
	directories := map[string]bool{}
	for _, relative := range journal.Paths {
		path, info, err := entryTreePath(stage, relative)
		if err == nil {
			if info.IsDir() {
				return messages.Errorf("初期化の作業ファイルを確認できません: %s", path)
			}
			if err := os.Remove(path); err != nil {
				return err
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		for parent := filepath.Dir(filepath.FromSlash(relative)); parent != "."; parent = filepath.Dir(parent) {
			directories[parent] = true
		}
	}
	ordered := make([]string, 0, len(directories))
	for directory := range directories {
		ordered = append(ordered, directory)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(ordered)))
	for _, relative := range ordered {
		path, _, err := entryTreePath(stage, filepath.ToSlash(relative))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	entries, err := settingsResetDirectoryEntries(stage, "")
	if err != nil {
		return err
	}
	if len(entries) != 1 || entries[0].Name() != settingsResetJournalName {
		return messages.Errorf("初期化の作業フォルダーに別のファイルがあります: %s", stage)
	}
	if err := os.Remove(filepath.Join(stage, settingsResetJournalName)); err != nil {
		return err
	}
	return os.Remove(stage)
}

func restoreSettingsResetStage(base, stage string, journal settingsResetJournal) error {
	for index := len(journal.Paths) - 1; index >= 0; index-- {
		relative := journal.Paths[index]
		path, info, err := entryTreePath(stage, relative)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if info.IsDir() {
			return messages.Errorf("初期化の作業ファイルを確認できません: %s", path)
		}
		if _, _, err := entryTreePath(base, relative); !errors.Is(err, os.ErrNotExist) {
			if err != nil {
				return err
			}
			return messages.Errorf("初期化前の情報を戻す場所に別のファイルがあります: %s", filepath.Join(base, filepath.FromSlash(relative)))
		}
		parent := filepath.ToSlash(filepath.Dir(filepath.FromSlash(relative)))
		if parent == "." {
			parent = ""
		}
		if _, _, err := entryTreePath(base, parent); err != nil {
			return err
		}
		if err := os.Rename(path, filepath.Join(base, filepath.FromSlash(relative))); err != nil {
			return err
		}
	}
	return removeSettingsResetStage(stage, journal)
}

// A journal makes a stopped process recover either the original files or the
// completed reset. The new generation in settings.json is the commit point.
func recoverSettingsReset(directory string) error {
	base, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(base)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, settingsResetPrefix) || !settingsResetIDPattern.MatchString(strings.TrimPrefix(name, settingsResetPrefix)) {
			continue
		}
		stage, _, err := entryTreePath(base, name)
		if err != nil {
			return err
		}
		journal, err := readSettingsResetJournal(stage)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if name != settingsResetPrefix+journal.Generation {
			return messages.Errorf("前回の初期化の記録を読み取れません: %s", stage)
		}
		data, _, err := readSettingsImportFile(filepath.Join(base, "settings.json"), 1<<20)
		if err != nil {
			return err
		}
		var config configuration
		committed := json.Unmarshal(data, &config) == nil && config.SettingsGeneration == journal.Generation
		if committed {
			err = removeSettingsResetStage(stage, journal)
		} else {
			err = restoreSettingsResetStage(base, stage, journal)
		}
		if err != nil {
			return messages.Errorf("前回の初期化の後処理を完了できません: %w", err)
		}
	}
	return nil
}

func (a *App) applySettingsReset(ctx context.Context, inspection settingsResetInspection, config configuration) (error, error) {
	base := inspection.Directory
	files := append([]settingsResetFile{}, inspection.files...)
	settingsFound := false
	for _, file := range files {
		settingsFound = settingsFound || file.relative == "settings.json"
	}
	if !settingsFound {
		_, info, err := entryTreePath(base, "settings.json")
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		if err == nil {
			if info.IsDir() {
				return nil, fail(http.StatusBadRequest, "保存情報のファイルを確認できません: %s", filepath.Join(base, "settings.json"))
			}
			files = append(files, settingsResetFile{"settings.json", info})
		}
	}
	journal := settingsResetJournal{Version: 1, Generation: config.SettingsGeneration, Paths: []string{}}
	for _, file := range files {
		journal.Paths = append(journal.Paths, file.relative)
		_, info, err := entryTreePath(base, file.relative)
		if err != nil {
			return nil, err
		}
		if !sameEntryInfo(file.info, info) {
			return nil, entryChangedError()
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	stage := filepath.Join(base, settingsResetPrefix+config.SettingsGeneration)
	if err := os.Mkdir(stage, 0700); err != nil {
		return nil, err
	}
	data, err := json.Marshal(journal)
	if err == nil {
		err = writeAtomic(filepath.Join(stage, settingsResetJournalName), append(data, '\n'), 0600)
	}
	if err != nil {
		_ = os.Remove(stage)
		return nil, err
	}
	rollback := func(cause error) (error, error) {
		if err := restoreSettingsResetStage(base, stage, journal); err != nil {
			return nil, messages.Errorf("初期化を中止しましたが，一部の情報を元の場所へ戻せませんでした: %v; %v", cause, err)
		}
		return nil, cause
	}
	for _, file := range files {
		if err := ctx.Err(); err != nil {
			return rollback(err)
		}
		path, info, err := entryTreePath(base, file.relative)
		if err != nil {
			return rollback(err)
		}
		if !sameEntryInfo(file.info, info) {
			return rollback(entryChangedError())
		}
		destination := filepath.Join(stage, filepath.FromSlash(file.relative))
		if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
			return rollback(err)
		}
		if err := os.Rename(path, destination); err != nil {
			return rollback(err)
		}
	}
	if err := ctx.Err(); err != nil {
		return rollback(err)
	}
	data, err = json.MarshalIndent(config, "", "  ")
	if err == nil {
		err = writeAtomicChecked(filepath.Join(base, "settings.json"), append(data, '\n'), 0600, func() error {
			if _, _, err := entryTreePath(base, ""); err != nil {
				return err
			}
			if _, err := os.Lstat(filepath.Join(base, "settings.json")); !errors.Is(err, os.ErrNotExist) {
				if err != nil {
					return err
				}
				return entryChangedError()
			}
			return nil
		})
	}
	if err != nil {
		return rollback(err)
	}
	if err := removeSettingsResetStage(stage, journal); err != nil {
		return messages.Errorf("初期化は完了しましたが，作業ファイルを消去できませんでした．アプリを起動し直すと再度消去します: %v", err), nil
	}
	return nil, nil
}
