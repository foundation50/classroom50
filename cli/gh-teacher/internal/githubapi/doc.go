// Package githubapi is the single seam between gh-teacher and the GitHub REST
// API — the ONLY package permitted to import go-gh/v2/pkg/api (CI-enforced).
// Every domain talks to GitHub through the transport-verb Client interface
// here, plus the generic pagination and git-tree-commit plumbing on top.
//
// The interface is transport-verb-level (Get/Post/Request), not per-operation —
// domain shaping belongs in the service layer.
package githubapi
