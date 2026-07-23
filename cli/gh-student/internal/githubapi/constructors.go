package githubapi

import "github.com/cli/go-gh/v2/pkg/api"

// ClientOptions aliases go-gh's api.ClientOptions for callers that build
// a non-default client (e.g., the test client in internal/githubtest).
type ClientOptions = api.ClientOptions

// NewClient builds a REST client from opts, as a Client. Wraps
// api.NewRESTClient so callers don't import go-gh.
func NewClient(opts ClientOptions) (Client, error) {
	return api.NewRESTClient(opts)
}
