package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestShutdownServerClosesConnectionWithoutRequest(t *testing.T) {
	accepted := make(chan struct{}, 1)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("a connection without an HTTP request reached the handler")
	}))
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			accepted <- struct{}{}
		}
	}
	server.Start()
	defer server.Close()
	connection, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	select {
	case <-accepted:
	case <-time.After(2 * time.Second):
		t.Fatal("the server did not accept the connection")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	if err := shutdownServer(ctx, server.Config); err != nil {
		t.Fatalf("shutdown after the deadline: %v", err)
	}
	if !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatalf("the open connection should require the shutdown deadline: %v", ctx.Err())
	}
	if err := connection.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	var data [1]byte
	if count, err := connection.Read(data[:]); count != 0 || !errors.Is(err, io.EOF) {
		t.Fatalf("connection after shutdown: read %d bytes, %v", count, err)
	}
}

func TestShutdownServerWaitsForAcceptedSave(t *testing.T) {
	file := filepath.Join(t.TempDir(), "draft.txt")
	arrived := make(chan struct{})
	finishSave := make(chan struct{})
	var finishOnce sync.Once
	releaseSave := func() { finishOnce.Do(func() { close(finishSave) }) }
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		content, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		close(arrived)
		select {
		case <-finishSave:
		case <-r.Context().Done():
			return
		}
		if err := os.WriteFile(file, content, 0600); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	defer releaseSave()
	requestDone := make(chan error, 1)
	go func() {
		response, err := server.Client().Post(server.URL, "text/plain", strings.NewReader("saved draft"))
		if err == nil {
			_, err = io.Copy(io.Discard, response.Body)
			response.Body.Close()
			if response.StatusCode != http.StatusNoContent {
				err = fmt.Errorf("save status: %d", response.StatusCode)
			}
		}
		requestDone <- err
	}()
	select {
	case <-arrived:
	case <-time.After(2 * time.Second):
		t.Fatal("the save request did not reach the server")
	}
	started := make(chan struct{})
	server.Config.RegisterOnShutdown(func() { close(started) })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	shutdownDone := make(chan error, 1)
	go func() { shutdownDone <- shutdownServer(ctx, server.Config) }()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown did not start")
	}
	select {
	case err := <-shutdownDone:
		t.Fatalf("shutdown finished before the accepted save: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	releaseSave()
	select {
	case err := <-requestDone:
		if err != nil {
			t.Fatalf("save during shutdown: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the save request did not finish")
	}
	select {
	case err := <-shutdownDone:
		if err != nil {
			t.Fatalf("shutdown after saving: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown did not finish after saving")
	}
	if ctx.Err() != nil {
		t.Fatalf("saving should finish before the shutdown deadline: %v", ctx.Err())
	}
	content, err := os.ReadFile(file)
	if err != nil || string(content) != "saved draft" {
		t.Fatalf("saved contents: %q, %v", content, err)
	}
}
