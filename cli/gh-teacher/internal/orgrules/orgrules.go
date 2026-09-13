// Package orgrules installs and maintains the two org-level branch rulesets
// behind the Feedback PR feature. Org rulesets need an org-admin token (gh
// teacher authenticates as org owner); the workflow GITHUB_TOKEN has no
// administration scope, which is why this lives in the CLI, not the runner.
// Mirrored by the web app's github-core/rulesets.ts — the definitions must
// match exactly, a divergence is a parity bug.
package orgrules

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubapi"
)

// Stable ruleset names so re-running init is idempotent — Ensure reconciles
// an existing ruleset (by name) in place.
const (
	NameSubmissionHistory = "classroom50-protect-submission-history"
	NameFeedbackBase      = "classroom50-feedback-base-lock"
)

// Body is the POST /orgs/{org}/rulesets payload. Only the fields we set are
// modeled.
type Body struct {
	Name         string        `json:"name"`
	Target       string        `json:"target"`
	Enforcement  string        `json:"enforcement"`
	Conditions   Conditions    `json:"conditions"`
	BypassActors []BypassActor `json:"bypass_actors"`
	Rules        []Rule        `json:"rules"`
}

type Conditions struct {
	RefName        RefPattern `json:"ref_name"`
	RepositoryName RefPattern `json:"repository_name"`
}

// RefPattern is GitHub's include/exclude shape, reused for ref_name and
// repository_name. "~ALL" (repos) and "~DEFAULT_BRANCH" (refs) are the
// documented wildcards.
type RefPattern struct {
	Include []string `json:"include"`
	Exclude []string `json:"exclude"`
}

// BypassActor lets an actor skip the rules. `exempt` means GitHub doesn't
// evaluate the rules for that actor at all, so they get a plain Merge button
// instead of the "bypass rules" checkbox and an audit entry; `always` keeps
// the checkbox as a deliberate break-glass step.
type BypassActor struct {
	ActorID    int64  `json:"actor_id"`
	ActorType  string `json:"actor_type"`
	BypassMode string `json:"bypass_mode"`
}

type Rule struct {
	Type string `json:"type"`
}

// orgAdminActorID is GitHub's fixed actor_id for the OrganizationAdmin role
// (the org-owner role — the teacher).
const orgAdminActorID = 1

// FeedbackBaseBypassActors is the feedback-base lock's bypass list: org owners
// plus every classroom staff team, all exempt. Students are collaborators on
// their own repo and never on a staff team, so the `update` rule binds them
// while staff merge the Feedback PR like any other PR. Sorted by team ID so a
// reconcile compares stably.
func FeedbackBaseBypassActors(staffTeamIDs []int64) []BypassActor {
	actors := []BypassActor{{ActorID: orgAdminActorID, ActorType: "OrganizationAdmin", BypassMode: "exempt"}}
	for _, id := range uniqueSortedIDs(staffTeamIDs) {
		actors = append(actors, BypassActor{ActorID: id, ActorType: "Team", BypassMode: "exempt"})
	}
	return actors
}

func uniqueSortedIDs(ids []int64) []int64 {
	seen := make(map[int64]bool, len(ids))
	out := make([]int64, 0, len(ids))
	for _, id := range ids {
		if id <= 0 || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	slices.Sort(out)
	return out
}

// Bodies is the full definition of both org rulesets. staffTeamIDs are the
// teacher/head-TA/TA team IDs of every classroom in the org; they only affect
// the feedback-base lock's bypass list.
func Bodies(staffTeamIDs []int64) []Body {
	allRepos := RefPattern{Include: []string{"~ALL"}, Exclude: []string{}}
	return []Body{
		{
			Name:        NameSubmissionHistory,
			Target:      "branch",
			Enforcement: "active",
			Conditions: Conditions{
				// ~DEFAULT_BRANCH follows each repo's actual default branch
				// (not hardcoded `main`) so it still covers repos renamed by
				// org policy — and matches the branch the Feedback PR opens
				// against.
				RefName:        RefPattern{Include: []string{"~DEFAULT_BRANCH"}, Exclude: []string{}},
				RepositoryName: allRepos,
			},
			// `always`, not exempt: an owner rewriting a student's history
			// should be a deliberate, audited bypass.
			BypassActors: []BypassActor{{ActorID: orgAdminActorID, ActorType: "OrganizationAdmin", BypassMode: "always"}},
			// non_fast_forward blocks force-push; deletion blocks delete.
			// Neither blocks a normal fast-forward submit.
			Rules: []Rule{{Type: "non_fast_forward"}, {Type: "deletion"}},
		},
		{
			Name:        NameFeedbackBase,
			Target:      "branch",
			Enforcement: "active",
			Conditions: Conditions{
				RefName:        RefPattern{Include: []string{"refs/heads/" + contract.FeedbackBaseBranch}, Exclude: []string{}},
				RepositoryName: allRepos,
			},
			BypassActors: FeedbackBaseBypassActors(staffTeamIDs),
			// `update` restricts pushes/merges to bypass actors (owners and
			// staff teams); `deletion` blocks delete. Creation stays allowed
			// so accept or the runner can land the branch once.
			Rules: []Rule{{Type: "update"}, {Type: "deletion"}},
		},
	}
}

// Ensure installs two org-level branch rulesets covering every current and
// future repo (the student assignment repos):
//
//  1. submission history — on the default branch: block force-push + deletion
//     so a student can't rewrite/erase submission history; normal
//     fast-forward submits still go through.
//  2. feedback-base lock — on the `feedback` branch: restrict updates + block
//     deletion so students can't merge or move the frozen PR base. Owners and
//     every classroom's staff teams are exempt, so they merge the Feedback PR
//     with a plain Merge button. Branch *creation* stays allowed so accept or
//     the runner's GITHUB_TOKEN can create it once.
//
// Idempotent AND reconciling: an existing ruleset (by name) is PUT to the
// current definition, repairing a stale one from an older CLI and rebuilding
// the bypass list from staffTeamIDs. Warn-and-continue on any failure; the
// bool reports whether both rulesets ended up in place.
func Ensure(client githubapi.Client, out, errOut io.Writer, org string, staffTeamIDs []int64) (bool, error) {
	existing, err := List(client, org)
	if err != nil {
		_, _ = fmt.Fprintf(errOut, "Warning: %s: could not list org rulesets (%v); skipping Feedback PR branch protections. Apply them manually at https://github.com/organizations/%s/settings/rules if students can force-push submissions or merge feedback PRs.\n",
			org, err, org)
		return false, nil
	}

	allReady := true
	for _, rs := range Bodies(staffTeamIDs) {
		if id, ok := existing[rs.Name]; ok {
			// Reconcile: PUT the current definition so a re-run picks up a
			// changed branch pattern/rules instead of skipping it.
			if err := update(client, org, id, rs); err != nil {
				_, _ = fmt.Fprintf(errOut, "Warning: %s: could not update org ruleset %q (%v); review it at https://github.com/organizations/%s/settings/rules. A stale ruleset may %s.\n",
					org, rs.Name, err, org, missDescription(rs.Name))
				allReady = false
				continue
			}
			_, _ = fmt.Fprintf(out, "%s: org ruleset %q updated to current definition\n", org, rs.Name)
			continue
		}
		if err := create(client, org, rs); err != nil {
			_, _ = fmt.Fprintf(errOut, "Warning: %s: could not create org ruleset %q (%v); apply it manually at https://github.com/organizations/%s/settings/rules. Without it students could %s.\n",
				org, rs.Name, err, org, missDescription(rs.Name))
			allReady = false
			continue
		}
		_, _ = fmt.Fprintf(out, "%s: org ruleset %q created\n", org, rs.Name)
	}
	return allReady, nil
}

// List returns existing org rulesets as a name->ID map so Ensure can choose
// POST (new) vs PUT-by-ID (reconcile). Paginated so a large org doesn't hide
// the Classroom 50 entries (which would make the reconcile re-POST and 422).
func List(client githubapi.Client, org string) (map[string]int64, error) {
	type orgRuleset struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
	}
	rulesets, err := githubapi.PaginateAll[orgRuleset](client, 100, 100,
		func(page int) string {
			return fmt.Sprintf("orgs/%s/rulesets?per_page=100&page=%d", url.PathEscape(org), page)
		}, nil)
	if err != nil {
		return nil, err
	}
	ids := make(map[string]int64, len(rulesets))
	for _, r := range rulesets {
		ids[r.Name] = r.ID
	}
	return ids, nil
}

// TeamChange is the set of staff team IDs to add to or drop from the
// feedback-base bypass list.
type TeamChange struct {
	Add    []int64
	Remove []int64
}

// UpdateFeedbackBaseBypassTeams adds or drops staff teams on the feedback-base
// lock's bypass list without re-deriving the whole list: read the ruleset,
// merge the Team entries, PUT the full definition back only when something
// changes. The incremental sibling of Ensure, for the moment a classroom's
// staff team is created or torn down. Returns false when the ruleset isn't
// installed yet (init not run on this org); a later init rebuilds the list
// from every classroom, so nothing is lost.
func UpdateFeedbackBaseBypassTeams(client githubapi.Client, org string, change TeamChange) (bool, error) {
	id, current, err := feedbackBaseTeamIDs(client, org)
	if err != nil || id == 0 {
		return false, err
	}
	remove := make(map[int64]bool, len(change.Remove))
	for _, r := range change.Remove {
		remove[r] = true
	}
	exempt := make(map[int64]bool, len(current))
	ids := make([]int64, 0, len(current)+len(change.Add))
	dropping := false
	for _, teamID := range current {
		exempt[teamID] = true
		if remove[teamID] {
			dropping = true
			continue
		}
		ids = append(ids, teamID)
	}
	missing := false
	for _, teamID := range change.Add {
		if !exempt[teamID] {
			missing = true
			ids = append(ids, teamID)
		}
	}
	if !missing && !dropping {
		return true, nil
	}
	for _, rs := range Bodies(ids) {
		if rs.Name == NameFeedbackBase {
			return true, update(client, org, id, rs)
		}
	}
	return false, nil
}

// ExemptStaffTeams adds newly created staff teams to the feedback-base bypass
// list, best-effort: a failure warns (the next `gh teacher init` rebuilds the
// list) and never fails the command that created the team.
func ExemptStaffTeams(client githubapi.Client, errOut io.Writer, org string, teamIDs []int64) {
	if len(teamIDs) == 0 {
		return
	}
	ok, err := UpdateFeedbackBaseBypassTeams(client, org, TeamChange{Add: teamIDs})
	switch {
	case err != nil:
		_, _ = fmt.Fprintf(errOut, "Warning: %s: could not add the staff team(s) to the feedback-base ruleset bypass list (%v); staff can't merge feedback PRs until `gh teacher init %s` is re-run.\n", org, err, org)
	case !ok:
		_, _ = fmt.Fprintf(errOut, "Warning: %s: the feedback-base ruleset is not installed, so staff can't merge feedback PRs; run `gh teacher init %s`.\n", org, org)
	}
}

// RevokeStaffTeams drops staff teams about to be deleted from the
// feedback-base bypass list, best-effort. Run before the team delete so the
// PUT never references an actor GitHub no longer knows.
func RevokeStaffTeams(client githubapi.Client, errOut io.Writer, org string, teamIDs []int64) {
	if len(teamIDs) == 0 {
		return
	}
	if _, err := UpdateFeedbackBaseBypassTeams(client, org, TeamChange{Remove: teamIDs}); err != nil {
		_, _ = fmt.Fprintf(errOut, "Warning: %s: could not drop the staff team(s) from the feedback-base ruleset bypass list (%v); re-run `gh teacher init %s` to rebuild it.\n", org, err, org)
	}
}

// ExistingFeedbackBaseTeamIDs returns the staff team IDs currently on the
// feedback-base bypass list (none when the ruleset isn't installed). The
// fallback input for Ensure when the config repo can't be read, so a
// reconcile keeps rather than wipes the list.
func ExistingFeedbackBaseTeamIDs(client githubapi.Client, org string) ([]int64, error) {
	_, ids, err := feedbackBaseTeamIDs(client, org)
	return ids, err
}

// feedbackBaseTeamIDs reads the installed feedback-base ruleset and returns
// its ID and the Team actors on its bypass list; ID 0 means not installed.
func feedbackBaseTeamIDs(client githubapi.Client, org string) (int64, []int64, error) {
	existing, err := List(client, org)
	if err != nil {
		return 0, nil, err
	}
	id, ok := existing[NameFeedbackBase]
	if !ok {
		return 0, nil, nil
	}
	var current struct {
		BypassActors []BypassActor `json:"bypass_actors"`
	}
	path := fmt.Sprintf("orgs/%s/rulesets/%d", url.PathEscape(org), id)
	if err := client.Get(path, &current); err != nil {
		return 0, nil, fmt.Errorf("GET %s: %w", path, err)
	}
	var ids []int64
	for _, a := range current.BypassActors {
		if a.ActorType == "Team" {
			ids = append(ids, a.ActorID)
		}
	}
	return id, ids, nil
}

// CollectStaffTeams reads every classroom.json in the org's config repo and
// returns the recorded teacher/head-TA/TA team refs, the input Ensure needs to
// rebuild the bypass list. A missing config repo (fresh org) yields no refs
// and no error; any other read failure propagates so the caller can warn.
func CollectStaffTeams(client githubapi.Client, org string) ([]configrepo.TeamRef, error) {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		if isNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	entries, _, err := configrepo.ListDirContents(client, org, configrepo.ConfigRepoName, "", branch)
	if err != nil {
		if isNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	var refs []configrepo.TeamRef
	seen := map[int64]bool{}
	for _, e := range entries {
		if e.Type != "dir" {
			continue
		}
		c, ok, err := configrepo.LoadClassroom(client, org, e.Name, branch)
		if err != nil || !ok || c.Teams == nil {
			continue
		}
		for _, ref := range []*configrepo.TeamRef{c.Teams.Teacher, c.Teams.HeadTA, c.Teams.TA} {
			if ref != nil && ref.ID > 0 && !seen[ref.ID] {
				seen[ref.ID] = true
				refs = append(refs, *ref)
			}
		}
	}
	return refs, nil
}

// PrepareStaffTeams makes every staff team a valid bypass actor (GitHub
// rejects a `secret` team) and returns their IDs for Ensure. Teams created by
// an older release were secret; the PATCH here is the one-time upgrade. A
// team that can't be read or patched is reported and left out, so one bad
// team can't sink the whole ruleset PUT.
func PrepareStaffTeams(client githubapi.Client, out, errOut io.Writer, org string, teams []configrepo.TeamRef) []int64 {
	ids := make([]int64, 0, len(teams))
	for _, t := range teams {
		changed, err := configrepo.EnsureStaffTeamVisible(client, org, t.Slug)
		if err != nil {
			_, _ = fmt.Fprintf(errOut, "Warning: %s: could not make staff team %q visible to the organization (%v); its members can't merge feedback PRs until it is. Set the team's visibility to \"Visible\" at https://github.com/orgs/%s/teams/%s/edit and re-run init.\n",
				org, t.Slug, err, org, t.Slug)
			continue
		}
		if changed {
			_, _ = fmt.Fprintf(out, "%s: staff team %s is now visible to the organization (required to exempt it from the feedback-base ruleset)\n", org, t.Slug)
		}
		ids = append(ids, t.ID)
	}
	return ids
}

// StaffTeamIDs are the positive team IDs recorded in a classroom's `teams`
// block, in role order.
func StaffTeamIDs(teams *configrepo.StaffTeamsRef) []int64 {
	if teams == nil {
		return nil
	}
	var ids []int64
	for _, ref := range []*configrepo.TeamRef{teams.Teacher, teams.HeadTA, teams.TA} {
		if ref != nil && ref.ID > 0 {
			ids = append(ids, ref.ID)
		}
	}
	return ids
}

func isNotFound(err error) bool {
	return cliutil.IsHTTPStatus(err, http.StatusNotFound)
}

func create(client githubapi.Client, org string, body Body) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("encode ruleset %q: %w", body.Name, err)
	}
	path := fmt.Sprintf("orgs/%s/rulesets", url.PathEscape(org))
	if err := client.Post(path, bytes.NewReader(payload), nil); err != nil {
		return fmt.Errorf("POST %s: %w", path, err)
	}
	return nil
}

// update PUTs the full definition over an existing ruleset by ID.
func update(client githubapi.Client, org string, id int64, body Body) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("encode ruleset %q: %w", body.Name, err)
	}
	path := fmt.Sprintf("orgs/%s/rulesets/%d", url.PathEscape(org), id)
	resp, err := client.Request(http.MethodPut, path, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("PUT %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("PUT %s: unexpected status %d", path, resp.StatusCode)
	}
	return nil
}

// missDescription explains, per ruleset, what a teacher loses if it couldn't
// be created — surfaced in the warning so the fix hint is actionable.
func missDescription(name string) string {
	switch name {
	case NameSubmissionHistory:
		return "force-push or delete their submission history on main"
	case NameFeedbackBase:
		return "merge or move the feedback PR themselves"
	default:
		return "bypass intended branch protections"
	}
}
