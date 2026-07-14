package configrepo

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/githubapi"
)

// classroomTeamName derives the GitHub team name for a classroom:
// `classroom50-<short>`. The short-name is already validated (lowercase alnum +
// hyphens), so the result is a valid team name whose slug equals it.
// Single-sourced so creation/membership/grant paths can't drift.
func classroomTeamName(shortName string) string {
	return "classroom50-" + shortName
}

// classroomTeamSlug is the URL slug GitHub assigns the team. Since
// classroomTeamName is already lowercase-with-hyphens, the slug equals the
// name; deriving it directly avoids reading the team back.
func classroomTeamSlug(shortName string) string {
	return classroomTeamName(shortName)
}

// TeamRef is the minimal team identity the CLI persists and reuses. The slug is
// the authoritative addressing key (GitHub may assign a slug differing from the
// name on a collision, so callers MUST use the persisted slug, not re-derive
// it). The id is the immutable handle used for delete verification.
type TeamRef struct {
	ID   int64  `json:"id"`
	Slug string `json:"slug"`
}

// StaffRole is a per-classroom staff role backing the web GUI's in-app
// roles. Each maps to a `secret` GitHub team named
// `classroom50-<short>-<role>` granted write on the config repo.
type StaffRole string

const (
	RoleInstructor StaffRole = "instructor"
	RoleTA         StaffRole = "ta"
)

// StaffRoles is every staff role, in a stable order (instructor first).
var StaffRoles = []StaffRole{RoleInstructor, RoleTA}

// StaffTeamRepoPermissions maps a staff role to the repo permission
// collect-scores grants that role's team on each student assignment repo and on
// private in-org templates. Source of truth for the collector's hand-mirrored
// STAFF_TEAM_PERMISSIONS (collect_scores.py) — keep the two in lockstep.
//
// A role absent from this map is granted nothing (the instructor team already
// gets its access at classroom setup, so only the TA team needs a collect-time
// grant today). Adding a future head-TA write team is a one-line addition here
// and in the mirror.
var StaffTeamRepoPermissions = map[StaffRole]string{
	RoleTA: "pull",
}

// staffTeamName derives the staff-role team name: `classroom50-<short>-<role>`.
// Mirrors the web's classroomTeamSlug(short, role). The short-name is canonical, so slug == name.
func staffTeamName(shortName string, role StaffRole) string {
	return "classroom50-" + shortName + "-" + string(role)
}

// StaffTeamsRef holds the per-classroom staff team refs the web GUI persists
// under classroom.json `teams`. Mirrors classroom-v1's `teams` $def.
type StaffTeamsRef struct {
	Instructor *TeamRef `json:"instructor,omitempty"`
	TA         *TeamRef `json:"ta,omitempty"`
}

// ResolveClassroomTeam reads the persisted team ref from the classroom's
// classroom.json at `ref` — the authoritative slug + id (never re-derive the
// slug). A classroom with no `team` block yields ok=false so callers can shape
// an actionable "run classroom add" message rather than 404ing on a guess.
func ResolveClassroomTeam(client githubapi.Client, org, shortName, ref string) (TeamRef, bool, error) {
	c, ok, err := LoadClassroom(client, org, shortName, ref)
	if err != nil {
		return TeamRef{}, false, err
	}
	if !ok || c.Team == nil || c.Team.Slug == "" {
		return TeamRef{}, false, nil
	}
	return *c.Team, true, nil
}

// ResolveClassroomStaffTeam reads the persisted staff-team ref for `role` from
// classroom.json at `ref`. Like ResolveClassroomTeam, the persisted slug is
// authoritative. No `teams` block yields ok=false so callers can shape an
// actionable "run classroom add" message.
func ResolveClassroomStaffTeam(client githubapi.Client, org, shortName, ref string, role StaffRole) (TeamRef, bool, error) {
	c, ok, err := LoadClassroom(client, org, shortName, ref)
	if err != nil {
		return TeamRef{}, false, err
	}
	if !ok || c.Teams == nil {
		return TeamRef{}, false, nil
	}
	var team *TeamRef
	switch role {
	case RoleInstructor:
		team = c.Teams.Instructor
	case RoleTA:
		team = c.Teams.TA
	}
	if team == nil || team.Slug == "" {
		return TeamRef{}, false, nil
	}
	return *team, true, nil
}

// CanonicalTeamSlugShortName reports whether shortName yields a team whose
// GitHub-assigned slug equals the name verbatim. GitHub slugifies by collapsing
// hyphen runs and trimming trailing hyphens, so a short-name with
// consecutive/trailing hyphens (both allowed by ShortNamePattern) would yield
// slug != name and every path re-deriving the slug would 404. Requiring a
// canonical short-name keeps the derived slug authoritative without an extra
// round-trip.
func CanonicalTeamSlugShortName(shortName string) bool {
	if strings.HasSuffix(shortName, "-") || strings.Contains(shortName, "--") {
		return false
	}
	return true
}

// EnsureClassroomTeam creates the per-classroom `secret` GitHub team
// (least-privilege: visible only to members and org owners), adopting an
// existing team of the same name rather than failing. This team grants
// rostered students read on private org-owned templates so `student accept`
// can generate their repo.
//
// `members_can_create_teams: false` (init's lockdown) doesn't block this — the
// teacher authenticates as an org owner.
func EnsureClassroomTeam(client githubapi.Client, org, shortName string) (TeamRef, error) {
	// Guard the slug==name invariant (see CanonicalTeamSlugShortName):
	// ShortNamePattern alone permits hyphens GitHub would slugify away.
	if !CanonicalTeamSlugShortName(shortName) {
		return TeamRef{}, fmt.Errorf("classroom short-name %q can't back a GitHub team — remove consecutive or trailing hyphens (GitHub would rewrite the team slug, breaking membership and template grants)", shortName)
	}
	return ensureSecretTeamByName(client, org, classroomTeamName(shortName))
}

// EnsureClassroomStaffTeam creates (or adopts) the per-classroom STAFF team for
// `role` — a `secret` team `classroom50-<short>-<role>`. Mirrors the web's
// ensureClassroomRoleTeam. Idempotent; safe as a preflight before any staff op.
func EnsureClassroomStaffTeam(client githubapi.Client, org, shortName string, role StaffRole) (TeamRef, error) {
	if !CanonicalTeamSlugShortName(shortName) {
		return TeamRef{}, fmt.Errorf("classroom short-name %q can't back a GitHub team — remove consecutive or trailing hyphens (GitHub would rewrite the team slug, breaking staff membership and config-repo grants)", shortName)
	}
	return ensureSecretTeamByName(client, org, staffTeamName(shortName, role))
}

// EnsureStaffTeams creates (or adopts) both staff teams (instructor, ta) and
// grants each `push` on the org's `classroom50` config repo so staff can author
// assignments. Returns the refs to record under classroom.json `teams`.
// Mirrors the web's ensureStaffTeams.
func EnsureStaffTeams(client githubapi.Client, org, shortName string) (*StaffTeamsRef, error) {
	refs := &StaffTeamsRef{}
	for _, role := range StaffRoles {
		team, err := EnsureClassroomStaffTeam(client, org, shortName, role)
		if err != nil {
			return nil, fmt.Errorf("ensure %s staff team: %w", role, err)
		}
		if _, err := GrantTeamRepoWrite(client, org, team.Slug, org, ConfigRepoName); err != nil {
			return nil, fmt.Errorf("grant %s staff team write on %s: %w", role, ConfigRepoName, err)
		}
		switch role {
		case RoleInstructor:
			refs.Instructor = &team
		case RoleTA:
			refs.TA = &team
		}
	}
	return refs, nil
}

// ensureSecretTeamByName creates a `secret` GitHub team named `name`,
// adopting an existing team of the same name rather than failing. `name` is a
// canonical short-name-derived value, so its slug equals the name.
//
// `members_can_create_teams: false` (init's lockdown) doesn't block this — the
// teacher authenticates as an org owner.
func ensureSecretTeamByName(client githubapi.Client, org, name string) (TeamRef, error) {
	body, err := json.Marshal(map[string]any{
		"name":    name,
		"privacy": "secret",
	})
	if err != nil {
		return TeamRef{}, fmt.Errorf("encode team body: %w", err)
	}
	createPath := fmt.Sprintf("orgs/%s/teams", url.PathEscape(org))
	var created TeamRef
	if err := client.Post(createPath, bytes.NewReader(body), &created); err != nil {
		// 422 = a team with this name already exists. Adopt it in place
		// (read id/slug, ensure privacy `secret`) so a re-run reconciles. If
		// the adopt read 404s, the 422 wasn't a name collision — surface the
		// original create error.
		if cliutil.IsHTTPStatus(err, http.StatusUnprocessableEntity) {
			adopted, adoptErr := adoptSecretTeamByName(client, org, name)
			if adoptErr != nil {
				if cliutil.IsHTTPStatus(adoptErr, http.StatusNotFound) {
					return TeamRef{}, fmt.Errorf("POST %s: %w", createPath, err)
				}
				return TeamRef{}, adoptErr
			}
			return adopted, nil
		}
		return TeamRef{}, fmt.Errorf("POST %s: %w", createPath, err)
	}
	return created, nil
}

// adoptSecretTeamByName reads an existing team by slug (== name, given the
// canonical short-name guard) and reconciles its privacy to `secret` (an older
// or hand-created team might be `closed`). Used on the 422 already-exists path.
func adoptSecretTeamByName(client githubapi.Client, org, name string) (TeamRef, error) {
	slug := name
	getPath := fmt.Sprintf("orgs/%s/teams/%s", url.PathEscape(org), url.PathEscape(slug))
	var existing struct {
		ID      int64  `json:"id"`
		Slug    string `json:"slug"`
		Privacy string `json:"privacy"`
	}
	if err := client.Get(getPath, &existing); err != nil {
		return TeamRef{}, fmt.Errorf("GET %s (adopting existing team): %w", getPath, err)
	}
	if existing.Privacy != "secret" {
		body, err := json.Marshal(map[string]any{"privacy": "secret"})
		if err != nil {
			return TeamRef{}, fmt.Errorf("encode team patch: %w", err)
		}
		patchPath := fmt.Sprintf("orgs/%s/teams/%s", url.PathEscape(org), url.PathEscape(existing.Slug))
		resp, err := client.Request(http.MethodPatch, patchPath, bytes.NewReader(body))
		if err != nil {
			return TeamRef{}, fmt.Errorf("PATCH %s (set privacy secret): %w", patchPath, err)
		}
		defer func() { _ = resp.Body.Close() }()
		_, _ = io.Copy(io.Discard, resp.Body)
	}
	return TeamRef{ID: existing.ID, Slug: existing.Slug}, nil
}

// IsDeletableClassroomTeamRef reports whether a persisted team ref is safe to
// delete: it must be `classroom50-`-namespaced AND carry a positive id. Mirrors
// the web's isDeletableClassroomTeamRef 1:1 — the fail-closed guard that keeps
// a malformed/hand-edited classroom.json from steering a destructive DELETE at
// an unrelated team. A ref failing this predicate is never deleted.
func IsDeletableClassroomTeamRef(team TeamRef) bool {
	return strings.HasPrefix(team.Slug, "classroom50-") && team.ID > 0
}

// DeleteClassroomTeam removes the classroom team by its persisted ref. Deletes
// via the SLUG — GitHub's DELETE endpoint is slug-addressed (a numeric value in
// the slug position 404s). The persisted slug is authoritative; as
// defense-in-depth, the live team's id is confirmed to match the persisted id
// before deletion. A 404 (already gone) is success, so `classroom remove` is
// idempotent.
//
// A ref failing IsDeletableClassroomTeamRef is a no-op: an empty slug or
// zero/absent id can't be verified against a live team, so the CLI refuses to
// delete blind (matching the web's fail-closed guard).
func DeleteClassroomTeam(client githubapi.Client, org string, team TeamRef) error {
	if team.Slug == "" {
		return nil
	}
	// Namespace guard: only ever delete a `classroom50-`-prefixed team.
	if !strings.HasPrefix(team.Slug, "classroom50-") {
		return fmt.Errorf("refusing to delete team %q at %s — not a classroom50-namespaced team; remove it by hand if intended", team.Slug, org)
	}
	// Fail closed on a non-positive id: without a recorded id we can't confirm
	// the live team at this slug is the one this classroom created. (The
	// load-bearing half of the web's guard an earlier port dropped.)
	if team.ID <= 0 {
		return fmt.Errorf("refusing to delete team %q at %s — no recorded id to verify it against; remove it by hand if intended", team.Slug, org)
	}
	// Defense-in-depth: confirm the team at this slug is the one we recorded
	// (same id) before deleting.
	getPath := fmt.Sprintf("orgs/%s/teams/%s", url.PathEscape(org), url.PathEscape(team.Slug))
	var live struct {
		ID int64 `json:"id"`
	}
	if err := client.Get(getPath, &live); err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return nil // already gone
		}
		return fmt.Errorf("GET %s (verify team before delete): %w", getPath, err)
	}
	if live.ID != team.ID {
		return fmt.Errorf("team %q at %s now has id %d, not the recorded %d — refusing to delete a team that isn't the one this classroom created; remove it by hand if intended",
			team.Slug, org, live.ID, team.ID)
	}
	path := fmt.Sprintf("orgs/%s/teams/%s", url.PathEscape(org), url.PathEscape(team.Slug))
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

// TeamMemberRole is a GitHub team-membership role — distinct from the
// per-classroom StaffRole. A typed constant keeps the compiler honest at call
// sites instead of surfacing a typo'd literal as a runtime 422.
type TeamMemberRole string

const (
	TeamMember     TeamMemberRole = "member"
	TeamMaintainer TeamMemberRole = "maintainer"
)

// AddTeamMembership adds (or updates) a user's membership in the team addressed
// by `slug`. For an existing org member it's active immediately; for a
// not-yet-member it stays pending until they accept the org invite. Idempotent.
func AddTeamMembership(client githubapi.Client, org, slug, username string) error {
	return AddTeamMembershipWithRole(client, org, slug, username, TeamMember)
}

// AddTeamMembershipWithRole is AddTeamMembership with an explicit team role.
// Staff-team creation adds the acting teacher as a `TeamMaintainer` (mirroring
// the web); roster/students always join as `TeamMember`.
func AddTeamMembershipWithRole(client githubapi.Client, org, slug, username string, role TeamMemberRole) error {
	body, err := json.Marshal(map[string]any{"role": string(role)})
	if err != nil {
		return fmt.Errorf("encode membership body: %w", err)
	}
	path := fmt.Sprintf("orgs/%s/teams/%s/memberships/%s",
		url.PathEscape(org), url.PathEscape(slug), url.PathEscape(username))
	resp, err := client.Request(http.MethodPut, path, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("PUT %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

// RemoveTeamMembership removes a user from the team addressed by `slug`. A 404
// (not a member, or team gone) is success so `roster remove` is idempotent.
// Does not affect org membership.
func RemoveTeamMembership(client githubapi.Client, org, slug, username string) error {
	path := fmt.Sprintf("orgs/%s/teams/%s/memberships/%s",
		url.PathEscape(org), url.PathEscape(slug), url.PathEscape(username))
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

// teamHasRepoAccess reports whether the team addressed by `slug` already has
// any access to <org>/<repo> (204 = yes, 404 = no). Keeps GrantTeamRepoRead
// idempotent.
func teamHasRepoAccess(client githubapi.Client, org, slug, repoOwner, repo string) (bool, error) {
	path := fmt.Sprintf("orgs/%s/teams/%s/repos/%s/%s",
		url.PathEscape(org), url.PathEscape(slug), url.PathEscape(repoOwner), url.PathEscape(repo))
	resp, err := client.Request(http.MethodGet, path, nil)
	if err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return false, nil
		}
		return false, fmt.Errorf("GET %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	return true, nil
}

// GrantTeamRepoRead grants the team `pull` on <repoOwner>/<repo> — the access a
// base-permission-`none` student needs to generate from a private org-owned
// template. Idempotent; returns whether a new grant was applied.
func GrantTeamRepoRead(client githubapi.Client, org, slug, repoOwner, repo string) (granted bool, err error) {
	return grantTeamRepo(client, org, slug, repoOwner, repo, "pull")
}

// GrantTeamRepoWrite grants the team `push` on <repoOwner>/<repo> — the access
// a staff team needs on the config repo to author assignments. Idempotent;
// returns whether a new grant was applied. Mirrors the web's
// grantTeamConfigRepoWrite.
func GrantTeamRepoWrite(client githubapi.Client, org, slug, repoOwner, repo string) (granted bool, err error) {
	return grantTeamRepo(client, org, slug, repoOwner, repo, "push")
}

// grantTeamRepo PUTs a team's repo permission, skipping the write when the team
// already has any access (keeps the grant idempotent). The existing-access
// check is permission-agnostic, acceptable for the create-time grant this
// backs.
func grantTeamRepo(client githubapi.Client, org, slug, repoOwner, repo, permission string) (granted bool, err error) {
	has, err := teamHasRepoAccess(client, org, slug, repoOwner, repo)
	if err != nil {
		return false, err
	}
	if has {
		return false, nil
	}
	body, err := json.Marshal(map[string]any{"permission": permission})
	if err != nil {
		return false, fmt.Errorf("encode grant body: %w", err)
	}
	path := fmt.Sprintf("orgs/%s/teams/%s/repos/%s/%s",
		url.PathEscape(org), url.PathEscape(slug), url.PathEscape(repoOwner), url.PathEscape(repo))
	resp, err := client.Request(http.MethodPut, path, bytes.NewReader(body))
	if err != nil {
		return false, fmt.Errorf("PUT %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	return true, nil
}

// ResolveClassroomTeamSlug returns the classroom team's addressing slug: the
// persisted classroom.json `team.slug` when present (authoritative — GitHub may
// re-slug on a collision), else the derived `classroom50-<short>`. Mirrors the
// web's resolveClassroomTeam and the Python collector's resolve_team_slug. A
// transient read failure propagates; only a genuinely absent team block falls
// back to derivation.
func ResolveClassroomTeamSlug(client githubapi.Client, org, shortName, ref string) (string, error) {
	team, ok, err := ResolveClassroomTeam(client, org, shortName, ref)
	if err != nil {
		return "", err
	}
	if ok {
		return team.Slug, nil
	}
	return classroomTeamSlug(shortName), nil
}

// teamMember is the minimal shape decoded from GET .../teams/{slug}/members.
type teamMember struct {
	Login string `json:"login"`
	ID    int64  `json:"id"`
}

// ListTeamMembers returns the logins of every member of the classroom team
// addressed by `slug`, walking pagination. The classroom GitHub team is
// authoritative for enrollment (roster.csv is optional display metadata). A
// 404 (team doesn't exist yet) returns an empty slice rather than erroring.
func ListTeamMembers(client githubapi.Client, org, slug string) ([]string, error) {
	const perPage, maxPages = 100, 100
	members, err := githubapi.PaginateAll[teamMember](
		client, perPage, maxPages,
		func(page int) string {
			return fmt.Sprintf("orgs/%s/teams/%s/members?per_page=%d&page=%d",
				url.PathEscape(org), url.PathEscape(slug), perPage, page)
		},
		func(path string, err error) error {
			if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
				return nil // 404 sentinel: caller handles the empty result
			}
			return fmt.Errorf("GET %s: %w", path, err)
		},
	)
	if err != nil {
		return nil, err
	}
	logins := make([]string, 0, len(members))
	for _, m := range members {
		if strings.TrimSpace(m.Login) != "" {
			logins = append(logins, m.Login)
		}
	}
	return logins, nil
}
