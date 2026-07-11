package invitecmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/foundation50/classroom50-cli-shared/ghutil"
	"github.com/foundation50/gh-student/internal/githubapi"
)

// listGroupMemberLogins returns the logins of student-level collaborators on
// org/repo, walking pagination. The repo `owner` (founder) is always kept even
// though they are repo `admin` (the org lockdown keeps them admin so they can
// manage collaborators). Every *other* admin — org owner, instructors, any
// admin-granted TA — is excluded so they don't consume student slots against
// max_group_size (push collaborators count; the founder and added teammates
// count, a non-founder admin does not).
//
// NOTE: this admin exclusion is for COUNTING toward max_group_size only — an
// advisory limit (bypassable via the GitHub UI). It is deliberately NOT how a
// teammate is CREDITED: crediting happens at collection time in
// collect_scores.py, which gates on the classroom GitHub team (not on
// collaborator permission), so a teammate on the team who is also a repo/org
// admin is still credited the shared group score though they don't count as a
// slot here. The classroom team — the source of truth for enrollment — is the
// real attribution boundary; the student CLI counts by permission instead.
//
// ctx bounds the enumeration: go-gh's default REST client has no HTTP timeout,
// so without a deadline a stalled collaborators API would hang the invite. The
// caller passes a context.WithTimeout matching the sibling Pages fetch budget.
func listGroupMemberLogins(ctx context.Context, client githubapi.Client, org, repo, owner string) ([]string, error) {
	const perPage = 100
	const maxPages = 100
	var logins []string
	path := fmt.Sprintf("repos/%s/%s/collaborators?per_page=%d&page=1",
		url.PathEscape(org), url.PathEscape(repo), perPage)
	for page := 1; page <= maxPages; page++ {
		resp, err := client.RequestWithContext(ctx, http.MethodGet, path, nil)
		if err != nil {
			return nil, fmt.Errorf("GET %s: %w", path, err)
		}
		var batch []struct {
			Login    string `json:"login"`
			RoleName string `json:"role_name"`
		}
		decodeErr := json.NewDecoder(resp.Body).Decode(&batch)
		linkHeader := resp.Header.Get("Link")
		// Drain before close so the connection can be pooled for the next
		// page — matches GetPage in the teacher CLI's githubapi.PaginateAll.
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		if decodeErr != nil {
			return nil, fmt.Errorf("GET %s: decode body: %w", path, decodeErr)
		}
		for _, c := range batch {
			// Exclude admins (org owners, admin-granted instructors/TAs) so
			// they don't count toward the student group limit — but keep the
			// founder, who is admin on their own repo.
			if strings.EqualFold(c.RoleName, "admin") && !strings.EqualFold(c.Login, owner) {
				continue
			}
			logins = append(logins, c.Login)
		}
		// Shared termination decision (ghutil.NextPage), identical to the
		// teacher CLI's githubapi.PaginateAll: follow GitHub's authoritative
		// `Link: rel="next"`, stop on a no-next Link / short no-Link page, else
		// synthesize the next page.
		next, stop := ghutil.NextPage(linkHeader, len(batch), perPage)
		if stop {
			return logins, nil
		}
		if next != "" {
			path = next
			continue
		}
		path = fmt.Sprintf("repos/%s/%s/collaborators?per_page=%d&page=%d",
			url.PathEscape(org), url.PathEscape(repo), perPage, page+1)
	}
	return nil, fmt.Errorf("repos/%s/%s/collaborators: too many collaborators to enumerate (hit the %d-page cap)", org, repo, maxPages)
}

// checkGroupSizeBeforeInvite enforces max_group_size for a group repo before
// adding a new push collaborator. It counts the repo's current student members
// (non-founder admins excluded) and errors when adding `invitee` would exceed
// `maxGroupSize`. An already-member invitee is never blocked (re-invite no-op).
//
// max <= 0 means no limit (defensive — group assignments always carry a
// positive size). The founder (`owner`) counts toward the total.
func checkGroupSizeBeforeInvite(ctx context.Context, client githubapi.Client, org, repo, owner, invitee string, maxGroupSize int) error {
	if maxGroupSize <= 0 {
		return nil
	}
	members, err := listGroupMemberLogins(ctx, client, org, repo, owner)
	if err != nil {
		return err
	}
	for _, login := range members {
		if strings.EqualFold(login, invitee) {
			// Already a member — re-inviting is a no-op, never blocked.
			return nil
		}
	}
	if len(members) >= maxGroupSize {
		return fmt.Errorf("group is full: %s/%s already has %d member(s), at the max of %d for this assignment — ask your instructor to raise --max-group-size if you need more",
			org, repo, len(members), maxGroupSize)
	}
	return nil
}
