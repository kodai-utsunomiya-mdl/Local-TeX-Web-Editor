//go:build windows

package app

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

func latexmkCommand(tool, bin string, arguments []string, projectRoot, temporaryRoot string) (*exec.Cmd, func(), error) {
	environment := commandEnvironment(bin)
	needsUTF8 := hasNonASCII(tool) || hasNonASCII(projectRoot)
	for _, argument := range arguments {
		needsUTF8 = needsUTF8 || hasNonASCII(argument)
	}
	if !needsUTF8 {
		command := exec.Command(tool, arguments...)
		command.Env = environment
		return command, func() {}, nil
	}

	// TeX Live's Windows wrapper obtains the command line through the ANSI
	// API. Its Perl interpreter also uses the active code page for filenames.
	// Run the installed latexmk.pl with a private UTF-8 copy of that Perl so
	// both the command line and later filesystem operations use UTF-8.
	// https://github.com/TeX-Live/texlive-source/blob/trunk/texk/texlive/windows_wrapper/runscript_dll.c
	texRoot := filepath.Dir(filepath.Dir(bin))
	perlRoot := filepath.Join(texRoot, "tlpkg", "tlperl")
	perlBin := filepath.Join(perlRoot, "bin")
	script := filepath.Join(texRoot, "texmf-dist", "scripts", "latexmk", "latexmk.pl")
	for _, path := range []string{filepath.Join(perlBin, "perl.exe"), script} {
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			return nil, nil, messages.Errorf("日本語などを含むパスでのコンパイルに必要な TeX Live のファイルが見つかりません: %s", path)
		}
	}
	private, cleanup, err := copyUTF8Perl(perlBin, temporaryRoot)
	if err != nil {
		return nil, nil, messages.Errorf("TeX Live の Perl を UTF-8 で起動する準備ができません: %w", err)
	}
	command := exec.Command(private, append([]string{script}, arguments...)...)
	command.Env = texLivePerlEnvironment(environment, perlRoot)
	return command, cleanup, nil
}

func hasNonASCII(text string) bool {
	for _, character := range text {
		if character >= utf8.RuneSelf {
			return true
		}
	}
	return false
}

func copyUTF8Perl(perlBin, temporaryRoot string) (string, func(), error) {
	directory, err := os.MkdirTemp(temporaryRoot, "tex-perl-utf8-")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { _ = os.RemoveAll(directory) }
	ready := false
	defer func() {
		if !ready {
			cleanup()
		}
	}()
	entries, err := os.ReadDir(perlBin)
	if err != nil {
		return "", nil, err
	}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.EqualFold(name, "perl.exe") && !strings.EqualFold(filepath.Ext(name), ".dll") {
			continue
		}
		if err := copyPerlRuntimeFile(filepath.Join(perlBin, name), filepath.Join(directory, name)); err != nil {
			return "", nil, err
		}
	}
	executable := filepath.Join(directory, "perl.exe")
	if err := platform.EnableUTF8CodePage(executable); err != nil {
		return "", nil, err
	}
	ready = true
	return executable, cleanup, nil
}

func copyPerlRuntimeFile(original, destination string) error {
	input, err := os.Open(original)
	if err != nil {
		return err
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return messages.Errorf("TeX Live のファイルを読み込めません: %s", original)
	}
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func texLivePerlEnvironment(environment []string, perlRoot string) []string {
	// Match runscript.tlu's environment cleanup. Explicit library paths are
	// needed because this interpreter copy lives outside tlpkg/tlperl/bin.
	remove := strings.Fields("PERL5LIB PERL5OPT PERLIO PERLIO_DEBUG PERLLIB PERL5DB PERL5DB_THREADED PERL5SHELL PERL_ALLOW_NON_IFS_LSP PERL_DEBUG_MSTATS PERL_DESTRUCT_LEVEL PERL_DL_NONLAZY PERL_ENCODING PERL_HASH_SEED PERL_HASH_SEED_DEBUG PERL_ROOT PERL_SIGNALS PERL_UNICODE")
	blocked := make(map[string]bool, len(remove))
	for _, key := range remove {
		blocked[key] = true
	}
	result := make([]string, 0, len(environment)+1)
	for _, item := range environment {
		key, value, _ := strings.Cut(item, "=")
		if strings.EqualFold(key, "PATH") {
			item = key + "=" + filepath.Join(perlRoot, "bin") + string(os.PathListSeparator) + value
		}
		if !blocked[strings.ToUpper(key)] {
			result = append(result, item)
		}
	}
	libraries := []string{filepath.Join(perlRoot, "site", "lib"), filepath.Join(perlRoot, "lib")}
	return append(result, "PERL5LIB="+strings.Join(libraries, string(os.PathListSeparator)))
}
