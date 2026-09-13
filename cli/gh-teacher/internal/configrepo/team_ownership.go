package configrepo

// Which team at a canonical slug is really the classroom's own. Mirrored by
// the web's AdoptGuard and the collector's staff_team_is_claimed.

import (
	"fmt"
	"net/http"
	"net/url"

	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/githubapi"
)

// adoptGuard decides whether an existing team at a canonical slug may be
// adopted. A slug proves nothing: any org member can create a team there, and
// classroom `<short>-<role>`'s student team sits at `<short>`'s `<role>` slug.
// So a staff team must not be a sibling classroom's student team, and must hold
// the config-repo grant only an owner-run flow gives (or match the id recorded
// when the grant step failed). A student team is always the classroom's own.
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

// StudentTeamOwner returns the classroom whose student team sits at
// `shortName`'s `role` slug (the classroom `<shortName>-<role>`), or "".
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
// classroom's, so nothing adopts, reshapes, grants, or exempts it. StudentOf is
// set when it is a sibling classroom's student team; otherwise it lacks the
// config-repo grant.
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
// team, or 0 when absent or naming another team.
func RecordedStaffTeamID(shortName string, role StaffRole, recorded *StaffTeamsRef) int64 {
	ref := recorded.RefForRole(role)
	if !IsCanonicalStaffTeamRef(shortName, role, ref) {
		return 0
	}
	return ref.ID
}

// OrgTeam is the slice of GitHub's team object the listing readers need.
type OrgTeam struct {
	ID      int64  `json:"id"`
	Slug    string `json:"slug"`
	Privacy string `json:"privacy"`
}

// ListConfigRepoTeams returns the teams with a grant on the config repo, keyed
// by slug: the teams Classroom 50 owns (see adoptGuard). A missing config repo
// (fresh org) yields an empty map; any other failure propagates.
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

// LiveTeamID returns the id of the team at `slug`, or 0 when none exists.
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
