package app

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

func isolatedTeXEnvironment(environment []string, root string) []string {
	result := make([]string, 0, len(environment)+3)
	for _, entry := range environment {
		key, _, _ := strings.Cut(entry, "=")
		upper := strings.ToUpper(key)
		if strings.HasPrefix(upper, "TEXMF") || strings.HasPrefix(upper, "PERL") || upper == "TEXINPUTS" || upper == "TEXFORMATS" || upper == "FONTCONFIG_FILE" || upper == "FONTCONFIG_PATH" {
			continue
		}
		result = append(result, entry)
	}
	return append(result, "TEXMFROOT="+root,
		"TEXMFHOME="+filepath.Join(root, "texmf-local"), "TEXMFLOCAL="+filepath.Join(root, "texmf-local"),
		"TEXMFVAR="+filepath.Join(root, "texmf-var"), "TEXMFSYSVAR="+filepath.Join(root, "texmf-var"),
		"TEXMFCONFIG="+filepath.Join(root, "texmf-config"), "TEXMFSYSCONFIG="+filepath.Join(root, "texmf-config"))
}

func checkManagedTeXDirectories(root string) error {
	for _, relative := range []string{"tlpkg", "texmf-dist", "texmf-local", "texmf-var", "texmf-config"} {
		_, info, err := entryTreePath(root, relative)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		if !info.IsDir() {
			return entryChangedError()
		}
	}
	return nil
}

func (a *App) executeTeXSetup(ctx context.Context, run *texSetupRun, command *exec.Cmd, directory string, output io.Writer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if run.job != nil {
		if err := checkTeXSetupDirectory(run.job); err != nil {
			return err
		}
		if run.rootInfo != nil {
			_, info, err := entryTreePath(run.job.path, "TinyTeX")
			if err != nil || !os.SameFile(run.rootInfo, info) {
				return messages.Errorf("TeX の導入先のフォルダーが変更されました．親フォルダーを選び直してください．")
			}
			if err := checkManagedTeXDirectories(run.root); err != nil {
				return err
			}
		}
	} else if run.reused != nil {
		if err := validateManagedTeX(*run.reused); err != nil {
			return err
		}
		if err := checkManagedTeXDirectories(run.root); err != nil {
			return err
		}
	} else if run.external != nil {
		if err := a.validateTeXSetupSelection(run); err != nil {
			return err
		}
	}
	command.Dir = directory
	platform.PrepareCommand(command)
	command.Cancel = func() error { return platform.StopProcess(command.Process) }
	command.WaitDelay = 2 * time.Second
	if output == nil {
		output = texSetupOutput{a, run}
	}
	command.Stdout, command.Stderr = output, output
	a.texSetupLog(run, "[command] %s\n", displayCommand(command.Path, command.Args[1:]))
	err := command.Run()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil {
		return messages.Errorf("TeX の導入コマンドが終了しました．ログを確認してください: %w", err)
	}
	return nil
}

func (a *App) texSetupTool(ctx context.Context, run *texSetupRun, directory, name string, arguments ...string) error {
	if run.external != nil && run.external.RequiresElevation {
		if name != "tlmgr" {
			return messages.Errorf("この TeX の操作にはパッケージ管理ツールを使ってください．")
		}
		if err := a.validateTeXSetupSelection(run); err != nil {
			return err
		}
		a.mu.Lock()
		if err := ctx.Err(); err != nil {
			a.mu.Unlock()
			return err
		}
		run.state.Cancelable, run.state.Stage = false, "authorizing"
		a.mu.Unlock()
		return runElevatedTeXCommand(ctx, *run.external, run.external.Manager, arguments, directory, texSetupOutput{a, run})
	}
	command, cleanup, err := texSetupToolCommand(ctx, run.bin, a.options.ConfigDir, run.external == nil, name, arguments...)
	if err != nil {
		return err
	}
	defer cleanup()
	if run.external == nil {
		directory, err = texSetupCommandPath(directory)
		if err != nil {
			return err
		}
	}
	return a.executeTeXSetup(ctx, run, command, directory, nil)
}

func (a *App) extractTeXSetup(ctx context.Context, run *texSetupRun, archive string) error {
	if err := checkTeXSetupDirectory(run.job); err != nil {
		return err
	}
	var command *exec.Cmd
	if runtime.GOOS == "windows" {
		command = exec.CommandContext(ctx, filepath.Join(run.job.commandPath, filepath.Base(archive)), "-y", "-o"+run.job.commandPath)
	} else {
		command = exec.CommandContext(ctx, "/usr/bin/tar", "-xJf", archive, "-C", run.job.path)
	}
	return a.executeTeXSetup(ctx, run, command, run.job.commandPath, nil)
}

func (a *App) installTeXSetupPackages(ctx context.Context, run *texSetupRun) error {
	year := texLiveYear(run.bin)
	repository := texLiveRepository(year, time.Now().Year())
	if repository == "" {
		return messages.Errorf("TeX Live の年を確認できません．導入した環境の記録を確認してください．")
	}
	a.texSetupLog(run, "[repository] %s\n", repository)
	if run.state.Operation == "packages" {
		a.mu.Lock()
		run.state.Source = repository
		a.mu.Unlock()
	}
	candidates := []string{repository}
	if year == time.Now().Year() {
		candidates = append(candidates, "https://ftp.fau.de/ctan/systems/texlive/tlnet", "https://tug.ctan.org/systems/texlive/tlnet")
	}
	var updateErr error
	for _, candidate := range candidates {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		updateContext, cancel := context.WithTimeout(ctx, 5*time.Minute)
		updateErr = a.texSetupTool(updateContext, run, run.root, "tlmgr", "--repository", candidate, "update", "--self")
		cancel()
		if updateErr == nil {
			repository = candidate
			break
		}
		a.texSetupLog(run, "[repository retry] %s: %v\n", candidate, updateErr)
	}
	if updateErr != nil {
		return updateErr
	}
	if run.job != nil {
		if err := a.texSetupTool(ctx, run, run.root, "tlmgr", "option", "repository", repository); err != nil {
			return err
		}
	}
	a.mu.Lock()
	if run.state.Operation == "packages" {
		run.state.Source = repository
	}
	a.mu.Unlock()
	arguments := []string{"--repository", repository, "install"}
	if run.reinstall {
		arguments = append(arguments, "--reinstall")
	}
	arguments = append(arguments, run.state.Packages...)
	if err := a.texSetupTool(ctx, run, run.root, "tlmgr", arguments...); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		a.texSetupLog(run, "[retry] %v\n", err)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
		if err := a.texSetupTool(ctx, run, run.root, "tlmgr", arguments...); err != nil {
			return err
		}
	}
	if runtime.GOOS == "darwin" {
		if err := a.texSetupTool(ctx, run, run.root, "tlmgr", "postaction", "install", "script", "xetex"); err != nil {
			return err
		}
	}
	for _, command := range [][]string{{"mktexlsr"}, {"updmap-sys", "--setoption", "kanjiEmbed", "haranoaji"}, {"fmtutil-sys", "--all"}} {
		if err := a.texSetupTool(ctx, run, run.root, command[0], command[1:]...); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) checkTeXSetup(ctx context.Context, run *texSetupRun) error {
	if !managedTeXProgramsAvailable(run.bin) {
		return messages.Errorf("導入後に必要な TeX の実行ファイルが見つかりません．ログを確認してください．")
	}
	work, err := os.MkdirTemp(filepath.Dir(run.root), "check-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)
	for _, name := range []string{"latexmk", "synctex", "bibtex", "upbibtex", "biber", "upmendex"} {
		argument := "--version"
		if name == "latexmk" {
			argument = "-version"
		} else if name == "synctex" {
			argument = "help"
		}
		if err := a.texSetupTool(ctx, run, work, name, argument); err != nil {
			return err
		}
	}
	for _, engine := range []string{"pdflatex", "lualatex", "xelatex", "uplatex"} {
		name := "check-" + engine
		text := "\\documentclass{article}\n\\usepackage{amsmath,hyperref}\n\\begin{document}\nTeX setup: $x^2+1$.\\label{setup}\n\\end{document}\n"
		if engine == "uplatex" {
			text = "\\documentclass[uplatex,dvipdfmx]{jsarticle}\n\\usepackage[haranoaji]{pxchfon}\n\\begin{document}\n日本語の組版を確認します．$x^2+1$\n\\end{document}\n"
		}
		if err := os.WriteFile(filepath.Join(work, name+".tex"), []byte(text), 0600); err != nil {
			return err
		}
		arguments := []string{"-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape"}
		if engine == "xelatex" {
			// XeTeX's built-in PDF driver does not quote its installation
			// directory on macOS. Use the same XDV-to-PDF sequence as latexmk
			// so that an installation path containing spaces works here too.
			arguments = append(arguments, "-no-pdf")
		}
		if err := a.texSetupTool(ctx, run, work, engine, append(arguments, name+".tex")...); err != nil {
			return err
		}
		switch engine {
		case "xelatex":
			if err := a.texSetupTool(ctx, run, work, "xdvipdfmx", "-E", "-o", name+".pdf", name+".xdv"); err != nil {
				return err
			}
		case "uplatex":
			if err := a.texSetupTool(ctx, run, work, "dvipdfmx", "-o", name+".pdf", name+".dvi"); err != nil {
				return err
			}
		}
		if !validCachedPDF(filepath.Join(work, name+".pdf")) {
			return messages.Errorf("%s の試験で PDF を作成できませんでした．", engine)
		}
		a.texSetupLog(run, "[checked] %s\n", engine)
	}
	return nil
}
