//go:build windows

package platform

import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"
)

// This manifest belongs only to the temporary console interpreter copy.
// Windows 10 version 1903 and later use it for command-line and filesystem
// ANSI APIs, without changing the machine's regional settings.
// https://learn.microsoft.com/en-us/windows/apps/design/globalizing/use-utf8-code-page
const utf8ConsoleManifest = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity type="win32" name="LocalTeXEditor.Perl" version="1.0.0.0"/>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application><supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/></application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings><activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage></windowsSettings>
  </application>
</assembly>`

var collectManifestLanguage = syscall.NewCallback(func(_, _, _, language, context uintptr) uintptr {
	languages := (*[]uint16)(unsafe.Pointer(context))
	*languages = append(*languages, uint16(language))
	return 1
})

// EnableUTF8CodePage updates a private executable copy before it is started.
// Other resources stay in place; every language variant of manifest #1 is
// updated so Windows cannot select an older variant in another locale.
func EnableUTF8CodePage(executable string) error {
	path, err := syscall.UTF16PtrFromString(executable)
	if err != nil {
		return err
	}
	module, _, callErr := kernel32.NewProc("LoadLibraryExW").Call(uintptr(unsafe.Pointer(path)), 0, 0x2|0x20)
	if module == 0 {
		return fmt.Errorf("read interpreter resources: %w", callErr)
	}
	var languages []uint16
	result, _, enumErr := kernel32.NewProc("EnumResourceLanguagesW").Call(module, 24, 1, collectManifestLanguage, uintptr(unsafe.Pointer(&languages)))
	runtime.KeepAlive(&languages)
	kernel32.NewProc("FreeLibrary").Call(module)
	if result == 0 {
		switch enumErr {
		case syscall.Errno(1812), syscall.Errno(1813), syscall.Errno(1814), syscall.Errno(1815):
			// ERROR_RESOURCE_{DATA,TYPE,NAME,LANG}_NOT_FOUND means there is
			// no existing manifest to replace. BeginUpdateResource can add
			// the first resource to a valid PE with no resource section.
			// https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--1700-3999-
		default:
			return fmt.Errorf("read interpreter manifest languages: %w", enumErr)
		}
	}
	if len(languages) == 0 {
		languages = []uint16{0}
	}
	update, _, callErr := kernel32.NewProc("BeginUpdateResourceW").Call(uintptr(unsafe.Pointer(path)), 0)
	if update == 0 {
		return fmt.Errorf("open interpreter manifest: %w", callErr)
	}
	committed := false
	defer func() {
		if !committed {
			kernel32.NewProc("EndUpdateResourceW").Call(update, 1)
		}
	}()
	manifest := []byte(utf8ConsoleManifest)
	for _, language := range languages {
		result, _, callErr := kernel32.NewProc("UpdateResourceW").Call(update, 24, 1, uintptr(language), uintptr(unsafe.Pointer(&manifest[0])), uintptr(len(manifest)))
		if result == 0 {
			return fmt.Errorf("write interpreter manifest: %w", callErr)
		}
	}
	runtime.KeepAlive(manifest)
	result, _, callErr = kernel32.NewProc("EndUpdateResourceW").Call(update, 0)
	committed = true
	if result == 0 {
		return fmt.Errorf("save interpreter manifest: %w", callErr)
	}
	return nil
}
