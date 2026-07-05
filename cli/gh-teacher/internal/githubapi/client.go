package githubapi

import (
	"io"
	"net/http"
)

// Client is the transport-verb seam over the GitHub REST API, exposing the
// three verbs gh-teacher uses: Get, Post, and the verb-agnostic Request (for
// PATCH/PUT/DELETE and the Link-header GET pagination needs). Deliberately not
// a per-operation domain interface — domain shaping lives in the service layer.
//
// The concrete implementation is go-gh's *api.RESTClient (returned by
// RequireAuthClient); tests use the in-memory fake in internal/githubtest.
type Client interface {
	// Get issues a GET and decodes the JSON body into resp (resp may be
	// nil for existence-only checks).
	Get(path string, resp interface{}) error
	// Post issues a POST with body and decodes the JSON response into
	// resp (resp may be nil).
	Post(path string, body io.Reader, resp interface{}) error
	// Request issues an arbitrary-method request and returns the raw
	// response, so callers can read headers (e.g. Link for pagination)
	// or status codes the decode-and-discard verbs hide.
	Request(method string, path string, body io.Reader) (*http.Response, error)
}
