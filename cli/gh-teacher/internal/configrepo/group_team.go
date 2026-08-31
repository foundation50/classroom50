package configrepo

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/githubapi"
)

// GroupDescription is the classroom50/group/v1 record stored in a group
// team's DESCRIPTION (`classroom50-group-<hash>-<n>`, a `secret` team backing
// a mode: team assignment). The hash in the team name is one-way, so this
// record is what makes a group team attributable — and safely deletable —
// after the assignment entry (or the whole config repo) is gone, mirroring
// the invite-team record's role.
//
// Mirrors schemas/group-team-v1.schema.json and the web writer with no
// compile-time link; both writers must produce byte-identical output for the
// same inputs (Go's json.Marshal escaping is the parity target).
type GroupDescription struct {
	Schema     string `json:"schema"`
	Classroom  string `json:"classroom"`
	Assignment string `json:"assignment"`
	// The students' (or teacher's) display name; omitted when empty.
	Name string `json:"name,omitempty"`
}

// groupTeamCounterCap bounds the 422-losing counter retry: a create that
// keeps colliding past this many counters is a pathology (or an org with 50+
// groups racing one accept), not something to spin on.
const groupTeamCounterCap = 50

// MarshalGroupDescription encodes the classroom50/group/v1 record for a group
// team description. Always re-derived, never read-modify-written (unknown
// fields a newer writer added are tolerated on read, dropped on rewrite). The
// exact bytes matter: readers compare and the web writer mirrors Go's
// json.Marshal escaping, like MarshalInviteDescription.
func MarshalGroupDescription(classroom, assignment, name string) (string, error) {
	out, err := json.Marshal(GroupDescription{
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

// ParseGroupDescription reads a team description into the group record,
// reporting ok=false when it is absent, non-JSON, or not a valid v1 record.
// Never errors: a hand-edited description simply yields no record and the
// caller skips the team rather than failing a whole sweep/list.
//
// A student-formed team's maintainer can edit their OWN team's description,
// so this is a trust boundary — callers must additionally verify the record
// hashes back to the team slug (VerifyGroupDescription) before acting on it.
func ParseGroupDescription(description string) (GroupDescription, bool) {
	var record GroupDescription
	if strings.TrimSpace(description) == "" {
		return GroupDescription{}, false
	}
	if err := json.Unmarshal([]byte(description), &record); err != nil {
		return GroupDescription{}, false
	}
	if record.Schema != contract.GroupSchemaV1 || record.Classroom == "" || record.Assignment == "" {
		return GroupDescription{}, false
	}
	return record, true
}

// VerifyGroupDescription reports whether rec legitimately belongs to slug:
// the slug must match the FULL group-team shape and the record's
// classroom+assignment must hash back to the slug's hex segment. This is the
// check that keeps a maintainer-edited description from steering attribution
// (or a delete) at another assignment's team.
func VerifyGroupDescription(slug string, rec GroupDescription) bool {
	if !contract.IsGroupTeamSlug(slug) {
		return false
	}
	_, ok := contract.ParseGroupTeamCounter(slug, rec.Classroom, rec.Assignment)
	return ok
}

// GroupTeamInfo is one live group team as the teacher tooling sees it: the
// addressing slug/id, the counter recovered from the slug, the parsed AND
// verified description record, and the current member logins.
type GroupTeamInfo struct {
	ID      int64
	Slug    string
	Counter int
	Record  GroupDescription
	Members []string
}

// groupTeamPayload is the org-teams / team-GET shape the group paths decode.
type groupTeamPayload struct {
	ID          int64  `json:"id"`
	Slug        string `json:"slug"`
	Description string `json:"description"`
}

// listOrgGroupTeams enumerates the org's teams and keeps the ones matching
// the FULL group-team shape (optionally narrowed to one assignment's
// enumeration prefix). A read failure propagates so a caller can report it
// rather than silently acting on nothing.
func listOrgGroupTeams(client githubapi.Client, org, prefix string) ([]groupTeamPayload, error) {
	teams, err := githubapi.PaginateAll[groupTeamPayload](
		client, githubapi.ListPerPage, githubapi.ListMaxPages,
		func(page int) string {
			return fmt.Sprintf("orgs/%s/teams?per_page=%d&page=%d",
				url.PathEscape(org), githubapi.ListPerPage, page)
		},
		func(path string, err error) error {
			return fmt.Errorf("GET %s: %w", path, err)
		},
	)
	if err != nil {
		return nil, err
	}
	var out []groupTeamPayload
	for _, t := range teams {
		if !contract.IsGroupTeamSlug(t.Slug) {
			continue
		}
		if prefix != "" && !strings.HasPrefix(t.Slug, prefix) {
			continue
		}
		out = append(out, t)
	}
	return out, nil
}

// CreateGroupTeam creates the next free `classroom50-group-<hash>-<n>` SECRET
// team for (classroom, assignment), carrying the classroom50/group/v1 record
// in its description and notifications disabled (assignment-repo churn would
// spam the group). `maintainers` (optional logins) ride the create body so a
// teacher-formed team can seed its membership in one request.
//
// Counter allocation: the visible teams pick the lowest free n as a starting
// guess, then the create's 422 is the authority — a name collision means
// another founder won that counter (even one whose secret team this caller
// can't see), so retry with n+1, bounded by groupTeamCounterCap. NEVER a
// visibility probe: a secret team is invisible to non-members, so a listing
// can't prove a counter free.
func CreateGroupTeam(client githubapi.Client, org, classroom, assignment, displayName string, maintainers []string) (slug string, id int64, n int, err error) {
	description, err := MarshalGroupDescription(classroom, assignment, displayName)
	if err != nil {
		return "", 0, 0, err
	}

	prefix := contract.GroupTeamAssignmentPrefix(classroom, assignment)
	taken := map[int]bool{}
	existing, err := listOrgGroupTeams(client, org, prefix)
	if err != nil {
		return "", 0, 0, err
	}
	for _, t := range existing {
		if c, ok := contract.ParseGroupTeamCounter(t.Slug, classroom, assignment); ok {
			taken[c] = true
		}
	}
	next := func(from int) int {
		for c := from; ; c++ {
			if !taken[c] {
				return c
			}
		}
	}

	createPath := fmt.Sprintf("orgs/%s/teams", url.PathEscape(org))
	counter := next(1)
	for attempt := 0; attempt < groupTeamCounterCap; attempt++ {
		name := contract.GroupTeamName(classroom, assignment, counter)
		teamBody := map[string]any{
			"name":                 name,
			"privacy":              "secret",
			"notification_setting": notificationsDisabled,
			"description":          description,
		}
		if len(maintainers) > 0 {
			teamBody["maintainers"] = maintainers
		}
		body, err := json.Marshal(teamBody)
		if err != nil {
			return "", 0, 0, fmt.Errorf("encode group team body: %w", err)
		}
		var created groupTeamPayload
		if err := client.Post(createPath, bytes.NewReader(body), &created); err != nil {
			// 422 = the counter is taken (possibly by a team this caller can't
			// see); lose gracefully and try the next one.
			if cliutil.IsHTTPStatus(err, http.StatusUnprocessableEntity) {
				taken[counter] = true
				counter = next(counter + 1)
				continue
			}
			return "", 0, 0, fmt.Errorf("POST %s: %w", createPath, err)
		}
		if created.Slug == "" {
			// name == slug by construction; a response missing it would make
			// every later request address the wrong path.
			created.Slug = name
		}
		return created.Slug, created.ID, counter, nil
	}
	return "", 0, 0, fmt.Errorf("could not allocate a group team counter for %s/%s after %d attempts: every candidate name collided; check https://github.com/orgs/%s/teams for stray %s* teams",
		classroom, assignment, groupTeamCounterCap, org, prefix)
}

// idpSyncHint decorates a team-membership 403 with the one non-obvious cause:
// an org whose teams are synced from an identity provider rejects direct
// membership writes with 403, which otherwise reads as a token problem.
func idpSyncHint(action, slug, org string, err error) error {
	if cliutil.IsHTTPStatus(err, http.StatusForbidden) {
		return fmt.Errorf("%s on team %q at %s was refused (HTTP 403): if this organization syncs team membership from an identity provider, GitHub blocks direct membership changes; manage the group through the identity provider instead: %w",
			action, slug, org, err)
	}
	return err
}

// AddGroupTeamMember adds username to the group team addressed by slug as a
// plain member. Idempotent; for a not-yet-org-member it stays pending until
// they accept the org invite.
func AddGroupTeamMember(client githubapi.Client, org, slug, username string) error {
	body, err := json.Marshal(map[string]any{"role": string(TeamMember)})
	if err != nil {
		return fmt.Errorf("encode membership body: %w", err)
	}
	path := fmt.Sprintf("orgs/%s/teams/%s/memberships/%s",
		url.PathEscape(org), url.PathEscape(slug), url.PathEscape(username))
	resp, err := client.Request(http.MethodPut, path, bytes.NewReader(body))
	if err != nil {
		return idpSyncHint("adding "+username, slug, org, fmt.Errorf("PUT %s: %w", path, err))
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

// RemoveGroupTeamMember removes username from the group team addressed by
// slug. A 404 (not a member, or team gone) is success, so removals are
// idempotent.
func RemoveGroupTeamMember(client githubapi.Client, org, slug, username string) error {
	path := fmt.Sprintf("orgs/%s/teams/%s/memberships/%s",
		url.PathEscape(org), url.PathEscape(slug), url.PathEscape(username))
	resp, err := client.Request(http.MethodDelete, path, nil)
	if err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return nil
		}
		return idpSyncHint("removing "+username, slug, org, fmt.Errorf("DELETE %s: %w", path, err))
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

// AttachRepoToGroupTeam grants the group team push on <org>/<repo> — the
// AUTHORITATIVE repo<->team link for a team-mode assignment (the
// `<classroom>-<assignment>-group-<n>` repo name is display/search
// convention, not the binding). Idempotent PUT.
func AttachRepoToGroupTeam(client githubapi.Client, org, slug, repo string) error {
	return putTeamRepoPermission(client, org, slug, org, repo, contract.PermissionPush)
}

// ListAssignmentGroupTeams enumerates one assignment's live group teams: org
// teams filtered to the assignment's enumeration prefix + full slug shape,
// each carrying its parsed AND verified description record plus the current
// member logins. A team whose record is missing or fails verification is
// skipped — it is not attributable to this assignment, so acting on it would
// trust a hand-edited description. Sorted by counter.
func ListAssignmentGroupTeams(client githubapi.Client, org, classroom, assignment string) ([]GroupTeamInfo, error) {
	prefix := contract.GroupTeamAssignmentPrefix(classroom, assignment)
	teams, err := listOrgGroupTeams(client, org, prefix)
	if err != nil {
		return nil, err
	}
	var out []GroupTeamInfo
	for _, t := range teams {
		counter, ok := contract.ParseGroupTeamCounter(t.Slug, classroom, assignment)
		if !ok {
			continue
		}
		record, ok := ParseGroupDescription(t.Description)
		if !ok || !VerifyGroupDescription(t.Slug, record) {
			continue
		}
		members, err := ListTeamMembers(client, org, t.Slug)
		if err != nil {
			return nil, err
		}
		out = append(out, GroupTeamInfo{
			ID:      t.ID,
			Slug:    t.Slug,
			Counter: counter,
			Record:  record,
			Members: members,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Counter < out[j].Counter })
	return out, nil
}

// DeleteGroupTeam removes one group team, fail-closed on every axis a
// destructive op needs (mirroring DeleteClassroomTeam's id verify and the
// invite sweep's shape fence):
//
//   - the slug must match the FULL group-team shape (the prefix alone is a
//     namespace a pathological classroom short-name could land in);
//   - recordedID must be positive and equal the LIVE team's id (a reused slug
//     is never clobbered blind — the TeamIdMismatch semantics);
//   - the live team must carry a parsed AND verified classroom50/group/v1
//     record, so only a team this feature owns is ever deleted.
//
// A 404 anywhere = already gone = success, so deletes are idempotent.
func DeleteGroupTeam(client githubapi.Client, org, slug string, recordedID int64) error {
	if slug == "" {
		return nil
	}
	if !contract.IsGroupTeamSlug(slug) {
		return fmt.Errorf("refusing to delete team %q at %s: not a %s<hash>-<n> group team; remove it by hand if intended", slug, org, contract.GroupTeamPrefix)
	}
	if recordedID <= 0 {
		return fmt.Errorf("refusing to delete team %q at %s: no recorded id to verify it against; remove it by hand if intended", slug, org)
	}
	getPath := fmt.Sprintf("orgs/%s/teams/%s", url.PathEscape(org), url.PathEscape(slug))
	var live groupTeamPayload
	if err := client.Get(getPath, &live); err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return nil // already gone
		}
		return fmt.Errorf("GET %s (verify group team before delete): %w", getPath, err)
	}
	if live.ID != recordedID {
		return fmt.Errorf("team %q at %s now has id %d, not the recorded %d: refusing to delete a team that isn't the one recorded; remove it by hand if intended",
			slug, org, live.ID, recordedID)
	}
	record, ok := ParseGroupDescription(live.Description)
	if !ok || !VerifyGroupDescription(slug, record) {
		return fmt.Errorf("refusing to delete team %q at %s: its description is not a verifiable classroom50/group/v1 record for this slug; remove it by hand if intended", slug, org)
	}
	path := fmt.Sprintf("orgs/%s/teams/%s", url.PathEscape(org), url.PathEscape(slug))
	resp, err := client.Request(http.MethodDelete, path, nil)
	if err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return nil
		}
		return fmt.Errorf("DELETE %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

// SweepClassroomGroupTeams deletes every group team attributable to
// `classroom` — for teardown, where assignments.json is about to be (or was)
// deleted: the description record, not any config read, is what scopes the
// sweep. Enumerates the org's `classroom50-group-` namespace, requires the
// full slug shape plus a parsed AND verified record whose classroom matches,
// and id-guards each delete against the live team just read.
//
// Per-team failures are collected (best-effort, like the invite sweep) so one
// stuck team can't strand the rest; a list failure propagates instead so the
// caller can report that nothing was swept.
func SweepClassroomGroupTeams(client githubapi.Client, org, classroom string) (deleted []string, failures []error, err error) {
	teams, err := listOrgGroupTeams(client, org, "")
	if err != nil {
		return nil, nil, err
	}
	for _, t := range teams {
		record, ok := ParseGroupDescription(t.Description)
		if !ok || !VerifyGroupDescription(t.Slug, record) || record.Classroom != classroom {
			continue
		}
		if err := DeleteGroupTeam(client, org, t.Slug, t.ID); err != nil {
			failures = append(failures, fmt.Errorf("%s: %w", t.Slug, err))
			continue
		}
		deleted = append(deleted, t.Slug)
	}
	return deleted, failures, nil
}
