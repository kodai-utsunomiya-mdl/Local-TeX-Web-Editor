//go:build windows

package platform

import (
	"path/filepath"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/branding"
)

func DefaultTeXSetupParent(configDir string) (string, error) {
	identity, err := CurrentPackageIdentity()
	if err != nil {
		return "", err
	}
	if identity != nil {
		return filepath.Join(configDir, "tex"), nil
	}
	local, err := knownFolderWithoutPackageRedirection(&folderLocalAppData)
	if err != nil {
		return "", err
	}
	return filepath.Join(local, branding.DataDirectoryName, "tex"), nil
}

func AcquireTeXSetupLock(root string) (func(), error) {
	return acquireNamedLock(root, `Local\LocalTeXEditorTeXSetup-`)
}
