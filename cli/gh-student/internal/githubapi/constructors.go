package githubapi

import (
	"github.com/cli/go-gh/v2/pkg/api"

	"github.com/foundation50/classroom50-cli-shared/ghauth"
)

// ClientOptions aliases go-gh's api.ClientOptions for callers that build
// a non-default client (e.g., the test client in internal/githubtest).
type ClientOptions = api.ClientOptions

// NewClient builds a REST client from opts, as a Client, so callers don't
// import go-gh.
func NewClient(opts ClientOptions) (Client, error) {
	return ghauth.NewRESTClient(opts)
}
