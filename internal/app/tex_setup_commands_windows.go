//go:build windows

package app

import (
	"context"
	"os/exec"
	"path/filepath"
)

func texSetupToolCommand(ctx context.Context, bin, temporaryRoot string, private bool, name string, arguments ...string) (*exec.Cmd, func(), error) {
	root := filepath.Dir(filepath.Dir(bin))
	environment := commandEnvironment(bin)
	if private {
		environment = isolatedTeXEnvironment(environment, root)
	}
	if name == "tlmgr" {
		perlRoot := filepath.Join(root, "tlpkg", "tlperl")
		private, cleanup, err := copyUTF8Perl(filepath.Join(perlRoot, "bin"), temporaryRoot)
		if err != nil {
			return nil, nil, err
		}
		script := filepath.Join(root, "texmf-dist", "scripts", "texlive", "tlmgr.pl")
		command := exec.CommandContext(ctx, private, append([]string{script}, arguments...)...)
		command.Env = texLivePerlEnvironment(environment, perlRoot)
		return command, cleanup, nil
	}
	command := exec.CommandContext(ctx, filepath.Join(bin, name+".exe"), arguments...)
	command.Env = environment
	return command, func() {}, nil
}
