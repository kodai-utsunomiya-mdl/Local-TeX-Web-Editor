//go:build !windows

package platform

import (
	"os"
	"os/exec"
	"strings"
	"syscall"
)

func PrepareCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func StopProcess(process *os.Process) error {
	if process == nil || process.Pid <= 0 {
		return nil
	}
	err := syscall.Kill(-process.Pid, syscall.SIGKILL)
	if err == syscall.ESRCH {
		return nil
	}
	return err
}

func IsReparsePoint(path string) (bool, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return false, err
	}
	return info.Mode()&os.ModeSymlink != 0, nil
}

func IsRegularFile(_ string, info os.FileInfo) (bool, error) {
	return info.Mode().IsRegular(), nil
}

func ReplaceFile(src, dst string) error { return os.Rename(src, dst) }

// ReplaceFileChecked checks the destination immediately before replacing it.
func ReplaceFileChecked(src, dst string, check func() error) error {
	if check != nil {
		if err := check(); err != nil {
			return err
		}
	}
	return ReplaceFile(src, dst)
}

func DecodeOutput(data []byte) string { return strings.ToValidUTF8(string(data), "\uFFFD") }

func EncodeFileName(name string) []byte { return []byte(name) }

func ShortPath(path string) (string, error) { return path, nil }
