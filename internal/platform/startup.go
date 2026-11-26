package platform

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
)

const startupTaskID = "LocalTeXWebEditorBackground"
const startupAgentLabel = "io.github.kodai-utsunomiya-mdl.local-tex-editor.background"

var startupRegistrationMu sync.Mutex

var ErrStartupUnsupported = messages.Errorf("ログイン時の自動起動は Windows と Mac の通常の設定フォルダーで利用できます．")
var ErrStartupConflict = messages.Errorf("自動起動の登録先に別のファイルがあります．内容を確認してください．")

type StartupState struct {
	Supported       bool   `json:"supported"`
	Enabled         bool   `json:"enabled"`
	CanEnable       bool   `json:"canEnable"`
	CanDisable      bool   `json:"canDisable"`
	CanOpenSettings bool   `json:"canOpenSettings"`
	Status          string `json:"status"`
	Message         string `json:"message"`
	Executable      string `json:"executable,omitempty"`
}

func startupConfigSupported(configDir string) bool {
	directories, err := DefaultConfigDirectories()
	if err != nil {
		return false
	}
	return startupPathsEqual(configDir, directories.Directory)
}

func startupPathsEqual(first, second string) bool {
	first, firstErr := filepath.Abs(first)
	second, secondErr := filepath.Abs(second)
	if firstErr != nil || secondErr != nil {
		return false
	}
	if resolved, err := filepath.EvalSymlinks(first); err == nil {
		first = resolved
	}
	if resolved, err := filepath.EvalSymlinks(second); err == nil {
		second = resolved
	}
	if runtime.GOOS == "windows" {
		return strings.EqualFold(first, second)
	}
	return first == second
}

func startupUnsupported() StartupState {
	return StartupState{Status: "unsupported", Message: ErrStartupUnsupported.Error()}
}

func startupDisabled() StartupState {
	return StartupState{Supported: true, CanEnable: true, Status: "disabled", Message: "ログイン時の自動起動は無効です．"}
}

func startupEnabled(executable string) StartupState {
	return StartupState{Supported: true, Enabled: true, CanDisable: true, Status: "enabled", Executable: executable,
		Message: "ログイン時にバックグラウンドで起動します．ブラウザで前回のタブを復元すると編集画面へ戻れます．"}
}

func startupRegularFile(path string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	linked, err := IsReparsePoint(path)
	if err != nil {
		return nil, err
	}
	if linked || !info.Mode().IsRegular() || info.Size() > 1<<20 {
		return nil, ErrStartupConflict
	}
	return info, nil
}

func writeStartupFile(path string, data []byte, replace bool) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	if info, err := os.Lstat(filepath.Dir(path)); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return ErrStartupConflict
	}
	if _, err := startupRegularFile(path); err == nil && !replace {
		return ErrStartupConflict
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".local-tex-startup-*")
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
	return os.Rename(file.Name(), path)
}
