package updater

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type updaterRoundTripper func(*http.Request) (*http.Response, error)

func (roundTrip updaterRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func updaterResponse(request *http.Request, status int, body []byte) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(body)), ContentLength: int64(len(body)), Request: request}
}

func signedTestRelease(t *testing.T, archive []byte) (*Client, ed25519.PrivateKey, *Release) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(archive)
	manifest := Manifest{
		SchemaVersion:   1,
		Version:         "0.1.17",
		PublishedAt:     "2026-11-27T00:00:00Z",
		ReleaseNotesURL: Repository + "/releases/tag/v0.1.17",
		Assets: map[string]Asset{"windows-amd64": {
			URL:    Repository + "/releases/download/v0.1.17/local-tex-web-editor-0.1.17-windows-x64.zip",
			SHA256: hex.EncodeToString(digest[:]), Size: int64(len(archive)),
		}},
	}
	client := NewClient()
	client.PublicKey = publicKey
	return client, privateKey, signTestManifest(t, client, privateKey, manifest)
}

func signTestManifest(t *testing.T, client *Client, key ed25519.PrivateKey, manifest Manifest) *Release {
	t.Helper()
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	signature := []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(key, data)))
	release, err := client.Verify(data, signature)
	if err != nil {
		t.Fatal(err)
	}
	return release
}

func TestNewerComparesNumericStableVersions(t *testing.T) {
	for _, test := range []struct {
		candidate, current string
		want               bool
	}{
		{"0.1.10", "0.1.9", true},
		{"0.1.9", "0.1.10", false},
		{"0.2.0", "0.1.99", true},
		{"1.0.0", "0.99.99", true},
		{"0.1.17", "0.1.17", false},
		{"0.1.17-rc.1", "0.1.16", false},
		{"v0.1.17", "0.1.16", false},
		{"0.01.17", "0.1.16", false},
		{"0.1.17", "development", false},
		{"0.1", "0.0.1", false},
		{"0.1.-1", "0.1.0", false},
		{"0.1.4294967296", "0.1.0", false},
		{"0.1.17\n", "0.1.16", false},
	} {
		if actual := Newer(test.candidate, test.current); actual != test.want {
			t.Errorf("Newer(%q, %q) = %v, want %v", test.candidate, test.current, actual, test.want)
		}
	}
}

func TestVerifyRejectsAlteredDataAndSignatures(t *testing.T) {
	for _, name := range []string{"data", "signature", "invalid base64", "another publisher", "missing key", "oversized manifest"} {
		t.Run(name, func(t *testing.T) {
			client, _, release := signedTestRelease(t, []byte("application"))
			data, signature := append([]byte(nil), release.Data...), append([]byte(nil), release.Signature...)
			switch name {
			case "data":
				data = bytes.Replace(data, []byte("2026-11-27"), []byte("2026-11-28"), 1)
			case "signature":
				signature[4] = 'A'
				if signature[4] == release.Signature[4] {
					signature[4] = 'B'
				}
			case "invalid base64":
				signature = []byte("not-a-signature")
			case "another publisher":
				other, _, err := ed25519.GenerateKey(rand.Reader)
				if err != nil {
					t.Fatal(err)
				}
				client.PublicKey = other
			case "missing key":
				client.PublicKey = nil
			case "oversized manifest":
				data = bytes.Repeat([]byte{' '}, maxManifestSize+1)
			}
			if _, err := client.Verify(data, signature); err == nil {
				t.Fatal("an invalid signed release was accepted")
			}
		})
	}
}

func TestVerifyRejectsSignedInvalidReleaseAddressesAndSizes(t *testing.T) {
	for _, name := range []string{"schema", "version", "release notes", "another host", "another repository", "http", "query", "fragment", "wrong version asset", "bad digest", "zero size", "excessive size", "unknown platform"} {
		t.Run(name, func(t *testing.T) {
			client, key, release := signedTestRelease(t, []byte("application"))
			manifest := release.Manifest
			asset := manifest.Assets["windows-amd64"]
			switch name {
			case "schema":
				manifest.SchemaVersion = 2
			case "version":
				manifest.Version = "../another-file"
			case "release notes":
				manifest.ReleaseNotesURL = "https://example.com/notes"
			case "another host":
				asset.URL = strings.Replace(asset.URL, "github.com", "github.com.example.com", 1)
			case "another repository":
				asset.URL = strings.Replace(asset.URL, "Local-TeX-Web-Editor/", "Other-App/", 1)
			case "http":
				asset.URL = strings.Replace(asset.URL, "https://", "http://", 1)
			case "query":
				asset.URL += "?download=another-file"
			case "fragment":
				asset.URL += "#file"
			case "wrong version asset":
				asset.URL = strings.ReplaceAll(asset.URL, "0.1.17", "0.1.16")
			case "bad digest":
				asset.SHA256 = "1234"
			case "zero size":
				asset.Size = 0
			case "excessive size":
				asset.Size = MaxArchiveSize + 1
			case "unknown platform":
				manifest.Assets["unknown"] = asset
			}
			manifest.Assets["windows-amd64"] = asset
			data, err := json.Marshal(manifest)
			if err != nil {
				t.Fatal(err)
			}
			signature := []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(key, data)))
			if _, err := client.Verify(data, signature); err == nil {
				t.Fatal("an invalid signed manifest was accepted")
			}
		})
	}
}

func TestUpdateRedirectsStayOnGitHubDownloadHosts(t *testing.T) {
	client := NewClient()
	for _, address := range []string{
		"https://github.com/releases/file", "https://objects.githubusercontent.com/file",
		"https://release-assets.githubusercontent.com/file?signature=example", "https://github-releases.githubusercontent.com/file",
	} {
		request, err := http.NewRequest(http.MethodGet, address, nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := client.HTTP.CheckRedirect(request, nil); err != nil {
			t.Errorf("expected download URL rejected: %s: %v", address, err)
		}
	}
	for _, address := range []string{
		"http://github.com/file", "https://github.com.evil.example/file", "https://127.0.0.1/file",
		"https://user:password@github.com/file", "https://github.com:8443/file", "file:///tmp/update.zip",
	} {
		parsed, err := url.Parse(address)
		if err != nil {
			t.Fatal(err)
		}
		if err := client.HTTP.CheckRedirect(&http.Request{URL: parsed}, nil); err == nil {
			t.Errorf("unexpected redirect allowed: %s", address)
		}
	}
	request, _ := http.NewRequest(http.MethodGet, Repository, nil)
	if err := client.HTTP.CheckRedirect(request, make([]*http.Request, 6)); err == nil {
		t.Fatal("an excessive redirect chain was accepted")
	}
}

func TestLatestFetchesSignatureForTheManifestVersion(t *testing.T) {
	client, _, expected := signedTestRelease(t, []byte("application"))
	var addresses []string
	client.HTTP.Transport = updaterRoundTripper(func(request *http.Request) (*http.Response, error) {
		addresses = append(addresses, request.URL.String())
		if request.Header.Get("User-Agent") == "" {
			t.Error("the update request did not identify the application")
		}
		if len(addresses) == 1 {
			return updaterResponse(request, http.StatusOK, expected.Data), nil
		}
		if request.URL.String() != Repository+"/releases/download/v0.1.17/app-update.json.sig" {
			t.Errorf("signature URL = %s", request.URL)
		}
		return updaterResponse(request, http.StatusOK, expected.Signature), nil
	})
	release, err := client.Latest(context.Background())
	if err != nil || release.Manifest.Version != expected.Manifest.Version || len(addresses) != 2 || addresses[0] != manifestURL {
		t.Fatalf("latest = %+v, %v; requests = %v", release, err, addresses)
	}
}

func TestLatestRejectsInvalidOrOversizedResponses(t *testing.T) {
	for _, test := range []struct {
		name   string
		body   []byte
		status int
	}{
		{"HTTP error", []byte("unavailable"), http.StatusServiceUnavailable},
		{"invalid JSON", []byte("not JSON"), http.StatusOK},
		{"invalid version", []byte(`{"version":"../another-file"}`), http.StatusOK},
		{"oversized manifest", bytes.Repeat([]byte{'x'}, maxManifestSize+1), http.StatusOK},
	} {
		t.Run(test.name, func(t *testing.T) {
			client, _, _ := signedTestRelease(t, []byte("application"))
			calls := 0
			client.HTTP.Transport = updaterRoundTripper(func(request *http.Request) (*http.Response, error) {
				calls++
				return updaterResponse(request, test.status, test.body), nil
			})
			if _, err := client.Latest(context.Background()); err == nil || calls != 1 {
				t.Fatalf("latest = %v; calls = %d", err, calls)
			}
		})
	}
}

type failingUpdateReader struct {
	first []byte
	err   error
}

func (reader *failingUpdateReader) Read(output []byte) (int, error) {
	if len(reader.first) > 0 {
		n := copy(output, reader.first)
		reader.first = reader.first[n:]
		return n, nil
	}
	return 0, reader.err
}

func TestDownloadRejectsIncompleteOrAlteredArchivesAndRemovesTemporaryFiles(t *testing.T) {
	archive := []byte("expected application archive")
	for _, name := range []string{"HTTP error", "declared size", "truncated", "extra bytes", "altered bytes", "connection closed", "cancelled"} {
		t.Run(name, func(t *testing.T) {
			client, _, release := signedTestRelease(t, archive)
			directory := t.TempDir()
			ctx := context.Background()
			if name == "cancelled" {
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				ctx = cancelled
			}
			client.HTTP.Transport = updaterRoundTripper(func(request *http.Request) (*http.Response, error) {
				response := updaterResponse(request, http.StatusOK, archive)
				switch name {
				case "HTTP error":
					response.StatusCode = http.StatusNotFound
				case "declared size":
					response.ContentLength++
				case "truncated":
					response.Body = io.NopCloser(bytes.NewReader(archive[:8]))
					response.ContentLength = -1
				case "extra bytes":
					response.Body = io.NopCloser(bytes.NewReader(append(append([]byte(nil), archive...), 'x')))
					response.ContentLength = -1
				case "altered bytes":
					response.Body = io.NopCloser(bytes.NewReader(bytes.Repeat([]byte{'x'}, len(archive))))
				case "connection closed":
					response.Body = io.NopCloser(&failingUpdateReader{first: archive[:8], err: io.ErrUnexpectedEOF})
				case "cancelled":
					return nil, request.Context().Err()
				}
				return response, nil
			})
			path, err := client.Download(ctx, release, "windows-amd64", directory, nil)
			if err == nil || path != "" {
				t.Fatalf("download = %q, %v", path, err)
			}
			entries, readErr := os.ReadDir(directory)
			if readErr != nil || len(entries) != 0 {
				t.Fatalf("partial files remain: %v, %v", entries, readErr)
			}
		})
	}
}

func TestDownloadUsesVerifiedMetadataAndCanReopenACompletedDownload(t *testing.T) {
	archive := bytes.Repeat([]byte("application data"), 10000)
	client, _, release := signedTestRelease(t, archive)
	expectedURL := release.Manifest.Assets["windows-amd64"].URL
	// The cached presentation object is not the signed source of download data.
	release.Manifest.Assets["windows-amd64"] = Asset{URL: "https://example.com/other.exe", Size: 1, SHA256: "bad"}
	client.HTTP.Transport = updaterRoundTripper(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() != expectedURL {
			t.Errorf("download URL = %s", request.URL)
		}
		return updaterResponse(request, http.StatusOK, archive), nil
	})
	directory := t.TempDir()
	var reported []float64
	filename, err := client.Download(context.Background(), release, "windows-amd64", directory, func(value float64) { reported = append(reported, value) })
	if err != nil {
		t.Fatal(err)
	}
	if len(reported) < 2 || reported[len(reported)-1] != 1 {
		t.Fatalf("progress = %v", reported)
	}
	for index, value := range reported {
		if value <= 0 || value > 1 || (index > 0 && value < reported[index-1]) {
			t.Fatalf("progress moved incorrectly: %v", reported)
		}
	}
	data, err := os.ReadFile(filename)
	if err != nil || !bytes.Equal(data, archive) {
		t.Fatalf("saved archive differs: %v", err)
	}
	verified, reopened, err := client.ReadDownloaded(directory, "windows-amd64")
	if err != nil || reopened != filename || verified.Manifest.Version != "0.1.17" {
		t.Fatalf("saved download = %+v, %q, %v", verified, reopened, err)
	}
	if err := os.WriteFile(filename, bytes.Repeat([]byte{'x'}, len(archive)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := client.ReadDownloaded(directory, "windows-amd64"); err == nil {
		t.Fatal("an altered saved archive was accepted")
	}
}

func TestDownloadCancellationReachesTheHTTPRequest(t *testing.T) {
	client, _, release := signedTestRelease(t, []byte("archive"))
	client.HTTP.Transport = updaterRoundTripper(func(request *http.Request) (*http.Response, error) {
		<-request.Context().Done()
		return nil, request.Context().Err()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	directory := t.TempDir()
	if _, err := client.Download(ctx, release, "windows-amd64", directory, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("cancellation = %v", err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 0 {
		t.Fatalf("temporary files remain: %v, %v", entries, err)
	}
}

func TestReadDownloadedChecksSignatureAndBoundedMetadata(t *testing.T) {
	for _, name := range []string{"signature", "oversized manifest", "unsupported platform"} {
		t.Run(name, func(t *testing.T) {
			archive := []byte("archive")
			client, _, release := signedTestRelease(t, archive)
			directory := t.TempDir()
			for filename, data := range map[string][]byte{"app-update.json": release.Data, "app-update.json.sig": release.Signature, "application.zip": archive} {
				if err := os.WriteFile(filepath.Join(directory, filename), data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			platform := "windows-amd64"
			switch name {
			case "signature":
				if err := os.WriteFile(filepath.Join(directory, "app-update.json.sig"), []byte("invalid"), 0600); err != nil {
					t.Fatal(err)
				}
			case "oversized manifest":
				if err := os.WriteFile(filepath.Join(directory, "app-update.json"), bytes.Repeat([]byte{'x'}, maxManifestSize+1), 0600); err != nil {
					t.Fatal(err)
				}
			case "unsupported platform":
				platform = "darwin-universal"
			}
			if _, _, err := client.ReadDownloaded(directory, platform); err == nil {
				t.Fatal("invalid saved update was accepted")
			}
		})
	}
}
