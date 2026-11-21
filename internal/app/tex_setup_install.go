package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

const managedTeXMarker = ".local-tex-editor-managed.json"
const maxTeXSetupArchive = 256 << 20

type managedTeXInstallation struct {
	Format    int    `json:"format"`
	ID        string `json:"id"`
	Release   string `json:"release"`
	Parent    string `json:"parent"`
	Directory string `json:"directory"`
	Bin       string `json:"bin"`
	CreatedAt string `json:"createdAt"`
}

type texSetupDirectory struct {
	parent, path, commandPath string
	parentInfo, info          os.FileInfo
}

func prepareTeXSetupParent(parent string, create bool) (string, os.FileInfo, error) {
	if !filepath.IsAbs(parent) {
		return "", nil, fail(http.StatusBadRequest, "導入先の親フォルダーには絶対パスを指定してください．")
	}
	parent = filepath.Clean(parent)
	if create {
		if err := os.MkdirAll(parent, 0700); err != nil {
			return "", nil, err
		}
	}
	info, err := os.Lstat(parent)
	if err != nil {
		return "", nil, messages.Errorf("導入先の親フォルダーを開けません: %w", err)
	}
	linked, err := platform.IsReparsePoint(parent)
	if err != nil {
		return "", nil, err
	}
	if !info.IsDir() || linked || info.Mode()&os.ModeSymlink != 0 {
		return "", nil, fail(http.StatusBadRequest, "導入先にはリンクを経由しない実際のフォルダーを選んでください．")
	}
	parent, err = filepath.EvalSymlinks(parent)
	if err != nil {
		return "", nil, err
	}
	_, info, err = entryTreePath(parent, "")
	if err != nil {
		return "", nil, err
	}
	probe, err := os.CreateTemp(parent, ".tex-write-*")
	if err != nil {
		return "", nil, messages.Errorf("導入先に書き込めません．別の親フォルダーを選んでください: %w", err)
	}
	path := probe.Name()
	closeErr := probe.Close()
	removeErr := os.Remove(path)
	if closeErr != nil {
		return "", nil, closeErr
	}
	if removeErr != nil {
		return "", nil, removeErr
	}
	return parent, info, nil
}

func texSetupCommandPath(path string) (string, error) {
	if runtime.GOOS != "windows" {
		return path, nil
	}
	if short, err := platform.ShortPath(path); err == nil {
		path = short
	}
	for _, character := range path {
		if character < 33 || character > 126 || strings.ContainsRune(`"'&|<>^%!?()`, character) {
			return "", messages.Errorf("この場所では TeX の導入に必要な短いパスを作れません．空白や日本語を含まない別の親フォルダーを選んでください．")
		}
	}
	return path, nil
}

func makeTeXSetupDirectory(parent string, parentInfo os.FileInfo) (*texSetupDirectory, error) {
	_, current, err := entryTreePath(parent, "")
	if err != nil || !os.SameFile(parentInfo, current) {
		return nil, messages.Errorf("TeX の導入先のフォルダーが変更されました．親フォルダーを選び直してください．")
	}
	path, err := os.MkdirTemp(parent, "tinytex-")
	if err != nil {
		return nil, err
	}
	_, info, err := entryTreePath(parent, filepath.Base(path))
	if err != nil {
		return nil, err
	}
	job := &texSetupDirectory{parent: parent, path: path, parentInfo: parentInfo, info: info}
	job.commandPath, err = texSetupCommandPath(path)
	if err != nil {
		_ = removeTeXSetupDirectory(job)
		return nil, err
	}
	return job, nil
}

func checkTeXSetupDirectory(job *texSetupDirectory) error {
	canonical, err := filepath.EvalSymlinks(job.parent)
	if err != nil || !samePath(canonical, job.parent) {
		return messages.Errorf("TeX の導入先のフォルダーが変更されました．親フォルダーを選び直してください．")
	}
	_, parentInfo, err := entryTreePath(job.parent, "")
	if err != nil || !os.SameFile(job.parentInfo, parentInfo) {
		return messages.Errorf("TeX の導入先のフォルダーが変更されました．親フォルダーを選び直してください．")
	}
	_, info, err := entryTreePath(job.parent, filepath.Base(job.path))
	if err != nil || !info.IsDir() || !os.SameFile(job.info, info) {
		return messages.Errorf("TeX の導入先のフォルダーが変更されました．親フォルダーを選び直してください．")
	}
	return nil
}

// This directory was created for this operation. Links inside a TeX tree are
// removed as links; their destinations and the chosen parent stay untouched.
func removeTeXSetupDirectory(job *texSetupDirectory) error {
	if job == nil {
		return nil
	}
	if err := checkTeXSetupDirectory(job); err != nil {
		return err
	}
	return os.RemoveAll(job.path)
}

func texSetupBinDirectory(root string) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(root, "bin", "windows")
	}
	return filepath.Join(root, "bin", "universal-darwin")
}

func validateManagedTeX(record managedTeXInstallation) error {
	if record.Format != 1 || record.ID == "" || record.Release == "" || !filepath.IsAbs(record.Parent) || !filepath.IsAbs(record.Directory) || !filepath.IsAbs(record.Bin) {
		return errors.New("invalid managed TeX record")
	}
	relative, err := filepath.Rel(record.Parent, record.Directory)
	if err != nil {
		return err
	}
	parts := strings.Split(filepath.ToSlash(relative), "/")
	if len(parts) != 2 || !strings.HasPrefix(parts[0], "tinytex-") || parts[1] != "TinyTeX" {
		return errors.New("invalid managed TeX directory")
	}
	canonicalParent, err := filepath.EvalSymlinks(record.Parent)
	if err != nil || !samePath(canonicalParent, record.Parent) {
		return errors.New("managed TeX parent changed")
	}
	_, info, err := entryTreePath(record.Parent, filepath.ToSlash(relative))
	if err != nil || !info.IsDir() {
		return errors.New("managed TeX directory changed")
	}
	bin, err := filepath.EvalSymlinks(record.Bin)
	if err != nil || !samePath(bin, texSetupBinDirectory(record.Directory)) {
		return errors.New("managed TeX bin changed")
	}
	marker := filepath.Join(record.Directory, managedTeXMarker)
	data, err := readCacheFile(marker, 16<<10)
	if err != nil {
		return err
	}
	var saved managedTeXInstallation
	if json.Unmarshal(data, &saved) != nil || saved != record {
		return errors.New("managed TeX record changed")
	}
	return nil
}

func (a *App) selectedManagedTeXLocked() (managedTeXInstallation, bool) {
	if a.config.TexBin != "" {
		for _, record := range a.config.TeXInstallations {
			if sameTeXSetupLocation(record.Bin, a.config.TexBin) && validateManagedTeX(record) == nil {
				return record, true
			}
		}
	}
	return managedTeXInstallation{}, false
}

func (a *App) downloadTeXSetup(ctx context.Context, run *texSetupRun) (string, error) {
	archive := run.archive
	if archive.Bytes <= 0 || archive.Bytes > maxTeXSetupArchive || len(archive.SHA256) != sha256.Size*2 {
		return "", errors.New("invalid TeX distribution metadata")
	}
	client := &http.Client{Timeout: 30 * time.Minute, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, ResponseHeaderTimeout: 30 * time.Second, IdleConnTimeout: 30 * time.Second},
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if request.URL.Scheme != "https" || len(via) >= 10 {
				return errors.New("invalid TeX download redirect")
			}
			return nil
		}}
	if a.texSetupHooks != nil && a.texSetupHooks.client != nil {
		client = a.texSetupHooks.client
	}
	defer client.CloseIdleConnections()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, archive.URL, nil)
	if err != nil {
		return "", err
	}
	response, err := client.Do(request)
	if err != nil {
		return "", messages.Errorf("TeX の配布物を取得できません: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", messages.Errorf("TeX の配布元が HTTP %d を返しました．時間をおいて再度お試しください．", response.StatusCode)
	}
	if response.ContentLength > 0 && response.ContentLength != archive.Bytes {
		return "", messages.Errorf("TeX の配布物の容量が一致しません．取得元を確認してください．")
	}
	if err := checkTeXSetupDirectory(run.job); err != nil {
		return "", err
	}
	filename := filepath.Join(run.job.path, "distribution"+filepath.Ext(archive.Filename))
	file, err := os.OpenFile(filename, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	reader := io.LimitReader(response.Body, archive.Bytes+1)
	buffer := make([]byte, 64<<10)
	var downloaded int64
	lastUpdate := time.Time{}
	a.mu.Lock()
	run.state.DownloadTotal = archive.Bytes
	a.mu.Unlock()
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		n, readErr := reader.Read(buffer)
		if n > 0 {
			downloaded += int64(n)
			if downloaded > archive.Bytes {
				return "", messages.Errorf("TeX の配布物が確認した容量を超えています．")
			}
			if _, err := file.Write(buffer[:n]); err != nil {
				return "", err
			}
			_, _ = hash.Write(buffer[:n])
			if time.Since(lastUpdate) >= 100*time.Millisecond || downloaded == archive.Bytes {
				a.mu.Lock()
				run.state.DownloadedBytes = downloaded
				a.mu.Unlock()
				lastUpdate = time.Now()
			}
		}
		if readErr != nil {
			if readErr != io.EOF {
				return "", readErr
			}
			break
		}
	}
	a.texSetupStage(run, "verifying")
	if downloaded != archive.Bytes || hex.EncodeToString(hash.Sum(nil)) != archive.SHA256 {
		return "", messages.Errorf("TeX の配布物の SHA-256 または容量が一致しません．展開を中止しました．")
	}
	if err := file.Sync(); err != nil {
		return "", err
	}
	if err := file.Close(); err != nil {
		return "", err
	}
	a.texSetupLog(run, "[SHA-256] %s\n", archive.SHA256)
	return filename, nil
}

func (a *App) runTeXSetup(run *texSetupRun, createParent bool) {
	defer a.workers.Done()
	defer close(run.done)
	defer run.cancel()
	a.texSetupMu.Lock()
	defer a.texSetupMu.Unlock()
	var err error
	switch run.state.Operation {
	case "packages", "remove-packages":
		err = a.performTeXPackageChange(run)
	case "uninstall":
		err = a.performTeXUninstall(run)
	default:
		err = a.performTeXSetup(run, createParent)
	}
	if err != nil && run.reused != nil && run.inventoryStarted {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		if recordErr := writeManagedTeXFiles(ctx, *run.reused, run.unknownFiles); recordErr != nil {
			a.texSetupLog(run, "[file list] %v\n", recordErr)
		}
		cancel()
	}
	if err != nil && run.job != nil {
		if cleanupErr := removeTeXSetupDirectory(run.job); cleanupErr != nil {
			a.texSetupLog(run, "[cleanup] %v\n", cleanupErr)
			err = messages.Errorf("%v\n作業フォルダーを片付けられませんでした: %v", err, cleanupErr)
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	run.state.Cancelable = false
	if err == nil {
		run.state.Status, run.state.Stage = "succeeded", "complete"
		run.state.Managed = run.external == nil && run.state.Operation != "uninstall"
		if run.state.Managed && run.state.Environment == nil {
			if record, ok := a.selectedManagedTeXLocked(); ok {
				environment := managedTeXEnvironment(record)
				run.state.Environment = &environment
				a.texEnvironment = &environment
			}
		}
	} else if errors.Is(run.ctx.Err(), context.DeadlineExceeded) {
		run.state.Status = "failed"
		run.err = messages.Errorf("TeX の導入が 4 時間を超えたため停止しました．ネットワークと空き容量を確認してください．")
	} else if errors.Is(run.ctx.Err(), context.Canceled) || errors.Is(err, context.Canceled) {
		run.state.Status = "cancelled"
		if run.job != nil {
			run.state.Managed = false
		}
	} else {
		run.state.Status, run.err = "failed", err
		if run.job != nil {
			run.state.Managed = false
		}
	}
}

func (a *App) performTeXSetup(run *texSetupRun, createParent bool) error {
	parent, parentInfo, err := prepareTeXSetupParent(run.state.Parent, createParent)
	if err != nil {
		return err
	}
	lockRoot := parent
	if run.reused != nil {
		lockRoot = run.reused.Directory
	}
	release, err := platform.AcquireTeXSetupLock(lockRoot)
	if err != nil {
		return messages.Errorf("同じ導入先で別の処理が進行中です．完了後にもう一度お試しください: %w", err)
	}
	defer release()
	if err := run.ctx.Err(); err != nil {
		return err
	}
	a.mu.Lock()
	run.state.Parent = parent
	a.mu.Unlock()
	var record managedTeXInstallation
	if run.reused != nil {
		record = *run.reused
		if err := validateManagedTeX(record); err != nil {
			return messages.Errorf("アプリから導入した TeX の記録とフォルダーが一致しません．設定を確認してください: %w", err)
		}
		if run.state.Operation == "packages" {
			run.unknownFiles, err = unknownManagedTeXFiles(run.ctx, record)
			if err != nil {
				return err
			}
			run.inventoryStarted = true
		}
	} else {
		run.job, err = makeTeXSetupDirectory(parent, parentInfo)
		if err != nil {
			return err
		}
		run.root = filepath.Join(run.job.path, "TinyTeX")
		a.mu.Lock()
		run.state.Directory = run.root
		a.mu.Unlock()
		a.texSetupLog(run, "[download] %s\n[directory] %s\n", run.archive.URL, run.root)
		archive, err := a.downloadTeXSetup(run.ctx, run)
		if err != nil {
			return err
		}
		a.texSetupStage(run, "extracting")
		if a.texSetupHooks != nil && a.texSetupHooks.extract != nil {
			err = a.texSetupHooks.extract(run.ctx, run, archive)
		} else {
			err = a.extractTeXSetup(run.ctx, run, archive)
		}
		if err != nil {
			return err
		}
		if err := checkTeXSetupDirectory(run.job); err != nil {
			return err
		}
		_, info, err := entryTreePath(run.job.path, "TinyTeX")
		if err != nil || !info.IsDir() {
			return messages.Errorf("TeX の配布物を展開したフォルダーが見つかりません．")
		}
		run.rootInfo = info
		run.bin = texSetupBinDirectory(filepath.Join(run.job.commandPath, "TinyTeX"))
		if err := os.Remove(archive); err != nil {
			return err
		}
		record = managedTeXInstallation{Format: 1, ID: run.state.ID, Release: texSetupRelease, Parent: parent, Directory: run.root, Bin: run.bin, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
		// Record the verified archive before commands create formats and caches.
		// Subsequent inventories add package files and normal generated files.
		data, err := json.Marshal(record)
		if err != nil {
			return err
		}
		if err := writeAtomicChecked(filepath.Join(record.Directory, managedTeXMarker), append(data, '\n'), 0600, func() error {
			if err := checkTeXSetupDirectory(run.job); err != nil {
				return err
			}
			_, info, err := entryTreePath(run.job.path, "TinyTeX")
			if err != nil || !os.SameFile(run.rootInfo, info) {
				return entryChangedError()
			}
			return nil
		}); err != nil {
			return err
		}
		if err := writeManagedTeXFiles(run.ctx, record, nil); err != nil {
			return err
		}
	}
	a.mu.Lock()
	run.state.Bin = run.bin
	a.mu.Unlock()
	// A completed, recorded installation can be selected again without a
	// download or an automatic package update.
	if run.reused == nil || run.state.Operation == "packages" {
		a.texSetupStage(run, "packages")
		if a.texSetupHooks != nil && a.texSetupHooks.packages != nil {
			err = a.texSetupHooks.packages(run.ctx, run)
		} else {
			err = a.installTeXSetupPackages(run.ctx, run)
		}
		if err != nil {
			return err
		}
		a.texSetupStage(run, "checking")
		if a.texSetupHooks != nil && a.texSetupHooks.check != nil {
			err = a.texSetupHooks.check(run.ctx, run)
		} else {
			err = a.checkTeXSetup(run.ctx, run)
		}
		if err != nil {
			return err
		}
	}
	if err := run.ctx.Err(); err != nil {
		return err
	}
	if run.job != nil {
		if err := checkTeXSetupDirectory(run.job); err != nil {
			return err
		}
		checkRoot := func() error {
			if err := checkTeXSetupDirectory(run.job); err != nil {
				return err
			}
			_, info, err := entryTreePath(run.job.path, "TinyTeX")
			if err != nil || !os.SameFile(run.rootInfo, info) {
				return entryChangedError()
			}
			return nil
		}
		data, err := json.MarshalIndent(record, "", "  ")
		if err != nil {
			return err
		}
		if err := writeAtomicChecked(filepath.Join(record.Directory, managedTeXMarker), append(data, '\n'), 0600, checkRoot); err != nil {
			return err
		}
	}
	if err := validateManagedTeX(record); err != nil {
		return err
	}
	if run.reused == nil || run.inventoryStarted {
		if err := writeManagedTeXFiles(run.ctx, record, run.unknownFiles); err != nil {
			return err
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := run.ctx.Err(); err != nil {
		return err
	}
	if a.closed {
		return context.Canceled
	}
	if !samePath(a.config.TexBin, run.configuredBin) {
		return fail(http.StatusConflict, "導入中に TeX の設定が変更されたため，設定を上書きしませんでした．選択した環境を確認してください．")
	}
	previous := append([]managedTeXInstallation{}, a.config.TeXInstallations...)
	registered := false
	for _, value := range previous {
		registered = registered || value == record
	}
	if !registered {
		a.config.TeXInstallations = append(a.config.TeXInstallations, record)
	}
	if err := a.updateSettingsLocked(&record.Bin, nil, nil); err != nil {
		a.config.TeXInstallations = previous
		return err
	}
	if run.state.Operation == "packages" {
		if a.build != nil {
			a.build.result.SourceChanged = true
		}
		if a.lastPDFID != "" {
			a.lastPDFChanged = true
		}
		a.noteCompiledPDFSettingsChangedLocked()
	}
	return nil
}

func managedTeXEnvironmentForBin(environment []string, bin string) []string {
	if bin == "" {
		return environment
	}
	root := filepath.Dir(filepath.Dir(bin))
	data, err := readCacheFile(filepath.Join(root, managedTeXMarker), 16<<10)
	if err != nil {
		return environment
	}
	var record managedTeXInstallation
	if json.Unmarshal(data, &record) != nil || !sameTeXSetupLocation(bin, record.Bin) || validateManagedTeX(record) != nil {
		return environment
	}
	return isolatedTeXEnvironment(environment, root)
}
