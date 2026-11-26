//go:build windows

package platform

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/branding"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
)

var folderStartup = nativeGUID{0xb97d20bb, 0xf46a, 0x4c97, [8]byte{0xba, 0x10, 0x5e, 0x36, 0x08, 0x43, 0x08, 0x54}}

func StartupStatus(configDir string) (StartupState, error) {
	startupRegistrationMu.Lock()
	defer startupRegistrationMu.Unlock()
	if !startupConfigSupported(configDir) {
		return startupUnsupported(), nil
	}
	identity, err := CurrentPackageIdentity()
	if err != nil {
		return StartupState{}, err
	}
	if identity != nil {
		return windowsStoreStartup(nil)
	}
	local, folder, err := windowsStartupFolders(false)
	if err != nil {
		return StartupState{}, err
	}
	state, err := windowsStartupStatusAt(local, folder)
	if err == nil && state.Enabled {
		applyWindowsStartupApproval(&state)
	}
	return state, err
}

func SetStartupEnabled(configDir string, enabled bool) (StartupState, error) {
	startupRegistrationMu.Lock()
	defer startupRegistrationMu.Unlock()
	if !startupConfigSupported(configDir) {
		return startupUnsupported(), ErrStartupUnsupported
	}
	identity, err := CurrentPackageIdentity()
	if err != nil {
		return StartupState{}, err
	}
	if identity != nil {
		return windowsStoreStartup(&enabled)
	}
	local, folder, err := windowsStartupFolders(enabled)
	if err != nil {
		return StartupState{}, err
	}
	source, err := os.Executable()
	if err != nil {
		return StartupState{}, err
	}
	state, err := setWindowsStartupAt(source, local, folder, enabled)
	if err == nil && state.Enabled {
		applyWindowsStartupApproval(&state)
	}
	return state, err
}

func OpenStartupSettings() error { return OpenBrowser("ms-settings:startupapps") }

func RefreshStartupRegistration(configDir string) error {
	startupRegistrationMu.Lock()
	defer startupRegistrationMu.Unlock()
	if !startupConfigSupported(configDir) {
		return nil
	}
	identity, err := CurrentPackageIdentity()
	if err != nil || identity != nil {
		return err
	}
	local, folder, err := windowsStartupFolders(false)
	if err != nil {
		return err
	}
	state, err := windowsStartupStatusAt(local, folder)
	if err != nil || !state.Enabled {
		return err
	}
	source, err := os.Executable()
	if err != nil {
		return err
	}
	_, err = setWindowsStartupAt(source, local, folder, true)
	return err
}

func windowsStartupFolders(create bool) (string, string, error) {
	local, err := existingShortcutFolder(&folderLocalAppData)
	if err != nil {
		return "", "", err
	}
	var folder string
	if create {
		folder, err = knownShortcutFolder(&folderStartup)
	} else {
		var wide *uint16
		result, _, _ := shell32.NewProc("SHGetKnownFolderPath").Call(uintptr(unsafe.Pointer(&folderStartup)), 0x4000, 0, uintptr(unsafe.Pointer(&wide))) // KF_FLAG_DONT_VERIFY
		if wide != nil {
			defer ole32.NewProc("CoTaskMemFree").Call(uintptr(unsafe.Pointer(wide)))
		}
		if int32(result) >= 0 && wide != nil {
			folder = nativeWideString(wide)
		} else {
			err = startupWindowsError("読み取り", result)
		}
	}
	return local, folder, err
}

func windowsStartupStatusAt(local, folder string) (StartupState, error) {
	state := startupDisabled()
	state.CanOpenSettings = true
	path := filepath.Join(folder, shortcutName)
	if _, err := startupRegularFile(path); errors.Is(err, os.ErrNotExist) {
		return state, nil
	} else if err != nil {
		return StartupState{}, err
	}
	link, err := readShellShortcut(path)
	target := filepath.Join(local, "Programs", branding.DataDirectoryName, shortcutExecutableName)
	if err != nil || !startupPathsEqual(link.Target, target) || link.Arguments != "--background" {
		return StartupState{}, ErrStartupConflict
	}
	state = startupEnabled(target)
	state.CanOpenSettings = true
	return state, nil
}

func setWindowsStartupAt(source, local, folder string, enabled bool) (StartupState, error) {
	before, err := windowsStartupStatusAt(local, folder)
	if err != nil {
		return StartupState{}, err
	}
	path := filepath.Join(folder, shortcutName)
	if !enabled {
		if before.Enabled {
			if err := os.Remove(path); err != nil {
				return StartupState{}, err
			}
			notifyShellChange(path, 0x00000004) // SHCNE_DELETE
		}
		return windowsStartupStatusAt(local, folder)
	}
	directory, err := shortcutInstallDirectory(local)
	if err != nil {
		return StartupState{}, err
	}
	release, err := acquireNamedLock(directory, `Local\LocalTeXEditorInstall-`)
	if err != nil {
		return StartupState{}, err
	}
	defer release()
	installed, err := installShortcutExecutable(source, directory)
	if err != nil {
		return StartupState{}, err
	}
	icon, created, err := installShortcutIcon(directory)
	if err != nil {
		return StartupState{}, err
	}
	if err := os.MkdirAll(folder, 0700); err != nil {
		return StartupState{}, err
	}
	file, err := os.CreateTemp(folder, "Local TeX Web Editor-*.lnk")
	if err != nil {
		return StartupState{}, err
	}
	temporary := file.Name()
	_ = file.Close()
	defer os.Remove(temporary)
	if err := writeShellShortcutWithArguments(temporary, installed, icon, "--background"); err != nil {
		return StartupState{}, err
	}
	if err := commitShortcutFile(temporary, path, before.Enabled); err != nil {
		return StartupState{}, err
	}
	notifyShellFileChange(installed, false)
	notifyShellFileChange(icon, created)
	notifyShellFileChange(path, !before.Enabled)
	return windowsStartupStatusAt(local, folder)
}

// Read Task Manager's choice without changing it. A new registration or an
// application update must not turn an OS-disabled startup entry back on.
func applyWindowsStartupApproval(state *StartupState) {
	keyName, _ := syscall.UTF16PtrFromString(`Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder`)
	var key syscall.Handle
	if err := syscall.RegOpenKeyEx(syscall.HKEY_CURRENT_USER, keyName, 0, syscall.KEY_READ, &key); err != nil {
		return
	}
	defer syscall.RegCloseKey(key)
	name, _ := syscall.UTF16PtrFromString(shortcutName)
	data := make([]byte, 32)
	var kind uint32
	size := uint32(len(data))
	if err := syscall.RegQueryValueEx(key, name, nil, &kind, &data[0], &size); err != nil || kind != syscall.REG_BINARY || size < 4 {
		return
	}
	if data[0] == 2 || data[0] == 6 {
		return
	}
	state.Enabled, state.CanEnable = false, false
	state.Status = "disabled-by-user"
	state.Message = "Windows の設定で自動起動が無効になっています．スタートアップの設定でこのアプリを有効にしてください．"
}

func startupWindowsError(action string, result uintptr) error {
	return messages.Errorf("ログイン時の起動設定を%sできません (HRESULT 0x%08X)．", messages.Label(action), uint32(result))
}
