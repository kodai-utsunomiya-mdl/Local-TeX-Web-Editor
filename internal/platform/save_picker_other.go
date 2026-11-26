//go:build !windows && !darwin

package platform

import "github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"

func showNativeSaveDialog(_ *folderPickRequest, _ string) (string, error) {
	return "", messages.Errorf("この OS では「ダウンロード」を使って保存してください．")
}
