package app

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

// TeXEnvironment describes the installation selected in the editor settings.
// Paths are resolved against that installation before a management action runs.
type TeXEnvironment struct {
	Directory           string   `json:"directory"`
	Bin                 string   `json:"bin"`
	Manager             string   `json:"manager"`
	ManagerApplication  string   `json:"managerApplication"`
	Format              string   `json:"format"`
	Managed             bool     `json:"managed"`
	Writable            bool     `json:"writable"`
	CanInstallPackages  bool     `json:"canInstallPackages"`
	CanRemovePackages   bool     `json:"canRemovePackages"`
	CanUninstall        bool     `json:"canUninstall"`
	UninstallInSettings bool     `json:"uninstallInSettings"`
	UninstallError      string   `json:"uninstallError,omitempty"`
	RequiresElevation   bool     `json:"requiresElevation"`
	Uninstaller         string   `json:"uninstaller"`
	StoreEdition        bool     `json:"storeEdition"`
	SystemDirectories   []string `json:"systemDirectories"`
	Shared              bool     `json:"shared"`
}

func inspectExternalTeX(ctx context.Context, bin string) (TeXEnvironment, error) {
	result := TeXEnvironment{Format: "texlive", SystemDirectories: []string{}}
	bin = texPackageBin(bin)
	if bin == "" {
		return result, messages.Errorf("TeX の実行ファイルの場所が見つかりません．設定で使用する環境を選んでください．")
	}
	extension, managerName := "", "tlmgr"
	if runtime.GOOS == "windows" {
		extension, managerName = ".exe", "tlmgr.bat"
	}
	kpsewhich, err := filepath.EvalSymlinks(filepath.Join(bin, "kpsewhich"+extension))
	if err != nil || !texProgramExists(kpsewhich) {
		return result, messages.Errorf("選択した TeX の kpsewhich が見つかりません．実行ファイルの場所を確認してください．")
	}
	// A directory such as /Library/TeX/texbin can select a particular TeX Live
	// year through a symbolic link. Use the actual executable's directory.
	result.Bin = filepath.Dir(kpsewhich)
	manager, err := filepath.EvalSymlinks(filepath.Join(bin, managerName))
	if err != nil || !texProgramExists(manager) {
		return result, messages.Errorf("選択した TeX に tlmgr が見つかりません．この画面では TeX Live，MacTeX，TinyTeX のパッケージを管理できます．")
	}
	root, err := externalTeXVariable(ctx, kpsewhich, result.Bin, "TEXMFROOT")
	if err != nil {
		return result, err
	}
	result.Directory, err = filepath.EvalSymlinks(root)
	if err != nil || !filepath.IsAbs(result.Directory) {
		return result, messages.Errorf("選択した TeX の保存先を確認できません: %s", root)
	}
	result.Directory = filepath.Clean(result.Directory)
	if err := validateExternalTeXPaths(result.Directory, kpsewhich, manager); err != nil {
		return result, err
	}
	// Keep the installation's normal entry point. On Unix, tlmgr is a link to
	// a Perl script, whose own location is used to find the TeX Live tree.
	result.Manager = filepath.Join(result.Bin, managerName)
	entry, err := filepath.EvalSymlinks(result.Manager)
	if err != nil || !samePath(entry, manager) {
		return result, messages.Errorf("選択した TeX とパッケージ管理ツールの保存先が一致しません．実行ファイルの場所を選び直してください．")
	}
	if info, err := os.Lstat(filepath.Join(result.Directory, ".tinytex")); err == nil && info.Mode().IsRegular() {
		result.Format = "tinytex"
	} else if runtime.GOOS == "darwin" && samePath(filepath.Dir(result.Directory), "/usr/local/texlive") {
		result.Format = "mactex"
	}
	for _, name := range []string{"TEXMFSYSVAR", "TEXMFSYSCONFIG"} {
		value, err := externalTeXVariable(ctx, kpsewhich, result.Bin, name)
		if err != nil {
			return result, err
		}
		if resolved, err := filepath.EvalSymlinks(value); err == nil {
			value = resolved
		}
		if !filepath.IsAbs(value) || strings.ContainsAny(value, "\x00\r\n") {
			return result, messages.Errorf("TeX の設定フォルダーを確認できません: %s", name)
		}
		found := false
		for _, directory := range result.SystemDirectories {
			found = found || samePath(directory, value)
		}
		if !found {
			result.SystemDirectories = append(result.SystemDirectories, filepath.Clean(value))
		}
	}
	result.Writable = externalTeXWritable(result.Directory, result.SystemDirectories)
	result.RequiresElevation = !result.Writable
	identity, identityErr := platform.CurrentPackageIdentity()
	result.StoreEdition = identityErr == nil && identity != nil
	data, err := readCacheFile(filepath.Join(result.Directory, "tlpkg", "texlive.tlpdb"), 64<<20)
	if err != nil {
		return result, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == "depend opt_w32_multi_user:1" {
			result.Shared = true
		}
	}
	if runtime.GOOS == "windows" {
		application := filepath.Join(result.Bin, "tlshell.exe")
		if actual, err := filepath.EvalSymlinks(application); err == nil && texProgramExists(actual) && pathInExternalTeX(result.Directory, actual) {
			result.ManagerApplication = actual
		}
		candidate := filepath.Join(result.Directory, "tlpkg", "installer", "uninst.bat")
		if info, err := os.Lstat(candidate); err == nil && info.Mode().IsRegular() {
			actual, err := filepath.EvalSymlinks(candidate)
			if err == nil && pathInExternalTeX(result.Directory, actual) {
				result.Uninstaller = actual
			}
		}
	}
	canElevate := runtime.GOOS == "darwin" || (runtime.GOOS == "windows" && !result.StoreEdition)
	result.CanInstallPackages = result.Writable || canElevate
	result.CanRemovePackages = result.CanInstallPackages
	result.CanUninstall = runtime.GOOS == "darwin" || (runtime.GOOS == "windows" && (result.Uninstaller != "" || result.Writable))
	if runtime.GOOS == "windows" && result.StoreEdition && (result.Shared || result.RequiresElevation) {
		result.CanUninstall = false
		result.UninstallInSettings = true
	}
	if err := validateExternalTeXDeletionPaths(result); err != nil {
		result.CanUninstall = false
		result.UninstallError = err.Error()
	}
	return result, nil
}

func externalTeXVariable(ctx context.Context, kpsewhich, bin, name string) (string, error) {
	commandContext, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	command := exec.CommandContext(commandContext, kpsewhich, "-var-value="+name)
	command.Env = commandEnvironment(bin)
	platform.PrepareCommand(command)
	command.Cancel = func() error { return platform.StopProcess(command.Process) }
	command.WaitDelay = 2 * time.Second
	data, err := command.Output()
	if err != nil {
		return "", messages.Errorf("選択した TeX の %s を読み取れません: %w", name, err)
	}
	value := strings.TrimSpace(platform.DecodeOutput(data))
	if value == "" || strings.ContainsAny(value, "\x00\r\n") || !filepath.IsAbs(value) {
		return "", messages.Errorf("選択した TeX の %s が絶対パスではありません．", name)
	}
	return filepath.Clean(value), nil
}

func pathInExternalTeX(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != "." && filepath.IsLocal(relative)
}

func validateExternalTeXPaths(root, kpsewhich, manager string) error {
	if !filepath.IsAbs(root) || samePath(root, filepath.Dir(root)) {
		return messages.Errorf("TeX 専用のフォルダーを確認できません: %s", root)
	}
	for _, path := range []string{kpsewhich, manager} {
		if !pathInExternalTeX(root, path) {
			return messages.Errorf("TeX の実行ファイルと管理ツールが同じ環境にありません．OS のパッケージ管理で導入した環境は，その管理ツールから変更してください．")
		}
	}
	for _, relative := range []string{"release-texlive.txt", "tlpkg/texlive.tlpdb", "texmf-dist/web2c/texmf.cnf"} {
		path := filepath.Join(root, filepath.FromSlash(relative))
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			return messages.Errorf("TeX Live の環境を確認するためのファイルが見つかりません: %s", path)
		}
		actual, err := filepath.EvalSymlinks(path)
		if err != nil || !pathInExternalTeX(root, actual) {
			return messages.Errorf("TeX Live の設定が選択した環境の外にあります: %s", path)
		}
	}
	release, err := readCacheFile(filepath.Join(root, "release-texlive.txt"), 64<<10)
	if err != nil || !strings.Contains(string(release), "TeX Live") {
		return messages.Errorf("TeX Live の環境を確認できません: %s", root)
	}
	return nil
}

func externalTeXWritable(root string, systemDirectories []string) bool {
	directories := append([]string{root, filepath.Join(root, "tlpkg"), filepath.Join(root, "texmf-dist")}, systemDirectories...)
	for _, directory := range directories {
		// A configured cache may not exist yet. Its closest existing parent
		// determines whether TeX can create it without OS authorization.
		for {
			if _, err := os.Stat(directory); err == nil {
				break
			} else if !os.IsNotExist(err) || samePath(directory, filepath.Dir(directory)) {
				return false
			}
			directory = filepath.Dir(directory)
		}
		probe, err := os.CreateTemp(directory, ".local-tex-editor-write-check-")
		if err != nil {
			return false
		}
		name := probe.Name()
		closeErr := probe.Close()
		removeErr := os.Remove(name)
		if closeErr != nil || removeErr != nil {
			return false
		}
	}
	return true
}

func validateExternalTeXEnvironment(ctx context.Context, expected TeXEnvironment) (TeXEnvironment, error) {
	current, err := inspectExternalTeX(ctx, expected.Bin)
	if err != nil {
		return current, err
	}
	if !samePath(current.Directory, expected.Directory) || !samePath(current.Manager, expected.Manager) || current.Format != expected.Format {
		return current, messages.Errorf("選択した TeX の環境が変更されました．対象をもう一度確認してください．")
	}
	if fmt.Sprint(current.SystemDirectories) != fmt.Sprint(expected.SystemDirectories) || current.Shared != expected.Shared || current.Uninstaller != expected.Uninstaller {
		return current, messages.Errorf("TeX のアンインストールに関係する設定が変更されました．対象をもう一度確認してください．")
	}
	return current, nil
}

// Callers can add the open project and the app's actual configuration folder.
// A TeX uninstaller may also remove its configured system caches, which need
// the same path checks as the installation itself.
func validateExternalTeXDeletionPaths(environment TeXEnvironment, protectedPaths ...string) error {
	targets := []string{environment.Directory}
	if runtime.GOOS == "windows" && environment.Uninstaller != "" {
		targets = append(targets, environment.SystemDirectories...)
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		protectedPaths = append(protectedPaths, home)
		for _, name := range []string{"Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos", "Library", "AppData"} {
			protectedPaths = append(protectedPaths, filepath.Join(home, name))
		}
	}
	if executable, err := os.Executable(); err == nil {
		protectedPaths = append(protectedPaths, executable)
	}
	protectedPaths = append(protectedPaths, os.TempDir())
	if runtime.GOOS == "windows" {
		for _, variable := range []string{"SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "APPDATA", "LOCALAPPDATA"} {
			if value := os.Getenv(variable); value != "" {
				protectedPaths = append(protectedPaths, value)
			}
		}
	} else {
		protectedPaths = append(protectedPaths, "/usr", "/usr/local", "/opt", "/Library", "/Library/TeX", "/Applications", "/etc", "/var", "/tmp")
	}
	for _, target := range targets {
		if !filepath.IsAbs(target) || samePath(target, filepath.Dir(target)) || strings.ContainsAny(target, "\x00\r\n") {
			return messages.Errorf("TeX の削除先として使用できない場所です: %s", target)
		}
		if actual, err := filepath.EvalSymlinks(target); err == nil && !samePath(actual, target) {
			return messages.Errorf("TeX の削除先がリンク先へ変わっています．実際の場所を確認してください: %s", target)
		}
		if !samePath(target, environment.Directory) && pathInExternalTeX(target, environment.Directory) {
			return messages.Errorf("TeX の設定フォルダーが環境の親フォルダーを指しています: %s", target)
		}
		for _, protected := range protectedPaths {
			if protected == "" || !filepath.IsAbs(protected) {
				continue
			}
			if actual, err := filepath.EvalSymlinks(protected); err == nil {
				protected = actual
			}
			if samePath(target, protected) || pathInExternalTeX(target, protected) {
				return messages.Errorf("TeX の削除先に，原稿，アプリ，またはユーザーや OS のフォルダーが含まれています: %s", target)
			}
		}
	}
	return nil
}
