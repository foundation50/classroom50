package githubapi

import "github.com/cli/go-gh/v2/pkg/api"

// HTTPError aliases go-gh's api.HTTPError so domain packages can branch on
// status codes and OAuth-scope headers without importing go-gh directly. As a
// type alias it carries every field and method of the underlying type
// (StatusCode, Message, Errors, Error(), …).
type HTTPError = api.HTTPError
