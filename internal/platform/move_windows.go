//go:build windows

package platform

// MoveFileExW without MOVEFILE_REPLACE_EXISTING rejects an occupied destination.
func MoveWithoutReplace(source, destination string) error {
	return commitShortcutFile(source, destination, false)
}
