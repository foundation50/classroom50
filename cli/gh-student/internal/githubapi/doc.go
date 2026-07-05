// Package githubapi is the single seam between gh-student and the GitHub REST
// API. It is the ONLY package permitted to import
// github.com/cli/go-gh/v2/pkg/api (enforced by a CI guard, not the compiler);
// every domain talks to GitHub through the transport-verb Client interface
// defined here.
//
// The interface is intentionally transport-verb-level (Get/Post/Patch/Request),
// not a per-operation domain interface — domain shaping belongs in the
// command/service layer, not this seam. Mirrors
// cli/gh-teacher/internal/githubapi (separate Go modules, so the seam can't be
// shared, only paralleled).
package githubapi
