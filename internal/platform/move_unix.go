//go:build darwin || linux

package platform

import (
	"os"
	"syscall"
	"unsafe"
)

// Move the directory entry in one syscall. A link followed by unlink could
// remove a newer file that another editor saved at the source path meanwhile.
func moveWithFlags(source, destination string, trap, directory, flags uintptr) error {
	linkError := func(err error) error {
		return &os.LinkError{Op: "rename", Old: source, New: destination, Err: err}
	}
	if trap == 0 {
		return linkError(syscall.ENOSYS)
	}
	from, err := syscall.BytePtrFromString(source)
	if err != nil {
		return linkError(err)
	}
	to, err := syscall.BytePtrFromString(destination)
	if err != nil {
		return linkError(err)
	}
	_, _, errno := syscall.Syscall6(trap,
		directory, uintptr(unsafe.Pointer(from)),
		directory, uintptr(unsafe.Pointer(to)), flags, 0)
	if errno != 0 {
		return linkError(errno)
	}
	return nil
}
