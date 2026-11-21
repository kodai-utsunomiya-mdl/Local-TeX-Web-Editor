//go:build !windows

package app

import (
	"context"
	"io"
)

func (a *App) prepareTeXSetupSelfUpdate(_ *texSetupRun, _ string, _ []string) (func(context.Context, io.Writer) error, error) {
	return nil, nil
}
