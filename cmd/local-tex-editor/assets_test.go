package main

import (
	"mime"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestWorkerMIMEDoesNotUseWindowsFileAssociations(t *testing.T) {
	previous := mime.TypeByExtension(".mjs")
	if err := mime.AddExtensionType(".mjs", "text/plain"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = mime.AddExtensionType(".mjs", previous) })
	module := "export const loaded = true;\n"
	assets := fstest.MapFS{"pdf.worker.min.mjs": {Data: []byte(module)}}
	handler := staticFiles("127.0.0.1:8765", assets)
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8765/pdf.worker.min.mjs", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != module {
		t.Fatalf("worker response: status %d, body %q", response.Code, response.Body.String())
	}
	mediaType, _, err := mime.ParseMediaType(response.Header().Get("Content-Type"))
	if err != nil || mediaType != "text/javascript" {
		t.Fatalf("a browser cannot load this module with Content-Type %q", response.Header().Get("Content-Type"))
	}
}

func TestStaticAssetsRevalidateAcrossApplicationUpdates(t *testing.T) {
	request := func(handler http.Handler, target, tag string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8765"+target, nil)
		if tag != "" {
			r.Header.Set("If-None-Match", tag)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	first := staticFiles("127.0.0.1:8765", fstest.MapFS{"app.js": {Data: []byte("version one")}, "service-worker.js": {Data: []byte("worker one")}, "index.html": {Data: []byte("page")}})
	for _, path := range []string{"/app.js", "/service-worker.js"} {
		response := request(first, path, "")
		tag := response.Header().Get("ETag")
		if response.Code != 200 || tag == "" || response.Header().Get("Cache-Control") != "no-cache" {
			t.Fatalf("response for %s = %v", path, response.Result())
		}
		unchanged := request(first, path, tag)
		if unchanged.Code != 304 || unchanged.Body.Len() != 0 {
			t.Fatal("unchanged code was downloaded again")
		}
		updated := staticFiles("127.0.0.1:8765", fstest.MapFS{path[1:]: {Data: []byte("version two")}})
		next := request(updated, path, tag)
		if next.Code != 200 || next.Header().Get("ETag") == tag || next.Body.String() != "version two" {
			t.Fatal("the previous build was returned after an update")
		}
	}
	if response := request(first, "/", ""); response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("the entry page must reload from the application")
	}
}

func TestOnlyExistingHashedChunksReceiveImmutableCaching(t *testing.T) {
	handler := staticFiles("127.0.0.1:8765", fstest.MapFS{"chunks/pdf-runtime-A1B2C3D4.js": {Data: []byte("export const pdf = true;")}})
	for _, example := range []struct {
		path   string
		status int
		cache  string
	}{
		{"/chunks/pdf-runtime-A1B2C3D4.js", 200, "public, max-age=31536000, immutable"},
		{"/chunks/missing-A1B2C3D4.js", 404, ""},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8765"+example.path, nil))
		if response.Code != example.status || response.Header().Get("Cache-Control") != example.cache {
			t.Fatalf("unexpected cache response for %s", example.path)
		}
	}
}
