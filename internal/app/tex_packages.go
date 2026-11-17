package app

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

type TeXProgramStatus struct {
	Name      string   `json:"name"`
	Path      string   `json:"path"`
	Available bool     `json:"available"`
	Packages  []string `json:"packages"`
}

type TeXPackageStatus struct {
	Bin           string             `json:"bin"`
	Manager       string             `json:"manager"`
	Year          int                `json:"year"`
	Repository    string             `json:"repository"`
	Shell         string             `json:"shell"`
	CommandPrefix string             `json:"commandPrefix"`
	Programs      []TeXProgramStatus `json:"programs"`
}

// This reads file metadata only. Package installation and searches happen in
// the user's terminal after they choose and copy a command from the settings.
func texPackagesStatus(bin string) TeXPackageStatus {
	bin = texPackageBin(bin)
	result := TeXPackageStatus{Bin: bin, Shell: "posix", Programs: []TeXProgramStatus{}}
	managerName, extension := "tlmgr", ""
	if runtime.GOOS == "windows" {
		result.Shell, managerName, extension = "powershell", "tlmgr.bat", ".exe"
	}
	if bin != "" {
		result.Year = texLiveYear(bin)
		manager := filepath.Join(bin, managerName)
		if texProgramExists(manager) {
			result.Manager = manager
			result.Repository, result.CommandPrefix = texPackageCommand(manager, result.Year, time.Now().Year(), runtime.GOOS)
		}
	}
	programs := []struct {
		name     string
		packages []string
	}{
		{"latexmk", []string{"latexmk"}},
		{"synctex", []string{"synctex"}},
		{"pdflatex", []string{"latex-bin", "pdftex"}},
		{"lualatex", []string{"latex-bin", "luahbtex", "luaotfload"}},
		{"xelatex", []string{"latex-bin", "xetex"}},
		{"uplatex", []string{"uplatex", "uptex"}},
		{"platex", []string{"platex", "ptex"}},
		{"dvipdfmx", []string{"dvipdfmx"}},
		{"upbibtex", []string{"uptex"}},
		{"bibtex", []string{"bibtex"}},
		{"biber", []string{"biber"}},
	}
	for _, program := range programs {
		status := TeXProgramStatus{Name: program.name, Packages: program.packages}
		if program.name == "synctex" && runtime.GOOS == "windows" {
			status.Packages = append(status.Packages, "synctex.windows")
		}
		if bin != "" {
			status.Path = filepath.Join(bin, program.name+extension)
			status.Available = texProgramExists(status.Path)
		}
		result.Programs = append(result.Programs, status)
	}
	return result
}

func texProgramExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && (runtime.GOOS == "windows" || info.Mode()&0111 != 0)
}

func texPackageBin(configured string) string {
	if configured != "" {
		if absolute, err := filepath.Abs(configured); err == nil {
			return absolute
		}
		return configured
	}
	manager := "tlmgr"
	if runtime.GOOS == "windows" {
		manager += ".bat"
	}
	if executable, err := exec.LookPath(manager); err == nil {
		if absolute, err := filepath.Abs(executable); err == nil {
			return filepath.Dir(absolute)
		}
	}
	var candidates []string
	if runtime.GOOS == "darwin" {
		candidates = append(candidates, "/Library/TeX/texbin/tlmgr")
	} else if runtime.GOOS == "windows" {
		drive := os.Getenv("SystemDrive")
		if drive == "" {
			drive = "C:"
		}
		candidates, _ = filepath.Glob(filepath.Join(drive+`\`, "texlive", "*", "bin", "windows", manager))
		sort.Sort(sort.Reverse(sort.StringSlice(candidates)))
	}
	for _, candidate := range candidates {
		if texProgramExists(candidate) {
			return filepath.Dir(candidate)
		}
	}
	return ""
}

func texLiveRepository(year, currentYear int) string {
	if year == 0 || year > currentYear {
		return ""
	}
	if year < currentYear {
		return fmt.Sprintf("https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/%d/tlnet-final", year)
	}
	return "https://mirror.ctan.org/systems/texlive/tlnet"
}

func posixLiteral(text string) string {
	return "'" + strings.ReplaceAll(text, "'", "'\"'\"'") + "'"
}

func texPackageCommand(manager string, year, currentYear int, platform string) (string, string) {
	if manager == "" {
		return "", ""
	}
	quote := posixLiteral
	prefix := ""
	if platform == "windows" {
		quote, prefix = powershellLiteral, "& "
	}
	prefix += quote(manager)
	repository := texLiveRepository(year, currentYear)
	if repository != "" {
		prefix += " --repository " + quote(repository)
	}
	return repository, prefix
}
