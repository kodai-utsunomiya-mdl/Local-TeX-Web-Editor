//go:build darwin

package platform

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

func TestMacTeXPathIncludesTheFinderLocation(t *testing.T) {
	for _, value := range []string{"", "/usr/bin:/bin", "/custom/tex:/Library/TeX/texbin:/usr/bin"} {
		result := withMacTeXPath(value)
		if withMacTeXPath(result) != result {
			t.Fatalf("adding the TeX path twice changed %q", result)
		}
		if value != "" && result[:len(value)] != value {
			t.Fatalf("the existing program search order changed: %q", result)
		}
	}
}

func TestNativeFolderPickerMacCanBeCancelledAndOpenedAgain(t *testing.T) {
	if os.Getenv("LOCAL_TEX_EDITOR_TEST_NATIVE_PICKER") != "1" {
		t.Skip("native dialogs run on the macOS CI runner")
	}
	for attempt := 0; attempt < 2; attempt++ {
		ctx, cancel := context.WithCancel(context.Background())
		result := pickerAsync(&projectFolderPicker, ctx)
		select {
		case value := <-result:
			cancel()
			t.Fatalf("folder dialog closed before cancellation: %q, %v", value.path, value.err)
		case <-time.After(2 * time.Second):
		}
		cancel()
		if value := pickerResult(t, result); !errors.Is(value.err, context.Canceled) {
			t.Fatalf("cancelling the folder dialog returned: %q, %v", value.path, value.err)
		}
	}
}
