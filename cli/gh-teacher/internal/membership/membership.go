// Package membership is the org-membership service for gh-teacher: GitHub
// org-level invite / user-lookup / membership-state primitives, the
// account-listing shape and paginator (Account, ListAccounts) behind every
// members and collaborators read, and the 403-classification family shared by
// the invite, roster, member, and group commands. Talks to GitHub only through
// internal/githubapi.
//
// Boundary vs internal/configrepo: config-repo-keyed membership (team grants
// via the slug in classroom.json) lives in configrepo; pure org membership
// independent of stored config (invite/lookup/state) lives here. configrepo
// decodes team members into this package's Account; membership never imports
// configrepo.
//
// A primitives surface, not a fused service object: each consuming command
// needs a different subset, so the primitives are exported individually.
package membership

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/validate"
)

// InviteOrgByID posts an org invitation by the invitee's numeric id (callers
// with the id save the lookup). `username` is still needed so
// ClassifyOrgInviteError can produce "already a member"/"pending" messages.
func InviteOrgByID(client githubapi.Client, org, username string, userID int64, role string) error {
	body, err := json.Marshal(map[string]any{
		"invitee_id": userID,
		"role":       role,
	})
	if err != nil {
		return fmt.Errorf("encode body: %w", err)
	}
	path := fmt.Sprintf("orgs/%s/invitations", url.PathEscape(org))
	if err := client.Post(path, bytes.NewReader(body), nil); err != nil {
		return ClassifyOrgInviteError(client, org, username, path, err)
	}
	return nil
}

// ErrEmailAlreadyInvitedOrMember is the 422 GitHub returns when the address is
// already a member or already has a pending invitation. The username path
// confirms which via a membership lookup; an email has no
// `/orgs/{org}/memberships/{user}` to read, so the 422's text is the answer —
// callers treat it as a skip, not a failed invite.
var ErrEmailAlreadyInvitedOrMember = errors.New("already a member of the organization or already invited")

// ErrInvitationLimit is the 422 GitHub returns when the org's invitation cap
// (50 per day for a new or free org, 500 otherwise) or its spam throttle is hit.
// Nothing covers the address afterwards, so callers treat it like a rate limit,
// never as "already invited".
var ErrInvitationLimit = errors.New("GitHub's invitation limit for the organization was reached; try again later")

var (
	invitation422Limit   = regexp.MustCompile(`(?i)rate limit|invitation limit|too many`)
	invitation422Already = regexp.MustCompile(`(?i)already`)
)

// classifyInvitation422 reads a POST /orgs/{org}/invitations 422, which GitHub
// uses for three answers ("Validation failed, or the endpoint has been
// spammed"): already invited or a member, the invitation cap, or any other
// validation failure. Mirrors the web's classifyInvitation422 so both tools
// skip, defer, and fail on the same bodies.
func classifyInvitation422(email string, httpErr *githubapi.HTTPError) error {
	texts := []string{httpErr.Message}
	for _, item := range httpErr.Errors {
		texts = append(texts, item.Message)
	}
	joined := strings.TrimSpace(strings.Join(texts, " "))
	switch {
	case invitation422Limit.MatchString(joined):
		return fmt.Errorf("%s: %w (%s)", email, ErrInvitationLimit, joined)
	case invitation422Already.MatchString(joined):
		return fmt.Errorf("%s: %w", email, ErrEmailAlreadyInvitedOrMember)
	default:
		return fmt.Errorf("%s: GitHub rejected the invitation (%s); check the address and try again", email, joined)
	}
}

// InviteOrgByEmail posts an org invitation to an email address (the invitee has
// no GitHub account to look up yet). teamIDs auto-add the invitee to those teams
// on acceptance, so one accepted invitation lands them in the classroom without
// a separate team invite that could leave them org-active but team-pending.
// Mirrors the web's createOrgInvitation: exactly one of invitee_id / email.
func InviteOrgByEmail(client githubapi.Client, org, email string, teamIDs []int64) error {
	payload := map[string]any{
		"email": email,
		"role":  "direct_member",
	}
	if len(teamIDs) > 0 {
		payload["team_ids"] = teamIDs
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode body: %w", err)
	}
	path := fmt.Sprintf("orgs/%s/invitations", url.PathEscape(org))
	if err := client.Post(path, bytes.NewReader(body), nil); err != nil {
		// Intercepted before ClassifyOrgInviteError, whose 422 branch issues a
		// username-keyed membership GET this path has no username for.
		if httpErr, ok := errors.AsType[*githubapi.HTTPError](err); ok && httpErr.StatusCode == http.StatusUnprocessableEntity {
			return classifyInvitation422(email, httpErr)
		}
		return ClassifyOrgInviteError(client, org, "", path, err)
	}
	return nil
}

// ErrInvitationAlreadyGone means the DELETE 404'd: the invitation was cancelled
// elsewhere or replaced by a resend. Distinguishable from success because a
// cancel's teardown (deleting the invite team, dropping the pending roster row)
// must only run on a real cancellation — a stale id can 404 while a live
// invitation for the same address still exists. Mirrors the web's
// `cancelled: false`.
var ErrInvitationAlreadyGone = errors.New("invitation no longer exists")

// CancelOrgInvitation revokes a pending org invitation by id.
func CancelOrgInvitation(client githubapi.Client, org string, invitationID int64) error {
	path := fmt.Sprintf("orgs/%s/invitations/%d", url.PathEscape(org), invitationID)
	resp, err := client.Request(http.MethodDelete, path, nil)
	if err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return fmt.Errorf("%w (%s)", ErrInvitationAlreadyGone, path)
		}
		return fmt.Errorf("DELETE %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("DELETE %s: unexpected status %d", path, resp.StatusCode)
	}
	return nil
}

// PendingOrgInvitation is one GET /orgs/{org}/invitations element. GitHub keys
// an invitation by `login` (invited by id) or by `email` (invited by address) —
// never both — so a caller matching an invitation checks the field its own key
// lives in. Role is the raw API role; display normalization is the caller's.
type PendingOrgInvitation struct {
	ID    int64  `json:"id"`
	Login string `json:"login"`
	Email string `json:"email"`
	Role  string `json:"role"`
}

// IsEmailKeyed reports an invitation addressed by EMAIL — the one filter every
// email-invite path shares (the cancel's address lookup and the roster sync's
// liveness check), so the two can't drift into disagreeing on what an email
// invitation is.
func (inv PendingOrgInvitation) IsEmailKeyed() bool {
	return inv.Login == "" && inv.Email != ""
}

// ListPendingOrgInvitations walks every pending org invitation. Shared by
// `member list`, the cancel path (find an invitation by email) and the roster
// sync liveness check, so all three agree on what "pending" means. A 403 (no
// admin:org scope) is a hard error rather than an empty set, since "no pending
// invites" and "can't read invites" are very different signals.
func ListPendingOrgInvitations(client githubapi.Client, org string) ([]PendingOrgInvitation, error) {
	base := fmt.Sprintf("orgs/%s/invitations", url.PathEscape(org))
	subject := fmt.Sprintf("%s pending invitations", org)
	return githubapi.PaginateAll[PendingOrgInvitation](client, githubapi.ListPerPage, githubapi.ListMaxPages,
		func(page int) string {
			return fmt.Sprintf("%s?per_page=%d&page=%d", base, githubapi.ListPerPage, page)
		},
		func(path string, err error) error { return ClassifyMembershipReadError(path, subject, err) })
}

// FailedOrgInvitation is one GET /orgs/{org}/failed_invitations element: an
// invitation nobody accepted within GitHub's 7 days, or one GitHub couldn't
// deliver. Keyed by login or email exactly like a pending one.
type FailedOrgInvitation struct {
	ID    int64  `json:"id"`
	Login string `json:"login"`
	Email string `json:"email"`
}

// IsEmailKeyed is PendingOrgInvitation.IsEmailKeyed for a failed record.
func (inv FailedOrgInvitation) IsEmailKeyed() bool {
	return inv.Login == "" && inv.Email != ""
}

// ListFailedOrgInvitations walks GET /orgs/{org}/failed_invitations, the
// owner-only record GitHub keeps of expired invitations. The HTTP error is left
// unclassified so a caller can treat 403/404 as an empty list; dismissing a
// record is CancelOrgInvitation on its id.
func ListFailedOrgInvitations(client githubapi.Client, org string) ([]FailedOrgInvitation, error) {
	base := fmt.Sprintf("orgs/%s/failed_invitations", url.PathEscape(org))
	return githubapi.PaginateAll[FailedOrgInvitation](client, githubapi.ListPerPage, githubapi.ListMaxPages,
		func(page int) string {
			return fmt.Sprintf("%s?per_page=%d&page=%d", base, githubapi.ListPerPage, page)
		},
		func(path string, err error) error { return fmt.Errorf("GET %s: %w", path, err) })
}

// InvitationTeamRef is one element of GET /orgs/{org}/invitations/{id}/teams:
// the teams an invitation will add its invitee to on acceptance.
type InvitationTeamRef struct {
	ID   int64  `json:"id"`
	Slug string `json:"slug"`
}

// ListInvitationTeams reads the teams a pending invitation carries. An org
// invitation is org-scoped, so this list is the only thing that binds one to a
// classroom: a caller about to revoke an invitation it found by ADDRESS checks
// that one of its own classroom's teams is here, or it may revoke a sibling
// classroom's live invitation to the same address. A failed read is an error,
// never an empty set — an empty set reads as "not ours" and would refuse, but a
// caller must be able to tell a refusal from a degraded read.
func ListInvitationTeams(client githubapi.Client, org string, invitationID int64) ([]InvitationTeamRef, error) {
	base := fmt.Sprintf("orgs/%s/invitations/%d/teams", url.PathEscape(org), invitationID)
	subject := fmt.Sprintf("the teams on %s invitation %d", org, invitationID)
	return githubapi.PaginateAll[InvitationTeamRef](client, githubapi.ListPerPage, githubapi.ListMaxPages,
		func(page int) string {
			return fmt.Sprintf("%s?per_page=%d&page=%d", base, githubapi.ListPerPage, page)
		},
		func(path string, err error) error { return ClassifyMembershipReadError(path, subject, err) })
}

// LookupUser → (canonical login, immutable numeric ID). 404 → "user not found".
func LookupUser(client githubapi.Client, username string) (login string, userID int64, err error) {
	path := fmt.Sprintf("users/%s", url.PathEscape(username))
	var user struct {
		Login string `json:"login"`
		ID    int64  `json:"id"`
	}
	if err := client.Get(path, &user); err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return "", 0, fmt.Errorf("GitHub user %q not found", username)
		}
		return "", 0, fmt.Errorf("GET %s: %w", path, err)
	}
	return user.Login, user.ID, nil
}

// OrgMembershipKnownError: 422 followed by a membership lookup
// confirming the user is already active or pending. Roster commands
// match on this via `errors.As` so a TOCTOU race past
// MembershipState doesn't surface as "org invite failed".
type OrgMembershipKnownError struct {
	State string // "active" or "pending"
	msg   string
}

func (e *OrgMembershipKnownError) Error() string { return e.msg }

// ClassifyOrgInviteError maps POST /orgs/{org}/invitations errors to
// user-facing messages. Unrecognized errors wrap with request context. A rate
// limit is wrapped, not classified: GitHub sends secondary limits as a 403, and
// a caller deciding whether to defer needs cliutil.IsRateLimited to still see it.
func ClassifyOrgInviteError(client githubapi.Client, org, username, path string, err error) error {
	if cliutil.IsRateLimited(err) {
		return fmt.Errorf("POST %s: %w", path, err)
	}
	if httpErr, ok := errors.AsType[*githubapi.HTTPError](err); ok {
		switch httpErr.StatusCode {
		case http.StatusUnauthorized:
			return errors.New("authentication failed; run `gh teacher login` to (re)authenticate")

		case http.StatusForbidden:
			switch ClassifyOrgForbidden(httpErr) {
			case OrgForbiddenScopeMissing:
				return ErrMissingOrgAdminScope
			case OrgForbiddenNotAdmin:
				return fmt.Errorf("you must be an admin of %s to invite members", org)
			default:
				return fmt.Errorf("forbidden: ensure your token has the admin:org scope (`gh teacher login`) and that you are an admin of %s", org)
			}

		case http.StatusNotFound:
			return fmt.Errorf("%s: organization not found or not accessible", org)

		case http.StatusUnprocessableEntity:
			// Follow-up GET separates already-member from pending;
			// other 422s fall through to the wrapped error below.
			if state, ok := MembershipState(client, org, username); ok {
				switch state {
				case "active":
					return &OrgMembershipKnownError{
						State: "active",
						msg:   fmt.Sprintf("%s is already a member of %s", username, org),
					}
				case "pending":
					return &OrgMembershipKnownError{
						State: "pending",
						msg:   fmt.Sprintf("%s already has a pending invitation to %s; advise them to visit https://github.com/%s to accept", username, org, org),
					}
				}
			}
		}
	}
	return fmt.Errorf("POST %s: %w", path, err)
}

// OrgForbiddenKind classifies a 403 by what X-OAuth-Scopes reveals, so callers
// phrase their own message without re-inspecting the header. ScopeMissing: a
// classic token lacking admin:org; NotAdmin: has the scope but isn't an admin;
// Generic: absent header (e.g., a fine-grained PAT).
type OrgForbiddenKind int

const (
	OrgForbiddenGeneric OrgForbiddenKind = iota
	OrgForbiddenScopeMissing
	OrgForbiddenNotAdmin
)

// ClassifyOrgForbidden inspects an HTTPError's X-OAuth-Scopes. Shared by the
// invite (POST) and member-read (GET) paths so the scope-vs-admin distinction
// stays identical.
func ClassifyOrgForbidden(httpErr *githubapi.HTTPError) OrgForbiddenKind {
	scopes := httpErr.Headers.Get("X-OAuth-Scopes")
	switch {
	case scopes == "":
		return OrgForbiddenGeneric
	case !HasOrgAdminScope(scopes):
		return OrgForbiddenScopeMissing
	default:
		return OrgForbiddenNotAdmin
	}
}

// ErrMissingOrgAdminScope is the shared message for the scope-missing
// case (identical across invite and read paths).
var ErrMissingOrgAdminScope = errors.New("missing admin:org OAuth scope; run `gh teacher login` to grant it")

// ClassifyMembershipReadError maps the common failure statuses of the read-only
// membership endpoints to actionable messages, mirroring ClassifyOrgInviteError's
// 403/404 handling (and, like it, leaving a rate limit wrapped rather than
// classified). `subject` is a human label for the thing being read. Other
// statuses return the wrapped error.
func ClassifyMembershipReadError(path, subject string, err error) error {
	httpErr, ok := errors.AsType[*githubapi.HTTPError](err)
	if !ok || cliutil.IsRateLimited(err) {
		return fmt.Errorf("GET %s: %w", path, err)
	}
	switch httpErr.StatusCode {
	case http.StatusNotFound:
		return fmt.Errorf("%s: not found or not accessible", subject)
	case http.StatusForbidden:
		switch ClassifyOrgForbidden(httpErr) {
		case OrgForbiddenScopeMissing:
			return ErrMissingOrgAdminScope
		case OrgForbiddenNotAdmin:
			return fmt.Errorf("%s: forbidden: you may not have admin access to read it", subject)
		default:
			return fmt.Errorf("%s: forbidden: ensure your token has the admin:org scope (`gh teacher login`) and that you have access", subject)
		}
	}
	return fmt.Errorf("GET %s: %w", path, err)
}

// Account is one element of a GitHub account listing (org members, team
// members, repo collaborators): the login paired with the numeric id the
// roster's github_id column records. RoleName is the collaborators endpoint's
// permission level (read/triage/write/maintain/admin); the members endpoints
// leave it empty.
type Account struct {
	Login    string `json:"login"`
	ID       int64  `json:"id"`
	RoleName string `json:"role_name"`
}

// ListAccounts walks an account-listing endpoint under the shared page cap,
// classifying read failures for `subject` (a human label). `base` may already
// carry a query such as a role or affiliation filter.
func ListAccounts(client githubapi.Client, base, subject string) ([]Account, error) {
	sep := "?"
	if strings.Contains(base, "?") {
		sep = "&"
	}
	return githubapi.PaginateAll[Account](client, githubapi.ListPerPage, githubapi.ListMaxPages,
		func(page int) string {
			return fmt.Sprintf("%s%sper_page=%d&page=%d", base, sep, githubapi.ListPerPage, page)
		},
		func(path string, err error) error {
			return ClassifyMembershipReadError(path, subject, err)
		})
}

// Logins projects accounts to their logins for readers that key on username.
func Logins(accounts []Account) []string {
	out := make([]string, 0, len(accounts))
	for _, a := range accounts {
		out = append(out, a.Login)
	}
	return out
}

// HasOrgAdminScope: X-OAuth-Scopes contains admin:org.
func HasOrgAdminScope(scopes string) bool {
	return validate.ScopeListContains(scopes, "admin:org")
}

// MembershipState returns the org membership state ("active" or
// "pending"), or false on lookup failure.
func MembershipState(client githubapi.Client, org, username string) (string, bool) {
	path := fmt.Sprintf("orgs/%s/memberships/%s", url.PathEscape(org), url.PathEscape(username))
	var resp struct {
		State string `json:"state"`
	}
	if err := client.Get(path, &resp); err != nil {
		return "", false
	}
	return resp.State, true
}
