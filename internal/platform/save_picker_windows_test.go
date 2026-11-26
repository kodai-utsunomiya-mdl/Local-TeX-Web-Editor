//go:build windows

package platform

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func nativeSaveWindows() []uintptr {
	var windows []uintptr
	title := syscall.StringToUTF16Ptr(saveDialogTitle)
	var previous uintptr
	for {
		hwnd, _, _ := user32.NewProc("FindWindowExW").Call(0, previous, 0, uintptr(unsafe.Pointer(title)))
		if hwnd == 0 {
			return windows
		}
		previous = hwnd
		var pid uint32
		user32.NewProc("GetWindowThreadProcessId").Call(hwnd, uintptr(unsafe.Pointer(&pid)))
		visible, _, _ := user32.NewProc("IsWindowVisible").Call(hwnd)
		if pid == uint32(os.Getpid()) && visible != 0 {
			windows = append(windows, hwnd)
		}
	}
}

func waitForNativeSave(t *testing.T, exists bool) uintptr {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		windows := nativeSaveWindows()
		if !exists && len(windows) == 0 {
			return 0
		}
		if exists && len(windows) == 1 {
			active, _, _ := user32.NewProc("GetForegroundWindow").Call()
			if active == windows[0] {
				return windows[0]
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("native Save As windows = %v; want visible=%v", nativeSaveWindows(), exists)
	return 0
}

func TestNativeSavePickerSelectsANameAndCanBeCancelled(t *testing.T) {
	if os.Getenv("LOCAL_TEX_EDITOR_TEST_NATIVE_PICKER") != "1" {
		t.Skip("set LOCAL_TEX_EDITOR_TEST_NATIVE_PICKER=1 on an interactive Windows runner")
	}
	owner := nativeTestOwner(t, "Local TeX Web Editor Save As owner")
	t.Cleanup(CancelSavePicker)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	first := savePickerAsync(&documentSavePicker, ctx, "原稿.tex")
	hwnd := waitForNativeSave(t, true)
	if enabled, _, _ := user32.NewProc("IsWindowEnabled").Call(owner); enabled == 0 {
		t.Fatal("the browser owner was disabled while Save As was open")
	}
	if path, err := PickSaveFile(ctx, "different.pdf"); path != "" || err == nil {
		t.Fatalf("a concurrent save reused the first dialog: %q, %v", path, err)
	}
	var nameEdit uintptr
	callback := syscall.NewCallback(func(child, _ uintptr) uintptr {
		var class, text [1024]uint16
		user32.NewProc("GetClassNameW").Call(child, uintptr(unsafe.Pointer(&class[0])), uintptr(len(class)))
		user32.NewProc("GetWindowTextW").Call(child, uintptr(unsafe.Pointer(&text[0])), uintptr(len(text)))
		if strings.EqualFold(syscall.UTF16ToString(class[:]), "Edit") && syscall.UTF16ToString(text[:]) == "原稿.tex" {
			nameEdit = child
			return 0
		}
		return 1
	})
	user32.NewProc("EnumChildWindows").Call(hwnd, callback, 0)
	if nameEdit == 0 {
		t.Fatal("the suggested file name did not appear in the Save As name field")
	}
	selected := filepath.Join(t.TempDir(), "選択した原稿.tex")
	value := syscall.StringToUTF16Ptr(selected)
	if ok, _, _ := user32.NewProc("SetWindowTextW").Call(nameEdit, uintptr(unsafe.Pointer(value))); ok == 0 {
		t.Fatal("could not enter the destination in the native name field")
	}
	user32.NewProc("PostMessageW").Call(hwnd, 0x0111, 1, 0) // WM_COMMAND, IDOK
	if result := pickerResult(t, first); !strings.EqualFold(result.path, selected) || result.err != nil {
		t.Fatalf("native save destination = %+v, want %q", result, selected)
	}
	if _, err := os.Stat(selected); !os.IsNotExist(err) {
		t.Fatalf("choosing a destination wrote a file before the app could check it: %v", err)
	}
	waitForNativeSave(t, false)
	second := savePickerAsync(&documentSavePicker, ctx, "different.pdf")
	hwnd = waitForNativeSave(t, true)
	user32.NewProc("PostMessageW").Call(hwnd, 0x0010, 0, 0)
	if result := pickerResult(t, second); result.path != "" || result.err != nil {
		t.Fatalf("cancelling Save As = %+v", result)
	}
	waitForNativeSave(t, false)
	third := savePickerAsync(&documentSavePicker, ctx, "third.md")
	waitForNativeSave(t, true)
	cancel()
	if result := pickerResult(t, third); result.path != "" || !errors.Is(result.err, context.Canceled) {
		t.Fatalf("disconnecting Save As = %+v", result)
	}
	waitForNativeSave(t, false)
}
