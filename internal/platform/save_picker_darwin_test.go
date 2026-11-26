//go:build darwin

package platform

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

func TestNativeSavePickerMacCanBeCancelledAndOpenedAgain(t *testing.T) {
	if os.Getenv("LOCAL_TEX_EDITOR_TEST_NATIVE_PICKER") != "1" {
		t.Skip("native dialogs run on the macOS CI runner")
	}
	t.Cleanup(CancelSavePicker)
	for _, name := range []string{"原稿.tex", "compiled.pdf"} {
		ctx, cancel := context.WithCancel(context.Background())
		result := savePickerAsync(&documentSavePicker, ctx, name)
		select {
		case value := <-result:
			cancel()
			t.Fatalf("Save As closed before cancellation: %q, %v", value.path, value.err)
		case <-time.After(2 * time.Second):
		}
		cancel()
		if value := pickerResult(t, result); !errors.Is(value.err, context.Canceled) {
			t.Fatalf("cancelling Save As returned: %q, %v", value.path, value.err)
		}
	}
}
