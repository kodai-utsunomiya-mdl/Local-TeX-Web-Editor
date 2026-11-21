//go:build !windows

package app

import (
	"context"
	"os/exec"
	"path/filepath"
)

func texSetupToolCommand(ctx context.Context, bin, _ string, private bool, name string, arguments ...string) (*exec.Cmd, func(), error) {
	command := exec.CommandContext(ctx, filepath.Join(bin, name), arguments...)
	command.Env = commandEnvironment(bin)
	if private {
		command.Env = isolatedTeXEnvironment(command.Env, filepath.Dir(filepath.Dir(bin)))
	}
	return command, func() {}, nil
}
