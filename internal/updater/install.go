package updater

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

type InstallPlan struct {
	Directory      string `json:"directory"`
	Target         string `json:"target"`
	TargetSHA256   string `json:"targetSHA256"`
	ConfigDir      string `json:"configDir"`
	CurrentVersion string `json:"currentVersion"`
	Restart        bool   `json:"restart"`
}

// LaunchInstaller copies the current, already running application as a helper.
// The helper waits for the application's lock before verifying and installing
// the download. No request from the browser can choose a path or an executable.
func LaunchInstaller(directory, configDir, currentVersion string, restart bool) error {
	release, _, err := NewClient().ReadDownloaded(directory, "windows-amd64")
	if err != nil {
		return err
	}
	if !Newer(release.Manifest.Version, currentVersion) {
		return errors.New("the prepared update is not newer than this application")
	}
	target, err := os.Executable()
	if err != nil {
		return err
	}
	target, err = filepath.EvalSymlinks(target)
	if err != nil {
		return err
	}
	hash, err := fileHash(target)
	if err != nil {
		return err
	}
	helper, err := os.CreateTemp(directory, "update-helper-*.exe")
	if err != nil {
		return err
	}
	helperPath := helper.Name()
	helper.Close()
	if err := copyExecutable(target, helperPath); err != nil {
		os.Remove(helperPath)
		return err
	}
	plan := InstallPlan{directory, target, hash, configDir, currentVersion, restart}
	data, err := json.Marshal(plan)
	if err != nil {
		return err
	}
	planPath := helperPath + ".json"
	if err := os.WriteFile(planPath, data, 0600); err != nil {
		return err
	}
	command := exec.Command(helperPath, "--apply-app-update", planPath)
	platform.PrepareCommand(command)
	if err := command.Start(); err != nil {
		os.Remove(planPath)
		os.Remove(helperPath)
		return err
	}
	return command.Process.Release()
}

func ExtractWindowsExecutable(archive, destination string) (string, error) {
	reader, err := zip.OpenReader(archive)
	if err != nil {
		return "", err
	}
	defer reader.Close()
	if len(reader.File) > 4096 {
		return "", errors.New("the update archive contains too many files")
	}
	var executable *zip.File
	for _, file := range reader.File {
		name := strings.ReplaceAll(file.Name, "\\", "/")
		if strings.HasPrefix(name, "/") || strings.Contains(name, ":") {
			return "", errors.New("the update archive contains an invalid path")
		}
		for _, part := range strings.Split(name, "/") {
			if part == ".." {
				return "", errors.New("the update archive contains an invalid path")
			}
		}
		if name == "local-tex-web-editor.exe" {
			if executable != nil || !file.Mode().IsRegular() || file.UncompressedSize64 == 0 || file.UncompressedSize64 > 128<<20 {
				return "", errors.New("the update executable is invalid")
			}
			executable = file
		}
	}
	if executable == nil {
		return "", errors.New("the update archive does not contain the application")
	}
	source, err := executable.Open()
	if err != nil {
		return "", err
	}
	defer source.Close()
	output, err := os.CreateTemp(destination, "application-update-*.tmp")
	if err != nil {
		return "", err
	}
	name := output.Name()
	complete := false
	defer func() {
		output.Close()
		if !complete {
			os.Remove(name)
		}
	}()
	n, err := io.Copy(output, io.LimitReader(source, 128<<20+1))
	if err != nil {
		return "", err
	}
	if uint64(n) != executable.UncompressedSize64 {
		return "", errors.New("the update executable size is invalid")
	}
	if err := output.Sync(); err != nil {
		return "", err
	}
	if err := output.Close(); err != nil {
		return "", err
	}
	if err := os.Chmod(name, 0700); err != nil {
		return "", err
	}
	complete = true
	return name, nil
}

func fileHash(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > 128<<20 {
		return "", errors.New("the application executable is invalid")
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, io.LimitReader(f, 128<<20+1)); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func copyExecutable(source, target string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_TRUNC|os.O_CREATE, 0700)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, io.LimitReader(in, 128<<20+1)); err != nil {
		return err
	}
	return out.Sync()
}

func waitForApplicationExit(ctx context.Context, configDir string) (func(), error) {
	for {
		release, err := platform.AcquireAppLock(configDir)
		if err == nil {
			return release, nil
		}
		if !errors.Is(err, platform.ErrLocked) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// ReplaceExecutable keeps a complete previous executable until the new app
// reports that its local server is ready. Rename failures restore the old path.
func ReplaceExecutable(target, staged, expectedHash string) (string, error) {
	if _, err := fileHash(staged); err != nil {
		return "", err
	}
	actual, err := fileHash(target)
	if err != nil {
		return "", err
	}
	if actual != expectedHash {
		return "", errors.New("the installed application changed while the update was being prepared")
	}
	backupFile, err := os.CreateTemp(filepath.Dir(target), "application-previous-*.exe")
	if err != nil {
		return "", err
	}
	backup := backupFile.Name()
	backupFile.Close()
	os.Remove(backup)
	deadline := time.Now().Add(5 * time.Second)
	for {
		err = os.Rename(target, backup)
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			return "", err
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err := os.Rename(staged, target); err != nil {
		if restoreErr := os.Rename(backup, target); restoreErr != nil {
			return "", fmt.Errorf("%w; restoring the previous application failed: %v", err, restoreErr)
		}
		return "", err
	}
	return backup, nil
}

func RunInstaller(planPath string) (result error) {
	data, err := readBounded(planPath, 16<<10)
	if err != nil {
		return err
	}
	var plan InstallPlan
	if json.Unmarshal(data, &plan) != nil || !filepath.IsAbs(plan.Target) || !filepath.IsAbs(plan.Directory) || !filepath.IsAbs(plan.ConfigDir) {
		return errors.New("the application update plan is invalid")
	}
	defer os.Remove(planPath)
	previousExited, restarted := false, false
	var updateVersion string
	defer func() {
		if result != nil {
			_ = os.WriteFile(filepath.Join(plan.ConfigDir, "updates", "last-error.txt"), []byte(result.Error()), 0600)
			failure, _ := json.Marshal(map[string]string{"version": updateVersion, "error": result.Error()})
			_ = os.WriteFile(filepath.Join(plan.ConfigDir, "updates", "failed.json"), failure, 0600)
			if previousExited && plan.Restart && !restarted {
				old := exec.Command(plan.Target, "--background", "--config-dir", plan.ConfigDir)
				platform.PrepareCommand(old)
				if old.Start() == nil {
					_ = old.Process.Release()
				}
			}
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	unlock, err := waitForApplicationExit(ctx, plan.ConfigDir)
	if err != nil {
		return err
	}
	previousExited = true
	defer func() {
		if unlock != nil {
			unlock()
		}
	}()
	client := NewClient()
	release, archive, err := client.ReadDownloaded(plan.Directory, "windows-amd64")
	if err != nil {
		return err
	}
	updateVersion = release.Manifest.Version
	if !Newer(release.Manifest.Version, plan.CurrentVersion) {
		return errors.New("the downloaded update is not newer than the running application")
	}
	staged, err := ExtractWindowsExecutable(archive, filepath.Dir(plan.Target))
	if err != nil {
		return err
	}
	defer os.Remove(staged)
	// The archive was verified before extraction. Also check the built version
	// before changing the installed executable, while the old copy is usable.
	versionCtx, stopVersion := context.WithTimeout(ctx, 15*time.Second)
	check := exec.CommandContext(versionCtx, staged, "--version")
	platform.PrepareCommand(check)
	version, err := check.Output()
	stopVersion()
	if err != nil || strings.TrimSpace(string(version)) != release.Manifest.Version {
		return errors.New("the downloaded application did not report the expected version")
	}
	backup, err := ReplaceExecutable(plan.Target, staged, plan.TargetSHA256)
	if err != nil {
		return err
	}
	if !plan.Restart {
		return nil
	}
	readyPath := filepath.Join(plan.ConfigDir, "updates", "restart-ready.json")
	_ = os.Remove(readyPath)
	command := exec.Command(plan.Target, "--background", "--config-dir", plan.ConfigDir, "--ready-file", readyPath)
	platform.PrepareCommand(command)
	unlock()
	unlock = nil
	if err := command.Start(); err == nil {
		finished := make(chan error, 1)
		go func() { finished <- command.Wait() }()
		deadline := time.Now().Add(45 * time.Second)
		stopped := false
		for time.Now().Before(deadline) && !stopped {
			if updateServerReady(readyPath, release.Manifest.Version, command.Process.Pid) {
				restarted = true
				_ = os.Remove(backup)
				_ = os.Remove(filepath.Join(plan.ConfigDir, "updates", "last-error.txt"))
				_ = os.Remove(filepath.Join(plan.ConfigDir, "updates", "failed.json"))
				return nil
			}
			select {
			case <-finished:
				stopped = true
			case <-time.After(200 * time.Millisecond):
			}
		}
		if !stopped {
			_ = command.Process.Kill()
			<-finished
		}
	}
	// A startup failure rolls back the executable. Existing settings and project
	// files stay at their original paths and are opened by the previous version.
	unlock, err = waitForApplicationExit(ctx, plan.ConfigDir)
	if err != nil {
		return err
	}
	failed := plan.Target + ".failed-update"
	_ = os.Remove(failed)
	if err := os.Rename(plan.Target, failed); err != nil {
		return err
	}
	if err := os.Rename(backup, plan.Target); err != nil {
		_ = os.Rename(failed, plan.Target)
		return err
	}
	_ = os.Remove(failed)
	unlock()
	unlock = nil
	old := exec.Command(plan.Target, "--background", "--config-dir", plan.ConfigDir)
	platform.PrepareCommand(old)
	if old.Start() == nil {
		restarted = true
		_ = old.Process.Release()
	}
	return errors.New("the new application could not start; the previous version was restored")
}

func updateServerReady(path, version string, pid int) bool {
	var ready struct {
		Version string `json:"version"`
		PID     int    `json:"pid"`
		URL     string `json:"url"`
		Token   string `json:"token"`
	}
	data, err := readBounded(path, 16<<10)
	if err != nil || json.Unmarshal(data, &ready) != nil || ready.Version != version || ready.PID != pid || len(ready.Token) < 16 {
		return false
	}
	address, err := url.Parse(ready.URL)
	if err != nil || address.Scheme != "http" || address.User != nil || address.Path != "/" || address.RawQuery != "" || address.Fragment != "" || address.Port() == "" {
		return false
	}
	ip := net.ParseIP(address.Hostname())
	if ip == nil || !ip.IsLoopback() {
		return false
	}
	// The update state reports the running version without scanning project
	// folders or looking for TeX tools during the startup check.
	request, err := http.NewRequest(http.MethodGet, ready.URL+"api/updates", nil)
	if err != nil {
		return false
	}
	request.Header.Set("X-Local-Token", ready.Token)
	client := &http.Client{Timeout: time.Second, Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false
	}
	var state struct {
		CurrentVersion string `json:"currentVersion"`
	}
	return json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&state) == nil && state.CurrentVersion == version
}
