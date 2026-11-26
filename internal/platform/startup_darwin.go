//go:build darwin

package platform

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
)

func startupMacPaths() (string, string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", "", err
	}
	executable, err := os.Executable()
	if err != nil {
		return "", "", err
	}
	if resolved, err := filepath.EvalSymlinks(executable); err == nil {
		executable = resolved
	}
	if !validStartupMacExecutable(executable) || strings.Contains(executable, "/AppTranslocation/") || strings.HasPrefix(executable, "/Volumes/") {
		return "", "", messages.Errorf("ログイン時に起動するには，アプリケーションフォルダーの Local TeX Web Editor.app から設定してください．")
	}
	return filepath.Join(home, "Library", "LaunchAgents", startupAgentLabel+".plist"), executable, nil
}

func macStartupStateAt(path string) (StartupState, error) {
	if _, err := startupRegularFile(path); errors.Is(err, os.ErrNotExist) {
		return startupDisabled(), nil
	} else if err != nil {
		return StartupState{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return StartupState{}, err
	}
	executable, err := startupLaunchAgentExecutable(data)
	if err != nil {
		return StartupState{}, err
	}
	return startupEnabled(executable), nil
}

func startupMacVersion() (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "/usr/bin/sw_vers", "-productVersion").Output()
	if err != nil {
		return 0, err
	}
	major, _, _ := strings.Cut(strings.TrimSpace(string(output)), ".")
	return strconv.Atoi(major)
}

func macStartupApproval(path string, state StartupState) StartupState {
	major, err := startupMacVersion()
	if err != nil || major < 13 {
		return state
	}
	state.CanOpenSettings = true
	if !state.Enabled {
		return state
	}
	// macOS 12 uses LaunchAgents directly. On newer systems, read the user's
	// authorization through ServiceManagement rather than changing that choice.
	const script = `ObjC.import('Foundation'); ObjC.import('ServiceManagement');
function run(argv) { return String($.SMAppService.statusForLegacyURL($.NSURL.fileURLWithPath(argv[0]))); }`
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "/usr/bin/osascript", "-l", "JavaScript", "-e", script, path).Output()
	if err == nil && strings.TrimSpace(string(output)) == "1" {
		return state
	}
	state.Enabled, state.CanEnable = false, false
	state.Status = "requires-approval"
	state.Message = "macOS のシステム設定でログイン項目を開き，Local TeX Web Editor のバックグラウンドでの実行を許可してください．"
	if err != nil || strings.TrimSpace(string(output)) != "2" {
		state.Status = "registered"
		state.Message = "自動起動を登録しました．macOS のシステム設定のログイン項目で，バックグラウンドでの実行を確認してください．"
	}
	return state
}

func StartupStatus(configDir string) (StartupState, error) {
	startupRegistrationMu.Lock()
	defer startupRegistrationMu.Unlock()
	if !startupConfigSupported(configDir) {
		return startupUnsupported(), nil
	}
	path, _, err := startupMacPaths()
	if err != nil {
		return StartupState{Status: "unsupported", Message: err.Error()}, nil
	}
	state, err := macStartupStateAt(path)
	if err != nil {
		return StartupState{}, err
	}
	return macStartupApproval(path, state), nil
}

func SetStartupEnabled(configDir string, enabled bool) (StartupState, error) {
	startupRegistrationMu.Lock()
	defer startupRegistrationMu.Unlock()
	if !startupConfigSupported(configDir) {
		return startupUnsupported(), ErrStartupUnsupported
	}
	path, executable, err := startupMacPaths()
	if err != nil {
		return StartupState{}, err
	}
	before, err := macStartupStateAt(path)
	if err != nil {
		return StartupState{}, err
	}
	if !enabled {
		if before.Enabled {
			// Removing next login's registration leaves this editing session running.
			if err := os.Remove(path); err != nil {
				return StartupState{}, err
			}
		}
		state := startupDisabled()
		major, _ := startupMacVersion()
		state.CanOpenSettings = major >= 13
		return state, nil
	}
	if err := writeStartupFile(path, startupLaunchAgent(executable), before.Enabled); err != nil {
		return StartupState{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	domain := fmt.Sprintf("gui/%d", os.Getuid())
	if err := exec.CommandContext(ctx, "/bin/launchctl", "bootstrap", domain, path).Run(); err != nil {
		// An already loaded agent uses the newly written path at the next login.
		if err := exec.CommandContext(ctx, "/bin/launchctl", "print", domain+"/"+startupAgentLabel).Run(); err != nil {
			state := macStartupApproval(path, startupEnabled(executable))
			if state.Status == "requires-approval" || state.Status == "registered" {
				return state, nil
			}
			return StartupState{}, messages.Errorf("macOS のログイン項目を登録できません: %w", err)
		}
	}
	return macStartupApproval(path, startupEnabled(executable)), nil
}

func OpenStartupSettings() error {
	return OpenBrowser("x-apple.systempreferences:com.apple.LoginItems-Settings.extension")
}

func RefreshStartupRegistration(configDir string) error {
	startupRegistrationMu.Lock()
	defer startupRegistrationMu.Unlock()
	if !startupConfigSupported(configDir) {
		return nil
	}
	path, executable, err := startupMacPaths()
	if err != nil {
		return nil
	}
	state, err := macStartupStateAt(path)
	if err != nil || !state.Enabled || state.Executable == executable {
		return err
	}
	return writeStartupFile(path, startupLaunchAgent(executable), true)
}
