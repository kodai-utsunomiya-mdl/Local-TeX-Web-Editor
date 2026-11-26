//go:build windows

package platform

import (
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
)

var (
	classFileSaveDialog = nativeGUID{0xc0b4e2f3, 0xba21, 0x4773, [8]byte{0x8d, 0xba, 0x33, 0x5e, 0xc9, 0x46, 0xeb, 0x8b}}
	iidFileSaveDialog   = nativeGUID{0x84bccd23, 0x5fde, 0x4cdb, [8]byte{0xae, 0xa4, 0xaf, 0x64, 0xb8, 0x3d, 0x78, 0xab}}
)

func saveDialogError(action string, result uintptr) error {
	return messages.Errorf("保存先の選択画面を%sできません (HRESULT 0x%08X)．", messages.Label(action), uint32(result))
}

func showNativeSaveDialog(request *folderPickRequest, suggestedName string) (string, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := request.ctx.Err(); err != nil {
		return "", err
	}
	owner, _, _ := user32.NewProc("GetForegroundWindow").Call()
	result, _, _ := ole32.NewProc("CoInitializeEx").Call(0, 2) // COINIT_APARTMENTTHREADED
	if int32(result) < 0 {
		return "", saveDialogError("初期化", result)
	}
	defer ole32.NewProc("CoUninitialize").Call()
	var dialog *nativeCOMObject
	result, _, _ = ole32.NewProc("CoCreateInstance").Call(
		uintptr(unsafe.Pointer(&classFileSaveDialog)), 0, 1,
		uintptr(unsafe.Pointer(&iidFileSaveDialog)), uintptr(unsafe.Pointer(&dialog)))
	if int32(result) < 0 || dialog == nil {
		return "", saveDialogError("作成", result)
	}
	defer dialog.call(2)
	var options uint32
	if result = dialog.call(10, uintptr(unsafe.Pointer(&options))); int32(result) < 0 {
		return "", saveDialogError("設定", result)
	}
	// FOS_OVERWRITEPROMPT | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR |
	// FOS_PATHMUSTEXIST. Windows asks before accepting an existing file.
	if result = dialog.call(9, uintptr(options|0x2|0x40|0x8|0x800)); int32(result) < 0 {
		return "", saveDialogError("設定", result)
	}
	localizedTitle := messages.Text(messages.LanguageFromContext(request.ctx), saveDialogTitle)
	title, _ := syscall.UTF16PtrFromString(localizedTitle)
	if result = dialog.call(17, uintptr(unsafe.Pointer(title))); int32(result) < 0 {
		return "", saveDialogError("設定", result)
	}
	name, err := syscall.UTF16PtrFromString(suggestedName)
	if err != nil {
		return "", messages.Errorf("保存するファイル名が無効です．")
	}
	if result = dialog.call(15, uintptr(unsafe.Pointer(name))); int32(result) < 0 { // SetFileName
		return "", saveDialogError("設定", result)
	}
	if extension := strings.TrimPrefix(filepath.Ext(suggestedName), "."); extension != "" {
		value, _ := syscall.UTF16PtrFromString(extension)
		if result = dialog.call(22, uintptr(unsafe.Pointer(value))); int32(result) < 0 { // SetDefaultExtension
			return "", saveDialogError("設定", result)
		}
	}
	controller, err := newFileDialogController(request, owner, localizedTitle)
	if err != nil {
		return "", err
	}
	defer controller.destroy()
	stopForwarding := controller.forwardRequests()
	defer stopForwarding()
	if err := request.ctx.Err(); err != nil {
		return "", err
	}
	result = dialog.call(3, controller.hwnd)
	if uint32(result) == hresultCancelled {
		return "", nil
	}
	if int32(result) < 0 {
		return "", saveDialogError("表示", result)
	}
	var item *nativeCOMObject
	if result = dialog.call(20, uintptr(unsafe.Pointer(&item))); int32(result) < 0 || item == nil {
		return "", saveDialogError("読み取り", result)
	}
	defer item.call(2)
	var path *uint16
	if result = item.call(5, 0x80058000, uintptr(unsafe.Pointer(&path))); int32(result) < 0 || path == nil { // SIGDN_FILESYSPATH
		return "", messages.Errorf("選択した保存先のパスを取得できません．")
	}
	defer ole32.NewProc("CoTaskMemFree").Call(uintptr(unsafe.Pointer(path)))
	return nativeWideString(path), nil
}
