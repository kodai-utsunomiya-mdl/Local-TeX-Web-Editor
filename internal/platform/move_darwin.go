package platform

// MoveWithoutReplace uses renameatx_np with RENAME_EXCL for files and folders.
// The syscall and flags are defined by XNU's bsd/kern/syscalls.master,
// bsd/sys/fcntl.h, and bsd/sys/stdio.h. Both Darwin architectures use syscall 488.
// Calling it through syscall.Syscall6 also works with CGO_ENABLED=0.
func MoveWithoutReplace(source, destination string) error {
	const renameatxNP = 488
	// AT_FDCWD = -2 and RENAME_EXCL = 0x4 on Darwin.
	const currentDirectory = ^uintptr(1)
	const renameExclusive = 0x4
	return moveWithFlags(source, destination, renameatxNP, currentDirectory, renameExclusive)
}
