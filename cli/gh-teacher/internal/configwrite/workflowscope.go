package configwrite

import (
	"errors"

	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/validate"
)

// ErrMissingWorkflowScope: no `workflow` OAuth scope, so GitHub 404s the
// Tree write of the skeleton's .github/workflows files. The guidance steers
// the teacher to re-authenticate with the scope granted.
var ErrMissingWorkflowScope = errors.New("auth token is missing the `workflow` OAuth scope, so init can't commit the skeleton's .github/workflows files; re-run `gh teacher login` (or `gh auth refresh -s admin:org,workflow`), then run init again")

// tokenLacksWorkflowScope reports whether err's X-OAuth-Scopes header is
// present but missing `workflow`. An absent header (a fine-grained PAT
// doesn't set it) returns false, so we fall back rather than guess.
func tokenLacksWorkflowScope(err error) bool {
	httpErr, ok := errors.AsType[*githubapi.HTTPError](err)
	if !ok {
		return false
	}
	scopes := httpErr.Headers.Get("X-OAuth-Scopes")
	if scopes == "" {
		return false
	}
	return !validate.ScopeListContains(scopes, "workflow")
}

// ClassifyWorkflowScope404 maps a Tree-write 404 to ErrMissingWorkflowScope
// when X-OAuth-Scopes shows `workflow` absent. A 404 without that signal is
// fresh-repo lag, so it returns nil. Wired into the shared paths as classify404.
func ClassifyWorkflowScope404(err error) error {
	if tokenLacksWorkflowScope(err) {
		return ErrMissingWorkflowScope
	}
	return nil
}
