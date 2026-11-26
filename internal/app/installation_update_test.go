package app

import (
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestInstallationUpdateAllowsEditingAndFinishesBeforeExit(t *testing.T) {
	a, _ := testApp(t)
	started, proceed, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	a.StartInstallationUpdate(func() error { close(started); <-proceed; return errors.New("installation test error") }, func() error { close(finished); return nil })
	<-started
	response := apiRequest(a, http.MethodGet, "/api/state", nil, nil)
	if response.Code != http.StatusOK {
		t.Fatal("the editor cannot open during its launch-link update")
	}
	closed := make(chan struct{})
	go func() { _ = a.Close(); close(closed) }()
	select {
	case <-closed:
		t.Fatal("the process exited while its launch-link update was running")
	case <-time.After(15 * time.Millisecond):
	}
	close(proceed)
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("the process did not finish after updating its launch links")
	}
	<-finished
	a.mu.Lock()
	err := a.options.InstallationError
	a.mu.Unlock()
	if err == nil || !strings.Contains(err.Error(), "installation test error") {
		t.Fatal("the update error was not available to the editor")
	}
}
