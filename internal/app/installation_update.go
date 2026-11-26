package app

import (
	"strings"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
)

type installationErrors []error

func (problems installationErrors) Error() string { return problems.LocalizedMessage("ja") }

func (problems installationErrors) LocalizedMessage(language string) string {
	var parts []string
	for _, problem := range problems {
		if problem != nil {
			parts = append(parts, messages.ErrorText(language, problem))
		}
	}
	return strings.Join(parts, "\n")
}

// Updating existing launch links can copy an executable and involve the OS.
// Serve the editor first, and wait for this work before the process exits.
func (a *App) StartInstallationUpdate(updates ...func() error) {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return
	}
	a.workers.Add(1)
	a.mu.Unlock()
	go func() {
		defer a.workers.Done()
		for _, update := range updates {
			if err := update(); err != nil {
				a.mu.Lock()
				a.options.InstallationError = installationErrors{a.options.InstallationError, err}
				a.mu.Unlock()
			}
		}
	}()
}
