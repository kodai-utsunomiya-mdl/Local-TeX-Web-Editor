package app

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

// The inspector supplies absolute paths. Check them again immediately before
// asking another process to change an installation.
func checkExternalTeXCommandPaths(environment TeXEnvironment, executable, directory string) error {
	root := environment.Directory
	if !filepath.IsAbs(root) || samePath(root, filepath.Dir(root)) || strings.ContainsAny(root, "\x00\r\n") {
		return messages.Errorf("TeX 専用のフォルダーを確認できません: %s", root)
	}
	actual, err := filepath.EvalSymlinks(root)
	if err != nil || !samePath(actual, root) {
		return messages.Errorf("TeX のフォルダーが変更されました．対象をもう一度確認してください．")
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return messages.Errorf("TeX のフォルダーを開けません: %s", root)
	}
	for _, path := range []string{executable, directory} {
		if !filepath.IsAbs(path) || strings.ContainsAny(path, "\x00\r\n") {
			return messages.Errorf("TeX の操作に使うパスを確認できません: %s", path)
		}
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil || (!samePath(resolved, root) && !pathInExternalTeX(root, resolved)) {
			return messages.Errorf("TeX の操作先が選択した環境の外にあります: %s", path)
		}
	}
	info, err = os.Stat(executable)
	if err != nil || !info.Mode().IsRegular() {
		return messages.Errorf("TeX の管理ツールを開けません: %s", executable)
	}
	info, err = os.Stat(directory)
	if err != nil || !info.IsDir() {
		return messages.Errorf("TeX の作業フォルダーを開けません: %s", directory)
	}
	return nil
}

func checkExternalTeXArguments(arguments []string) error {
	for _, argument := range arguments {
		if strings.ContainsRune(argument, '\x00') {
			return messages.Errorf("TeX のコマンドに使えない文字が含まれています．")
		}
	}
	return nil
}

func quoteExternalTeXShellArgument(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func elevatedExternalTeXShellCommand(environment TeXEnvironment, executable string, arguments []string, directory string) (string, error) {
	if err := checkExternalTeXCommandPaths(environment, executable, directory); err != nil {
		return "", err
	}
	if !samePath(executable, environment.Manager) {
		return "", messages.Errorf("選択した TeX の tlmgr 以外を管理者権限で実行することはできません．")
	}
	if err := checkExternalTeXArguments(arguments); err != nil {
		return "", err
	}
	words := []string{quoteExternalTeXShellArgument(executable)}
	for _, argument := range arguments {
		words = append(words, quoteExternalTeXShellArgument(argument))
	}
	return "cd " + quoteExternalTeXShellArgument(directory) + " && " +
		"unset PERL5LIB PERLLIB PERL5OPT PERL5DB PERL5DB_THREADED PERL5SHELL PERL_UNICODE && " +
		"PATH=" + quoteExternalTeXShellArgument(environment.Bin+":/usr/bin:/bin:/usr/sbin:/sbin") + " " +
		strings.Join(words, " "), nil
}

// The first install uses the selected installation's configured repository.
// Check it before elevation so tlmgr's release error reaches the application's
// existing archive retry. The retry already has an explicit --repository.
func externalTeXInstallCheckArguments(arguments []string) []string {
	if len(arguments) == 0 || arguments[0] != "install" {
		return nil
	}
	return append([]string{"install", "--dry-run"}, arguments[1:]...)
}

func runExternalTeXInstallCheck(ctx context.Context, command *exec.Cmd, output io.Writer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if output == nil {
		output = io.Discard
	}
	platform.PrepareCommand(command)
	command.Cancel = func() error { return platform.StopProcess(command.Process) }
	command.WaitDelay = 2 * time.Second
	writer := &externalTeXOutput{writer: output}
	command.Stdout, command.Stderr = writer, writer
	fmt.Fprintf(writer, "[command] %s\n", displayCommand(command.Path, command.Args[1:]))
	err := command.Run()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil {
		return messages.Errorf("TeX の導入コマンドが終了しました．ログを確認してください: %w", err)
	}
	return nil
}

// A privileged child can keep running after an unprivileged parent is killed.
// Keep the installation's lock until the native operation has actually ended.
func waitNativeTeXCommand(ctx context.Context, command *exec.Cmd, output io.Writer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if output == nil {
		output = io.Discard
	}
	writer := &externalTeXOutput{writer: output}
	command.Stdout, command.Stderr = writer, writer
	if err := command.Start(); err != nil {
		return err
	}
	finished := make(chan error, 1)
	go func() { finished <- command.Wait() }()
	select {
	case err := <-finished:
		return err
	case <-ctx.Done():
		fmt.Fprintln(writer, messages.Text(messages.LanguageFromContext(ctx), "OS の画面で開始した TeX の操作が終了するまで待っています．中止する場合は，開いた画面で操作してください．"))
		return <-finished
	}
}

type externalTeXOutput struct {
	mu     sync.Mutex
	writer io.Writer
}

func (output *externalTeXOutput) Write(data []byte) (int, error) {
	output.mu.Lock()
	defer output.mu.Unlock()
	return output.writer.Write(data)
}

func externalTeXUninstallResult(environment TeXEnvironment, operationErr error) error {
	_, err := os.Lstat(environment.Directory)
	if os.IsNotExist(err) {
		return nil
	}
	if operationErr != nil {
		return operationErr
	}
	if err != nil {
		return messages.Errorf("TeX の削除後に保存先を確認できません: %w", err)
	}
	return messages.Errorf("TeX のフォルダーが残っています．OS の画面で操作を完了した後，もう一度一覧を更新してください: %s", environment.Directory)
}

func externalTeXRollbackResult(operationErr, rollbackErr error) error {
	if rollbackErr == nil {
		return operationErr
	}
	return messages.Errorf("%w\nTeX のパス登録を元に戻せませんでした: %v", operationErr, rollbackErr)
}
