package main

import (
	"context"
	"errors"
	"net/http"
)

// Give accepted requests time to finish, then close any connections that are
// still open. A browser may open a connection without sending an HTTP request.
func shutdownServer(ctx context.Context, server *http.Server) error {
	err := server.Shutdown(ctx)
	if errors.Is(err, context.DeadlineExceeded) {
		return server.Close()
	}
	return err
}
