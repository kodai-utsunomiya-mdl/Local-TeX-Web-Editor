//go:build windows

package platform

import (
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/branding"
)

const appmodelErrorNoPackage = 15700

var windowsPackageIdentity = sync.OnceValues(readCurrentPackageIdentity)

func CurrentPackageIdentity() (*PackageIdentity, error) {
	return windowsPackageIdentity()
}

func readCurrentPackageIdentity() (*PackageIdentity, error) {
	fullName, err := readPackageString("GetCurrentPackageFullName")
	if err != nil || fullName == "" {
		return nil, err
	}
	familyName, err := readPackageString("GetCurrentPackageFamilyName")
	if err != nil {
		return nil, err
	}
	if familyName == "" {
		return nil, fmt.Errorf("Windows returned an empty package family name")
	}
	return &PackageIdentity{FullName: fullName, FamilyName: familyName}, nil
}

func readPackageString(name string) (string, error) {
	procedure := kernel32.NewProc(name)
	if err := procedure.Find(); err != nil {
		return "", fmt.Errorf("%s: %w", name, err)
	}
	value, err := queryPackageString(func(size *uint32, buffer *uint16) uintptr {
		result, _, _ := procedure.Call(uintptr(unsafe.Pointer(size)), uintptr(unsafe.Pointer(buffer)))
		return result
	})
	if err != nil {
		return "", fmt.Errorf("%s: %w", name, err)
	}
	return value, nil
}

func queryPackageString(query func(*uint32, *uint16) uintptr) (string, error) {
	var size uint32
	result := query(&size, nil)
	if result == appmodelErrorNoPackage {
		return "", nil
	}
	if result != uintptr(syscall.ERROR_INSUFFICIENT_BUFFER) {
		return "", fmt.Errorf("could not read the Windows package identity: %w", syscall.Errno(result))
	}
	if size < 2 || size > 32768 {
		return "", fmt.Errorf("invalid Windows package identity length: %d", size)
	}
	buffer := make([]uint16, size)
	result = query(&size, &buffer[0])
	if result != 0 {
		return "", fmt.Errorf("could not read the Windows package identity: %w", syscall.Errno(result))
	}
	if size < 2 || size > uint32(len(buffer)) || buffer[size-1] != 0 {
		return "", fmt.Errorf("invalid Windows package identity result")
	}
	return syscall.UTF16ToString(buffer[:size-1]), nil
}

func DefaultConfigDirectories() (ConfigDirectories, error) {
	identity, err := CurrentPackageIdentity()
	if err != nil {
		return ConfigDirectories{}, err
	}
	if identity == nil {
		return unpackagedConfigDirectories()
	}
	local, err := knownFolderWithoutPackageRedirection(&folderLocalAppData)
	if err != nil {
		return ConfigDirectories{}, err
	}
	roamingID := nativeGUID{0x3eb685db, 0x65f9, 0x4cf6, [8]byte{0xa0, 0x3a, 0xe3, 0xef, 0x65, 0x72, 0x9f, 0x3d}}
	roaming, err := knownFolderWithoutPackageRedirection(&roamingID)
	if err != nil {
		return ConfigDirectories{}, err
	}
	return packageConfigDirectories(identity, local, roaming)
}

func packageConfigDirectories(identity *PackageIdentity, local, roaming string) (ConfigDirectories, error) {
	family := identity.FamilyName
	if family == "" || family == "." || family == ".." || strings.ContainsAny(family, `\/:`) || !filepath.IsAbs(local) || !filepath.IsAbs(roaming) {
		return ConfigDirectories{}, fmt.Errorf("invalid Windows package data location")
	}
	return ConfigDirectories{
		Directory:  filepath.Join(local, "Packages", family, "LocalState", branding.DataDirectoryName),
		ImportFrom: filepath.Join(roaming, branding.DataDirectoryName),
	}, nil
}

func knownFolderWithoutPackageRedirection(id *nativeGUID) (string, error) {
	var path *uint16
	// KF_FLAG_NO_PACKAGE_REDIRECTION returns the user's existing folders,
	// rather than the package's virtual AppData view.
	result, _, _ := shell32.NewProc("SHGetKnownFolderPath").Call(
		uintptr(unsafe.Pointer(id)), 0x00010000, 0, uintptr(unsafe.Pointer(&path)))
	if path != nil {
		defer ole32.NewProc("CoTaskMemFree").Call(uintptr(unsafe.Pointer(path)))
	}
	if int32(result) < 0 || path == nil {
		return "", fmt.Errorf("could not find the Windows application data folder (HRESULT 0x%08X)", uint32(result))
	}
	return nativeWideString(path), nil
}
