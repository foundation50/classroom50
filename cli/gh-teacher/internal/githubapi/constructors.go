package githubapi

import (
	"github.com/cli/go-gh/v2/pkg/api"

	"github.com/foundation50/classroom50-cli-shared/ghauth"
)

// ClientOptions aliases go-gh's api.ClientOptions for the few call sites
// that build a non-default client (e.g., a client authenticated as a
// supplied service token).
type ClientOptions = api.ClientOptions

// DefaultClient returns the default REST client for the configured host,
// as a Client, so callers don't import go-gh.
func DefaultClient() (Client, error) {
	return ghauth.NewRESTClient(ClientOptions{})
}

// NewClient builds a REST client from opts, as a Client, so callers don't
// import go-gh.
func NewClient(opts ClientOptions) (Client, error) {
	return ghauth.NewRESTClient(opts)
}
