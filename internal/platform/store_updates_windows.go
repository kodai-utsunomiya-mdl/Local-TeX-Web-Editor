//go:build windows

package platform

import (
	"context"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
)

// The interface layout comes from Microsoft's Windows metadata:
// https://github.com/microsoft/windows-rs/blob/master/crates/libs/windows/src/Windows/Services/Store/mod.rs
var (
	iidStoreContextStatics = nativeGUID{0x9c06ee5f, 0x15c0, 0x4e72, [8]byte{0x93, 0x30, 0xd6, 0x19, 0x1c, 0xeb, 0xd1, 0x9c}}
	iidStoreContext3       = nativeGUID{0xe26226ca, 0x1a01, 0x4730, [8]byte{0x85, 0xa6, 0xec, 0xc8, 0x96, 0xe4, 0xae, 0x38}}
	iidStoreWindow         = nativeGUID{0x3e68d4bd, 0x7135, 0x4d10, [8]byte{0x80, 0x18, 0x9f, 0xb6, 0xd9, 0xf3, 0x3f, 0xa1}}
	iidStoreAsyncInfo      = nativeGUID{0x00000036, 0, 0, [8]byte{0xc0, 0, 0, 0, 0, 0, 0, 0x46}}
	// IIterable<StorePackageUpdate>, using the WinRT parameterized-interface
	// signature pinterface({faa585ea-6214-4217-afda-7f46de5869b3};
	// rc(Windows.Services.Store.StorePackageUpdate;{140fa150-3cbf-4a35-b91f-48271c31b072})).
	iidStoreUpdateIterable = nativeGUID{0x6b076c51, 0x849e, 0x5ec5, [8]byte{0xae, 0xd5, 0x9b, 0x05, 0x85, 0x59, 0x19, 0x02}}
	storeUpdatesGate       = make(chan struct{}, 1)
	storeWindowOnce        sync.Once
	storeWindowErr         error
	storeWindowClass       = syscall.StringToUTF16Ptr("LocalTeXEditor.StoreUpdates")
)

// ManageStoreUpdates runs on an STA with an owning window and a message loop.
// It only asks the Store for this packaged app; it never opens a web release or
// installs a package downloaded by the application itself.
func ManageStoreUpdates(ctx context.Context, options StoreUpdateOptions) (StoreUpdateState, error) {
	if err := validateStoreUpdateRequest(ctx, options); err != nil {
		return StoreUpdateState{}, err
	}
	identity, err := CurrentPackageIdentity()
	if err != nil {
		return StoreUpdateState{}, err
	}
	if identity == nil {
		return StoreUpdateState{Status: "unsupported"}, ErrStoreUpdatesUnsupported
	}
	limit := 20 * time.Minute
	if options.Action == "check" {
		limit = 45 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	select {
	case storeUpdatesGate <- struct{}{}:
		defer func() { <-storeUpdatesGate }()
	case <-ctx.Done():
		return StoreUpdateState{}, ctx.Err()
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	hr, _, _ := startupCombase.NewProc("RoInitialize").Call(0) // RO_INIT_SINGLETHREADED
	if int32(hr) < 0 {
		return StoreUpdateState{}, storeWindowsError(hr)
	}
	defer startupCombase.NewProc("RoUninitialize").Call()
	hwnd, err := newStoreUpdateWindow(options.Interactive)
	if err != nil {
		return StoreUpdateState{}, err
	}
	defer user32.NewProc("DestroyWindow").Call(hwnd)
	store, err := newStoreContext(hwnd)
	if err != nil {
		return StoreUpdateState{}, err
	}
	defer store.call(2)
	return performStoreUpdates(ctx, store, options)
}

func newStoreUpdateWindow(interactive bool) (uintptr, error) {
	instance, _, _ := kernel32.NewProc("GetModuleHandleW").Call(0)
	storeWindowOnce.Do(func() {
		class := nativeWindowClass{procedure: folderControllerCallback, instance: instance, className: storeWindowClass}
		class.size = uint32(unsafe.Sizeof(class))
		atom, _, err := user32.NewProc("RegisterClassExW").Call(uintptr(unsafe.Pointer(&class)))
		if atom == 0 {
			storeWindowErr = messages.Errorf("Microsoft Store の更新画面を準備できません: %w", err)
		}
	})
	if storeWindowErr != nil {
		return 0, storeWindowErr
	}
	var owner uintptr
	if interactive {
		owner, _, _ = user32.NewProc("GetForegroundWindow").Call()
	}
	title := syscall.StringToUTF16Ptr("Local TeX Web Editor")
	hwnd, _, err := user32.NewProc("CreateWindowExW").Call(0x80,
		uintptr(unsafe.Pointer(storeWindowClass)), uintptr(unsafe.Pointer(title)), 0x80000000,
		100, 100, 640, 480, owner, 0, instance, 0) // WS_EX_TOOLWINDOW; WS_POPUP
	if hwnd == 0 {
		return 0, messages.Errorf("Microsoft Store の更新画面を準備できません: %w", err)
	}
	return hwnd, nil
}

func newStoreContext(hwnd uintptr) (*nativeCOMObject, error) {
	name, _ := syscall.UTF16FromString("Windows.Services.Store.StoreContext")
	var class uintptr
	hr, _, _ := startupCombase.NewProc("WindowsCreateString").Call(
		uintptr(unsafe.Pointer(&name[0])), uintptr(len(name)-1), uintptr(unsafe.Pointer(&class)))
	if int32(hr) < 0 {
		return nil, storeWindowsError(hr)
	}
	defer startupCombase.NewProc("WindowsDeleteString").Call(class)
	var factory *nativeCOMObject
	hr, _, _ = startupCombase.NewProc("RoGetActivationFactory").Call(class,
		uintptr(unsafe.Pointer(&iidStoreContextStatics)), uintptr(unsafe.Pointer(&factory)))
	if int32(hr) < 0 || factory == nil {
		return nil, storeWindowsError(hr)
	}
	defer factory.call(2)
	var store *nativeCOMObject
	if hr = factory.call(6, uintptr(unsafe.Pointer(&store))); int32(hr) < 0 || store == nil { // GetDefault
		return nil, storeWindowsError(hr)
	}
	var window *nativeCOMObject
	hr = store.call(0, uintptr(unsafe.Pointer(&iidStoreWindow)), uintptr(unsafe.Pointer(&window)))
	if int32(hr) < 0 || window == nil {
		store.call(2)
		return nil, storeWindowsError(hr)
	}
	defer window.call(2)
	if hr = window.call(3, hwnd); int32(hr) < 0 { // IInitializeWithWindow.Initialize
		store.call(2)
		return nil, storeWindowsError(hr)
	}
	return store, nil
}

func performStoreUpdates(ctx context.Context, store *nativeCOMObject, options StoreUpdateOptions) (StoreUpdateState, error) {
	state := StoreUpdateState{Status: "current"}
	var operation *nativeCOMObject
	hr := store.call(23, uintptr(unsafe.Pointer(&operation))) // GetAppAndOptionalStorePackageUpdatesAsync
	if int32(hr) < 0 || operation == nil {
		return state, storeWindowsError(hr)
	}
	defer operation.call(2)
	if err := waitStoreOperation(ctx, operation); err != nil {
		return state, err
	}
	var updates *nativeCOMObject
	if hr = operation.call(8, uintptr(unsafe.Pointer(&updates))); int32(hr) < 0 || updates == nil { // GetResults
		return state, storeWindowsError(hr)
	}
	defer updates.call(2)
	var count uint32
	if hr = updates.call(7, uintptr(unsafe.Pointer(&count))); int32(hr) < 0 { // IVectorView.Size
		return state, storeWindowsError(hr)
	}
	state.PackageCount, state.Available = int(count), count > 0
	if !state.Available {
		return state, nil
	}
	state.Status = "available"
	var silent *nativeCOMObject
	hr = store.call(0, uintptr(unsafe.Pointer(&iidStoreContext3)), uintptr(unsafe.Pointer(&silent)))
	if int32(hr) < 0 || silent == nil {
		return state, storeWindowsError(hr)
	}
	defer silent.call(2)
	var allowed uint8
	if hr = silent.call(6, uintptr(unsafe.Pointer(&allowed))); int32(hr) < 0 {
		return state, storeWindowsError(hr)
	}
	state.CanSilentlyDownload = allowed != 0
	if options.Action == "check" {
		return state, nil
	}
	if !state.CanSilentlyDownload && !options.Interactive {
		state.Status = "waiting"
		state.Message = "Microsoft Store の設定や通信の状態により，自動更新を待っています．"
		return state, nil
	}
	var iterable *nativeCOMObject
	hr = updates.call(0, uintptr(unsafe.Pointer(&iidStoreUpdateIterable)), uintptr(unsafe.Pointer(&iterable)))
	if int32(hr) < 0 || iterable == nil {
		return state, storeWindowsError(hr)
	}
	defer iterable.call(2)
	if err := ctx.Err(); err != nil {
		return state, err
	}
	registered := false
	if options.Action == "install" && options.Restart {
		if err := registerStoreRestart(options.ConfigDir); err != nil {
			return state, err
		}
		registered = true
	}
	installed := false
	defer func() {
		if registered && !installed {
			kernel32.NewProc("UnregisterApplicationRestart").Call()
		}
	}()
	var change *nativeCOMObject
	object, index := silent, 7 // TrySilentDownloadStorePackageUpdatesAsync
	if options.Action == "install" {
		index = 8 // TrySilentDownloadAndInstallStorePackageUpdatesAsync
	}
	if options.Interactive {
		object, index = store, 24 // RequestDownloadStorePackageUpdatesAsync
		if options.Action == "install" {
			index = 25 // RequestDownloadAndInstallStorePackageUpdatesAsync
		}
	}
	hr = object.call(index, uintptr(unsafe.Pointer(iterable)), uintptr(unsafe.Pointer(&change)))
	if int32(hr) < 0 || change == nil {
		return state, storeWindowsError(hr)
	}
	defer change.call(2)
	if err := waitStoreOperation(ctx, change); err != nil {
		return state, err
	}
	var result *nativeCOMObject
	if hr = change.call(10, uintptr(unsafe.Pointer(&result))); int32(hr) < 0 || result == nil { // IAsyncOperationWithProgress.GetResults
		return state, storeWindowsError(hr)
	}
	defer result.call(2)
	var overall int32
	if hr = result.call(6, uintptr(unsafe.Pointer(&overall))); int32(hr) < 0 { // OverallState
		return state, storeWindowsError(hr)
	}
	state, err := storeUpdateResult(state, options.Action, overall)
	installed = state.Status == "installed"
	return state, err
}

func waitStoreOperation(ctx context.Context, operation *nativeCOMObject) error {
	if operation == nil {
		return messages.Errorf("Microsoft Store から更新の応答を受け取れませんでした．")
	}
	var info *nativeCOMObject
	hr := operation.call(0, uintptr(unsafe.Pointer(&iidStoreAsyncInfo)), uintptr(unsafe.Pointer(&info)))
	if int32(hr) < 0 || info == nil {
		return storeWindowsError(hr)
	}
	defer info.call(2)
	for {
		if err := ctx.Err(); err != nil {
			info.call(9) // IAsyncInfo.Cancel
			return err
		}
		var status int32
		if hr = info.call(7, uintptr(unsafe.Pointer(&status))); int32(hr) < 0 {
			return storeWindowsError(hr)
		}
		switch status {
		case 1: // Completed
			return nil
		case 2: // Canceled
			return context.Canceled
		case 3: // Error
			var code int32
			if hr = info.call(8, uintptr(unsafe.Pointer(&code))); int32(hr) < 0 {
				return storeWindowsError(hr)
			}
			return storeWindowsError(uintptr(uint32(code)))
		}
		// WinRT callbacks can arrive through this STA while an operation waits.
		// Limit each batch so cancellation is serviced even with many messages.
		for index := 0; index < 32; index++ {
			var message nativeWindowMessage
			found, _, _ := user32.NewProc("PeekMessageW").Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0, 1)
			if found == 0 {
				break
			}
			if message.message == 0x0012 { // WM_QUIT
				info.call(9)
				return context.Canceled
			}
			user32.NewProc("TranslateMessage").Call(uintptr(unsafe.Pointer(&message)))
			user32.NewProc("DispatchMessageW").Call(uintptr(unsafe.Pointer(&message)))
		}
		select {
		case <-ctx.Done():
			info.call(9)
			return ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func storeRestartArguments(configDir string) (string, error) {
	arguments := []string{"--background"}
	if configDir != "" {
		arguments = append(arguments, "--config-dir", configDir)
	}
	for index, argument := range arguments {
		arguments[index] = syscall.EscapeArg(argument)
	}
	commandLine := strings.Join(arguments, " ")
	wide, err := syscall.UTF16FromString(commandLine)
	if err != nil || len(wide) > 1024 {
		return "", messages.Errorf("更新後に開くアプリの起動引数が長すぎるか無効です．")
	}
	return commandLine, nil
}

func registerStoreRestart(configDir string) error {
	arguments, err := storeRestartArguments(configDir)
	if err != nil {
		return err
	}
	wide, _ := syscall.UTF16PtrFromString(arguments)
	// Restart for app updates only. Ordinary crashes, hangs, and OS reboots do
	// not inherit this registration's behavior.
	hr, _, _ := kernel32.NewProc("RegisterApplicationRestart").Call(uintptr(unsafe.Pointer(wide)), 1|2|8)
	if int32(hr) < 0 {
		return storeWindowsError(hr)
	}
	return nil
}

func storeWindowsError(hr uintptr) error {
	return messages.Errorf("Microsoft Store の更新を処理できません (HRESULT 0x%08X)．", uint32(hr))
}
