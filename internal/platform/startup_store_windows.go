//go:build windows

package platform

import (
	"runtime"
	"syscall"
	"time"
	"unsafe"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
)

var startupCombase = syscall.NewLazyDLL("combase.dll")

// Windows.ApplicationModel metadata:
// https://github.com/microsoft/windows-rs/blob/master/crates/libs/windows/src/Windows/ApplicationModel/mod.rs
var iidStartupTaskStatics = nativeGUID{0xee5b60bd, 0xa148, 0x41a7, [8]byte{0xb2, 0x6e, 0xe8, 0xb8, 0x8a, 0x1e, 0x62, 0xf8}}
var iidStartupAsyncInfo = nativeGUID{0x00000036, 0, 0, [8]byte{0xc0, 0, 0, 0, 0, 0, 0, 0x46}}

func startupHString(value string) (uintptr, func(), error) {
	wide, err := syscall.UTF16FromString(value)
	if err != nil {
		return 0, nil, err
	}
	var handle uintptr
	result, _, _ := startupCombase.NewProc("WindowsCreateString").Call(uintptr(unsafe.Pointer(&wide[0])), uintptr(len(wide)-1), uintptr(unsafe.Pointer(&handle)))
	if int32(result) < 0 {
		return 0, nil, startupWindowsError("準備", result)
	}
	return handle, func() { startupCombase.NewProc("WindowsDeleteString").Call(handle) }, nil
}

func waitStartupOperation(operation *nativeCOMObject) error {
	if operation == nil {
		return messages.Errorf("Windows から起動設定の応答を受け取れませんでした．")
	}
	var info *nativeCOMObject
	result := operation.call(0, uintptr(unsafe.Pointer(&iidStartupAsyncInfo)), uintptr(unsafe.Pointer(&info)))
	if int32(result) < 0 || info == nil {
		return startupWindowsError("読み取り", result)
	}
	defer info.call(2)
	deadline := time.Now().Add(5 * time.Second)
	for {
		var status int32
		if result := info.call(7, uintptr(unsafe.Pointer(&status))); int32(result) < 0 {
			return startupWindowsError("読み取り", result)
		}
		switch status {
		case 1: // AsyncStatus.Completed
			return nil
		case 2:
			return messages.Errorf("ログイン時の起動設定がキャンセルされました．")
		case 3:
			var code int32
			info.call(8, uintptr(unsafe.Pointer(&code)))
			return startupWindowsError("変更", uintptr(uint32(code)))
		}
		if time.Now().After(deadline) {
			info.call(9) // IAsyncInfo.Cancel
			return messages.Errorf("Windows の起動設定から応答がありません．もう一度お試しください．")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func windowsStoreStartup(enabled *bool) (StartupState, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	result, _, _ := startupCombase.NewProc("RoInitialize").Call(1) // RO_INIT_MULTITHREADED
	if int32(result) < 0 {
		return StartupState{}, startupWindowsError("準備", result)
	}
	defer startupCombase.NewProc("RoUninitialize").Call()
	class, freeClass, err := startupHString("Windows.ApplicationModel.StartupTask")
	if err != nil {
		return StartupState{}, err
	}
	defer freeClass()
	var factory *nativeCOMObject
	result, _, _ = startupCombase.NewProc("RoGetActivationFactory").Call(class, uintptr(unsafe.Pointer(&iidStartupTaskStatics)), uintptr(unsafe.Pointer(&factory)))
	if int32(result) < 0 || factory == nil {
		return StartupState{}, startupWindowsError("読み取り", result)
	}
	defer factory.call(2)
	id, freeID, err := startupHString(startupTaskID)
	if err != nil {
		return StartupState{}, err
	}
	defer freeID()
	var operation *nativeCOMObject
	if result := factory.call(7, id, uintptr(unsafe.Pointer(&operation))); int32(result) < 0 || operation == nil {
		return StartupState{}, startupWindowsError("読み取り", result)
	}
	defer operation.call(2)
	if err := waitStartupOperation(operation); err != nil {
		return StartupState{}, err
	}
	var task *nativeCOMObject
	if result := operation.call(8, uintptr(unsafe.Pointer(&task))); int32(result) < 0 || task == nil {
		return StartupState{}, startupWindowsError("読み取り", result)
	}
	defer task.call(2)
	var state int32
	if result := task.call(8, uintptr(unsafe.Pointer(&state))); int32(result) < 0 {
		return StartupState{}, startupWindowsError("読み取り", result)
	}
	if enabled != nil {
		if *enabled && state == 0 {
			var enable *nativeCOMObject
			if result := task.call(6, uintptr(unsafe.Pointer(&enable))); int32(result) < 0 || enable == nil {
				return StartupState{}, startupWindowsError("変更", result)
			}
			defer enable.call(2)
			if err := waitStartupOperation(enable); err != nil {
				return StartupState{}, err
			}
			if result := enable.call(8, uintptr(unsafe.Pointer(&state))); int32(result) < 0 {
				return StartupState{}, startupWindowsError("変更", result)
			}
		} else if !*enabled && state == 2 {
			if result := task.call(7); int32(result) < 0 {
				return StartupState{}, startupWindowsError("変更", result)
			}
			if result := task.call(8, uintptr(unsafe.Pointer(&state))); int32(result) < 0 {
				return StartupState{}, startupWindowsError("読み取り", result)
			}
		}
	}
	return windowsStoreStartupState(state), nil
}

func windowsStoreStartupState(value int32) StartupState {
	state := startupDisabled()
	state.CanOpenSettings = true
	switch value {
	case 0:
	case 1:
		state.CanEnable = false
		state.Status = "disabled-by-user"
		state.Message = "Windows の設定で自動起動が無効になっています．スタートアップの設定でこのアプリを有効にしてください．"
	case 2:
		state = startupEnabled("")
		state.CanOpenSettings = true
	case 3:
		state.CanEnable = false
		state.Status = "disabled-by-policy"
		state.Message = "Windows の管理設定で自動起動が無効になっています．"
	case 4:
		state.Enabled, state.CanEnable = true, false
		state.Status = "enabled-by-policy"
		state.Message = "Windows の管理設定でログイン時に起動します．"
	default:
		state.CanEnable = false
		state.Status = "unavailable"
		state.Message = "Windows のスタートアップ設定で状態を確認してください．"
	}
	return state
}
