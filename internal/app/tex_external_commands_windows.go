//go:build windows

package app

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"unicode/utf16"
	"unsafe"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

var (
	externalTeXShell32  = syscall.NewLazyDLL("shell32.dll")
	externalTeXOle32    = syscall.NewLazyDLL("ole32.dll")
	externalTeXKernel32 = syscall.NewLazyDLL("kernel32.dll")
)

type externalTeXShellExecuteInfo struct {
	Size       uint32
	Mask       uint32
	Window     uintptr
	Verb       *uint16
	File       *uint16
	Parameters *uint16
	Directory  *uint16
	Show       int32
	Instance   uintptr
	IDList     uintptr
	Class      *uint16
	ClassKey   uintptr
	HotKey     uint32
	Icon       uintptr
	Process    syscall.Handle
}

func externalTeXSystemProgram(name string) string {
	systemRoot := os.Getenv("SystemRoot")
	if systemRoot == "" {
		systemRoot = `C:\Windows`
	}
	return filepath.Join(systemRoot, "System32", name)
}

func quoteExternalTeXPowerShell(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func externalTeXWindowsArguments(arguments []string) string {
	quoted := make([]string, len(arguments))
	for index, argument := range arguments {
		quoted[index] = syscall.EscapeArg(argument)
	}
	return strings.Join(quoted, " ")
}

func encodeExternalTeXPowerShell(script string) string {
	wide := utf16.Encode([]rune(script))
	data := make([]byte, len(wide)*2)
	for index, character := range wide {
		binary.LittleEndian.PutUint16(data[index*2:], character)
	}
	return base64.StdEncoding.EncodeToString(data)
}

func elevatedExternalTeXPowerShell(environment TeXEnvironment, executable string, arguments []string, directory string) (string, func(), error) {
	if err := checkExternalTeXCommandPaths(environment, executable, directory); err != nil {
		return "", nil, err
	}
	if err := checkExternalTeXArguments(arguments); err != nil {
		return "", nil, err
	}
	if !samePath(executable, environment.Manager) || !strings.EqualFold(filepath.Base(executable), "tlmgr.bat") {
		return "", nil, messages.Errorf("選択した TeX の tlmgr 以外を管理者権限で実行することはできません．")
	}
	// Call Perl directly: passing package names through cmd.exe would interpret
	// percent signs and metacharacters a second time.
	perlRoot := filepath.Join(environment.Directory, "tlpkg", "tlperl")
	perl := filepath.Join(perlRoot, "bin", "perl.exe")
	script := filepath.Join(environment.Directory, "texmf-dist", "scripts", "texlive", "tlmgr.pl")
	for _, path := range []string{perl, script} {
		if err := checkExternalTeXCommandPaths(environment, path, directory); err != nil {
			return "", nil, err
		}
	}
	cleanup := func() {}
	if hasNonASCII(perl) || hasNonASCII(script) || hasNonASCII(strings.Join(arguments, "")) {
		var err error
		perl, cleanup, err = copyUTF8Perl(filepath.Dir(perl), os.TempDir())
		if err != nil {
			return "", nil, err
		}
	}
	toolArguments := append([]string{script}, arguments...)
	searchPath := strings.Join([]string{filepath.Join(perlRoot, "bin"), environment.Bin, filepath.Dir(externalTeXSystemProgram("cmd.exe")), filepath.Dir(filepath.Dir(externalTeXSystemProgram("cmd.exe")))}, ";")
	// ProcessStartInfo accepts a Windows command line verbatim. Each argument
	// is quoted with CommandLineToArgvW rules before it becomes a PS literal.
	command := "$ErrorActionPreference='Stop'\n" +
		"$p=New-Object System.Diagnostics.Process\n" +
		"$p.StartInfo.FileName=" + quoteExternalTeXPowerShell(perl) + "\n" +
		"$p.StartInfo.Arguments=" + quoteExternalTeXPowerShell(externalTeXWindowsArguments(toolArguments)) + "\n" +
		"$p.StartInfo.WorkingDirectory=" + quoteExternalTeXPowerShell(directory) + "\n" +
		"$p.StartInfo.UseShellExecute=$false\n" +
		"foreach($key in @($p.StartInfo.EnvironmentVariables.Keys)){if($key -like 'PERL*'){$p.StartInfo.EnvironmentVariables.Remove($key)}}\n" +
		"$p.StartInfo.EnvironmentVariables['PATH']=" + quoteExternalTeXPowerShell(searchPath) + "\n" +
		"$p.StartInfo.EnvironmentVariables['PERL5LIB']=" + quoteExternalTeXPowerShell(filepath.Join(perlRoot, "site", "lib")+";"+filepath.Join(perlRoot, "lib")) + "\n" +
		"[void]$p.Start()\n$p.WaitForExit()\n$code=$p.ExitCode\n" +
		"if($code -ne 0){Write-Host ('TeX exited with code '+$code); [void](Read-Host 'Press Enter after reviewing the output')}\nexit $code\n"
	return command, cleanup, nil
}

func runElevatedTeXCommand(ctx context.Context, environment TeXEnvironment, executable string, arguments []string, directory string, output io.Writer) error {
	if environment.StoreEdition {
		return messages.Errorf("Microsoft Store 版では，管理者権限が必要な環境の操作は公式の TeX 管理ツールから行ってください．")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	script, cleanup, err := elevatedExternalTeXPowerShell(environment, executable, arguments, directory)
	if err != nil {
		return err
	}
	defer cleanup()
	if checkArguments := externalTeXInstallCheckArguments(arguments); checkArguments != nil {
		// tlmgr permits --dry-run on a read-only installation and performs the
		// same repository/year check as install. Capture this unprivileged
		// process directly; the elevated console cannot inherit our pipes.
		command, cleanCheck, err := texSetupToolCommand(ctx, environment.Bin, os.TempDir(), false, "tlmgr", checkArguments...)
		if err != nil {
			return err
		}
		command.Dir = directory
		err = runExternalTeXInstallCheck(ctx, command, output)
		cleanCheck()
		if err != nil {
			return err
		}
		if err := checkExternalTeXCommandPaths(environment, executable, directory); err != nil {
			return err
		}
	}
	if output != nil {
		fmt.Fprintf(output, "[command] %s\n", displayCommand(executable, arguments))
		fmt.Fprintln(output, messages.Text(messages.LanguageFromContext(ctx), "Windows の承認画面の後に開くウィンドウで，TeX の処理を確認してください．"))
	}
	powershell := externalTeXSystemProgram(`WindowsPowerShell\v1.0\powershell.exe`)
	arguments = []string{"-NoLogo", "-NoProfile", "-EncodedCommand", encodeExternalTeXPowerShell(script)}
	return shellExecuteExternalTeX(ctx, "runas", powershell, externalTeXWindowsArguments(arguments), directory, true, output)
}

func shellExecuteExternalTeX(ctx context.Context, verb, executable, arguments, directory string, wait bool, output io.Writer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	hr, _, _ := externalTeXOle32.NewProc("CoInitializeEx").Call(0, 2)
	if int32(hr) < 0 {
		return fmt.Errorf("open TeX tool: COM HRESULT 0x%x", uint32(hr))
	}
	defer externalTeXOle32.NewProc("CoUninitialize").Call()
	verbWide, err := syscall.UTF16PtrFromString(verb)
	if err != nil {
		return err
	}
	fileWide, err := syscall.UTF16PtrFromString(executable)
	if err != nil {
		return err
	}
	parametersWide, err := syscall.UTF16PtrFromString(arguments)
	if err != nil {
		return err
	}
	var directoryWide *uint16
	if directory != "" {
		directoryWide, err = syscall.UTF16PtrFromString(directory)
		if err != nil {
			return err
		}
	}
	info := externalTeXShellExecuteInfo{Mask: 0x40 | 0x100, Verb: verbWide, File: fileWide, Parameters: parametersWide, Directory: directoryWide, Show: 1}
	info.Size = uint32(unsafe.Sizeof(info))
	ok, _, callErr := externalTeXShell32.NewProc("ShellExecuteExW").Call(uintptr(unsafe.Pointer(&info)))
	if ok == 0 {
		if errors.Is(callErr, syscall.Errno(1223)) {
			return context.Canceled
		}
		return fmt.Errorf("open TeX tool: %w", callErr)
	}
	if info.Process == 0 {
		if wait {
			return messages.Errorf("OS が開いた TeX の操作の終了を確認できません．開いた画面で結果を確認してください．")
		}
		return nil
	}
	defer syscall.CloseHandle(info.Process)
	if !wait {
		return nil
	}
	cancelReported := false
	for {
		status, err := syscall.WaitForSingleObject(info.Process, 250)
		if err != nil {
			return err
		}
		if status == syscall.WAIT_OBJECT_0 {
			var exitCode uint32
			if err := syscall.GetExitCodeProcess(info.Process, &exitCode); err != nil {
				return err
			}
			if exitCode != 0 {
				return messages.Errorf("TeX の操作が終了コード %d で終了しました．開いたウィンドウの内容を確認してください．", exitCode)
			}
			return nil
		}
		if status != syscall.WAIT_TIMEOUT {
			return fmt.Errorf("wait for TeX tool: Windows status %d", status)
		}
		if ctx.Err() != nil && !cancelReported {
			cancelReported = true
			if output != nil {
				fmt.Fprintln(output, messages.Text(messages.LanguageFromContext(ctx), "OS の画面で開始した TeX の操作が終了するまで待っています．中止する場合は，開いた画面で操作してください．"))
			}
		}
	}
}

var externalTeXBatchPath = regexp.MustCompile(`"([^"\r\n]+)"`)

func checkExternalTeXWindowsUninstaller(environment TeXEnvironment) error {
	expected := filepath.Join(environment.Directory, "tlpkg", "installer", "uninst.bat")
	if !samePath(environment.Uninstaller, expected) {
		return messages.Errorf("選択した TeX の公式アンインストーラーを確認できません．")
	}
	if err := checkExternalTeXCommandPaths(environment, expected, environment.Directory); err != nil {
		return err
	}
	first, err := readCacheFile(expected, 1<<20)
	if err != nil {
		return err
	}
	// The installer writes absolute paths into these files. An installation
	// moved later must not invoke an uninstaller still aimed at the old path.
	normalized := strings.ToLower(strings.ReplaceAll(platform.DecodeOutput(first), "/", `\`))
	root := strings.ToLower(filepath.Clean(environment.Directory))
	if !strings.Contains(normalized, "path "+root+`\tlpkg\tlperl\bin;`+root+`\bin\windows;`) {
		return messages.Errorf("アンインストーラーに記録された TeX の場所が，選択したフォルダーと一致しません．Windows のアプリ設定から内容を確認してください．")
	}
	secondPath := filepath.Join(filepath.Dir(expected), "uninst2.bat")
	if err := checkExternalTeXCommandPaths(environment, secondPath, environment.Directory); err != nil {
		return err
	}
	second, err := readCacheFile(secondPath, 1<<20)
	if err != nil {
		return err
	}
	foundRoot := false
	for _, match := range externalTeXBatchPath.FindAllStringSubmatch(platform.DecodeOutput(second), -1) {
		path := filepath.Clean(strings.ReplaceAll(match[1], "/", `\`))
		if path == "%0" {
			continue
		}
		if strings.ContainsAny(path, "%!\x00") || !filepath.IsAbs(path) {
			return messages.Errorf("アンインストーラーの削除先を確認できません: %s", match[1])
		}
		allowed := samePath(path, environment.Directory) || pathInExternalTeX(environment.Directory, path)
		foundRoot = foundRoot || samePath(path, environment.Directory)
		for _, systemDirectory := range environment.SystemDirectories {
			allowed = allowed || samePath(path, systemDirectory)
		}
		if !allowed {
			return messages.Errorf("アンインストーラーが，確認した TeX のフォルダー以外を参照しています: %s", match[1])
		}
	}
	if !foundRoot {
		return messages.Errorf("アンインストーラーから TeX の保存先を確認できません．")
	}
	return nil
}

func runExternalTeXUninstall(ctx context.Context, environment TeXEnvironment, output io.Writer) error {
	if environment.Managed || !environment.CanUninstall {
		return messages.Errorf("この TeX の環境は，外部環境の削除操作から変更できません．")
	}
	if environment.StoreEdition && (environment.RequiresElevation || environment.Shared || environment.UninstallInSettings) {
		return messages.Errorf("この TeX の環境は，Windows のアプリ設定からアンインストールしてください．")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if environment.Uninstaller != "" {
		if err := checkExternalTeXWindowsUninstaller(environment); err != nil {
			return err
		}
		verb := "open"
		if environment.RequiresElevation || environment.Shared {
			verb = "runas"
		}
		if output != nil {
			fmt.Fprintf(output, "[uninstall] %s\n", environment.Uninstaller)
		}
		// No command-line argument: TeX Live's script suppresses its native
		// confirmation when any argument is supplied.
		err := shellExecuteExternalTeX(ctx, verb, environment.Uninstaller, "", filepath.Dir(environment.Directory), true, output)
		return externalTeXWindowsUninstallResult(ctx, environment, err, output)
	}
	if environment.Format != "tinytex" || !environment.Writable || environment.Shared {
		return messages.Errorf("この TeX の環境の公式アンインストーラーが見つかりません．Windows のアプリ設定から確認してください．")
	}
	if err := checkExternalTeXCommandPaths(environment, environment.Manager, environment.Directory); err != nil {
		return err
	}
	registered, err := externalTeXWindowsUserPathContains(environment.Bin)
	if err != nil {
		return err
	}
	restorePath := func() error {
		if !registered {
			return nil
		}
		command, cleanup, err := texSetupToolCommand(context.WithoutCancel(ctx), environment.Bin, os.TempDir(), false, "tlmgr", "path", "add", "--windowsmode", "user")
		if err != nil {
			return err
		}
		defer cleanup()
		command.Dir = environment.Directory
		platform.PrepareCommand(command)
		command.Stdout, command.Stderr = output, output
		return command.Run()
	}
	// TinyTeX's official removal first unregisters this user's TeX bin path.
	// Its portable archive has no generated TeX Live uninst.bat.
	command, cleanup, err := texSetupToolCommand(ctx, environment.Bin, os.TempDir(), false, "tlmgr", "path", "remove", "--windowsmode", "user")
	if err != nil {
		return err
	}
	defer cleanup()
	command.Dir = environment.Directory
	platform.PrepareCommand(command)
	command.Stdout, command.Stderr = output, output
	if err := command.Run(); err != nil {
		return externalTeXRollbackResult(messages.Errorf("TinyTeX のパス登録を解除できません: %w", err), restorePath())
	}
	err = trashExternalTeXWindows(ctx, environment.Directory)
	if result := externalTeXUninstallResult(environment, err); result != nil {
		return externalTeXRollbackResult(result, restorePath())
	}
	return nil
}

func externalTeXWindowsUserPathContains(bin string) (bool, error) {
	subkey, _ := syscall.UTF16PtrFromString("Environment")
	var key syscall.Handle
	if err := syscall.RegOpenKeyEx(syscall.HKEY_CURRENT_USER, subkey, 0, syscall.KEY_QUERY_VALUE, &key); err != nil {
		if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
			return false, nil
		}
		return false, err
	}
	defer syscall.RegCloseKey(key)
	name, _ := syscall.UTF16PtrFromString("Path")
	var kind, length uint32
	if err := syscall.RegQueryValueEx(key, name, nil, &kind, nil, &length); err != nil {
		if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
			return false, nil
		}
		return false, err
	}
	if (kind != syscall.REG_SZ && kind != syscall.REG_EXPAND_SZ) || length > 1<<20 || length%2 != 0 {
		return false, messages.Errorf("Windows のユーザー PATH を読み取れません．")
	}
	if length == 0 {
		return false, nil
	}
	wide := make([]uint16, length/2+1)
	if err := syscall.RegQueryValueEx(key, name, nil, &kind, (*byte)(unsafe.Pointer(&wide[0])), &length); err != nil {
		return false, err
	}
	expand := externalTeXKernel32.NewProc("ExpandEnvironmentStringsW")
	count, _, callErr := expand.Call(uintptr(unsafe.Pointer(&wide[0])), 0, 0)
	if count == 0 || count > 1<<20 {
		return false, fmt.Errorf("read Windows user PATH: %v", callErr)
	}
	expanded := make([]uint16, int(count))
	count, _, callErr = expand.Call(uintptr(unsafe.Pointer(&wide[0])), uintptr(unsafe.Pointer(&expanded[0])), uintptr(len(expanded)))
	if count == 0 || count > uintptr(len(expanded)) {
		return false, fmt.Errorf("read Windows user PATH: %v", callErr)
	}
	for _, path := range filepath.SplitList(syscall.UTF16ToString(expanded)) {
		path = strings.Trim(strings.TrimSpace(path), `"`)
		if actual, err := filepath.EvalSymlinks(path); err == nil && samePath(actual, bin) {
			return true, nil
		}
	}
	return false, nil
}

func externalTeXWindowsUninstallResult(ctx context.Context, environment TeXEnvironment, operationErr error, output io.Writer) error {
	for _, path := range []string{filepath.Join(environment.Bin, "kpsewhich.exe"), environment.Manager, filepath.Join(environment.Directory, "tlpkg", "texlive.tlpdb")} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			if operationErr != nil {
				return operationErr
			}
			return messages.Errorf("TeX の実行ファイルまたはパッケージの記録が残っています．Windows の画面で操作を完了した後，一覧を更新してください: %s", path)
		}
	}
	entries, err := os.ReadDir(environment.Directory)
	if err != nil && !os.IsNotExist(err) {
		return messages.Errorf("TeX の削除後に保存先を確認できません: %w", err)
	}
	if err == nil && output != nil {
		fmt.Fprintln(output, messages.Text(messages.LanguageFromContext(ctx), "TeX のアンインストールが完了しました．設定ファイルなどが次のフォルダーに残っています: %s", environment.Directory))
		for _, entry := range entries {
			fmt.Fprintln(output, filepath.Join(environment.Directory, entry.Name()))
		}
	}
	return nil
}

type externalTeXFileOperation struct {
	Window      uintptr
	Operation   uint32
	From        *uint16
	To          *uint16
	Flags       uint16
	Aborted     int32
	NameMapping uintptr
	Progress    *uint16
}

func trashExternalTeXWindows(ctx context.Context, directory string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !filepath.IsAbs(directory) || strings.HasPrefix(directory, `\\?\`) || strings.ContainsAny(directory, "*?\x00") {
		return messages.Errorf("ごみ箱へ移す TeX のパスを確認できません: %s", directory)
	}
	wide, err := syscall.UTF16FromString(directory)
	if err != nil {
		return err
	}
	wide = append(wide, 0) // SHFileOperation expects a double-NUL list.
	info := externalTeXFileOperation{Operation: 3, From: &wide[0], Flags: 0x0040 | 0x4000}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	hr, _, _ := externalTeXOle32.NewProc("CoInitializeEx").Call(0, 2)
	if int32(hr) < 0 {
		return fmt.Errorf("move TeX to Recycle Bin: COM HRESULT 0x%x", uint32(hr))
	}
	defer externalTeXOle32.NewProc("CoUninitialize").Call()
	// ALLOWUNDO requests the Recycle Bin. WANTNUKEWARNING requires Windows
	// to ask before permanently removing an item that cannot be recycled.
	result, _, _ := externalTeXShell32.NewProc("SHFileOperationW").Call(uintptr(unsafe.Pointer(&info)))
	if info.Aborted != 0 {
		return context.Canceled
	}
	if result != 0 {
		return fmt.Errorf("move TeX to Recycle Bin: Windows code %d", result)
	}
	return nil
}

func openExternalTeXManager(ctx context.Context, environment TeXEnvironment) error {
	if err := checkExternalTeXCommandPaths(environment, environment.ManagerApplication, environment.Directory); err != nil {
		return err
	}
	if !strings.EqualFold(filepath.Base(environment.ManagerApplication), "tlshell.exe") || !samePath(filepath.Dir(environment.ManagerApplication), environment.Bin) {
		return messages.Errorf("選択した TeX の公式管理画面を確認できません．")
	}
	// tlshell.exe owns its UAC dialog. The editor opens it with normal rights.
	return shellExecuteExternalTeX(ctx, "open", environment.ManagerApplication, "", environment.Directory, false, nil)
}

func openExternalTeXUninstaller(ctx context.Context, environment TeXEnvironment) error {
	if !environment.UninstallInSettings || !environment.StoreEdition {
		return messages.Errorf("この環境は，TeX の削除確認画面から操作してください．")
	}
	return shellExecuteExternalTeX(ctx, "open", "ms-settings:appsfeatures", "", "", false, nil)
}
