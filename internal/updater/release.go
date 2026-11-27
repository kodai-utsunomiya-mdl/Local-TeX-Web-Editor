// Package updater downloads and verifies application releases before replacing
// an executable. User documents and the TeX installation are outside its scope.
package updater

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const Repository = "https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor"
const manifestURL = Repository + "/releases/latest/download/app-update.json"
const maxManifestSize = 64 << 10
const MaxArchiveSize int64 = 256 << 20

//go:embed public-key.txt
var publicKeyText string

type Asset struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type Manifest struct {
	SchemaVersion   int              `json:"schemaVersion"`
	Version         string           `json:"version"`
	PublishedAt     string           `json:"publishedAt"`
	ReleaseNotesURL string           `json:"releaseNotesURL"`
	Assets          map[string]Asset `json:"assets"`
}

type Release struct {
	Manifest  Manifest
	Data      []byte
	Signature []byte
}

type Client struct {
	HTTP      *http.Client
	PublicKey ed25519.PublicKey
}

func NewClient() *Client {
	key, _ := base64.StdEncoding.DecodeString(strings.TrimSpace(publicKeyText))
	return &Client{PublicKey: key, HTTP: &http.Client{
		Timeout: 15 * time.Minute,
		CheckRedirect: func(r *http.Request, via []*http.Request) error {
			if len(via) >= 6 || !trustedDownloadURL(r.URL) {
				return errors.New("the update download redirected to an unexpected address")
			}
			return nil
		},
	}}
}

func trustedDownloadURL(u *url.URL) bool {
	if u.Scheme != "https" || u.User != nil || u.Port() != "" {
		return false
	}
	switch strings.ToLower(u.Hostname()) {
	case "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "github-releases.githubusercontent.com":
		return true
	}
	return false
}

func versionParts(s string) ([3]uint64, bool) {
	var result [3]uint64
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return result, false
	}
	for i, p := range parts {
		if p == "" || (len(p) > 1 && p[0] == '0') {
			return result, false
		}
		for _, c := range p {
			if c < '0' || c > '9' {
				return result, false
			}
		}
		v, err := strconv.ParseUint(p, 10, 32)
		if err != nil {
			return result, false
		}
		result[i] = v
	}
	return result, true
}

func StableVersion(version string) bool { _, ok := versionParts(version); return ok }

// Newer compares complete stable versions, including values such as 0.1.9 and
// 0.1.10. Development and prerelease names are never installed automatically.
func Newer(candidate, current string) bool {
	a, ok := versionParts(candidate)
	if !ok {
		return false
	}
	b, ok := versionParts(current)
	if !ok {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return false
}

func (c *Client) get(ctx context.Context, address string, limit int64) ([]byte, error) {
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, err
	}
	r.Header.Set("User-Agent", "Local-TeX-Web-Editor-Updater")
	r.Header.Set("Accept", "application/octet-stream")
	response, err := c.HTTP.Do(r)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("update information returned HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("the update information is too large")
	}
	return data, nil
}

func (c *Client) Verify(data, signature []byte) (*Release, error) {
	if len(data) > maxManifestSize || len(c.PublicKey) != ed25519.PublicKeySize {
		return nil, errors.New("the update verification key or information is invalid")
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(signature)))
	if err != nil || !ed25519.Verify(c.PublicKey, data, sig) {
		return nil, errors.New("the application update signature could not be verified")
	}
	var m Manifest
	if json.Unmarshal(data, &m) != nil || m.SchemaVersion != 1 {
		return nil, errors.New("the application update format is unsupported")
	}
	if _, ok := versionParts(m.Version); !ok || m.ReleaseNotesURL != Repository+"/releases/tag/v"+m.Version {
		return nil, errors.New("the application update version is invalid")
	}
	for name, asset := range m.Assets {
		hash, err := hex.DecodeString(asset.SHA256)
		if err != nil || len(hash) != sha256.Size || asset.Size <= 0 || asset.Size > MaxArchiveSize {
			return nil, errors.New("the update archive information is invalid")
		}
		var suffix string
		switch name {
		case "windows-amd64":
			suffix = "windows-x64.zip"
		case "darwin-universal":
			suffix = "macos-universal.zip"
		default:
			return nil, errors.New("the update platform is unsupported")
		}
		expected := Repository + "/releases/download/v" + m.Version + "/local-tex-web-editor-" + m.Version + "-" + suffix
		if asset.URL != expected {
			return nil, errors.New("the update archive address is invalid")
		}
	}
	return &Release{m, append([]byte(nil), data...), append([]byte(nil), signature...)}, nil
}

func (c *Client) Latest(ctx context.Context) (*Release, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	data, err := c.get(ctx, manifestURL, maxManifestSize)
	if err != nil {
		return nil, err
	}
	var head struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(data, &head) != nil {
		return nil, errors.New("the update information could not be read")
	}
	if _, ok := versionParts(head.Version); !ok {
		return nil, errors.New("the update version is invalid")
	}
	// Read the signature from the version named by the manifest. Publishing a
	// newer latest release between these requests cannot pair unrelated files.
	sig, err := c.get(ctx, Repository+"/releases/download/v"+head.Version+"/app-update.json.sig", 1024)
	if err != nil {
		return nil, err
	}
	return c.Verify(data, sig)
}

func (c *Client) Download(ctx context.Context, release *Release, platform, directory string, progress func(float64)) (string, error) {
	verified, err := c.Verify(release.Data, release.Signature)
	if err != nil {
		return "", err
	}
	asset, ok := verified.Manifest.Assets[platform]
	if !ok {
		return "", errors.New("this release does not include an update for this platform")
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	file, err := os.CreateTemp(directory, "download-*.zip")
	if err != nil {
		return "", err
	}
	name := file.Name()
	completed := false
	defer func() {
		file.Close()
		if !completed {
			os.Remove(name)
		}
	}()
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, asset.URL, nil)
	if err != nil {
		return "", err
	}
	r.Header.Set("User-Agent", "Local-TeX-Web-Editor-Updater")
	response, err := c.HTTP.Do(r)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("the update download returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength > 0 && response.ContentLength != asset.Size {
		return "", errors.New("the update download size is different from the signed information")
	}
	hash := sha256.New()
	total := int64(0)
	buffer := make([]byte, 64<<10)
	source := io.LimitReader(response.Body, asset.Size+1)
	for {
		n, readErr := source.Read(buffer)
		if n > 0 {
			total += int64(n)
			if total > asset.Size {
				return "", errors.New("the update download is larger than expected")
			}
			if _, err := file.Write(buffer[:n]); err != nil {
				return "", err
			}
			hash.Write(buffer[:n])
			if progress != nil {
				progress(float64(total) / float64(asset.Size))
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return "", readErr
		}
	}
	if total != asset.Size || hex.EncodeToString(hash.Sum(nil)) != asset.SHA256 {
		return "", errors.New("the update download did not match its signed SHA-256")
	}
	if err := file.Sync(); err != nil {
		return "", err
	}
	if err := file.Close(); err != nil {
		return "", err
	}
	for _, v := range []struct {
		name string
		data []byte
	}{{"app-update.json", release.Data}, {"app-update.json.sig", release.Signature}} {
		if err := os.WriteFile(filepath.Join(directory, v.name), v.data, 0600); err != nil {
			return "", err
		}
	}
	archive := filepath.Join(directory, "application.zip")
	if err := os.Rename(name, archive); err != nil {
		return "", err
	}
	completed = true
	return archive, nil
}

func (c *Client) ReadDownloaded(directory, platform string) (*Release, string, error) {
	data, err := readBounded(filepath.Join(directory, "app-update.json"), maxManifestSize)
	if err != nil {
		return nil, "", err
	}
	sig, err := readBounded(filepath.Join(directory, "app-update.json.sig"), 1024)
	if err != nil {
		return nil, "", err
	}
	release, err := c.Verify(data, sig)
	if err != nil {
		return nil, "", err
	}
	asset, ok := release.Manifest.Assets[platform]
	if !ok {
		return nil, "", errors.New("the downloaded update does not support this platform")
	}
	archive := filepath.Join(directory, "application.zip")
	if err := verifyFile(archive, asset.Size, asset.SHA256); err != nil {
		return nil, "", err
	}
	return release, archive, nil
}

func readBounded(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err == nil && int64(len(data)) > limit {
		err = errors.New("the update file is too large")
	}
	return data, err
}

func verifyFile(path string, size int64, expected string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() != size {
		return errors.New("the downloaded update size is invalid")
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, size+1))
	if err != nil {
		return err
	}
	if n != size || hex.EncodeToString(h.Sum(nil)) != expected {
		return errors.New("the downloaded update SHA-256 is invalid")
	}
	return nil
}
