package platform

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func savePickerAsync(picker *saveFilePicker, ctx context.Context, name string) <-chan folderPickResult {
	result := make(chan folderPickResult, 1)
	go func() {
		path, err := picker.pick(ctx, name)
		result <- folderPickResult{path, err}
	}()
	return result
}

func TestSavePickerGivesTheChosenPathToOnlyOneRequest(t *testing.T) {
	started := make(chan *folderPickRequest, 1)
	selection := make(chan string, 1)
	picker := &saveFilePicker{show: func(request *folderPickRequest, name string) (string, error) {
		if name != "原稿.tex" {
			t.Errorf("suggested name = %q", name)
		}
		started <- request
		select {
		case path := <-selection:
			return path, nil
		case <-request.ctx.Done():
			return "", request.ctx.Err()
		}
	}}
	t.Cleanup(picker.close)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	first := savePickerAsync(picker, ctx, filepath.Join("project", "原稿.tex"))
	request := <-started
	if path, err := picker.pick(ctx, "別の原稿.tex"); path != "" || err == nil {
		t.Fatalf("a second export used the first destination: %q, %v", path, err)
	}
	select {
	case <-request.focus:
	case <-ctx.Done():
		t.Fatal("the existing Save As dialog was not brought forward")
	}
	selected := filepath.Join(t.TempDir(), "保存した原稿.tex")
	selection <- selected
	if result := pickerResult(t, first); result.path != selected || result.err != nil {
		t.Fatalf("selected destination = %+v", result)
	}
}

func TestSavePickerCancellationAllowsAnotherFile(t *testing.T) {
	started := make(chan string, 2)
	picker := &saveFilePicker{show: func(request *folderPickRequest, name string) (string, error) {
		started <- name
		<-request.ctx.Done()
		return "", nil
	}}
	t.Cleanup(picker.close)
	ctx, cancel := context.WithCancel(context.Background())
	first := savePickerAsync(picker, ctx, "first.pdf")
	if name := <-started; name != "first.pdf" {
		t.Fatalf("first name = %q", name)
	}
	cancel()
	if result := pickerResult(t, first); !errors.Is(result.err, context.Canceled) {
		t.Fatalf("cancelled export = %+v", result)
	}
	second := savePickerAsync(picker, context.Background(), "second.pdf")
	if name := <-started; name != "second.pdf" {
		t.Fatalf("second name = %q", name)
	}
	picker.close()
	if result := pickerResult(t, second); !errors.Is(result.err, context.Canceled) || result.path != "" {
		t.Fatalf("closing the Save As dialog = %+v", result)
	}
}

func TestSavePickerRejectsInvalidNamesBeforeOpening(t *testing.T) {
	picker := &saveFilePicker{show: func(*folderPickRequest, string) (string, error) {
		t.Fatal("an invalid request opened a dialog")
		return "", nil
	}}
	for _, name := range []string{"", ".", string(filepath.Separator), "bad\x00name"} {
		if path, err := picker.pick(context.Background(), name); path != "" || err == nil {
			t.Errorf("name %q returned %q, %v", name, path, err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := picker.pick(ctx, "draft.tex"); !errors.Is(err, context.Canceled) {
		t.Errorf("a cancelled request returned %v", err)
	}
}
