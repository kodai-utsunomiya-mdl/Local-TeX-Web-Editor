//go:build windows

package main

import (
	"bytes"
	"encoding/binary"
	"encoding/xml"
	"os"
	"strings"
	"syscall"
	"testing"
	"unsafe"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/branding"
)

func TestWindowsExecutableIcon(t *testing.T) {
	path := os.Getenv("LOCAL_TEX_EDITOR_ICON_EXE")
	if path == "" {
		var err error
		path, err = os.Executable()
		if err != nil {
			t.Fatal(err)
		}
	}
	wide, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	shell := syscall.NewLazyDLL("shell32.dll")
	user := syscall.NewLazyDLL("user32.dll")
	kernel := syscall.NewLazyDLL("kernel32.dll")
	var large, small uintptr
	extracted, _, callErr := shell.NewProc("ExtractIconExW").Call(uintptr(unsafe.Pointer(wide)), 0,
		uintptr(unsafe.Pointer(&large)), uintptr(unsafe.Pointer(&small)), 1)
	if large != 0 {
		defer user.NewProc("DestroyIcon").Call(large)
	}
	if small != 0 {
		defer user.NewProc("DestroyIcon").Call(small)
	}
	if uint32(extracted) == ^uint32(0) {
		t.Fatalf("Windows could not extract the executable's icons: %v", callErr)
	}
	// ExtractIconExW counts the returned icons. Requesting both output arrays
	// for one resource yields two handles: one large icon and one small icon.
	// GetLastError is meaningful for this API only when it returns UINT_MAX.
	if extracted != 2 || large == 0 || small == 0 {
		t.Fatalf("Windows could not extract both executable icons: count=%d, large=%x, small=%x", extracted, large, small)
	}
	module, _, callErr := kernel.NewProc("LoadLibraryExW").Call(uintptr(unsafe.Pointer(wide)), 0, 0x22) // DATAFILE | IMAGE_RESOURCE
	if module == 0 {
		t.Fatalf("load executable resources: %v", callErr)
	}
	defer kernel.NewProc("FreeLibrary").Call(module)
	resourceData := func(kind, id uintptr) []byte {
		t.Helper()
		resource, _, callErr := kernel.NewProc("FindResourceW").Call(module, id, kind)
		if resource == 0 {
			t.Fatalf("find resource %d/%d: %v", kind, id, callErr)
		}
		size, _, _ := kernel.NewProc("SizeofResource").Call(module, resource)
		handle, _, _ := kernel.NewProc("LoadResource").Call(module, resource)
		pointer, _, _ := kernel.NewProc("LockResource").Call(handle)
		if size == 0 || size > 1<<20 || pointer == 0 {
			t.Fatalf("read resource %d/%d: size=%d, pointer=%x", kind, id, size, pointer)
		}
		data := make([]byte, int(size))
		kernel.NewProc("RtlMoveMemory").Call(uintptr(unsafe.Pointer(&data[0])), pointer, size)
		return data
	}
	group := resourceData(14, 1) // RT_GROUP_ICON
	count := int(binary.LittleEndian.Uint16(branding.Icon[4:6]))
	if len(group) != 6+14*count || !bytes.Equal(group[:6], branding.Icon[:6]) {
		t.Fatalf("unexpected icon group: %d bytes", len(group))
	}
	for index := 0; index < count; index++ {
		entry := branding.Icon[6+16*index : 22+16*index]
		groupEntry := group[6+14*index : 20+14*index]
		if !bytes.Equal(groupEntry[:12], entry[:12]) {
			t.Fatalf("icon %d changed its size or image format", index+1)
		}
		id := binary.LittleEndian.Uint16(groupEntry[12:14])
		data := resourceData(3, uintptr(id)) // RT_ICON
		offset, size := binary.LittleEndian.Uint32(entry[12:16]), binary.LittleEndian.Uint32(entry[8:12])
		if !bytes.Equal(data, branding.Icon[offset:offset+size]) {
			t.Fatalf("icon %d changed its artwork", index+1)
		}
		width := uintptr(entry[0])
		if width == 0 {
			width = 256
		}
		icon, _, callErr := user.NewProc("LoadImageW").Call(module, 1, 1, width, width, 0) // IMAGE_ICON
		if icon == 0 {
			t.Fatalf("Windows could not load the %d px icon: %v", width, callErr)
		}
		user.NewProc("DestroyIcon").Call(icon)
	}
	var manifest struct {
		XMLName xml.Name `xml:"urn:schemas-microsoft-com:asm.v1 assembly"`
		Trust   struct {
			Security struct {
				Privileges struct {
					Execution struct {
						Level    string `xml:"level,attr"`
						UIAccess string `xml:"uiAccess,attr"`
					} `xml:"urn:schemas-microsoft-com:asm.v3 requestedExecutionLevel"`
				} `xml:"urn:schemas-microsoft-com:asm.v3 requestedPrivileges"`
			} `xml:"urn:schemas-microsoft-com:asm.v3 security"`
		} `xml:"urn:schemas-microsoft-com:asm.v3 trustInfo"`
		Application struct {
			Settings struct {
				Legacy string `xml:"http://schemas.microsoft.com/SMI/2005/WindowsSettings dpiAware"`
				DPI    string `xml:"http://schemas.microsoft.com/SMI/2016/WindowsSettings dpiAwareness"`
			} `xml:"urn:schemas-microsoft-com:asm.v3 windowsSettings"`
		} `xml:"urn:schemas-microsoft-com:asm.v3 application"`
	}
	if err := xml.Unmarshal(resourceData(24, 1), &manifest); err != nil {
		t.Fatalf("read the application manifest from the executable: %v", err)
	}
	if execution := manifest.Trust.Security.Privileges.Execution; execution.Level != "asInvoker" || execution.UIAccess != "false" {
		t.Fatalf("unexpected requested execution level: %+v", execution)
	}
	settings := manifest.Application.Settings
	if strings.TrimSpace(settings.Legacy) != "true/pm" || strings.ReplaceAll(settings.DPI, " ", "") != "PerMonitorV2,PerMonitor" {
		t.Fatalf("unexpected DPI settings: %+v", settings)
	}
	// The test executable contains the same resource object as the application.
	// Check that Windows applied its manifest when it created this process.
	context, _, callErr := user.NewProc("GetThreadDpiAwarenessContext").Call()
	if context == 0 {
		t.Fatalf("read the process's default DPI context: %v", callErr)
	}
	if equal, _, _ := user.NewProc("AreDpiAwarenessContextsEqual").Call(context, ^uintptr(3)); equal == 0 { // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (-4)
		t.Fatalf("Windows did not start the process with Per-Monitor V2 DPI awareness: context=%x", context)
	}
	t.Logf("Windows loaded all %d icon sizes and the application manifest from %s; Per-Monitor V2 is active", count, path)
}
