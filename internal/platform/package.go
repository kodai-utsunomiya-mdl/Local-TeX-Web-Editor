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

func unpackagedConfigDirectories() (ConfigDirectories, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return ConfigDirectories{}, err
	}
	return ConfigDirectories{Directory: filepath.Join(base, branding.DataDirectoryName)}, nil
}
