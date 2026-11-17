//go:build darwin

package platform

import (
	"os"
	"os/exec"
	"path/filepath"
)

const macTeXBin = "/Library/TeX/texbin"

func init() {
	// Finder does not run a login shell. MacTeX exposes its active TeX Live
	// installation at this stable path for applications launched by Finder.
	_ = os.Setenv("PATH", withMacTeXPath(os.Getenv("PATH")))
}

func withMacTeXPath(value string) string {
	for _, directory := range filepath.SplitList(value) {
		if filepath.Clean(directory) == macTeXBin {
			return value
		}
	}
	if value == "" {
		return macTeXBin
	}
	return value + string(os.PathListSeparator) + macTeXBin
}

func OpenBrowser(url string) error {
	return exec.Command("/usr/bin/open", url).Run()
}

func ShowError(message string) {
	// Pass the message as data, so file names cannot become AppleScript code.
	script := "on run argv\n display alert \"Local TeX Web Editor\" message (item 1 of argv) as critical buttons {\"OK\"} default button \"OK\"\nend run"
	_ = exec.Command("/usr/bin/osascript", "-e", script, message).Run()
}
