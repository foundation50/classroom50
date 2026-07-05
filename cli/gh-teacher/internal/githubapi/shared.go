package githubapi

import (
	"fmt"
	"net/url"

	"github.com/cli/go-gh/v2/pkg/api"

	"github.com/foundation50/classroom50-cli-shared/ghutil"
	"github.com/foundation50/classroom50-cli-shared/gittree"
)

// rest recovers the concrete *api.RESTClient backing a Client. Every Client in
// this binary is the go-gh client (or a test fake embedding one), so the
// assertion holds; it panics otherwise — a programming error, since the
// shared-module helpers below require the concrete type.
func rest(c Client) *api.RESTClient {
	rc, ok := c.(*api.RESTClient)
	if !ok {
		panic("githubapi: Client is not a *api.RESTClient; shared-module operations require the concrete go-gh client")
	}
	return rc
}

// CurrentUser returns the authenticated user's login and id.
func CurrentUser(c Client) (login string, id int64, err error) {
	return ghutil.CurrentUser(rest(c))
}

// OrgPlan reads GET /orgs/{org} and returns the billing plan name
// ("free"/"team"/"enterprise"), empty when the token lacks billing visibility.
// Lives here (with the other org reads) so the pure internal/orgpolicy seam
// stays stdlib-only. The error is returned raw so callers can classify it.
func OrgPlan(c Client, org string) (string, error) {
	path := fmt.Sprintf("orgs/%s", url.PathEscape(org))
	var resp struct {
		Plan struct {
			Name string `json:"name"`
		} `json:"plan"`
	}
	if err := c.Get(path, &resp); err != nil {
		return "", err
	}
	return resp.Plan.Name, nil
}

// SetCollaborator adds username to owner/repo at the given permission,
// returning the resulting HTTP status.
func SetCollaborator(c Client, owner, repo, username, permission string) (int, error) {
	return ghutil.SetCollaborator(rest(c), owner, repo, username, permission)
}

// WaitForStableBranch polls until owner/repo's branch is readable after
// a templated-repo creation, smoothing replication lag.
func WaitForStableBranch(c Client, owner, repo, branch string) error {
	return ghutil.WaitForStableBranch(rest(c), owner, repo, branch)
}

// CommitWithRebase runs the optimistic tree-commit-with-rebase loop.
func CommitWithRebase(
	c Client,
	owner, repo, branch, message string,
	build func(parentSHA string) (gittree.Change, error),
	classify404 func(error) error,
) (string, error) {
	return gittree.CommitWithRebase(rest(c), owner, repo, branch, message, build, classify404)
}

// UploadBlobs uploads file contents as git blobs, returning their tree
// entries.
func UploadBlobs(c Client, owner, repo string, files map[string]string) ([]gittree.TreeEntry, error) {
	return gittree.UploadBlobs(rest(c), owner, repo, files)
}

// CommitWithFreshRepoRetry commits a prepared entry set, retrying while a
// freshly created repo's git-data APIs lag.
func CommitWithFreshRepoRetry(
	c Client,
	owner, repo, branch, message string,
	entries []gittree.TreeEntry,
	cfg gittree.FreshRepoRetry,
) (string, error) {
	return gittree.CommitWithFreshRepoRetry(rest(c), owner, repo, branch, message, entries, cfg)
}
