package platform

import (
	"context"
	"time"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
)

// StoreUpdateOptions selects a Store operation. Install may cause Windows to
// close this process, so callers must finish saving work before requesting it.
type StoreUpdateOptions struct {
	Action      string
	Interactive bool
	Restart     bool
	ConfigDir   string
}

type StoreUpdateState struct {
	Available           bool   `json:"available"`
	Downloaded          bool   `json:"downloaded"`
	CanSilentlyDownload bool   `json:"canSilentlyDownload"`
	PackageCount        int    `json:"packageCount"`
	Status              string `json:"status"`
	Version             string `json:"version,omitempty"`
	Message             string `json:"message,omitempty"`
}

var ErrStoreUpdatesUnsupported = messages.Errorf("Microsoft Store から導入した Windows 版で更新できます．")

func storeRestartDelay(startedAt, now time.Time) time.Duration {
	age := now.Sub(startedAt)
	if age >= time.Minute {
		return 0
	}
	if age < 0 {
		age = 0
	}
	return time.Minute - age
}

func waitStoreRestartAge(ctx context.Context, startedAt time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	delay := storeRestartDelay(startedAt, time.Now())
	if delay == 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return ctx.Err()
	}
}

func validateStoreUpdateRequest(ctx context.Context, options StoreUpdateOptions) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	switch options.Action {
	case "check", "download", "install":
		return nil
	default:
		return messages.Errorf("アプリの更新操作を選んでください．")
	}
}

func storeUpdateResult(state StoreUpdateState, action string, overall int32) (StoreUpdateState, error) {
	switch overall {
	case 3: // StorePackageUpdateState.Completed
		state.Downloaded = true
		state.Status = "ready"
		if action == "install" {
			state.Available = false
			state.Status = "installed"
		}
	case 4: // Canceled
		state.Status = "available"
		state.Message = "Microsoft Store の更新を取り消しました．"
	case 6: // ErrorLowBattery
		state.Status = "waiting"
		state.Message = "バッテリーを充電してから，Microsoft Store の更新を再開します．"
	case 7, 8: // ErrorWiFiRecommended, ErrorWiFiRequired
		state.Status = "waiting"
		state.Message = "通信の設定により，Microsoft Store の自動更新を待っています．"
	default:
		state.Status = "error"
		return state, messages.Errorf("Microsoft Store の更新を完了できませんでした (状態 %d)．", overall)
	}
	return state, nil
}
