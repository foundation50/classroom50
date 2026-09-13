package configrepo

// Which GitHub team is a classroom's own. The slug convention alone can't say:
// any org member can create a team at a staff slug, and a classroom named
// `<short>-<role>` puts its student team at `<short>`'s `<role>` slug. This
// file holds the two proofs (the classroom directory, then the config-repo
// grant) and the reads the write paths make against them. Mirrored by the
// web's AdoptGuard and the collector's staff_team_is_claimed.

import (
	"fmt"
	"net/http"
	"net/url"

	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/githubapi"
)

// adoptGuard decides whether an existing team at a canonical slug may be
// adopted. The slug alone proves nothing: any org member can create a team
// (members_can_create_teams is on for student groups), and a classroom whose
// short name ends in a role suffix puts its student team at another
// classroom's staff slug. Two facts settle it. A classroom directory
// `<short>-<role>` in the config repo means the team at `<short>`'s `<role>`
// slug is that classroom's student team, whatever it holds. Otherwise, what
// only an owner-run Classroom 50 flow does is grant a team access to the
// `classroom50` config repo, so a staff team must hold that grant (or match
// the id classroom.json recorded when the team was created and the grant step
// failed). A student team is always the classroom's own: its slug can only be
// a staff slug when the classroom itself is the `<short>-<role>` directory.
// Mirrored by the web's AdoptGuard.
type adoptGuard struct {
	staff      bool
	shortName  string
	role       StaffRole
	recordedID int64
}

func (g adoptGuard) check(client githubapi.Client, org, slug string, liveID int64) error {
	if !g.staff {
		return nil
	}
	if other, err := StudentTeamOwner(client, org, g.shortName, g.role); err != nil {
		return err
	} else if other != "" {
		return &UnclaimedTeamError{Org: org, Slug: slug, StudentOf: other, Role: g.role}
	}
	granted, err := teamHasRepoAccess(client, org, slug, org, ConfigRepoName)
	if err != nil {
		return fmt.Errorf("check %s access to the classroom50 repository: %w", slug, err)
	}
	if granted || (g.recordedID > 0 && g.recordedID == liveID) {
		return nil
	}
	return &UnclaimedTeamError{Org: org, Slug: slug, Role: g.role}
}

// StudentTeamOwner returns the short name of the classroom whose STUDENT team
// sits at `shortName`'s `role` slug (the classroom `<shortName>-<role>`), or ""
// when no such classroom exists. One contents probe on the config repo; the
// default branch is used so callers need no ref.
func StudentTeamOwner(client githubapi.Client, org, shortName string, role StaffRole) (string, error) {
	other := shortName + "-" + string(role)
	exists, err := ContentsExists(client, org, ConfigRepoName, other+"/classroom.json", "")
	if err != nil {
		return "", fmt.Errorf("check for a classroom named %s: %w", other, err)
	}
	if exists {
		return other, nil
	}
	return "", nil
}

// UnclaimedTeamError reports a team at a staff slug that is not this
// classroom's staff team and so is neither adopted, PATCHed, granted, nor
// exempted. StudentOf names the classroom whose student team it is, when the
// slug collision is the reason; otherwise the team lacks the config-repo grant.
type UnclaimedTeamError struct {
	Org       string
	Slug      string
	Role      StaffRole
	StudentOf string
}

func (e *UnclaimedTeamError) Error() string {
	if e.StudentOf != "" {
		return fmt.Sprintf("team %q is the student team of classroom %s, not this classroom's %s team; leave the %s role unstaffed here or rename one of the classrooms",
			e.Slug, e.StudentOf, e.Role, e.Role)
	}
	return fmt.Sprintf("team %q already exists in %s but was not created by Classroom 50 (it has no access to the classroom50 repository); review its members at https://github.com/orgs/%s/teams/%s, then either delete it or grant it access to the classroom50 repository to use it as this classroom's staff team, and re-run",
		e.Slug, e.Org, e.Org, e.Slug)
}

// RecordedStaffTeamID is the id classroom.json records for the role's canonical
// team, or 0 when the block is absent or names some other team.
func RecordedStaffTeamID(shortName string, role StaffRole, recorded *StaffTeamsRef) int64 {
	ref := recorded.RefForRole(role)
	if !IsCanonicalStaffTeamRef(shortName, role, ref) {
		return 0
	}
	return ref.ID
}

// OrgTeam is the slice of GitHub's team object the team listing readers need.
type OrgTeam struct {
	ID      int64  `json:"id"`
	Slug    string `json:"slug"`
	Privacy string `json:"privacy"`
}

// ListConfigRepoTeams returns every team that holds a grant on the org's
// `classroom50` config repo, keyed by slug, in one paginated read: the set of
// teams Classroom 50 owns (see adoptGuard for why the grant is the proof). A
// missing config repo (fresh org) yields an empty map; any other read failure
// propagates.
func ListConfigRepoTeams(client githubapi.Client, org string) (map[string]OrgTeam, error) {
	teams, err := githubapi.PaginateAll[OrgTeam](
		client, githubapi.ListPerPage, githubapi.ListMaxPages,
		func(page int) string {
			return fmt.Sprintf("repos/%s/%s/teams?per_page=%d&page=%d",
				url.PathEscape(org), ConfigRepoName, githubapi.ListPerPage, page)
		},
		func(path string, err error) error {
			return fmt.Errorf("GET %s: %w", path, err)
		},
	)
	if err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return map[string]OrgTeam{}, nil
		}
		return nil, err
	}
	bySlug := make(map[string]OrgTeam, len(teams))
	for _, t := range teams {
		bySlug[t.Slug] = t
	}
	return bySlug, nil
}

// LiveTeamID returns the id of the team at `slug`, or 0 when no team exists
// there. The slug-to-id read behind every path that must act on the team GitHub
// actually has at a canonical slug rather than a recorded ref.
func LiveTeamID(client githubapi.Client, org, slug string) (int64, error) {
	getPath := fmt.Sprintf("orgs/%s/teams/%s", url.PathEscape(org), url.PathEscape(slug))
	var live struct {
		ID int64 `json:"id"`
	}
	if err := client.Get(getPath, &live); err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return 0, nil
		}
		return 0, fmt.Errorf("GET %s: %w", getPath, err)
	}
	return live.ID, nil
}
