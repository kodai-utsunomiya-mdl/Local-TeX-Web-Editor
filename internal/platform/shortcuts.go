package platform

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/branding"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
)

// The installation identity remains compatible with the pre-rename records.
const shortcutApplication = "github.com/kodai-utsunomiya-mdl/local-tex-editor"
const shortcutExecutableName = branding.ExecutableName + ".exe"
const legacyShortcutExecutableName = "local-tex-editor.exe"
const shortcutManifestName = "installation.json"
const shortcutName = branding.Name + ".lnk"
const legacyShortcutName = "Local TeX Editor.lnk"
const shortcutExecutableLimit int64 = 512 << 20

var ErrShortcutsUnsupported = messages.Errorf("起動用のショートカット作成は Windows で利用できます．")
var ErrShortcutsManagedByWindows = messages.Errorf("このアプリのインストールと更新は Windows が管理しています．スタートメニューから起動できます．")
var ErrShortcutConflict = messages.Errorf("作成先のファイルを確認してください．")

type ShortcutResult struct {
	Executable string `json:"executable"`
	Shortcut   string `json:"shortcut"`
	Message    string `json:"message"`
}

type shortcutInstallation struct {
	Application string `json:"application"`
	Format      int    `json:"format"`
	SHA256      string `json:"sha256"`
}

func shortcutPathsEqual(first, second string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(first), filepath.Clean(second))
	}
	return filepath.Clean(first) == filepath.Clean(second)
}

func shortcutSameFile(first, second string) bool {
	if shortcutPathsEqual(first, second) {
		return true
	}
	firstInfo, firstErr := os.Stat(first)
	secondInfo, secondErr := os.Stat(second)
	return firstErr == nil && secondErr == nil && os.SameFile(firstInfo, secondInfo)
}

func shortcutInstallDirectory(localAppData string) (string, error) {
	if !filepath.IsAbs(localAppData) {
		return "", messages.Errorf("アプリの保存先を取得できません．")
	}
	directory := localAppData
	for _, component := range []string{"Programs", branding.DataDirectoryName} {
		directory = filepath.Join(directory, component)
		if err := os.Mkdir(directory, 0700); err != nil && !errors.Is(err, os.ErrExist) {
			return "", messages.Errorf("アプリの保存先を作成できません (%s): %w", directory, err)
		}
		info, err := os.Lstat(directory)
		if err != nil {
			return "", err
		}
		linked, err := IsReparsePoint(directory)
		if err != nil {
			return "", err
		}
		if linked || !info.IsDir() {
			return "", messages.Errorf("アプリの保存先が通常のフォルダーではありません (%s)．%w", directory, ErrShortcutConflict)
		}
	}
	return directory, nil
}

func shortcutRegularFile(path string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	linked, err := IsReparsePoint(path)
	if err != nil {
		return nil, err
	}
	regular, err := IsRegularFile(path, info)
	if err != nil {
		return nil, err
	}
	if linked || !regular {
		return nil, messages.Errorf("通常のファイルとして扱えません (%s)．%w", path, ErrShortcutConflict)
	}
	return info, nil
}

func shortcutFileHash(path string) (string, error) {
	info, err := shortcutRegularFile(path)
	if err != nil {
		return "", err
	}
	if info.Size() <= 0 || info.Size() > shortcutExecutableLimit {
		return "", messages.Errorf("アプリの実行ファイルのサイズを確認してください (%s)．%w", path, ErrShortcutConflict)
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	written, err := io.Copy(hash, io.LimitReader(file, shortcutExecutableLimit+1))
	if err != nil {
		return "", err
	}
	if written != info.Size() {
		return "", messages.Errorf("実行ファイルが読み込み中に変更されました．もう一度操作してください．")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func readShortcutInstallation(path string) (*shortcutInstallation, error) {
	info, err := shortcutRegularFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if info.Size() > 4096 {
		return nil, messages.Errorf("この保存先に別の installation.json があります (%s)．%w", path, ErrShortcutConflict)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil {
		return nil, err
	}
	var value shortcutInstallation
	if len(data) > 4096 || json.Unmarshal(data, &value) != nil || value.Application != shortcutApplication || value.Format != 1 {
		return nil, messages.Errorf("この保存先に別の installation.json があります (%s)．%w", path, ErrShortcutConflict)
	}
	if hash, err := hex.DecodeString(value.SHA256); err != nil || len(hash) != sha256.Size {
		return nil, messages.Errorf("アプリの配置情報を読めません (%s)．%w", path, ErrShortcutConflict)
	}
	return &value, nil
}

// The caller supplies its own executable and a directory obtained from the
// current user's known folders. API request fields never supply either path.
func installShortcutExecutable(source, directory string) (string, error) {
	source, err := filepath.EvalSymlinks(source)
	if err != nil {
		return "", messages.Errorf("起動中の実行ファイルを開けません: %w", err)
	}
	sourceHash, err := shortcutFileHash(source)
	if err != nil {
		return "", err
	}
	target := filepath.Join(directory, shortcutExecutableName)
	manifestPath := filepath.Join(directory, shortcutManifestName)
	manifest, err := readShortcutInstallation(manifestPath)
	if err != nil {
		return "", err
	}
	existing, err := shortcutRegularFile(target)
	exists := err == nil
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	legacy, err := registeredLegacyShortcut(directory, manifest, exists)
	if err != nil {
		return "", err
	}
	copyNeeded := !exists
	if exists {
		targetHash := sourceHash
		// Launching the installed executable reads the same file through both
		// paths. Its contents have already been hashed for this operation.
		if !shortcutSameFile(source, target) {
			targetHash, err = shortcutFileHash(target)
			if err != nil {
				return "", err
			}
		}
		copyNeeded = targetHash != sourceHash
		if copyNeeded && (manifest == nil || manifest.SHA256 != targetHash) {
			return "", messages.Errorf("配置先の実行ファイルが，このアプリの配置記録と一致しません (%s)．%w", target, ErrShortcutConflict)
		}
		if shortcutPathsEqual(source, target) {
			copyNeeded = false
		}
	}
	if copyNeeded {
		staged, err := stageShortcutExecutable(source, directory, sourceHash)
		if err != nil {
			return "", err
		}
		defer os.Remove(staged)
		if exists {
			current, err := shortcutRegularFile(target)
			if err != nil || !os.SameFile(existing, current) || existing.Size() != current.Size() || !existing.ModTime().Equal(current.ModTime()) {
				return "", messages.Errorf("配置先の実行ファイルが操作中に変更されました．%w", ErrShortcutConflict)
			}
		}
		if err := commitShortcutFile(staged, target, exists); err != nil {
			return "", messages.Errorf("配置先のアプリを更新できません (%s)．起動中の Local TeX Web Editor を終了し，新しい実行ファイルを開いてから再度操作してください．%w (%w)", target, ErrShortcutConflict, err)
		}
	}
	if legacy != nil && manifest.SHA256 != sourceHash {
		if err := updateLegacyShortcutExecutable(target, directory, sourceHash, legacy); err != nil {
			return "", err
		}
	}
	if manifest == nil || manifest.SHA256 != sourceHash {
		data, err := json.MarshalIndent(shortcutInstallation{Application: shortcutApplication, Format: 1, SHA256: sourceHash}, "", "  ")
		if err != nil {
			return "", err
		}
		if err := writeShortcutInstallation(manifestPath, append(data, '\n'), manifest != nil); err != nil {
			return "", messages.Errorf("アプリの配置情報を保存できません: %w", err)
		}
	}
	return target, nil
}

// Existing pins and user-created links can still target the old filename.
// Update that file only when its hash agrees with this application's record.
func registeredLegacyShortcut(directory string, manifest *shortcutInstallation, currentExists bool) (os.FileInfo, error) {
	if manifest == nil {
		return nil, nil
	}
	path := filepath.Join(directory, legacyShortcutExecutableName)
	info, err := shortcutRegularFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	hash, err := shortcutFileHash(path)
	if err != nil {
		return nil, err
	}
	if hash != manifest.SHA256 {
		if !currentExists {
			return nil, messages.Errorf("配置先の実行ファイルが，このアプリの配置記録と一致しません (%s)．%w", path, ErrShortcutConflict)
		}
		return nil, nil
	}
	return info, nil
}

func updateLegacyShortcutExecutable(installed, directory, expectedHash string, previous os.FileInfo) error {
	// A hard link gives the old launch path the same executable without a second
	// copy. File systems without hard links can use the regular staged copy.
	file, err := os.CreateTemp(directory, "local-tex-web-editor-legacy-*.tmp")
	if err != nil {
		return err
	}
	staged := file.Name()
	if err := file.Close(); err != nil {
		_ = os.Remove(staged)
		return err
	}
	if err := os.Remove(staged); err != nil {
		return err
	}
	if err := os.Link(installed, staged); err != nil {
		staged, err = stageShortcutExecutable(installed, directory, expectedHash)
		if err != nil {
			return err
		}
	}
	defer os.Remove(staged)
	legacy := filepath.Join(directory, legacyShortcutExecutableName)
	current, err := shortcutRegularFile(legacy)
	if err != nil || !os.SameFile(previous, current) || previous.Size() != current.Size() || !previous.ModTime().Equal(current.ModTime()) {
		return messages.Errorf("配置先の実行ファイルが操作中に変更されました．%w", ErrShortcutConflict)
	}
	if err := commitShortcutFile(staged, legacy, true); err != nil {
		return messages.Errorf("配置先のアプリを更新できません (%s)．起動中の Local TeX Web Editor を終了し，新しい実行ファイルを開いてから再度操作してください．%w (%w)", legacy, ErrShortcutConflict, err)
	}
	return nil
}

func stageShortcutExecutable(source, directory, expectedHash string) (string, error) {
	input, err := os.Open(source)
	if err != nil {
		return "", err
	}
	defer input.Close()
	output, err := os.CreateTemp(directory, "local-tex-editor-*.tmp")
	if err != nil {
		return "", err
	}
	name := output.Name()
	done := false
	defer func() {
		_ = output.Close()
		if !done {
			_ = os.Remove(name)
		}
	}()
	hash := sha256.New()
	if _, err := io.Copy(io.MultiWriter(output, hash), io.LimitReader(input, shortcutExecutableLimit+1)); err != nil {
		return "", err
	}
	if hex.EncodeToString(hash.Sum(nil)) != expectedHash {
		return "", messages.Errorf("実行ファイルがコピー中に変更されました．もう一度操作してください．")
	}
	if err := output.Sync(); err != nil {
		return "", err
	}
	if err := output.Close(); err != nil {
		return "", err
	}
	done = true
	return name, nil
}

func writeShortcutInstallation(path string, data []byte, replace bool) error {
	file, err := os.CreateTemp(filepath.Dir(path), "installation-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return commitShortcutFile(file.Name(), path, replace)
}

// A new name for each artwork revision also gives Explorer a new cache entry.
// The .lnk can then use the updated icon even after the executable is replaced
// at its existing installation path.
func installShortcutIcon(directory string) (string, bool, error) {
	hash := sha256.Sum256(branding.Icon)
	name := "local-tex-editor-icon-" + hex.EncodeToString(hash[:8]) + ".ico"
	path := filepath.Join(directory, name)
	if info, err := shortcutRegularFile(path); err == nil {
		if info.Size() != int64(len(branding.Icon)) {
			return "", false, messages.Errorf("アプリのアイコンと同名の別ファイルがあります (%s)．%w", path, ErrShortcutConflict)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return "", false, err
		}
		if !bytes.Equal(data, branding.Icon) {
			return "", false, messages.Errorf("アプリのアイコンと同名の別ファイルがあります (%s)．%w", path, ErrShortcutConflict)
		}
		return path, false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", false, err
	}
	file, err := os.CreateTemp(directory, "local-tex-editor-icon-*.tmp")
	if err != nil {
		return "", false, err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err := file.Write(branding.Icon); err != nil {
		return "", false, err
	}
	if err := file.Sync(); err != nil {
		return "", false, err
	}
	if err := file.Close(); err != nil {
		return "", false, err
	}
	if err := commitShortcutFile(file.Name(), path, false); err != nil {
		return "", false, err
	}
	return path, true, nil
}
