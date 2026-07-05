package githubtest

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/cli/go-gh/v2/pkg/api"

	"github.com/foundation50/gh-student/internal/githubapi"
)

// hostRewriteTransport redirects every request to a single test server while
// preserving the path so the handler can dispatch on it. This is the seam
// go-gh's docs recommend for tests (ClientOptions.Transport "should be
// reserved for testing").
type hostRewriteTransport struct {
	target *url.URL
}

func (h *hostRewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req.URL.Scheme = h.target.Scheme
	req.URL.Host = h.target.Host
	return http.DefaultTransport.RoundTrip(req)
}

// NewTestClient wires a real go-gh client at the given test server, returned as
// the githubapi.Client seam. AuthToken must be non-empty so go-gh's
// header-injection layer leaves Authorization alone.
//
// This is the shared white-box test helper for gh-student: domain tests
// construct a Client here instead of reaching into the concrete go-gh
// constructor, so the go-gh dependency stays confined to githubapi and this
// package. Mirrors cli/gh-teacher/internal/githubtest (separate Go modules, so
// the helper can't be shared).
func NewTestClient(t *testing.T, server *httptest.Server) githubapi.Client {
	t.Helper()
	u, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse server URL: %v", err)
	}
	client, err := api.NewRESTClient(api.ClientOptions{
		Host:         "github.com",
		AuthToken:    "test-token",
		Transport:    &hostRewriteTransport{target: u},
		LogIgnoreEnv: true,
	})
	if err != nil {
		t.Fatalf("api.NewRESTClient: %v", err)
	}
	return client
}
