//go:build windows

package app

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUnicodeMainUsesInstalledLatexmkWithPrivatePerl(t *testing.T) {
	texRoot := t.TempDir()
	bin := filepath.Join(texRoot, "bin", "windows")
	perlRoot := filepath.Join(texRoot, "tlpkg", "tlperl")
	perl := filepath.Join(perlRoot, "bin", "perl.exe")
	script := filepath.Join(texRoot, "texmf-dist", "scripts", "latexmk", "latexmk.pl")
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, perl, original)
	writeTestFile(t, script, []byte("# installed latexmk script\n"))
	writeTestFile(t, filepath.Join(perlRoot, "bin", "perl542.dll"), []byte("runtime"))
	temporary := t.TempDir()
	arguments := []string{"-pdf", "./別の 原稿.tex"}
	command, cleanup, err := latexmkCommand(filepath.Join(bin, "latexmk.exe"), bin, arguments, t.TempDir(), temporary)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cleanup)
	if command.Path == perl || !strings.HasPrefix(command.Path, temporary+string(os.PathSeparator)) {
		t.Fatalf("the installed interpreter was not copied to private storage: %s", command.Path)
	}
	if len(command.Args) != 4 || command.Args[1] != script || command.Args[3] != arguments[1] {
		t.Fatalf("the real script or Unicode filename changed: %#v", command.Args)
	}
	if !strings.Contains(strings.Join(command.Env, "\n"), filepath.Join(perlRoot, "lib")) {
		t.Fatal("the copied interpreter cannot find TeX Live's installed Perl libraries")
	}
	after, err := os.ReadFile(perl)
	if err != nil || !bytes.Equal(after, original) {
		t.Fatalf("the installed interpreter was changed: %v", err)
	}
	cleanup()
	if _, err := os.Stat(command.Path); !os.IsNotExist(err) {
		t.Fatalf("the temporary interpreter was not removed: %v", err)
	}
}

func TestTeXLivePerlEnvironmentUsesTheInstalledLibraries(t *testing.T) {
	root := `C:\TeX Live\tlpkg\tlperl`
	environment := texLivePerlEnvironment([]string{"PATH=C:\\TeX Live\\bin\\windows", "pErL5LiB=elsewhere", "PERL5OPT=-MUnrelated", "PERL_UNICODE=S", "TEXINPUTS=figures;", "KEEP=value"}, root)
	joined := strings.Join(environment, "\n")
	for _, expected := range []string{"TEXINPUTS=figures;", "KEEP=value", "PERL5LIB=" + filepath.Join(root, "site", "lib") + ";" + filepath.Join(root, "lib")} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("missing %q in %q", expected, joined)
		}
	}
	for _, unwanted := range []string{"elsewhere", "PERL5OPT=", "PERL_UNICODE="} {
		if strings.Contains(joined, unwanted) {
			t.Fatalf("inherited Perl setting %q remains in %q", unwanted, joined)
		}
	}
}
