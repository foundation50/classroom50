// Package membership is the org-membership service for gh-teacher: GitHub
// org-level invite / user-lookup / membership-state primitives and the
// 403-classification family shared by the invite, roster, and member commands.
// Talks to GitHub only through internal/githubapi.
//
// Boundary vs internal/configrepo: config-repo-keyed membership (team grants
// via the slug in classroom.json) lives in configrepo; pure org membership
// independent of stored config (invite/lookup/state) lives here.
//
// A primitives surface, not a fused service object: each consuming command
// needs a different subset, so the primitives are exported individually.
package membership

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"

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
// user-facing messages. Unrecognized errors wrap with request context.
func ClassifyOrgInviteError(client githubapi.Client, org, username, path string, err error) error {
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
// Generic: absent header (e.g. a fine-grained PAT).
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
