//go:build !windows && !darwin

package app

import (
	"context"
	"io"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
)

func runElevatedTeXCommand(ctx context.Context, environment TeXEnvironment, executable string, arguments []string, directory string, output io.Writer) error {
	return messages.Errorf("この OS では管理者権限が必要な TeX の操作を開始できません．OS のパッケージ管理ツールを使ってください．")
}

func runExternalTeXUninstall(ctx context.Context, environment TeXEnvironment, output io.Writer) error {
	return messages.Errorf("この OS では，導入に使った管理ツールから TeX を削除してください．")
}

func openExternalTeXManager(ctx context.Context, environment TeXEnvironment) error {
	return messages.Errorf("この OS では，導入に使ったパッケージ管理ツールを開いてください．")
}

func openExternalTeXUninstaller(ctx context.Context, environment TeXEnvironment) error {
	return messages.Errorf("この OS では，導入に使った管理ツールから TeX を削除してください．")
}
