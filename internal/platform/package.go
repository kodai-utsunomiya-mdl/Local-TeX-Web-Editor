package platform

import (
	"os"
	"path/filepath"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/branding"
)

// PackageIdentity is supplied by Windows for an installed MSIX application.
// FamilyName remains the same when that package is updated.
type PackageIdentity struct {
	FullName   string `json:"fullName"`
	FamilyName string `json:"familyName"`
}

type ConfigDirectories struct {
	Directory  string
	ImportFrom string
}

// IsDefaultConfigDirectory reports whether the app uses its normal per-user
// settings folder, including the LocalState folder of an MSIX package.
func IsDefaultConfigDirectory(configDir string) bool {
	directories, err := DefaultConfigDirectories()
	if err != nil {
		return false
	}
	return startupPathsEqual(configDir, directories.Directory)
}

func unpackagedConfigDirectories() (ConfigDirectories, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return ConfigDirectories{}, err
	}
	return ConfigDirectories{Directory: filepath.Join(base, branding.DataDirectoryName)}, nil
}
