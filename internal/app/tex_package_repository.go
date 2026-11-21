package app

import (
	"bufio"
	"fmt"
	"io"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
)

var texLiveRepositoryMismatch = regexp.MustCompile(`Local TeX Live \((20[0-9]{2})\) is older than remote repository \((20[0-9]{2})\)`)

func installedTeXRepository(root string) (string, error) {
	path, info, err := entryTreePath(root, "tlpkg/texlive.tlpdb")
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Size() > 64<<20 {
		return "", entryChangedError()
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	current, err := file.Stat()
	if err != nil || !os.SameFile(info, current) {
		return "", entryChangedError()
	}
	// Settings read this on every refresh. The installation record is near
	// the start of the database, so stop before reading all package records.
	scanner := bufio.NewScanner(io.LimitReader(file, 64<<20+1))
	inInstallation := false
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "name ") {
			if inInstallation {
				return "", nil
			}
			inInstallation = line == "name 00texlive.installation"
		}
		if inInstallation && strings.HasPrefix(line, "depend opt_location:") {
			return strings.TrimSpace(strings.TrimPrefix(line, "depend opt_location:")), nil
		}
	}
	return "", scanner.Err()
}

// Retry the official annual archive only after tlmgr reports a release mismatch.
// This also works before the next annual release has reached CTAN. Local,
// historical, and multiple repositories continue to use their existing settings.
func archivedTeXRepository(repository, output string) string {
	if repository != "ctan" {
		parsed, err := url.Parse(repository)
		if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http" && parsed.Scheme != "ftp") || parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
			return ""
		}
		path := strings.TrimSuffix(strings.TrimSuffix(parsed.Path, "/"), "/tlpkg")
		if !strings.HasSuffix(path, "/systems/texlive/tlnet") {
			return ""
		}
	}
	match := texLiveRepositoryMismatch.FindStringSubmatch(output)
	if match == nil {
		return ""
	}
	local, _ := strconv.Atoi(match[1])
	remote, _ := strconv.Atoi(match[2])
	if local < 2008 || remote <= local {
		return ""
	}
	return fmt.Sprintf("https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/%d/tlnet-final", local)
}

func (a *App) addSelectedTeXPackages(run *texSetupRun) error {
	repository, err := installedTeXRepository(run.root)
	if err != nil {
		return err
	}
	a.mu.Lock()
	run.state.Source = repository
	a.mu.Unlock()
	arguments := []string{"install"}
	if run.reinstall {
		arguments = append(arguments, "--reinstall")
	}
	arguments = append(arguments, run.state.Packages...)
	err = a.texSetupTool(run.ctx, run, run.root, "tlmgr", arguments...)
	if err == nil || run.ctx.Err() != nil {
		return err
	}
	a.mu.Lock()
	output := string(run.log)
	a.mu.Unlock()
	fallback := archivedTeXRepository(repository, output)
	if fallback == "" {
		return err
	}
	a.texSetupLog(run, "[repository] %s\n", fallback)
	a.mu.Lock()
	run.state.Source = fallback
	a.mu.Unlock()
	return a.texSetupTool(run.ctx, run, run.root, "tlmgr", append([]string{"--repository", fallback}, arguments...)...)
}
