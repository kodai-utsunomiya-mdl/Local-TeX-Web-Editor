//go:build !windows

package platform

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
)

func DefaultTeXSetupParent(configDir string) (string, error) {
	return filepath.Join(configDir, "tex"), nil
}

func AcquireTeXSetupLock(root string) (func(), error) {
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	base := filepath.Join(os.TempDir(), fmt.Sprintf("local-tex-editor-tex-locks-%d", os.Getuid()))
	if err := os.Mkdir(base, 0700); err != nil && !os.IsExist(err) {
		return nil, err
	}
	info, err := os.Lstat(base)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
		return nil, fmt.Errorf("invalid TeX lock directory: %s", base)
	}
	key := sha256.Sum256([]byte(filepath.Clean(canonical)))
	return acquireFileLock(filepath.Join(base, fmt.Sprintf("%x.lock", key)))
}
