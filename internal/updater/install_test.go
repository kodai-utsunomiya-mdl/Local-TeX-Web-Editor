package updater

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

type updateZipEntry struct {
	name string
	data []byte
	mode os.FileMode
}

func updateZip(t *testing.T, entries ...updateZipEntry) []byte {
	t.Helper()
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.name, Method: zip.Store}
		mode := entry.mode
		if mode == 0 {
			mode = 0600
		}
		header.SetMode(mode)
		file, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write(entry.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func writeUpdateTestFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0700); err != nil {
		t.Fatal(err)
	}
}

func extractUpdateTestArchive(t *testing.T, archive []byte) (string, string, error) {
	t.Helper()
	directory := t.TempDir()
	archivePath := filepath.Join(t.TempDir(), "update.zip")
	writeUpdateTestFile(t, archivePath, archive)
	result, err := ExtractWindowsExecutable(archivePath, directory)
	return result, directory, err
}

func TestExtractWindowsExecutableWritesOnlyTheApplication(t *testing.T) {
	application := []byte("application binary")
	archive := updateZip(t,
		updateZipEntry{name: "docs/guide.md", data: []byte("documentation")},
		updateZipEntry{name: "local-tex-web-editor.exe", data: application},
		updateZipEntry{name: "README.md", data: []byte("readme")},
	)
	filename, directory, err := extractUpdateTestArchive(t, archive)
	if err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(filename)
	if err != nil || !bytes.Equal(contents, application) {
		t.Fatalf("application contents = %q, %v", contents, err)
	}
	files, err := os.ReadDir(directory)
	if err != nil || len(files) != 1 {
		t.Fatalf("extracted entries = %v, %v", files, err)
	}
	if filepath.Dir(filename) != directory {
		t.Fatalf("application escaped its destination: %s", filename)
	}
}

func TestExtractWindowsExecutableRejectsUnsafeOrAmbiguousArchives(t *testing.T) {
	valid := updateZipEntry{name: "local-tex-web-editor.exe", data: []byte("application")}
	for _, test := range []struct {
		name    string
		entries []updateZipEntry
	}{
		{"parent path", []updateZipEntry{valid, {name: "../outside.txt", data: []byte("outside")}}},
		{"parent with backslash", []updateZipEntry{valid, {name: `docs\..\outside.txt`, data: []byte("outside")}}},
		{"absolute path", []updateZipEntry{valid, {name: "/outside.txt", data: []byte("outside")}}},
		{"Windows drive", []updateZipEntry{valid, {name: `C:\outside.txt`, data: []byte("outside")}}},
		{"alternate data stream", []updateZipEntry{valid, {name: "file.txt:stream", data: []byte("outside")}}},
		{"duplicate executable", []updateZipEntry{valid, valid}},
		{"linked executable", []updateZipEntry{{name: valid.name, data: []byte("another-file"), mode: os.ModeSymlink | 0700}}},
		{"empty executable", []updateZipEntry{{name: valid.name}}},
		{"missing executable", []updateZipEntry{{name: "readme.txt", data: []byte("readme")}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			filename, directory, err := extractUpdateTestArchive(t, updateZip(t, test.entries...))
			if err == nil || filename != "" {
				t.Fatalf("invalid archive extracted to %q: %v", filename, err)
			}
			files, readErr := os.ReadDir(directory)
			if readErr != nil || len(files) != 0 {
				t.Fatalf("rejected archive left files: %v, %v", files, readErr)
			}
		})
	}
}

func TestExtractWindowsExecutableRemovesACorruptedResult(t *testing.T) {
	archive := updateZip(t, updateZipEntry{name: "local-tex-web-editor.exe", data: []byte("application binary")})
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	offset, err := reader.File[0].DataOffset()
	if err != nil {
		t.Fatal(err)
	}
	archive[offset] ^= 0xff
	filename, directory, err := extractUpdateTestArchive(t, archive)
	if err == nil || filename != "" {
		t.Fatalf("corrupt archive extracted to %q: %v", filename, err)
	}
	files, err := os.ReadDir(directory)
	if err != nil || len(files) != 0 {
		t.Fatalf("corrupt output remains: %v, %v", files, err)
	}
}

func TestExtractWindowsExecutableBoundsTheExecutableAndEntryCount(t *testing.T) {
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	header := &zip.FileHeader{Name: "local-tex-web-editor.exe", Method: zip.Store, UncompressedSize64: (128 << 20) + 1, CompressedSize64: 1}
	header.SetMode(0700)
	file, err := writer.CreateRaw(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte{'x'}); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if _, _, err := extractUpdateTestArchive(t, output.Bytes()); err == nil {
		t.Fatal("an excessive executable size was accepted")
	}
	entries := []updateZipEntry{{name: "local-tex-web-editor.exe", data: []byte("application")}}
	for i := 0; i < 4096; i++ {
		entries = append(entries, updateZipEntry{name: fmt.Sprintf("docs/%d.txt", i)})
	}
	if _, _, err := extractUpdateTestArchive(t, updateZip(t, entries...)); err == nil {
		t.Fatal("an excessive entry count was accepted")
	}
}

func TestReplaceExecutableKeepsThePreviousFileUntilStartupSucceeds(t *testing.T) {
	directory := t.TempDir()
	target, staged := filepath.Join(directory, "editor.exe"), filepath.Join(directory, "prepared.exe")
	writeUpdateTestFile(t, target, []byte("previous application"))
	writeUpdateTestFile(t, staged, []byte("new application"))
	expected, err := fileHash(target)
	if err != nil {
		t.Fatal(err)
	}
	backup, err := ReplaceExecutable(target, staged, expected)
	if err != nil {
		t.Fatal(err)
	}
	for filename, expected := range map[string]string{target: "new application", backup: "previous application"} {
		data, err := os.ReadFile(filename)
		if err != nil || string(data) != expected {
			t.Fatalf("%s = %q, %v", filename, data, err)
		}
	}
}

func TestReplaceExecutableLeavesTheOriginalWhenThePreparedFileIsMissing(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "editor.exe")
	writeUpdateTestFile(t, target, []byte("previous application"))
	before := updateTestFileInfo(t, target)
	expected, err := fileHash(target)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ReplaceExecutable(target, filepath.Join(directory, "missing.exe"), expected); err == nil {
		t.Fatal("the missing update was accepted")
	}
	after, err := os.Stat(target)
	if err != nil || !os.SameFile(before, after) {
		t.Fatalf("the original executable was not restored: %v", err)
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != "previous application" {
		t.Fatalf("previous application = %q, %v", data, err)
	}
}

func TestReplaceExecutableRestoresTheOriginalAfterAMoveFailure(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("this test uses directory write permissions to fail the second rename")
	}
	directory := t.TempDir()
	protected := filepath.Join(directory, "prepared")
	if err := os.Mkdir(protected, 0700); err != nil {
		t.Fatal(err)
	}
	target, staged := filepath.Join(directory, "editor.exe"), filepath.Join(protected, "prepared.exe")
	writeUpdateTestFile(t, target, []byte("previous application"))
	writeUpdateTestFile(t, staged, []byte("new application"))
	expected, err := fileHash(target)
	if err != nil {
		t.Fatal(err)
	}
	before := updateTestFileInfo(t, target)
	if err := os.Chmod(protected, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(protected, 0700) })
	if _, err := ReplaceExecutable(target, staged, expected); err == nil {
		t.Fatal("the protected prepared file was moved")
	}
	after, err := os.Stat(target)
	if err != nil || !os.SameFile(before, after) {
		t.Fatalf("the previous application was not restored: %v", err)
	}
	if _, err := os.Stat(staged); err != nil {
		t.Fatalf("the prepared file was lost: %v", err)
	}
}

func TestReplaceExecutableRejectsAChangedInstalledApplication(t *testing.T) {
	directory := t.TempDir()
	target, staged := filepath.Join(directory, "editor.exe"), filepath.Join(directory, "prepared.exe")
	writeUpdateTestFile(t, target, []byte("previous application"))
	expected, err := fileHash(target)
	if err != nil {
		t.Fatal(err)
	}
	writeUpdateTestFile(t, target, []byte("another version was installed"))
	writeUpdateTestFile(t, staged, []byte("new application"))
	if _, err := ReplaceExecutable(target, staged, expected); err == nil {
		t.Fatal("an application changed by another update was replaced")
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != "another version was installed" {
		t.Fatalf("installed application was changed: %q, %v", data, err)
	}
}

func TestReplaceExecutableRejectsAStagedDirectoryOrLink(t *testing.T) {
	for _, name := range []string{"directory", "symlink"} {
		t.Run(name, func(t *testing.T) {
			directory := t.TempDir()
			target, staged := filepath.Join(directory, "editor.exe"), filepath.Join(directory, "prepared.exe")
			writeUpdateTestFile(t, target, []byte("previous application"))
			expected, err := fileHash(target)
			if err != nil {
				t.Fatal(err)
			}
			if name == "directory" {
				if err := os.Mkdir(staged, 0700); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.Symlink(target, staged); err != nil {
					t.Skipf("symlinks unavailable: %v", err)
				}
			}
			if _, err := ReplaceExecutable(target, staged, expected); err == nil {
				t.Fatal("a staged directory or link replaced the application")
			}
			data, err := os.ReadFile(target)
			if err != nil || string(data) != "previous application" {
				t.Fatalf("original application = %q, %v", data, err)
			}
		})
	}
}

const updaterTestMode = "LOCAL_TEX_UPDATER_TEST_PROCESS"
const updaterTestVersion = "LOCAL_TEX_UPDATER_TEST_VERSION"

// A copied test executable provides a real process for the installer on each
// operating system, including Windows PE loading and executable rename rules.
func TestMain(m *testing.M) {
	if mode := os.Getenv(updaterTestMode); mode != "" {
		if len(os.Args) == 2 && os.Args[1] == "--version" {
			fmt.Println(os.Getenv(updaterTestVersion))
			os.Exit(0)
		}
		if len(os.Args) > 1 && os.Args[1] == "--background" {
			os.Exit(runUpdaterTestApplication(mode))
		}
	}
	os.Exit(m.Run())
}

func runUpdaterTestApplication(mode string) int {
	argument := func(name string) string {
		for index := 1; index+1 < len(os.Args); index++ {
			if os.Args[index] == name {
				return os.Args[index+1]
			}
		}
		return ""
	}
	configDir, readyPath := argument("--config-dir"), argument("--ready-file")
	if mode == "fail-new-process" && readyPath != "" {
		return 7
	}
	if readyPath == "" {
		readyPath = filepath.Join(configDir, "fallback-ready.json")
	}
	unlock, err := platform.AcquireAppLock(configDir)
	if err != nil {
		return 8
	}
	defer unlock()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 9
	}
	defer listener.Close()
	version := os.Getenv(updaterTestVersion)
	ready := map[string]any{"url": "http://" + listener.Addr().String() + "/", "token": "local-updater-test-token", "pid": os.Getpid(), "version": version}
	data, err := json.Marshal(ready)
	if err != nil || os.WriteFile(readyPath, data, 0600) != nil {
		return 10
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Local-Token") != "local-updater-test-token" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"version": version})
	}), ReadHeaderTimeout: time.Second}
	if err := server.Serve(listener); err != nil {
		return 11
	}
	return 0
}

func prepareInstallerProcessTest(t *testing.T, mode string) (InstallPlan, string, os.FileInfo) {
	t.Helper()
	current, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	application, err := os.ReadFile(current)
	if err != nil {
		t.Fatal(err)
	}
	archive := updateZip(t, updateZipEntry{name: "local-tex-web-editor.exe", data: application})
	client, _, release := signedTestRelease(t, archive)
	oldKey := publicKeyText
	publicKeyText = base64.StdEncoding.EncodeToString(client.PublicKey)
	t.Cleanup(func() { publicKeyText = oldKey })
	root := t.TempDir()
	configDir := filepath.Join(root, "settings")
	directory := filepath.Join(configDir, "updates", "prepared")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "editor.exe")
	writeUpdateTestFile(t, target, application)
	before := updateTestFileInfo(t, target)
	expected, err := fileHash(target)
	if err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string][]byte{"app-update.json": release.Data, "app-update.json.sig": release.Signature, "application.zip": archive} {
		writeUpdateTestFile(t, filepath.Join(directory, name), data)
	}
	plan := InstallPlan{Directory: directory, Target: target, TargetSHA256: expected, ConfigDir: configDir, CurrentVersion: "0.1.16", Restart: true}
	data, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	planPath := filepath.Join(directory, "installer.json")
	writeUpdateTestFile(t, planPath, data)
	t.Setenv(updaterTestMode, mode)
	t.Setenv(updaterTestVersion, "0.1.17")
	for _, readyPath := range []string{filepath.Join(directory, "restart-ready.json"), filepath.Join(configDir, "fallback-ready.json")} {
		readyPath := readyPath
		t.Cleanup(func() {
			data, err := os.ReadFile(readyPath)
			if err != nil {
				return
			}
			var ready struct {
				PID int `json:"pid"`
			}
			if json.Unmarshal(data, &ready) != nil || ready.PID <= 0 || ready.PID == os.Getpid() {
				return
			}
			if process, err := os.FindProcess(ready.PID); err == nil {
				_ = process.Kill()
				_, _ = process.Wait()
			}
		})
	}
	return plan, planPath, before
}

func TestRunInstallerChecksTheExecutableVersionBeforeReplacement(t *testing.T) {
	plan, path, before := prepareInstallerProcessTest(t, "healthy")
	t.Setenv(updaterTestVersion, "0.1.18")
	if err := RunInstaller(path); err == nil {
		t.Fatal("a different executable version was installed")
	}
	after, err := os.Stat(plan.Target)
	if err != nil || !os.SameFile(before, after) {
		t.Fatalf("the old executable was replaced: %v", err)
	}
	waitForUpdaterTestReadyFile(t, filepath.Join(plan.ConfigDir, "fallback-ready.json"))
}

func TestRunInstallerRestartsTheOriginalWhenTheSavedDownloadWasDamaged(t *testing.T) {
	plan, path, before := prepareInstallerProcessTest(t, "healthy")
	writeUpdateTestFile(t, filepath.Join(plan.Directory, "application.zip"), []byte("interrupted or damaged download"))
	if err := RunInstaller(path); err == nil {
		t.Fatal("a damaged saved download was accepted")
	}
	after, err := os.Stat(plan.Target)
	if err != nil || !os.SameFile(before, after) {
		t.Fatalf("the original executable was replaced: %v", err)
	}
	waitForUpdaterTestReadyFile(t, filepath.Join(plan.ConfigDir, "fallback-ready.json"))
}

func TestRunInstallerStartsThePreparedApplication(t *testing.T) {
	plan, path, before := prepareInstallerProcessTest(t, "healthy")
	if err := RunInstaller(path); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(plan.Target)
	if err != nil || os.SameFile(before, after) {
		t.Fatalf("the prepared executable was not installed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(plan.Directory, "restart-ready.json")); err != nil {
		t.Fatalf("the new process did not report readiness: %v", err)
	}
	backups, err := filepath.Glob(filepath.Join(filepath.Dir(plan.Target), "application-previous-*.exe"))
	if err != nil || len(backups) != 0 {
		t.Fatalf("a completed installation left backups: %v, %v", backups, err)
	}
}

func TestRunInstallerRestoresAndStartsThePreviousApplication(t *testing.T) {
	plan, path, before := prepareInstallerProcessTest(t, "fail-new-process")
	if err := RunInstaller(path); err == nil || !strings.Contains(err.Error(), "previous version was restored") {
		t.Fatalf("startup failure = %v", err)
	}
	after, err := os.Stat(plan.Target)
	if err != nil || !os.SameFile(before, after) {
		t.Fatalf("the original executable was not restored: %v", err)
	}
	waitForUpdaterTestReadyFile(t, filepath.Join(plan.ConfigDir, "fallback-ready.json"))
	data, err := os.ReadFile(filepath.Join(plan.ConfigDir, "updates", "failed.json"))
	var failure struct {
		Version string `json:"version"`
	}
	if err != nil || json.Unmarshal(data, &failure) != nil || failure.Version != "0.1.17" {
		t.Fatalf("the failed version was not recorded: %q, %v", data, err)
	}
}

func updateTestFileInfo(t *testing.T, path string) os.FileInfo {
	t.Helper()
	// Windows resolves file IDs lazily for os.Stat. Reading through the open
	// file records its identity before the installer changes the target path.
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	info, err := file.Stat()
	closeErr := file.Close()
	if err != nil {
		t.Fatal(err)
	}
	if closeErr != nil {
		t.Fatal(closeErr)
	}
	return info
}

func waitForUpdaterTestReadyFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("the application did not report readiness: %s", path)
}

func TestRunInstallerRejectsInvalidPlansBeforeStartingAProcess(t *testing.T) {
	for _, data := range [][]byte{[]byte("not JSON"), []byte(`{"target":"relative.exe","directory":"relative","configDir":"relative"}`), bytes.Repeat([]byte{'x'}, (16<<10)+1)} {
		path := filepath.Join(t.TempDir(), "plan.json")
		writeUpdateTestFile(t, path, data)
		if err := RunInstaller(path); err == nil {
			t.Fatal("an invalid installer plan was accepted")
		}
	}
}

func TestUpdateServerReadyChecksTheProcessAddressTokenAndHTTPVersion(t *testing.T) {
	for _, name := range []string{"ready", "wrong ready version", "wrong process", "short token", "external address", "userinfo", "query", "wrong HTTP version", "HTTP error", "redirect"} {
		t.Run(name, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				requests.Add(1)
				if request.URL.Path != "/api/state" || request.Header.Get("X-Local-Token") != "local-updater-test-token" {
					t.Error("the readiness request did not use the authenticated state endpoint")
				}
				switch name {
				case "HTTP error":
					http.Error(w, "unavailable", http.StatusServiceUnavailable)
				case "redirect":
					http.Redirect(w, request, "/unexpected-update-state", http.StatusFound)
				case "wrong HTTP version":
					_ = json.NewEncoder(w).Encode(map[string]string{"version": "0.1.16"})
				default:
					_ = json.NewEncoder(w).Encode(map[string]string{"version": "0.1.17"})
				}
			}))
			defer server.Close()
			ready := map[string]any{"url": server.URL + "/", "token": "local-updater-test-token", "version": "0.1.17", "pid": 12345}
			wantRequests := 1
			switch name {
			case "wrong ready version":
				ready["version"] = "0.1.16"
				wantRequests = 0
			case "wrong process":
				ready["pid"] = 12346
				wantRequests = 0
			case "short token":
				ready["token"] = "short"
				wantRequests = 0
			case "external address":
				ready["url"] = "https://example.invalid/"
				wantRequests = 0
			case "userinfo":
				ready["url"] = strings.Replace(server.URL, "http://", "http://user:password@", 1) + "/"
				wantRequests = 0
			case "query":
				ready["url"] = server.URL + "/?file=other"
				wantRequests = 0
			}
			data, err := json.Marshal(ready)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "ready.json")
			writeUpdateTestFile(t, path, data)
			if actual := updateServerReady(path, "0.1.17", 12345); actual != (name == "ready") {
				t.Fatalf("ready = %v for %s", actual, name)
			}
			if actual := requests.Load(); actual != int32(wantRequests) {
				t.Fatalf("readiness requests = %d, want %d", actual, wantRequests)
			}
		})
	}
}

func TestWaitForApplicationExitHonorsCancellation(t *testing.T) {
	// Windows mutexes are owned by threads, so acquire the app lock on a
	// different goroutine and release it from that goroutine as the API requires.
	directory := t.TempDir()
	locked, finish, finished := make(chan error, 1), make(chan struct{}), make(chan struct{})
	go func() {
		defer close(finished)
		unlock, err := platform.AcquireAppLock(directory)
		locked <- err
		if err == nil {
			<-finish
			unlock()
		}
	}()
	if err := <-locked; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { close(finish); <-finished })
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	unlock, err := waitForApplicationExit(ctx, directory)
	if unlock != nil {
		unlock()
		t.Fatal("the lock was acquired while the application was still running")
	}
	if err != context.DeadlineExceeded {
		t.Fatalf("waiting for exit = %v on %s", err, runtime.GOOS)
	}
}
