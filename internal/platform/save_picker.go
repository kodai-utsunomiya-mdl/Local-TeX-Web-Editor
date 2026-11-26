package platform

import (
	"context"
	"path/filepath"
	"strings"
	"sync"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
)

const saveDialogTitle = "名前を付けて保存"

type saveFilePicker struct {
	mu     sync.Mutex
	active *folderPickRequest
	show   func(*folderPickRequest, string) (string, error)
}

var documentSavePicker = saveFilePicker{show: showNativeSaveDialog}

// PickSaveFile asks for a file name and destination, including the operating
// system's confirmation before replacing an existing file. Each result belongs
// to one caller so concurrent exports cannot write to the same chosen path.
func PickSaveFile(ctx context.Context, suggestedName string) (string, error) {
	return documentSavePicker.pick(ctx, suggestedName)
}

func CancelSavePicker() {
	documentSavePicker.close()
}

func (picker *saveFilePicker) pick(ctx context.Context, suggestedName string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	name := filepath.Base(suggestedName)
	if name == "" || name == "." || name == string(filepath.Separator) || strings.ContainsRune(name, 0) {
		return "", messages.Errorf("保存するファイル名が無効です．")
	}
	picker.mu.Lock()
	if active := picker.active; active != nil {
		select {
		case active.focus <- struct{}{}:
		default:
		}
		picker.mu.Unlock()
		return "", messages.Errorf("保存先の選択画面が開いています．保存またはキャンセルしてから，もう一度実行してください．")
	}
	nativeContext, cancel := context.WithCancel(ctx)
	request := &folderPickRequest{ctx: nativeContext, cancel: cancel, focus: make(chan struct{}, 1)}
	picker.active = request
	picker.mu.Unlock()
	defer func() {
		cancel()
		picker.mu.Lock()
		picker.active = nil
		picker.mu.Unlock()
	}()
	path, err := picker.show(request, name)
	if nativeContext.Err() != nil {
		return "", nativeContext.Err()
	}
	return path, err
}

func (picker *saveFilePicker) close() {
	picker.mu.Lock()
	defer picker.mu.Unlock()
	if picker.active != nil {
		picker.active.cancel()
	}
}
