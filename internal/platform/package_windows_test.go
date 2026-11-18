//go:build windows

package platform

import (
	"errors"
	"path/filepath"
	"syscall"
	"testing"
	"unsafe"
)

func TestPackageIdentityUsesWindowsResult(t *testing.T) {
	const fullName = "LocalTeXWebEditor.Test_0.1.4.0_x64__testpublisher"
	want := syscall.StringToUTF16(fullName)
	calls := 0
	result, err := queryPackageString(func(size *uint32, buffer *uint16) uintptr {
		calls++
		if buffer == nil {
			*size = uint32(len(want))
			return uintptr(syscall.ERROR_INSUFFICIENT_BUFFER)
		}
		copy(unsafe.Slice(buffer, *size), want)
		return 0
	})
	if err != nil || result != fullName || calls != 2 {
		t.Fatalf("package identity = %q, calls = %d, error = %v", result, calls, err)
	}
	result, err = queryPackageString(func(_ *uint32, _ *uint16) uintptr { return appmodelErrorNoPackage })
	if result != "" || err != nil {
		t.Fatalf("unpackaged process = %q, %v", result, err)
	}
	_, err = queryPackageString(func(_ *uint32, _ *uint16) uintptr { return uintptr(syscall.ERROR_ACCESS_DENIED) })
	if !errors.Is(err, syscall.ERROR_ACCESS_DENIED) {
		t.Fatalf("Windows errors must not be interpreted as an unpackaged app: %v", err)
	}
}

func TestPackageConfigurationUsesFamilyNameAcrossUpdates(t *testing.T) {
	local, roaming := filepath.Join(t.TempDir(), "Local"), filepath.Join(t.TempDir(), "Roaming")
	before, err := packageConfigDirectories(&PackageIdentity{FullName: "App_0.1.4.0_x64__publisher", FamilyName: "App_publisher"}, local, roaming)
	if err != nil {
		t.Fatal(err)
	}
	after, err := packageConfigDirectories(&PackageIdentity{FullName: "App_0.1.5.0_x64__publisher", FamilyName: "App_publisher"}, local, roaming)
	if err != nil || before != after {
		t.Fatalf("configuration moved during an update: %#v -> %#v (%v)", before, after, err)
	}
	if before.Directory != filepath.Join(local, "Packages", "App_publisher", "LocalState", "LocalTeXEditor") || before.ImportFrom != filepath.Join(roaming, "LocalTeXEditor") {
		t.Fatalf("configuration folders = %#v", before)
	}
	testPackage, err := packageConfigDirectories(&PackageIdentity{FamilyName: "Test_publisher"}, local, roaming)
	if err != nil || testPackage.Directory == before.Directory {
		t.Fatalf("different package identities share data: %#v (%v)", testPackage, err)
	}
}

func TestWindowsPackageIdentityMatchesProcess(t *testing.T) {
	identity, err := CurrentPackageIdentity()
	if err != nil {
		t.Fatal(err)
	}
	fullName, err := readPackageString("GetCurrentPackageFullName")
	if err != nil {
		t.Fatal(err)
	}
	if (identity == nil) != (fullName == "") || (identity != nil && (identity.FullName != fullName || identity.FamilyName == "")) {
		t.Fatalf("process identity = %#v, direct Windows result = %q", identity, fullName)
	}
}
