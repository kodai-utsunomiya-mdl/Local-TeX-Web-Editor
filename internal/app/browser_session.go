package app

import (
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

// Each editor tab observes the application through an authenticated stream.
// Tabs may freeze or be discarded while the user works elsewhere. Ending a
// stream only releases that request; Quit or an OS exit ends the application.
func (a *App) browserSessionHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	if _, ok := w.(http.Flusher); !ok {
		writeError(w, fail(http.StatusInternalServerError, "ブラウザとの接続を開始できません．"))
		return
	}
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		writeError(w, fail(http.StatusServiceUnavailable, "アプリを起動し直してください．"))
		return
	}
	end := a.browserEnd
	a.mu.Unlock()

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	writeComment := func(comment string) bool {
		if err := controller.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil && !errors.Is(err, http.ErrNotSupported) {
			return false
		}
		if _, err := io.WriteString(w, ": "+comment+"\n\n"); err != nil {
			return false
		}
		if err := controller.Flush(); err != nil {
			return false
		}
		_ = controller.SetWriteDeadline(time.Time{})
		return true
	}
	if !writeComment("connected") {
		return
	}
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-end:
			return
		case <-ticker.C:
			if !writeComment("keepalive") {
				return
			}
		}
	}
}

// CloseBrowserSessions ends the open responses before http.Server.Shutdown
// waits for handlers. The application no longer accepts requests after this.
func (a *App) CloseBrowserSessions() {
	a.mu.Lock()
	a.closeBrowserSessionsLocked()
	a.mu.Unlock()
}

func (a *App) closeBrowserSessionsLocked() {
	a.closed = true
	if a.browserEnd != nil {
		close(a.browserEnd)
		a.browserEnd = nil
	}
}

func (a *App) requestShutdown() {
	a.shutdownOnce.Do(func() {
		a.CloseBrowserSessions()
		platform.CancelFolderPicker()
		platform.CancelSavePicker()
		a.cancelTeXSetup()
		_ = a.stopBuild()
		if a.options.Shutdown != nil {
			a.options.Shutdown()
		}
	})
}
