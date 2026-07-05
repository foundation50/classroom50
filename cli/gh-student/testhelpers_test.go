package main

import (
	"net/http/httptest"
	"testing"

	"github.com/foundation50/gh-student/internal/githubapi"
	"github.com/foundation50/gh-student/internal/githubtest"
)

// newTestRESTClient wires a real go-gh client at the test server, as the
// githubapi.Client seam. Thin shim over githubtest.NewTestClient so existing
// package-main call sites stay unchanged.
func newTestRESTClient(t *testing.T, server *httptest.Server) githubapi.Client {
	t.Helper()
	return githubtest.NewTestClient(t, server)
}
