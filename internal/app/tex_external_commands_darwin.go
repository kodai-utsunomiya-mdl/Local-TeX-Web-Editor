//go:build darwin

package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

func runElevatedTeXCommand(ctx context.Context, environment TeXEnvironment, executable string, arguments []string, directory string, output io.Writer) error {
	commandText, err := elevatedExternalTeXShellCommand(environment, executable, arguments, directory)
	if err != nil {
		return err
	}
	if output != nil {
		fmt.Fprintf(output, "[command] %s\n", displayCommand(executable, arguments))
	}
	return runAuthorizedExternalTeXShell(ctx, commandText, output)
}

func runAuthorizedExternalTeXShell(ctx context.Context, commandText string, output io.Writer) error {
	// The script is fixed; all shell text travels as an argument. macOS owns
	// the authorization dialog and receives no password from the application.
	script := "on run argv\n do shell script (item 1 of argv) with administrator privileges without altering line endings\nend run"
	return runExternalTeXAppleScript(ctx, script, []string{commandText}, output)
}

func runExternalTeXAppleScript(ctx context.Context, script string, arguments []string, output io.Writer) error {
	command := exec.Command("/usr/bin/osascript", append([]string{"-e", script}, arguments...)...)
	var captured bytes.Buffer
	var writer io.Writer = &captured
	if output != nil {
		writer = io.MultiWriter(output, &captured)
	}
	err := waitNativeTeXCommand(ctx, command, writer)
	return externalTeXAppleScriptError(err, captured.String())
}

func externalTeXAppleScriptError(err error, output string) error {
	if err != nil {
		// osascript ends its error with the AppleScript error number, including
		// -128 for a canceled authorization or Finder dialog in any UI language.
		lastLine := strings.TrimSpace(output)
		if index := strings.LastIndexByte(lastLine, '\n'); index >= 0 {
			lastLine = lastLine[index+1:]
		}
		if strings.HasSuffix(lastLine, "(-128)") {
			return context.Canceled
		}
	}
	return err
}

func runExternalTeXUninstall(ctx context.Context, environment TeXEnvironment, output io.Writer) error {
	if environment.Managed || !environment.CanUninstall {
		return messages.Errorf("この TeX の環境は，外部環境の削除操作から変更できません．")
	}
	if err := checkExternalTeXCommandPaths(environment, environment.Manager, environment.Directory); err != nil {
		return err
	}
	var registration externalTeXMacRegistration
	if environment.Format == "tinytex" {
		var err error
		registration, err = inspectExternalTeXMacRegistration(environment, "/etc/paths.d/TinyTeX")
		if err != nil {
			return err
		}
		if err := unregisterExternalTeXMac(ctx, environment, registration, output); err != nil {
			return externalTeXRollbackResult(err, restoreExternalTeXMacRegistration(context.WithoutCancel(ctx), registration, output))
		}
	}
	if output != nil {
		fmt.Fprintf(output, "[trash] %s\n", environment.Directory)
	}
	// Moving to Finder's Trash gives the user the usual macOS authorization
	// and conflict dialogs. The destination is explicitly Trash, so a volume
	// without a usable Trash does not cause a permanent-delete fallback.
	script := "on run argv\n set texFolder to POSIX file (item 1 of argv) as alias\n with timeout of 86400 seconds\n  tell application \"Finder\"\n   activate\n   move texFolder to trash\n  end tell\n end timeout\nend run"
	err := runExternalTeXAppleScript(ctx, script, []string{environment.Directory}, output)
	if result := externalTeXUninstallResult(environment, err); result != nil {
		return externalTeXRollbackResult(result, restoreExternalTeXMacRegistration(context.WithoutCancel(ctx), registration, output))
	}
	return nil
}

type externalTeXMacLink struct {
	Path   string
	Target string
}

type externalTeXMacRegistration struct {
	Links    []externalTeXMacLink
	PathFile string
	PathData string
}

func inspectExternalTeXMacRegistration(environment TeXEnvironment, pathFile string) (externalTeXMacRegistration, error) {
	registration := externalTeXMacRegistration{}
	data, err := readCacheFile(filepath.Join(environment.Directory, "tlpkg", "texlive.tlpdb"), 64<<20)
	if err != nil {
		return registration, err
	}
	options := map[string]string{}
	for _, line := range strings.Split(string(data), "\n") {
		for _, name := range []string{"sys_bin", "sys_man", "sys_info"} {
			if value, ok := strings.CutPrefix(strings.TrimSpace(line), "depend opt_"+name+":"); ok {
				if !filepath.IsAbs(value) || strings.ContainsAny(value, "\x00\r\n") {
					return registration, messages.Errorf("TinyTeX のパス登録先を確認できません: %s", value)
				}
				options[name] = value
			}
		}
	}
	collect := func(source, destination string) error {
		if destination == "" {
			return nil
		}
		entries, err := os.ReadDir(source)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if entry.Name() == "man" {
				continue
			}
			path := filepath.Join(destination, entry.Name())
			target, err := os.Readlink(path)
			if err == nil && strings.HasPrefix(target, source+string(filepath.Separator)) {
				registration.Links = append(registration.Links, externalTeXMacLink{Path: path, Target: target})
			}
		}
		return nil
	}
	if err := collect(environment.Bin, options["sys_bin"]); err != nil {
		return registration, err
	}
	if err := collect(filepath.Join(environment.Directory, "texmf-dist", "doc", "info"), options["sys_info"]); err != nil {
		return registration, err
	}
	man := filepath.Join(environment.Directory, "texmf-dist", "doc", "man")
	sections, err := os.ReadDir(man)
	if err != nil && !os.IsNotExist(err) {
		return registration, err
	}
	if options["sys_man"] != "" {
		for _, section := range sections {
			if section.IsDir() {
				if err := collect(filepath.Join(man, section.Name()), filepath.Join(options["sys_man"], section.Name())); err != nil {
					return registration, err
				}
			}
		}
	}
	info, err := os.Lstat(pathFile)
	if os.IsNotExist(err) {
		return registration, nil
	}
	if err != nil {
		return registration, err
	}
	// A different TinyTeX installation may own this global path entry.
	if info.Mode().IsRegular() {
		contents, err := readCacheFile(pathFile, 64<<10)
		if err != nil {
			return registration, err
		}
		actual, err := filepath.EvalSymlinks(strings.TrimSpace(string(contents)))
		if err == nil && samePath(actual, environment.Bin) {
			registration.PathFile, registration.PathData = pathFile, string(contents)
		}
	}
	return registration, nil
}

func remainingExternalTeXMacLinks(registration externalTeXMacRegistration) bool {
	for _, link := range registration.Links {
		if target, err := os.Readlink(link.Path); err == nil && target == link.Target {
			return true
		}
	}
	return false
}

func unregisterExternalTeXMac(ctx context.Context, environment TeXEnvironment, registration externalTeXMacRegistration, output io.Writer) error {
	if len(registration.Links) > 0 {
		command := exec.Command(environment.Manager, "path", "remove")
		command.Dir, command.Env = environment.Directory, commandEnvironment(environment.Bin)
		platform.PrepareCommand(command)
		err := waitNativeTeXCommand(ctx, command, output)
		if remainingExternalTeXMacLinks(registration) {
			err = runElevatedTeXCommand(ctx, environment, environment.Manager, []string{"path", "remove"}, environment.Directory, output)
			if remainingExternalTeXMacLinks(registration) {
				if err != nil {
					return err
				}
				return messages.Errorf("TinyTeX のコマンドへのリンクが残っています．ログを確認してください．")
			}
		} else if err != nil && ctx.Err() != nil {
			return ctx.Err()
		}
	}
	if registration.PathFile != "" {
		current, err := readCacheFile(registration.PathFile, 64<<10)
		if err != nil || string(current) != registration.PathData {
			return messages.Errorf("TinyTeX のパス登録が変更されました．対象をもう一度確認してください．")
		}
		if err := os.Remove(registration.PathFile); err != nil {
			if !os.IsPermission(err) {
				return err
			}
			// Only the exact entry inspected above may be removed by the OS.
			path := quoteExternalTeXShellArgument(registration.PathFile)
			command := "[ ! -L " + path + " ] && [ \"$(/bin/cat " + path + ")\" = " + quoteExternalTeXShellArgument(strings.TrimRight(registration.PathData, "\n")) + " ] && /bin/rm " + path
			if err := runAuthorizedExternalTeXShell(ctx, command, output); err != nil {
				return err
			}
		}
	}
	return nil
}

func restoreExternalTeXMacRegistration(ctx context.Context, registration externalTeXMacRegistration, output io.Writer) error {
	var commands []string
	for _, link := range registration.Links {
		if _, err := os.Lstat(link.Path); !os.IsNotExist(err) {
			continue
		}
		if err := os.Symlink(link.Target, link.Path); err != nil {
			if !os.IsPermission(err) {
				return err
			}
			path, target := quoteExternalTeXShellArgument(link.Path), quoteExternalTeXShellArgument(link.Target)
			commands = append(commands, "if [ ! -e "+path+" ] && [ ! -L "+path+" ]; then /bin/ln -s "+target+" "+path+"; fi")
		}
	}
	if registration.PathFile != "" {
		file, err := os.OpenFile(registration.PathFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
		if err == nil {
			_, writeErr := io.WriteString(file, registration.PathData)
			closeErr := file.Close()
			if writeErr != nil || closeErr != nil {
				return errors.Join(writeErr, closeErr)
			}
		} else if !os.IsExist(err) {
			if !os.IsPermission(err) {
				return err
			}
			commands = append(commands, "(set -C; umask 022; /usr/bin/printf '%s' "+quoteExternalTeXShellArgument(registration.PathData)+" > "+quoteExternalTeXShellArgument(registration.PathFile)+")")
		}
	}
	if len(commands) > 0 {
		return runAuthorizedExternalTeXShell(ctx, "set -e\n"+strings.Join(commands, "\n"), output)
	}
	return nil
}

func openExternalTeXManager(ctx context.Context, environment TeXEnvironment) error {
	return messages.Errorf("この OS では，TeX のパッケージをアプリの管理画面から変更してください．")
}

func openExternalTeXUninstaller(ctx context.Context, environment TeXEnvironment) error {
	return messages.Errorf("この OS では，確認画面から TeX のフォルダーをごみ箱へ移してください．")
}
