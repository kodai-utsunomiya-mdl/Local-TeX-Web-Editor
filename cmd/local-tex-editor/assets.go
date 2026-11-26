package main

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"io/fs"
	"net/http"
	"path"
	"regexp"
	"strings"
	"sync"
)

var immutableChunk = regexp.MustCompile(`^chunks/[a-zA-Z0-9_-]+-[A-Z0-9]{8}\.js$`)

func staticFiles(host string, assets fs.FS) http.Handler {
	files := http.FileServer(http.FS(assets))
	var tags sync.Map
	etag := func(name string) string {
		if value, ok := tags.Load(name); ok {
			return value.(string)
		}
		file, err := assets.Open(name)
		if err != nil {
			return ""
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			return ""
		}
		hash := sha256.New()
		if _, err := io.Copy(hash, file); err != nil {
			return ""
		}
		value := `"` + hex.EncodeToString(hash.Sum(nil)) + `"`
		tags.Store(name, value)
		return value
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != host {
			http.Error(w, "Unexpected Host", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
		// Windows file associations can label .mjs as text/plain. The bundled
		// browser code needs its web content type regardless of those settings.
		switch path.Ext(r.URL.Path) {
		case ".js", ".mjs":
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		case ".wasm":
			w.Header().Set("Content-Type", "application/wasm")
		case ".css":
			w.Header().Set("Content-Type", "text/css; charset=utf-8")
		case ".html":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
		}
		if r.URL.Path == "/" || path.Ext(r.URL.Path) == ".html" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
		} else {
			name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
			if value := etag(name); value != "" {
				// The executable embeds one immutable set of assets. A new process
				// computes tags from its own build, so updates replace changed code.
				w.Header().Set("ETag", value)
				w.Header().Set("Cache-Control", "no-cache")
				if immutableChunk.MatchString(name) {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
			}
		}
		files.ServeHTTP(w, r)
	})
}
