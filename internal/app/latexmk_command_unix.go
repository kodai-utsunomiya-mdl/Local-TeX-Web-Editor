//go:build !windows

package app

import "os/exec"

func latexmkCommand(tool, bin string, arguments []string, _, _ string) (*exec.Cmd, func(), error) {
	command := exec.Command(tool, arguments...)
	command.Env = commandEnvironment(bin)
	return command, func() {}, nil
}
