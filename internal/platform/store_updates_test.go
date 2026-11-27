package platform

import (
	"context"
	"errors"
	"testing"
)

func TestStoreUpdateCompletionAndDeferredConditions(t *testing.T) {
	for _, test := range []struct {
		name       string
		action     string
		overall    int32
		status     string
		downloaded bool
		available  bool
		wantError  bool
	}{
		{"download completed", "download", 3, "ready", true, true, false},
		{"install completed", "install", 3, "installed", true, false, false},
		{"cancelled", "download", 4, "available", false, true, false},
		{"battery", "download", 6, "waiting", false, true, false},
		{"network recommended", "download", 7, "waiting", false, true, false},
		{"network required", "install", 8, "waiting", false, true, false},
		{"failed", "install", 5, "error", false, true, true},
		{"still pending", "download", 0, "error", false, true, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			state, err := storeUpdateResult(StoreUpdateState{Available: true, PackageCount: 1}, test.action, test.overall)
			if (err != nil) != test.wantError || state.Status != test.status || state.Downloaded != test.downloaded || state.Available != test.available {
				t.Fatalf("result = %+v, %v", state, err)
			}
			if !test.wantError && !test.downloaded && state.Message == "" {
				t.Fatal("a deferred or cancelled update needs an explanation")
			}
		})
	}
}

func TestStoreUpdateRejectsInvalidAndCancelledRequests(t *testing.T) {
	if err := validateStoreUpdateRequest(context.Background(), StoreUpdateOptions{Action: "remove"}); err == nil {
		t.Fatal("an unsupported operation was accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := validateStoreUpdateRequest(ctx, StoreUpdateOptions{Action: "install"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled request = %v", err)
	}
}
