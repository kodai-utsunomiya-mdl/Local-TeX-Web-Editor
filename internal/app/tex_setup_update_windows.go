//go:build windows

package app

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

// On Windows, tlmgr.pl prepares its own update and exits. tlmgr.bat normally
// removes stale scripts, runs Perl, renames the newly prepared updater, then
// runs that updater. Keep those steps when using our private Perl interpreter.
func (a *App) prepareTeXSetupSelfUpdate(run *texSetupRun, name string, arguments []string) (func(context.Context, io.Writer) error, error) {
	if name != "tlmgr" {
		return nil, nil
	}
	update, self := false, false
	for _, argument := range arguments {
		switch argument {
		case "update":
			update = true
		case "--self", "-self":
			self = true
		case "--dry-run", "-dry-run", "--list", "-list":
			return nil, nil
		}
	}
	if !update || !self {
		return nil, nil
	}
	for _, name := range []string{"updater-w32", "update-self.log"} {
		if err := removeTeXSetupUpdateFile(run.root, name); err != nil {
			return nil, err
		}
	}
	return func(ctx context.Context, output io.Writer) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		updater, info, err := entryTreePath(run.root, "temp/updater-w32")
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return entryChangedError()
		}
		// Lstat on Windows defers reading the file ID until SameFile is
		// called. Obtain the ID through a handle before the old name goes
		// away, then close the handle so Windows permits the rename.
		file, err := os.Open(updater)
		if err != nil {
			return err
		}
		opened, statErr := file.Stat()
		closeErr := file.Close()
		if statErr != nil {
			return statErr
		}
		if closeErr != nil {
			return closeErr
		}
		if !os.SameFile(info, opened) {
			return entryChangedError()
		}
		info = opened
		if err := removeTeXSetupUpdateFile(run.root, "updater-w32.bat"); err != nil {
			return err
		}
		batch := updater + ".bat"
		if err := platform.MoveWithoutReplace(updater, batch); err != nil {
			return err
		}
		path, current, err := entryTreePath(run.root, "temp/updater-w32.bat")
		if err != nil || !os.SameFile(info, current) {
			return entryChangedError()
		}
		path, err = texSetupCommandPath(path)
		if err != nil {
			return err
		}
		directory, err := texSetupCommandPath(run.root)
		if err != nil {
			return err
		}
		command := exec.CommandContext(ctx, externalTeXSystemProgram("cmd.exe"), "/d", "/e:on", "/v:off", "/c", path)
		command.Env = commandEnvironment(run.bin)
		if run.external == nil {
			command.Env = isolatedTeXEnvironment(command.Env, filepath.Dir(filepath.Dir(run.bin)))
		}
		err = a.executeTeXSetup(ctx, run, command, directory, output)
		// The official updater writes the nested command's output to this
		// file. Include it in the same progress log, including on failure.
		if logPath, _, logErr := entryTreePath(run.root, "temp/update-self.log"); logErr == nil {
			if log, readErr := readCacheFile(logPath, maxLogBytes); readErr == nil {
				if output == nil {
					output = texSetupOutput{a, run}
				}
				_, _ = output.Write(log)
			}
		}
		if err != nil {
			return err
		}
		for _, name := range []string{"updater-w32.bat", "update-self.log"} {
			if err := removeTeXSetupUpdateFile(run.root, name); err != nil {
				return err
			}
		}
		// The updater removes its own tar archives and tar.exe. Remove the
		// temporary directory only when nothing else was placed inside it.
		temporary, _, err := entryTreePath(run.root, "temp")
		if err != nil {
			return err
		}
		entries, err := os.ReadDir(temporary)
		if err != nil || len(entries) != 0 {
			return err
		}
		if err := os.Remove(temporary); err != nil && !os.IsNotExist(err) {
			if entries, readErr := os.ReadDir(temporary); readErr == nil && len(entries) != 0 {
				return nil
			}
			return err
		}
		return nil
	}, nil
}

func removeTeXSetupUpdateFile(root, name string) error {
	path, info, err := entryTreePath(root, "temp/"+name)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return entryChangedError()
	}
	return os.Remove(path)
}
