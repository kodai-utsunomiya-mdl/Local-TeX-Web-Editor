//go:build !windows && !darwin

package platform

import (
	"os/exec"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
)

func OpenBrowser(url string) error {
	cmd := exec.Command("xdg-open", url)
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}

func showNativeFolderDialog(_ *folderPickRequest) (string, error) {
	return "", messages.Errorf("この OS ではフォルダーのパスを入力してください．")
}

func ShowError(message string) {}
