package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

const legacySettingsImportMarker = "imported-from-zip.json"

type settingsImportFile struct {
	relative string
	data     []byte
}

// ImportLegacySettings runs while the new application holds its startup lock.
// Settings and UI records are read in full before any file is copied. A marker
// makes the import a one-time operation, including after a draft is discarded.
func ImportLegacySettings(source, destination string) error {
	if !filepath.IsAbs(source) || !filepath.IsAbs(destination) || samePath(source, destination) {
		return fmt.Errorf("invalid folders for importing the ZIP version's settings")
	}
	marker := filepath.Join(destination, legacySettingsImportMarker)
	data, exists, err := readSettingsImportFile(marker, 4096)
	if err != nil {
		return err
	}
	if exists {
		var record struct {
			Version int `json:"version"`
		}
		if json.Unmarshal(data, &record) != nil || record.Version != 1 {
			return fmt.Errorf("could not read the settings import record: %s", marker)
		}
		return nil
	}

	var files []settingsImportFile
	if exists, err := settingsImportDestinationExists(destination, "settings.json"); err != nil {
		return err
	} else if !exists {
		path := filepath.Join(source, "settings.json")
		data, exists, err := readSettingsImportFile(path, 1<<20)
		if err != nil {
			return err
		}
		if exists {
			var config configuration
			if !settingsImportObject(data) || json.Unmarshal(data, &config) != nil {
				return invalidSettingsImport(path)
			}
			files = append(files, settingsImportFile{relative: "settings.json", data: data})
		}
	}
	uiDirectory := filepath.Join(source, "ui-state")
	entries, err := settingsImportEntries(uiDirectory)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		hash, err := hex.DecodeString(strings.TrimSuffix(name, ".json"))
		if !strings.HasSuffix(name, ".json") || err != nil || len(hash) != sha256.Size {
			continue
		}
		relative := filepath.Join("ui-state", name)
		if exists, err := settingsImportDestinationExists(destination, relative); err != nil {
			return err
		} else if exists {
			continue
		}
		path := filepath.Join(uiDirectory, name)
		data, exists, err := readSettingsImportFile(path, 2*maxTextSize)
		if err != nil {
			return err
		}
		if !exists {
			continue
		}
		var record storedUIValue
		if !settingsImportObject(data) || json.Unmarshal(data, &record) != nil || len(record.Key) == 0 || len(record.Key) > 8192 || len(record.Value) == 0 {
			return invalidSettingsImport(path)
		}
		expectedHash := sha256.Sum256([]byte(record.Key))
		if !bytes.Equal(expectedHash[:], hash) {
			return invalidSettingsImport(path)
		}
		if record.Key != "preferences" && !strings.HasPrefix(record.Key, "drafts:") && !strings.HasPrefix(record.Key, "session:") {
			continue
		}
		files = append(files, settingsImportFile{relative: relative, data: data})
	}

	if err := os.MkdirAll(destination, 0700); err != nil {
		return err
	}
	for _, file := range files {
		path := filepath.Join(destination, file.relative)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return err
		}
		err := writeAtomicChecked(path, file.data, 0600, func() error {
			exists, err := settingsImportDestinationExists(destination, file.relative)
			if exists {
				return os.ErrExist
			}
			return err
		})
		if err != nil && !errors.Is(err, os.ErrExist) {
			return fmt.Errorf("could not import %s: %w", path, err)
		}
	}
	return writeAtomic(marker, []byte("{\"version\":1}\n"), 0600)
}

func settingsImportObject(data []byte) bool {
	data = bytes.TrimSpace(data)
	return len(data) > 0 && data[0] == '{' && utf8.Valid(data) && json.Valid(data)
}

func invalidSettingsImport(path string) error {
	return fmt.Errorf("the saved file is incomplete or invalid: %s; save and close the ZIP version before trying again", path)
}

func settingsImportDestinationExists(destination, relative string) (bool, error) {
	_, err := os.Lstat(filepath.Join(destination, relative))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

func settingsImportEntries(path string) ([]os.DirEntry, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	linked, err := platform.IsReparsePoint(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || linked {
		return nil, fmt.Errorf("the settings folder is not a regular directory: %s", path)
	}
	return os.ReadDir(path)
}

func readSettingsImportFile(path string, limit int64) ([]byte, bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	regular, err := platform.IsRegularFile(path, info)
	if err != nil {
		return nil, false, err
	}
	linked, err := platform.IsReparsePoint(path)
	if err != nil {
		return nil, false, err
	}
	if !regular || info.Mode()&os.ModeSymlink != 0 || linked || info.Size() > limit {
		return nil, false, fmt.Errorf("the saved file cannot be imported: %s", path)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, false, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return nil, false, err
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, false, err
	}
	after, err := os.Stat(path)
	if err != nil {
		return nil, false, err
	}
	if !os.SameFile(info, opened) || !os.SameFile(opened, after) || after.Size() != int64(len(data)) || after.Size() > limit || !info.ModTime().Equal(after.ModTime()) {
		return nil, false, fmt.Errorf("the saved file changed while it was being read: %s; save and close the ZIP version before trying again", path)
	}
	return data, true, nil
}
