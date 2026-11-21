//go:build windows

package app

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func externalTeXWindowsFakePerl(t *testing.T) string {
	t.Helper()
	executable := filepath.Join(t.TempDir(), "fake-perl.exe")
	script := "$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition " + quoteExternalTeXPowerShell(externalTeXWindowsFakePerlSource) + " -Language CSharp -OutputType ConsoleApplication -OutputAssembly " + quoteExternalTeXPowerShell(executable)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, externalTeXSystemProgram(`WindowsPowerShell\v1.0\powershell.exe`), "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodeExternalTeXPowerShell(script))
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("compile the interpreter fixture: %v\n%s", err, output)
	}
	return executable
}

func externalTeXWindowsUpdateEnvironment(t *testing.T, interpreter string) TeXEnvironment {
	t.Helper()
	root := filepath.Join(t.TempDir(), "author's TeX 日本語")
	bin := filepath.Join(root, "bin", "windows")
	manager := filepath.Join(bin, "tlmgr.bat")
	writeTestFile(t, manager, []byte("this launcher must not run"))
	writeTestFile(t, filepath.Join(root, "texmf-dist", "scripts", "texlive", "tlmgr.pl"), []byte("the selected manager script"))
	perl := filepath.Join(root, "tlpkg", "tlperl", "bin", "perl.exe")
	if err := os.MkdirAll(filepath.Dir(perl), 0700); err != nil {
		t.Fatal(err)
	}
	if err := copyPerlRuntimeFile(interpreter, perl); err != nil {
		t.Fatal(err)
	}
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := texSetupCommandPath(root); err != nil {
		t.Skipf("this test location cannot provide a short TeX path: %v", err)
	}
	bin = filepath.Join(root, "bin", "windows")
	return TeXEnvironment{Directory: root, Bin: bin, Manager: filepath.Join(bin, "tlmgr.bat"), Format: "texlive", RequiresElevation: true}
}

func executeExternalTeXPowerShellForTest(t *testing.T, script string) (string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, externalTeXSystemProgram(`WindowsPowerShell\v1.0\powershell.exe`), "-NoLogo", "-NoProfile", "-EncodedCommand", encodeExternalTeXPowerShell(script))
	command.Stdin = strings.NewReader("\n\n")
	output, err := command.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("the generated script did not finish: %v\n%s", ctx.Err(), output)
	}
	return string(output), err
}

func TestExternalTeXWindowsSelfUpdateCompletesInsideTheApprovedScript(t *testing.T) {
	interpreter := externalTeXWindowsFakePerl(t)
	for _, test := range []struct {
		mode                string
		code                int
		finished, log, temp bool
	}{
		{"success", 0, true, true, false},
		{"no-update", 0, false, false, false},
		{"keep-temp", 0, true, true, true},
		{"perl-failure", 7, false, false, true},
		{"updater-failure", 9, false, true, true},
	} {
		t.Run(test.mode, func(t *testing.T) {
			environment := externalTeXWindowsUpdateEnvironment(t, interpreter)
			t.Setenv("LOCAL_TEX_EXTERNAL_UPDATE_TEST", test.mode)
			t.Setenv("PERL5OPT", "must not reach the selected interpreter")
			for _, name := range []string{"updater-w32", "updater-w32.bat"} {
				writeTestFile(t, filepath.Join(environment.Directory, "temp", name), []byte("@echo off\r\n>\"%~dp0..\\stale.txt\" echo stale updater\r\n"))
			}
			writeTestFile(t, filepath.Join(environment.Directory, "temp", "update-self.log"), []byte("stale update log"))
			arguments := []string{"--machine-readable", "--repository", "https://tex.example/日本語?value=';&%PATH%$()", "update", "--self"}
			script, cleanup, err := elevatedExternalTeXPowerShell(environment, environment.Manager, arguments, environment.Directory)
			if err != nil {
				t.Fatal(err)
			}
			defer cleanup()
			output, err := executeExternalTeXPowerShellForTest(t, script)
			if test.code == 0 {
				if err != nil {
					t.Fatalf("self-update failed: %v\n%s", err, output)
				}
			} else {
				var exit *exec.ExitError
				if !errors.As(err, &exit) || exit.ExitCode() != test.code {
					t.Fatalf("exit = %v, want %d\n%s", err, test.code, output)
				}
			}
			assertCompiledPDFFileMissing(t, filepath.Join(environment.Directory, "stale.txt"))
			if strings.Contains(output, "stale update log") || strings.Contains(output, "current updater log") != test.log {
				t.Fatalf("unexpected update log: %s", output)
			}
			_, finishedErr := os.Stat(filepath.Join(environment.Directory, "finished.txt"))
			if (finishedErr == nil) != test.finished {
				t.Fatalf("updater completion: %v; want completed=%v", finishedErr, test.finished)
			}
			_, tempErr := os.Stat(filepath.Join(environment.Directory, "temp"))
			if (tempErr == nil) != test.temp {
				t.Fatalf("temporary folder: %v; want present=%v", tempErr, test.temp)
			}
			if test.mode == "keep-temp" {
				data, err := os.ReadFile(filepath.Join(environment.Directory, "temp", "other.txt"))
				if err != nil || string(data) != "another file" {
					t.Fatal("the updater changed an unrelated temporary file")
				}
			}
			data, err := os.ReadFile(filepath.Join(environment.Directory, "arguments.txt"))
			if err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, line := range strings.Fields(string(data)) {
				value, err := base64.StdEncoding.DecodeString(line)
				if err != nil {
					t.Fatal(err)
				}
				got = append(got, string(value))
			}
			shortRoot, _ := texSetupCommandPath(environment.Directory)
			want := append([]string{filepath.Join(shortRoot, "texmf-dist", "scripts", "texlive", "tlmgr.pl")}, arguments...)
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("the selected interpreter received %q, want %q", got, want)
			}
		})
	}
}

func TestExternalTeXWindowsSelfUpdateRechecksTheTemporaryDirectoryAfterPerl(t *testing.T) {
	interpreter := externalTeXWindowsFakePerl(t)
	environment := externalTeXWindowsUpdateEnvironment(t, interpreter)
	outside := t.TempDir()
	outside, err := texSetupCommandPath(outside)
	if err != nil {
		t.Skipf("no short test path: %v", err)
	}
	updater := filepath.Join(outside, "updater-w32")
	content := []byte("@echo off\r\n>\"%~dp0unexpected.txt\" echo outside updater\r\n")
	writeTestFile(t, updater, content)
	t.Setenv("LOCAL_TEX_EXTERNAL_UPDATE_TEST", "redirect-temp")
	t.Setenv("LOCAL_TEX_EXTERNAL_UPDATE_OUTSIDE", outside)
	script, cleanup, err := elevatedExternalTeXPowerShell(environment, environment.Manager, []string{"update", "--self"}, environment.Directory)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	output, err := executeExternalTeXPowerShellForTest(t, script)
	if err == nil || !strings.Contains(output, "reparse point") {
		t.Fatalf("the changed directory was accepted: %v\n%s", err, output)
	}
	if data, err := os.ReadFile(updater); err != nil || string(data) != string(content) {
		t.Fatal("the updater outside the selected TeX folder was changed")
	}
	assertCompiledPDFFileMissing(t, filepath.Join(outside, "unexpected.txt"))
}

func TestExternalTeXWindowsSelfUpdateRejectsARootChangedDuringApproval(t *testing.T) {
	interpreter := externalTeXWindowsFakePerl(t)
	environment := externalTeXWindowsUpdateEnvironment(t, interpreter)
	t.Setenv("LOCAL_TEX_EXTERNAL_UPDATE_TEST", "success")
	script, cleanup, err := elevatedExternalTeXPowerShell(environment, environment.Manager, []string{"update", "--self"}, environment.Directory)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	moved := environment.Directory + "-moved"
	if err := os.Rename(environment.Directory, moved); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.Remove(environment.Directory)
		_ = os.Rename(moved, environment.Directory)
	})
	command := exec.Command(externalTeXSystemProgram("cmd.exe"), "/d", "/c", "mklink", "/J", environment.Directory, moved)
	if output, err := command.CombinedOutput(); err != nil {
		t.Skipf("directory junctions are unavailable: %v\n%s", err, output)
	}
	output, err := executeExternalTeXPowerShellForTest(t, script)
	if err == nil || !strings.Contains(output, "reparse point") {
		t.Fatalf("the installation changed during approval: %v\n%s", err, output)
	}
	assertCompiledPDFFileMissing(t, filepath.Join(moved, "arguments.txt"))
	assertCompiledPDFFileMissing(t, filepath.Join(moved, "finished.txt"))
}

// The generated PowerShell runs this small executable in place of Perl. It
// receives the same script path and arguments, then prepares the same nested
// cmd structure as tlmgr.pl. The test invokes the script without UAC.
const externalTeXWindowsFakePerlSource = `
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
public class FakeTeXPerl {
  public static int Main(string[] args) {
    if (Environment.GetEnvironmentVariable("PERL5OPT") != null) return 91;
    string root=Path.GetFullPath(Path.Combine(Path.GetDirectoryName(args[0]),"..","..",".."));
    string[] encoded=new string[args.Length];
    for(int i=0;i<args.Length;i++) encoded[i]=Convert.ToBase64String(Encoding.UTF8.GetBytes(args[i]));
    File.WriteAllLines(Path.Combine(root,"arguments.txt"),encoded,Encoding.ASCII);
    string mode=Environment.GetEnvironmentVariable("LOCAL_TEX_EXTERNAL_UPDATE_TEST");
    string temporary=Path.Combine(root,"temp");
    Directory.CreateDirectory(temporary);
    if(mode=="no-update") return 0;
    if(mode=="redirect-temp") {
      Directory.Move(temporary,Path.Combine(root,"saved-temp"));
      var process=new Process();
      process.StartInfo.FileName=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"cmd.exe");
      process.StartInfo.Arguments="/d /c mklink /J \""+temporary+"\" \""+Environment.GetEnvironmentVariable("LOCAL_TEX_EXTERNAL_UPDATE_OUTSIDE")+"\"";
      process.StartInfo.UseShellExecute=false;
      process.Start(); process.WaitForExit();
      return process.ExitCode;
    }
    if(mode=="keep-temp") File.WriteAllText(Path.Combine(temporary,"other.txt"),"another file",Encoding.ASCII);
    string batch="@echo off\r\nif [%1]==[:doit] goto :doit\r\n"+
      "cmd.exe /e:on/v:off/d/c call \"%~f0\" :doit 2^>\"%~dp0update-self.log\" 1^>^&2\r\nrem\r\ngoto :eof\r\n"+
      ":doit\r\necho current updater log\r\n";
    if(mode=="updater-failure") batch+="exit /b 9\r\n";
    else batch+=">\"%~dp0..\\finished.txt\" echo completed\r\nexit /b 0\r\n";
    File.WriteAllText(Path.Combine(temporary,"updater-w32"),batch,Encoding.ASCII);
    return mode=="perl-failure" ? 7 : 0;
  }
}
`
