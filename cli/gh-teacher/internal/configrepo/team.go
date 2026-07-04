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

// classroomTeamName derives the GitHub team name for a classroom from
// its short-name: `classroom50-<short>`. The short-name is already
// validated against validate.ShortNamePattern (lowercase alnum + hyphens), so
// the result is a valid team name and its slug is the same string.
// Single-sourced here so creation, membership, and grant paths can't
// drift on the naming scheme.
func classroomTeamName(shortName string) string {
	return "classroom50-" + shortName
}

// classroomTeamSlug is the URL slug GitHub assigns the team. Because
// classroomTeamName is already lowercase with hyphens (matching
// GitHub's slugification), the slug equals the name; computing it
// directly avoids a round-trip to read the team back.
func classroomTeamSlug(shortName string) string {
	return classroomTeamName(shortName)
}

// TeamRef is the minimal team identity the CLI persists and reuses.
// The slug is the authoritative addressing key for all team
// operations (GitHub may assign a slug that differs from the name on a
// collision — e.g. `classroom50-cs-1` — so callers MUST use the
// persisted slug rather than re-deriving `classroom50-<short>`). The
// id is the immutable handle used for the delete so a re-slugged or
// renamed team can't be confused with an unrelated one.
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

// staffTeamName derives the GitHub team name for a classroom staff role:
// `classroom50-<short>-<role>`. Mirrors the web's staffTeamName
// (web/src/hooks/github/mutations.ts). As with classroomTeamName the
// short-name is canonical, so the slug equals the name.
func staffTeamName(shortName string, role StaffRole) string {
	return "classroom50-" + shortName + "-" + string(role)
}

// StaffTeamsRef holds the per-classroom staff team refs the web GUI persists
// under classroom.json `teams`. Mirrors classroom-v1's `teams` $def.
type StaffTeamsRef struct {
	Instructor *TeamRef `json:"instructor,omitempty"`
	TA         *TeamRef `json:"ta,omitempty"`
}

// ResolveClassroomTeam reads the persisted team ref from the
// classroom's classroom.json at `ref`. This is the authoritative slug
// + id for every team operation — never re-derive the slug from the
// short-name (GitHub may have assigned a different slug on a name
// collision). A classroom with no `team` block (created before this
// feature, or hand-authored) yields ok=false so callers can shape an
// actionable "run classroom add" message rather than blindly hitting a
// 404 against a guessed slug.
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

// ResolveClassroomStaffTeam reads the persisted staff-team ref for
// `role` from the classroom's classroom.json at `ref`. Like
// ResolveClassroomTeam, the persisted slug is authoritative — never
// re-derive it. A classroom with no `teams` block (created before the
// staff-teams feature, or by an older CLI) yields ok=false so callers
// can shape an actionable "run classroom add" message.
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

// CanonicalTeamSlugShortName reports whether shortName produces a team
// name whose GitHub-assigned slug equals the name verbatim. GitHub
// slugifies team names by collapsing hyphen runs and trimming trailing
// hyphens, so a short-name with consecutive or trailing hyphens (both
// allowed by validate.ShortNamePattern) would yield slug != name — and every
// team path that re-derives the slug via classroomTeamSlug would then
// 404. Requiring a canonical short-name keeps the locally-derived slug
// authoritative without an extra API round-trip on every membership /
// grant / delete call.
func CanonicalTeamSlugShortName(shortName string) bool {
	if strings.HasSuffix(shortName, "-") || strings.Contains(shortName, "--") {
		return false
	}
	return true
}

// EnsureClassroomTeam creates the per-classroom GitHub team (privacy
// `secret`, least-privilege: visible only to its members and org
// owners), reconciling-and-adopting an existing team of the same name
// rather than failing — matching the idempotent re-run style of the
// rest of the CLI. The team is what grants rostered students read on
// private, org-owned assignment templates so `gh student accept` can
// generate their repo.
//
// `members_can_create_teams: false` (set by init's lockdown) does not
// block this — the teacher authenticates as an org owner.
func EnsureClassroomTeam(client githubapi.Client, org, shortName string) (TeamRef, error) {
	// Guard the slug==name invariant the team paths rely on (see
	// CanonicalTeamSlugShortName). validate.ShortNamePattern alone permits
	// consecutive/trailing hyphens, which GitHub would slugify away.
	if !CanonicalTeamSlugShortName(shortName) {
		return TeamRef{}, fmt.Errorf("classroom short-name %q can't back a GitHub team — remove consecutive or trailing hyphens (GitHub would rewrite the team slug, breaking membership and template grants)", shortName)
	}
	return ensureSecretTeamByName(client, org, classroomTeamName(shortName))
}

// EnsureClassroomStaffTeam creates (or adopts) the per-classroom STAFF
// team for `role` — a `secret` team named `classroom50-<short>-<role>`.
// It mirrors the web GUI's ensureClassroomRoleTeam so a classroom
// created/managed via the CLI carries the same staff teams the web
// expects. Idempotent; safe as a preflight before any staff op.
func EnsureClassroomStaffTeam(client githubapi.Client, org, shortName string, role StaffRole) (TeamRef, error) {
	if !CanonicalTeamSlugShortName(shortName) {
		return TeamRef{}, fmt.Errorf("classroom short-name %q can't back a GitHub team — remove consecutive or trailing hyphens (GitHub would rewrite the team slug, breaking staff membership and config-repo grants)", shortName)
	}
	return ensureSecretTeamByName(client, org, staffTeamName(shortName, role))
}

// EnsureStaffTeams creates (or adopts) both staff teams (instructor, ta)
// for a classroom and grants each `push` on the org's `classroom50`
// config repo, so staff can author assignments. Returns the persisted
// refs to record under classroom.json `teams`. Mirrors the web's
// ensureStaffTeams.
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

// ensureSecretTeamByName creates a `secret` GitHub team named `name`
// (least-privilege: visible only to its members and org owners),
// reconciling-and-adopting an existing team of the same name rather than
// failing — matching the idempotent re-run style of the rest of the CLI.
// The name is a canonical short-name-derived value, so its slug equals
// the name.
//
// `members_can_create_teams: false` (set by init's lockdown) does not
// block this — the teacher authenticates as an org owner.
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
		// 422 = a team with this name already exists. Adopt it in
		// place (read its id/slug, ensure privacy `secret`) rather
		// than failing, so a re-run reconciles cleanly. If the adopt
		// read 404s, the 422 was NOT a name collision — surface the
		// original create error, which reflects the real cause.
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

// adoptSecretTeamByName reads an existing team by its slug (== name,
// given the canonical short-name guard) and reconciles its privacy to
// `secret` (an older or hand-created team might be `closed`). Used by
// ensureSecretTeamByName on the 422 already-exists path.
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

// IsDeletableClassroomTeamRef reports whether a persisted team ref is
// safe to delete: it must be `classroom50-`-namespaced AND carry a
// positive id. This mirrors the web's isDeletableClassroomTeamRef
// (web/src/hooks/github/mutations.ts) 1:1 — the shared fail-closed guard
// that keeps a malformed or hand-edited classroom.json (now writable by
// any staff team granted config-repo push) from steering a destructive
// DELETE at an unrelated team. A ref that fails this predicate is never
// verified-and-deleted; callers skip it.
func IsDeletableClassroomTeamRef(team TeamRef) bool {
	return strings.HasPrefix(team.Slug, "classroom50-") && team.ID > 0
}

// DeleteClassroomTeam removes the classroom team identified by the
// persisted ref. It deletes via the team SLUG — GitHub's
// `DELETE /orgs/{org}/teams/{team_slug}` endpoint is slug-addressed;
// the numeric id only works on the separate
// `/organizations/{org_id}/team/{team_id}` path, so a numeric value in
// the slug position is treated as a (non-existent) slug and 404s. The
// persisted slug is authoritative (captured from the create response),
// so it addresses exactly this classroom's team and never a re-derived
// guess. As defense-in-depth against a slug later reused by an
// unrelated team, the live team's id is confirmed to match the
// persisted id before deletion. A 404 (already gone) is treated as
// success so `classroom remove` is idempotent.
//
// A ref that fails IsDeletableClassroomTeamRef is a no-op: an empty slug
// or a zero/absent id (a classroom created before the id was persisted,
// or a hand-edited ref) can't be verified against a live team, so the
// CLI refuses to delete blind — matching the web's fail-closed guard.
// The `id != 0` verification path below therefore never runs against an
// id it can't confirm.
func DeleteClassroomTeam(client githubapi.Client, org string, team TeamRef) error {
	if team.Slug == "" {
		return nil
	}
	// Namespace guard (mirrors the web's isDeletableClassroomTeamRef):
	// only ever delete a `classroom50-`-prefixed team, so a malformed or
	// hand-edited classroom.json can't point the delete at an unrelated
	// org team.
	if !strings.HasPrefix(team.Slug, "classroom50-") {
		return fmt.Errorf("refusing to delete team %q at %s — not a classroom50-namespaced team; remove it by hand if intended", team.Slug, org)
	}
	// Fail closed on a non-positive id: without a recorded id we can't
	// confirm the live team at this slug is the one this classroom
	// created, so we must not DELETE it. This is the load-bearing half of
	// the web's guard the earlier port dropped — a hand-edited ref of
	// `{"id": 0, "slug": "classroom50-<other>-instructor"}` would
	// otherwise be deleted blind on the prefix alone.
	if team.ID <= 0 {
		return fmt.Errorf("refusing to delete team %q at %s — no recorded id to verify it against; remove it by hand if intended", team.Slug, org)
	}
	// Defense-in-depth: confirm the team currently at this slug is the
	// one we recorded (same id) before deleting, so we never remove an
	// unrelated team that happens to occupy the slug now.
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
// per-classroom StaffRole (instructor|ta). Only these two values are
// valid; a typed constant keeps the compiler honest at the call sites
// instead of surfacing a typo'd literal as a 422 at runtime.
type TeamMemberRole string

const (
	TeamMember     TeamMemberRole = "member"
	TeamMaintainer TeamMemberRole = "maintainer"
)

// AddTeamMembership adds (or updates) a user's membership in the team
// addressed by `slug` (the authoritative persisted slug) via
// PUT .../teams/{slug}/memberships/{username}. For an existing org
// member the membership is active immediately; for a not-yet-member it
// goes pending until they accept the org invite. Idempotent — re-adding
// a member is a clean no-op.
func AddTeamMembership(client githubapi.Client, org, slug, username string) error {
	return AddTeamMembershipWithRole(client, org, slug, username, TeamMember)
}

// AddTeamMembershipWithRole is AddTeamMembership with an explicit team
// role. Staff-team creation adds the acting teacher as an instructor
// `TeamMaintainer` (mirroring the web), while roster/students always
// join as `TeamMember`.
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

// RemoveTeamMembership removes a user from the team addressed by
// `slug`. A 404 (not a member, or the team is gone) is treated as
// success so `roster remove` is idempotent. Does not affect org
// membership.
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

// teamHasRepoAccess reports whether the team addressed by `slug`
// already has any access to <org>/<repo>. GET
// .../teams/{slug}/repos/{owner}/{repo} returns 204 when the team has
// access, 404 when it doesn't. Used to keep GrantTeamRepoRead
// idempotent (skip the PUT when already granted).
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

// GrantTeamRepoRead grants the team addressed by `slug` `pull` (read)
// on <repoOwner>/<repo> — the access a base-permission-`none` student
// needs to generate from a private, org-owned template. Idempotent:
// skips the PUT when the team already has access. Returns whether a
// new grant was applied.
func GrantTeamRepoRead(client githubapi.Client, org, slug, repoOwner, repo string) (granted bool, err error) {
	return grantTeamRepo(client, org, slug, repoOwner, repo, "pull")
}

// GrantTeamRepoWrite grants the team addressed by `slug` `push` (write)
// on <repoOwner>/<repo> — the access a staff team needs on the
// `classroom50` config repo to author assignments. Idempotent: skips
// the PUT when the team already has access. Returns whether a new grant
// was applied. Mirrors the web's grantTeamConfigRepoWrite.
func GrantTeamRepoWrite(client githubapi.Client, org, slug, repoOwner, repo string) (granted bool, err error) {
	return grantTeamRepo(client, org, slug, repoOwner, repo, "push")
}

// grantTeamRepo PUTs a team's repo permission, skipping the write when
// the team already has any access (keeps the grant idempotent). The
// existing-access check is permission-agnostic; a staff-team re-run
// after a permission change would be a no-op, which is acceptable for
// the create-time grant this backs.
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

// ResolveClassroomTeamSlug returns the classroom team's addressing slug:
// the persisted classroom.json `team.slug` when present (authoritative —
// GitHub may re-slug on a name collision, e.g. `classroom50-cs-1`), else the
// derived `classroom50-<short>`. Mirrors the web app's resolveClassroomTeam and
// the Python collector's resolve_team_slug so all three consumers target the
// same team. A transient read failure propagates (so a caller doesn't target a
// wrong slug); only a genuinely absent team block falls back to the derivation.
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
// addressed by `slug`, walking pagination. This is the team-driven username
// source for grade collection: the classroom GitHub team is authoritative for
// who is enrolled (students.csv is only optional display metadata). A 404 (team
// doesn't exist yet) returns an empty slice so a classroom whose team hasn't
// been created reads as "no members" rather than erroring.
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
				return nil // sentinel: caller treats nil error + handles empty
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
