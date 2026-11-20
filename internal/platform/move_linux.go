package platform

import "runtime"

// MoveWithoutReplace uses renameat2 with RENAME_NOREPLACE for Linux development
// builds. A filesystem that cannot perform the operation returns an error.
func MoveWithoutReplace(source, destination string) error {
	var renameat2 uintptr
	switch runtime.GOARCH {
	case "amd64":
		renameat2 = 316
	case "arm64":
		renameat2 = 276
	}
	// AT_FDCWD = -100 and RENAME_NOREPLACE = 1 on Linux.
	const currentDirectory = ^uintptr(99)
	const renameExclusive = 1
	return moveWithFlags(source, destination, renameat2, currentDirectory, renameExclusive)
}
