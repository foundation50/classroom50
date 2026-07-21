package cliutil

import "github.com/foundation50/classroom50-cli-shared/ghutil"

// IsHTTPStatus reports whether err is a *api.HTTPError with the given status.
// Thin wrapper over the shared ghutil helper so domain packages don't import
// the shared package directly.
func IsHTTPStatus(err error, code int) bool {
	return ghutil.IsHTTPStatus(err, code)
}

// IsRateLimited reports whether err is a GitHub rate-limit / secondary-limit
// (abuse) response rather than a genuine authz denial. Thin wrapper over the
// shared ghutil helper.
func IsRateLimited(err error) bool {
	return ghutil.IsRateLimited(err)
}
