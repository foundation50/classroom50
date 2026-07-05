package githubtest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/foundation50/gh-teacher/internal/githubapi"
)

// Fake is an in-memory githubapi.Client for tests exercising domain logic
// without an httptest server. Each verb dispatches to an optional func field;
// an unset field returns a "no handler" error.
//
// WARNING: Do NOT pass a Fake into the shared-module wrappers in
// internal/githubapi (CommitWithRebase, UploadBlobs, etc.) or any function
// reaching them — they type-assert back to the concrete go-gh *api.RESTClient
// and PANIC otherwise. Use NewTestClient (a real client over httptest.Server)
// for those; the Fake is only for the transport-verb surface.
type Fake struct {
	GetFunc     func(path string, resp interface{}) error
	PostFunc    func(path string, body io.Reader, resp interface{}) error
	RequestFunc func(method, path string, body io.Reader) (*http.Response, error)
}

var _ githubapi.Client = (*Fake)(nil)

func (f *Fake) Get(path string, resp interface{}) error {
	if f.GetFunc == nil {
		return fmt.Errorf("githubtest.Fake: no GetFunc for %s", path)
	}
	return f.GetFunc(path, resp)
}

func (f *Fake) Post(path string, body io.Reader, resp interface{}) error {
	if f.PostFunc == nil {
		return fmt.Errorf("githubtest.Fake: no PostFunc for %s", path)
	}
	return f.PostFunc(path, body, resp)
}

func (f *Fake) Request(method, path string, body io.Reader) (*http.Response, error) {
	if f.RequestFunc == nil {
		return nil, fmt.Errorf("githubtest.Fake: no RequestFunc for %s %s", method, path)
	}
	return f.RequestFunc(method, path, body)
}

// JSONResponse builds an *http.Response with a JSON body and the given status
// and headers — a convenience for RequestFunc handlers driving pagination or
// status branching.
func JSONResponse(status int, body interface{}, header http.Header) (*http.Response, error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	if header == nil {
		header = http.Header{}
	}
	return &http.Response{
		StatusCode: status,
		Header:     header,
		Body:       io.NopCloser(bytes.NewReader(buf)),
	}, nil
}
