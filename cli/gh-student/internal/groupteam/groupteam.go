// Package groupteam is the student-side kit for the GitHub Teams behind a
// `mode: team` assignment (`classroom50-group-<hash>-<n>` secret teams):
// resolving "my team" from membership alone, founding a team (student
// formation), membership edits, and attaching the team to the shared repo.
// The teacher-side twin lives in gh-teacher's internal/configrepo; both
// binaries hand-mirror the classroom50/group/v1 description record with the
// shared contract as the naming source.
package groupteam

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-student/internal/githubapi"
)

// counterCap bounds the 422-losing counter retry on create, mirroring the
// teacher side: a student client cannot see other groups' secret teams, so a
// 422 is the only signal a counter is taken.
const counterCap = 50

// description is the classroom50/group/v1 record written into a founded
// team's description. Field order matters: both writers must produce
// byte-identical JSON (Go's json.Marshal escaping is the parity target).
type description struct {
	Schema     string `json:"schema"`
	Classroom  string `json:"classroom"`
	Assignment string `json:"assignment"`
	Name       string `json:"name,omitempty"`
}

// MarshalDescription encodes the classroom50/group/v1 record for a group
// team description; the display name is omitted when empty.
func MarshalDescription(classroom, assignment, name string) (string, error) {
	out, err := json.Marshal(description{
		Schema:     contract.GroupSchemaV1,
		Classroom:  classroom,
		Assignment: assignment,
		Name:       name,
	})
	if err != nil {
		return "", fmt.Errorf("encode group team description: %w", err)
	}
	return string(out), nil
}

// Membership is the student's resolved group team for one assignment.
type Membership struct {
	Slug    string
	Counter int
}

// myTeamsPageCap bounds the /user/teams walk (100×100 teams is far beyond any
// student's membership).
const (
	myTeamsPerPage  = 100
	myTeamsPagesMax = 100
)

// MyTeam resolves the authed student's group team for (org, classroom,
// assignment) from GET /user/teams — membership alone, no config read: the
// teams are secret, so the student sees exactly the ones they are on. Scoped
// to `org` (the same hash can exist in two orgs a student belongs to). When
// the student is somehow on several of the assignment's teams, the lowest
// counter wins deterministically. found=false means no team.
func MyTeam(client githubapi.Client, org, classroom, assignment string) (Membership, bool, error) {
	type userTeam struct {
		Slug         string `json:"slug"`
		Organization struct {
			Login string `json:"login"`
		} `json:"organization"`
	}
	teams, err := githubapi.PaginateAll[userTeam](
		client, myTeamsPerPage, myTeamsPagesMax,
		func(page int) string {
			return fmt.Sprintf("user/teams?per_page=%d&page=%d", myTeamsPerPage, page)
		},
		func(path string, err error) error {
			return fmt.Errorf("GET %s (resolving your group team): %w", path, err)
		},
	)
	if err != nil {
		return Membership{}, false, err
	}
	best := Membership{}
	found := false
	for _, team := range teams {
		if !strings.EqualFold(team.Organization.Login, org) {
			continue
		}
		counter, ok := contract.ParseGroupTeamCounter(team.Slug, classroom, assignment)
		if !ok {
			continue
		}
		if !found || counter < best.Counter {
			best = Membership{Slug: team.Slug, Counter: counter}
			found = true
		}
	}
	return best, found, nil
}

// Create founds a new group team for the assignment: a CLOSED (visible) team
// with notifications disabled carrying the classroom50/group/v1 record, the
// founding student left as GitHub's auto-added maintainer. Visible because
// student-formed groups must be browsable — classmates discover teams and use
// GitHub's native request-to-join, which only exists on visible teams
// (teacher-formed teams stay secret; they're never browsed). Counters are
// allocated create-first: start at 1 and on a 422 (the name is taken — even
// by a team this student can't see) retry with the next counter, bounded by
// counterCap. Never a visibility probe.
func Create(client githubapi.Client, org, classroom, assignment, displayName string) (Membership, error) {
	record, err := MarshalDescription(classroom, assignment, displayName)
	if err != nil {
		return Membership{}, err
	}
	createPath := fmt.Sprintf("orgs/%s/teams", url.PathEscape(org))
	for counter := 1; counter <= counterCap; counter++ {
		name := contract.GroupTeamName(classroom, assignment, counter)
		body, err := json.Marshal(map[string]any{
			"name":                 name,
			"privacy":              "closed",
			"notification_setting": "notifications_disabled",
			"description":          record,
		})
		if err != nil {
			return Membership{}, fmt.Errorf("encode group team body: %w", err)
		}
		var created struct {
			Slug string `json:"slug"`
		}
		if err := client.Post(createPath, bytes.NewReader(body), &created); err != nil {
			var httpErr *githubapi.HTTPError
			if errors.As(err, &httpErr) {
				if httpErr.StatusCode == http.StatusUnprocessableEntity {
					continue // counter taken; the next one may be free
				}
				if httpErr.StatusCode == http.StatusForbidden {
					return Membership{}, fmt.Errorf("GitHub refused to create the team (HTTP 403): the organization may not allow members to create teams; ask your teacher for help: %w", err)
				}
			}
			return Membership{}, fmt.Errorf("POST %s: %w", createPath, err)
		}
		slug := created.Slug
		if slug == "" {
			slug = name // name == slug by construction
		}
		return Membership{Slug: slug, Counter: counter}, nil
	}
	return Membership{}, fmt.Errorf("could not create a team after %d attempts: every candidate name was taken; ask your teacher for help", counterCap)
}

// AttachRepo grants the group team push on <org>/<repo> — the authoritative
// repo<->team link. Idempotent PUT; a student team maintainer (or the repo's
// creator-admin) can issue it.
func AttachRepo(ctx context.Context, client githubapi.Client, org, slug, repo string) error {
	body, err := json.Marshal(map[string]any{"permission": contract.PermissionPush})
	if err != nil {
		return fmt.Errorf("encode team-repo body: %w", err)
	}
	path := fmt.Sprintf("orgs/%s/teams/%s/repos/%s/%s",
		url.PathEscape(org), url.PathEscape(slug), url.PathEscape(org), url.PathEscape(repo))
	resp, err := client.RequestWithContext(ctx, http.MethodPut, path, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("PUT %s (attach your team to the repository): %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

// AddMember adds username to the group team as a plain member. For a
// not-yet-org-member the membership stays pending until they accept the org
// invite. Idempotent.
func AddMember(ctx context.Context, client githubapi.Client, org, slug, username string) error {
	body, err := json.Marshal(map[string]any{"role": "member"})
	if err != nil {
		return fmt.Errorf("encode membership body: %w", err)
	}
	path := fmt.Sprintf("orgs/%s/teams/%s/memberships/%s",
		url.PathEscape(org), url.PathEscape(slug), url.PathEscape(username))
	resp, err := client.RequestWithContext(ctx, http.MethodPut, path, bytes.NewReader(body))
	if err != nil {
		var httpErr *githubapi.HTTPError
		if errors.As(err, &httpErr) && httpErr.StatusCode == http.StatusForbidden {
			return fmt.Errorf("GitHub refused the team change (HTTP 403): only the team's founder (its maintainer) can add members, and an organization that syncs teams from an identity provider blocks membership changes entirely; ask your teacher for help: %w", err)
		}
		return fmt.Errorf("PUT %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

// ListMembers returns the team's member logins, walking pagination. A 404
// (team gone) propagates — the callers all resolved the team a moment ago,
// so its absence is worth surfacing, not masking as empty.
func ListMembers(client githubapi.Client, org, slug string) ([]string, error) {
	type member struct {
		Login string `json:"login"`
	}
	members, err := githubapi.PaginateAll[member](
		client, myTeamsPerPage, myTeamsPagesMax,
		func(page int) string {
			return fmt.Sprintf("orgs/%s/teams/%s/members?per_page=%d&page=%d",
				url.PathEscape(org), url.PathEscape(slug), myTeamsPerPage, page)
		},
		func(path string, err error) error {
			return fmt.Errorf("GET %s: %w", path, err)
		},
	)
	if err != nil {
		return nil, err
	}
	logins := make([]string, 0, len(members))
	for _, m := range members {
		if m.Login != "" {
			logins = append(logins, m.Login)
		}
	}
	return logins, nil
}

// OwnerSegment is the username-position segment of a team repo's name for
// counter n (`group-<n>`), so callers can reuse the individual repo-name
// formula with the segment in the username slot.
func OwnerSegment(counter int) string {
	return fmt.Sprintf("%s%d", contract.GroupRepoSegment, counter)
}
