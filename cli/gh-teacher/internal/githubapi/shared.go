package githubapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"

	"github.com/cli/go-gh/v2/pkg/api"

	"github.com/foundation50/classroom50-cli-shared/ghutil"
	"github.com/foundation50/classroom50-cli-shared/gittree"
	"github.com/foundation50/gh-teacher/internal/orgpolicy"
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

// orgBudgetsPath is the org billing-budgets endpoint (list + create). Kept here
// so the read and write helpers can't drift.
func orgBudgetsPath(org string) string {
	return fmt.Sprintf("organizations/%s/settings/billing/budgets", url.PathEscape(org))
}

// budgetsListResponse is the GET /organizations/{org}/settings/billing/budgets
// envelope. GitHub returns the budgets under a "budgets" key; unknown fields
// are ignored so the reader tolerates schema growth.
type budgetsListResponse struct {
	Budgets []orgpolicy.Budget `json:"budgets"`
}

// ListOrgBudgets reads the org's billing budgets. The error is returned raw so
// callers can classify a 403/404 (no billing visibility / not entitled) as an
// advisory, not a hard failure. Needs org Administration: Read.
func ListOrgBudgets(c Client, org string) ([]orgpolicy.Budget, error) {
	var resp budgetsListResponse
	if err := c.Get(orgBudgetsPath(org), &resp); err != nil {
		return nil, err
	}
	return resp.Budgets, nil
}

// CreateOrgActionsBudgetCap POSTs the desired $0 hard-stop Actions budget for
// the org, returning the HTTP status. Callers must only invoke this when no
// Actions budget exists (GitHub allows one budget per scope+SKU) — this helper
// never modifies an existing budget. Needs org Administration: Read and write.
func CreateOrgActionsBudgetCap(c Client, org string) (int, error) {
	body, err := json.Marshal(map[string]any{
		"budget_amount":         0,
		"prevent_further_usage": true,
		"budget_scope":          orgpolicy.BudgetScopeOrg,
		"budget_type":           orgpolicy.BudgetTypeProductPricing,
		"budget_product_sku":    orgpolicy.BudgetProductSKUActions,
	})
	if err != nil {
		return 0, fmt.Errorf("encode body: %w", err)
	}
	resp, err := c.Request(http.MethodPost, orgBudgetsPath(org), bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode, nil
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
