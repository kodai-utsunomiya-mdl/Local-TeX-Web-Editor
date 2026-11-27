//go:build !windows

package platform

import "context"

func ManageStoreUpdates(ctx context.Context, options StoreUpdateOptions) (StoreUpdateState, error) {
	if err := validateStoreUpdateRequest(ctx, options); err != nil {
		return StoreUpdateState{}, err
	}
	return StoreUpdateState{Status: "unsupported"}, ErrStoreUpdatesUnsupported
}
