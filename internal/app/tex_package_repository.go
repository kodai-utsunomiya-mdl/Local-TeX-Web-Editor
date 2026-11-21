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
var texLiveReportedRepository = regexp.MustCompile(`(?m)^tlmgr(?:\.pl)?: package repository (\S+) \((?:not )?verified[^\r\n]*\)\r?$`)

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
	if !strings.EqualFold(repository, "ctan") {
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

func resolvedSelectedTeXRepository(repository, output string) string {
	// The normal install output includes the infrastructure-update warning;
	// --machine-readable suppresses it. Read that invocation's repository
	// line so a redirector cannot choose another mirror for update and retry.
	// Keep local and tagged multi-repository settings exactly as configured.
	if repository != "" && !strings.EqualFold(repository, "ctan") {
		parsed, err := url.Parse(repository)
		if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http" && parsed.Scheme != "ftp") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || strings.ContainsAny(repository, " \t\r\n") {
			return repository
		}
	}
	if resolved := resolvedTeXSetupRepository(repository, output); resolved != repository {
		return resolved
	}
	if match := texLiveReportedRepository.FindStringSubmatch(output); match != nil {
		return resolvedTeXSetupRepository(repository, "location-url\t"+match[1])
	}
	return repository
}

func (a *App) addSelectedTeXPackages(run *texSetupRun) error {
	repository, err := installedTeXRepository(run.root)
	if err != nil {
		return err
	}
	setRepository := func(value string) {
		repository = value
		a.mu.Lock()
		run.state.Source = value
		a.mu.Unlock()
	}
	setRepository(repository)
	arguments := []string{"install"}
	if run.reinstall {
		arguments = append(arguments, "--reinstall")
	}
	arguments = append(arguments, run.state.Packages...)
	explicitRepository, archiveTried, updated := false, false, false
	withRepository := func(values []string) []string {
		if explicitRepository && repository != "" {
			return append([]string{"--repository", repository}, values...)
		}
		return values
	}
	selectArchive := func(output string) bool {
		if archiveTried {
			return false
		}
		archive := archivedTeXRepository(repository, output)
		if archive == "" {
			return false
		}
		archiveTried, explicitRepository = true, true
		setRepository(archive)
		a.texSetupLog(run, "[repository] %s\n", archive)
		return true
	}
	for {
		output, installErr := a.texSetupManagerResult(run.ctx, run, withRepository(arguments)...)
		if installErr == nil || run.ctx.Err() != nil {
			return installErr
		}
		if selectArchive(output) {
			continue
		}
		if updated || !strings.Contains(output, "tlmgr itself needs to be updated.") {
			return installErr
		}
		setRepository(resolvedSelectedTeXRepository(repository, output))
		explicitRepository = true
		for {
			updateArguments := withRepository([]string{"update", "--self"})
			updateOutput, updateErr := a.texSetupManagerResult(run.ctx, run, append([]string{"--machine-readable"}, updateArguments...)...)
			if updateErr == nil {
				setRepository(resolvedSelectedTeXRepository(repository, updateOutput))
				updated = true
				break
			}
			if run.ctx.Err() != nil || !selectArchive(updateOutput) {
				return updateErr
			}
		}
	}
}
