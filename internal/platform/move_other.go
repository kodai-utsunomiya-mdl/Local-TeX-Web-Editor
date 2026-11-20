//go:build !windows && !darwin && !linux

package platform

import (
	"errors"
	"os"
)

// MoveWithoutReplace needs an operating system API that checks the destination
// and moves the source atomically.
func MoveWithoutReplace(source, destination string) error {
	return &os.LinkError{Op: "rename", Old: source, New: destination, Err: errors.ErrUnsupported}
}
