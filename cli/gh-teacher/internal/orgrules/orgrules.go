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

// body is the POST /orgs/{org}/rulesets payload. Only the fields we set are
// modeled.
type rulesetBody struct {
	Name         string        `json:"name"`
	Target       string        `json:"target"`
	Enforcement  string        `json:"enforcement"`
	Conditions   conditions    `json:"conditions"`
	BypassActors []bypassActor `json:"bypass_actors"`
	Rules        []rule        `json:"rules"`
}

type conditions struct {
	RefName        refPattern `json:"ref_name"`
	RepositoryName refPattern `json:"repository_name"`
}

// refPattern is GitHub's include/exclude shape, reused for ref_name and
// repository_name. "~ALL" (repos) and "~DEFAULT_BRANCH" (refs) are the
// documented wildcards.
type refPattern struct {
	Include []string `json:"include"`
	Exclude []string `json:"exclude"`
}

// bypassActor lets an actor skip the rules. `exempt` means GitHub doesn't
// evaluate the rules for that actor at all, so they get a plain Merge button
// instead of the "bypass rules" checkbox and an audit entry; `always` keeps
// the checkbox as a deliberate break-glass step.
type bypassActor struct {
	ActorID    int64  `json:"actor_id"`
	ActorType  string `json:"actor_type"`
	BypassMode string `json:"bypass_mode"`
}

type rule struct {
	Type string `json:"type"`
}

// orgAdminActorID is GitHub's fixed actor_id for the OrganizationAdmin role
// (the org-owner role — the teacher).
const orgAdminActorID = 1

// GitHub's bypass-actor vocabulary, spelled once.
const (
	actorTypeOrgAdmin = "OrganizationAdmin"
	actorTypeTeam     = "Team"
	bypassExempt      = "exempt"
	bypassAlways      = "always"
)

func isExemptOwner(a bypassActor) bool {
	return a.ActorType == actorTypeOrgAdmin && a.BypassMode == bypassExempt
}

func isExemptTeam(a bypassActor) bool {
	return a.ActorType == actorTypeTeam && a.BypassMode == bypassExempt
}

// feedbackBaseBypassActors is the feedback-base lock's bypass list: org owners
// plus every classroom staff team, all exempt. Students are collaborators on
// their own repo and never on a staff team, so the `update` rule binds them
// while staff merge the Feedback PR like any other PR. Sorted by team ID so a
// reconcile compares stably.
func feedbackBaseBypassActors(staffTeamIDs []int64) []bypassActor {
	actors := []bypassActor{{ActorID: orgAdminActorID, ActorType: actorTypeOrgAdmin, BypassMode: bypassExempt}}
	for _, id := range uniqueSortedIDs(staffTeamIDs) {
		actors = append(actors, bypassActor{ActorID: id, ActorType: actorTypeTeam, BypassMode: bypassExempt})
	}
	return actors
}

// uniqueSortedIDs drops non-positive IDs, then sorts and dedupes.
func uniqueSortedIDs(ids []int64) []int64 {
	out := make([]int64, 0, len(ids))
	for _, id := range ids {
		if id > 0 {
			out = append(out, id)
		}
	}
	slices.Sort(out)
	return slices.Compact(out)
}

// bodies is the full definition of both org rulesets. staffTeamIDs are the
// teacher/head-TA/TA team IDs of every classroom in the org; they only affect
// the feedback-base lock's bypass list.
func bodies(staffTeamIDs []int64) []rulesetBody {
	return []rulesetBody{submissionHistoryBody(), feedbackBaseBody(staffTeamIDs)}
}

var allRepos = refPattern{Include: []string{"~ALL"}, Exclude: []string{}}

// submissionHistoryBody locks the default branch's history: non_fast_forward
// blocks force-push, deletion blocks delete, and neither blocks a normal
// fast-forward submit.
func submissionHistoryBody() rulesetBody {
	return rulesetBody{
		Name:        NameSubmissionHistory,
		Target:      "branch",
		Enforcement: "active",
		Conditions: conditions{
			// ~DEFAULT_BRANCH follows each repo's actual default branch (not
			// hardcoded `main`) so it still covers repos renamed by org policy,
			// and matches the branch the Feedback PR opens against.
			RefName:        refPattern{Include: []string{"~DEFAULT_BRANCH"}, Exclude: []string{}},
			RepositoryName: allRepos,
		},
		// `always`, not exempt: an owner rewriting a student's history should
		// be a deliberate, audited bypass.
		BypassActors: []bypassActor{{ActorID: orgAdminActorID, ActorType: actorTypeOrgAdmin, BypassMode: bypassAlways}},
		Rules:        []rule{{Type: "non_fast_forward"}, {Type: "deletion"}},
	}
}

// feedbackBaseBody locks the feedback branch: `update` restricts pushes and
// merges to the bypass actors (owners and staff teams), `deletion` blocks
// delete. Creation stays allowed so accept or the runner can land the branch
// once. Also the body the incremental bypass-list update PUTs.
func feedbackBaseBody(staffTeamIDs []int64) rulesetBody {
	return rulesetBody{
		Name:        NameFeedbackBase,
		Target:      "branch",
		Enforcement: "active",
		Conditions: conditions{
			RefName:        refPattern{Include: []string{"refs/heads/" + contract.FeedbackBaseBranch}, Exclude: []string{}},
			RepositoryName: allRepos,
		},
		BypassActors: feedbackBaseBypassActors(staffTeamIDs),
		Rules:        []rule{{Type: "update"}, {Type: "deletion"}},
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
	return ensure(client, out, errOut, org, bodies(staffTeamIDs))
}

// EnsureSubmissionHistoryOnly reconciles just the submission-history ruleset,
// for an init that could read neither the classrooms nor the current bypass
// list: rebuilding the feedback-base lock then would wipe every staff
// exemption, so it is left as it is (mirrors the web's repairRulesets with a
// null team list).
func EnsureSubmissionHistoryOnly(client githubapi.Client, out, errOut io.Writer, org string) (bool, error) {
	return ensure(client, out, errOut, org, []rulesetBody{submissionHistoryBody()})
}

func ensure(client githubapi.Client, out, errOut io.Writer, org string, rulesets []rulesetBody) (bool, error) {
	existing, err := list(client, org)
	if err != nil {
		_, _ = fmt.Fprintf(errOut, "Warning: %s: could not list org rulesets (%v); skipping Feedback PR branch protections. Apply them manually at https://github.com/organizations/%s/settings/rules if students can force-push submissions or merge feedback PRs.\n",
			org, err, org)
		return false, nil
	}

	allReady := true
	for _, rs := range rulesets {
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

// list returns existing org rulesets as a name->ID map so Ensure can choose
// POST (new) vs PUT-by-ID (reconcile). Paginated so a large org doesn't hide
// the Classroom 50 entries (which would make the reconcile re-POST and 422).
func list(client githubapi.Client, org string) (map[string]int64, error) {
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

// teamChange is the set of staff team IDs to add to or drop from the
// feedback-base bypass list.
type teamChange struct {
	add    []int64
	remove []int64
}

// updateFeedbackBaseBypassTeams adds or drops staff teams on the feedback-base
// lock's bypass list without re-deriving the whole list: read the ruleset,
// merge the Team entries, PUT the full definition back only when something
// changes. "Present" means listed AND exempt: a Team left at `always` by an
// older release, or an owner entry not yet exempt, is rebuilt too (mirrors the
// web's updateFeedbackBaseBypassTeams). Returns false when the ruleset isn't
// installed yet (init not run on this org); a later init rebuilds the list
// from every classroom, so nothing is lost.
func updateFeedbackBaseBypassTeams(client githubapi.Client, org string, change teamChange) (bool, error) {
	id, actors, err := feedbackBaseActors(client, org)
	if err != nil || id == 0 {
		return false, err
	}
	remove := make(map[int64]bool, len(change.remove))
	for _, r := range change.remove {
		remove[r] = true
	}
	ownerExempt := false
	exempt := map[int64]bool{}
	ids := make([]int64, 0, len(actors)+len(change.add))
	dropping := false
	for _, a := range actors {
		switch {
		case isExemptOwner(a):
			ownerExempt = true
		case isExemptTeam(a):
			if remove[a.ActorID] {
				dropping = true
				continue
			}
			exempt[a.ActorID] = true
			ids = append(ids, a.ActorID)
		}
	}
	missing := false
	for _, teamID := range change.add {
		if !exempt[teamID] && !remove[teamID] {
			missing = true
			ids = append(ids, teamID)
		}
	}
	if ownerExempt && !missing && !dropping {
		return true, nil
	}
	return true, update(client, org, id, feedbackBaseBody(ids))
}

// ExemptStaffTeams makes sure staff teams are exempt from the feedback-base
// lock so their members can merge feedback PRs. Idempotent and read-only when
// nothing is missing, so callers run it on create and on re-runs alike.
// Best-effort: a failure warns (the next `gh teacher init` rebuilds the list)
// and never fails the command that created the team.
func ExemptStaffTeams(client githubapi.Client, errOut io.Writer, org string, teams []configrepo.TeamRef) {
	ids := teamIDs(teams)
	if len(ids) == 0 {
		return
	}
	ok, err := updateFeedbackBaseBypassTeams(client, org, teamChange{add: ids})
	switch {
	case err != nil:
		_, _ = fmt.Fprintf(errOut, "Warning: %s: could not add the staff team(s) to the feedback-base ruleset bypass list (%v); staff can't merge feedback PRs until `gh teacher init %s` is re-run.\n", org, err, org)
	case !ok:
		_, _ = fmt.Fprintf(errOut, "Warning: %s: the feedback-base ruleset is not installed, so staff can't merge feedback PRs; run `gh teacher init %s`.\n", org, org)
	}
}

// RevokeClassroomStaffTeams drops the classrooms' staff teams from the
// feedback-base bypass list, best-effort. It resolves each canonical slug to the
// live team rather than trusting the head-TA-writable `teams` block, so an
// unrecorded team is dropped too. Run before the team delete so the PUT never
// references an actor GitHub no longer knows.
func RevokeClassroomStaffTeams(client githubapi.Client, errOut io.Writer, org string, shortNames ...string) {
	var ids []int64
	for _, shortName := range shortNames {
		for _, slug := range configrepo.StaffTeamSlugs(shortName) {
			id, err := configrepo.LiveTeamID(client, org, slug)
			if err != nil {
				_, _ = fmt.Fprintf(errOut, "Warning: %s: could not look up staff team %q to drop it from the feedback-base ruleset bypass list (%v); re-run `gh teacher init %s` to rebuild it.\n", org, slug, err, org)
				continue
			}
			if id > 0 {
				ids = append(ids, id)
			}
		}
	}
	if len(ids) == 0 {
		return
	}
	if _, err := updateFeedbackBaseBypassTeams(client, org, teamChange{remove: ids}); err != nil {
		_, _ = fmt.Fprintf(errOut, "Warning: %s: could not drop the staff team(s) from the feedback-base ruleset bypass list (%v); re-run `gh teacher init %s` to rebuild it.\n", org, err, org)
	}
}

// ExistingFeedbackBaseTeamIDs returns every Team actor currently on the
// feedback-base bypass list, whatever its mode (none when the ruleset isn't
// installed). The fallback input for Ensure when the config repo can't be
// read, so a reconcile keeps rather than wipes the list.
func ExistingFeedbackBaseTeamIDs(client githubapi.Client, org string) ([]int64, error) {
	_, actors, err := feedbackBaseActors(client, org)
	if err != nil {
		return nil, err
	}
	var ids []int64
	for _, a := range actors {
		if a.ActorType == actorTypeTeam {
			ids = append(ids, a.ActorID)
		}
	}
	return ids, nil
}

// feedbackBaseActors reads the installed feedback-base ruleset and returns its
// ID and bypass list; ID 0 means not installed.
func feedbackBaseActors(client githubapi.Client, org string) (int64, []bypassActor, error) {
	existing, err := list(client, org)
	if err != nil {
		return 0, nil, err
	}
	id, ok := existing[NameFeedbackBase]
	if !ok {
		return 0, nil, nil
	}
	var current struct {
		BypassActors []bypassActor `json:"bypass_actors"`
	}
	path := fmt.Sprintf("orgs/%s/rulesets/%d", url.PathEscape(org), id)
	if err := client.Get(path, &current); err != nil {
		return 0, nil, fmt.Errorf("GET %s: %w", path, err)
	}
	return id, current.BypassActors, nil
}

// Reconcile is init's ruleset step: rebuild the feedback-base bypass list from
// the live staff teams of every classroom, then Ensure both rulesets. When the
// classrooms or the org's teams can't be read, the list already on the ruleset
// is kept instead; when that can't be read either, the feedback-base ruleset is
// left untouched and only submission-history is reconciled (rebuilding would
// wipe every staff exemption). Returns whether every ruleset it attempted is
// in place and whether the feedback-base lock had to be left as is.
func Reconcile(client githubapi.Client, out, errOut io.Writer, org string) (ready, feedbackKept bool, err error) {
	staffTeamIDs, err := bypassTeamIDs(client, out, errOut, org)
	if err == nil {
		ready, err = Ensure(client, out, errOut, org, staffTeamIDs)
		return ready, false, err
	}
	_, _ = fmt.Fprintf(errOut, "Warning: %s: could not read classroom staff teams (%v); the feedback-base bypass list keeps its current teams. Re-run init once the classroom50 repository is readable.\n", org, err)
	staffTeamIDs, err = ExistingFeedbackBaseTeamIDs(client, org)
	if err == nil {
		ready, err = Ensure(client, out, errOut, org, staffTeamIDs)
		return ready, false, err
	}
	_, _ = fmt.Fprintf(errOut, "Warning: %s: could not read the current bypass list either (%v); the feedback-base ruleset was left unchanged. Re-run init once the classroom50 repository is readable.\n", org, err)
	ready, err = EnsureSubmissionHistoryOnly(client, out, errOut, org)
	return ready, true, err
}

func bypassTeamIDs(client githubapi.Client, out, errOut io.Writer, org string) ([]int64, error) {
	slugs, err := CollectStaffTeamSlugs(client, org)
	if err != nil {
		return nil, err
	}
	return PrepareStaffTeams(client, out, errOut, org, slugs)
}

// CollectStaffTeamSlugs returns the canonical staff team slugs of every
// classroom in the config repo. The slug is the identity: it is what every
// writer creates and what a head-TA-editable `teams` block cannot redirect. A
// slug that is a sibling classroom's student team (`ml`'s TA slug when `ml-ta`
// exists) is left out. A missing config repo yields none; any read failure
// propagates so the caller keeps the current bypass list.
func CollectStaffTeamSlugs(client githubapi.Client, org string) ([]string, error) {
	var shortNames []string
	var readErr error
	err := configrepo.WalkClassrooms(client, org,
		func(shortName string, err error) {
			if readErr == nil {
				readErr = fmt.Errorf("read %s/classroom.json: %w", shortName, err)
			}
		},
		func(shortName string, _ *configrepo.ClassroomJSON) {
			shortNames = append(shortNames, shortName)
		})
	if err != nil {
		return nil, err
	}
	classrooms := make(map[string]bool, len(shortNames))
	for _, s := range shortNames {
		classrooms[s] = true
	}
	var slugs []string
	for _, s := range shortNames {
		for _, role := range configrepo.StaffRoles {
			if classrooms[s+"-"+string(role)] {
				continue
			}
			slugs = append(slugs, configrepo.StaffTeamSlug(s, role))
		}
	}
	return slugs, readErr
}

// PrepareStaffTeams resolves the canonical slugs against the config-repo team
// listing, makes each match a valid bypass actor (GitHub rejects a `secret`
// team), and returns their IDs for Ensure. A slug with no granted team (a role
// never staffed, or a team Classroom 50 did not create) is simply absent. A
// listing failure propagates so the caller keeps the current list; a PATCH
// failure warns and leaves that team out.
func PrepareStaffTeams(client githubapi.Client, out, errOut io.Writer, org string, slugs []string) ([]int64, error) {
	teams, err := configrepo.ListConfigRepoTeams(client, org)
	if err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(slugs))
	for _, slug := range slugs {
		team, ok := teams[slug]
		if !ok {
			continue
		}
		if team.Privacy != configrepo.StaffTeamPrivacy {
			if err := configrepo.SetTeamPrivacy(client, org, slug, configrepo.StaffTeamPrivacy); err != nil {
				// A throttled PATCH says nothing about the team; propagate so
				// the caller keeps the current list instead of rebuilding a
				// shorter one (mirrors the web's isRateLimited rethrow).
				if cliutil.IsRateLimited(err) {
					return nil, fmt.Errorf("PATCH team %s privacy: %w", slug, err)
				}
				_, _ = fmt.Fprintf(errOut, "Warning: %s: could not make staff team %q visible to the organization (%v); its members can't merge feedback PRs until it is. Set the team's visibility to \"Visible\" at https://github.com/orgs/%s/teams/%s/edit and re-run init.\n",
					org, slug, err, org, slug)
				continue
			}
			_, _ = fmt.Fprintf(out, "%s: staff team %s is now visible to the organization (required to exempt it from the feedback-base ruleset)\n", org, slug)
		}
		ids = append(ids, team.ID)
	}
	return ids, nil
}

// CanonicalStaffTeamRefs are the staff team refs recorded in a classroom's
// `teams` block that name the team Classroom 50 creates for that role, in
// role order. Non-canonical entries are dropped.
func CanonicalStaffTeamRefs(shortName string, teams *configrepo.StaffTeamsRef) []configrepo.TeamRef {
	var refs []configrepo.TeamRef
	for _, rr := range teams.StaffRoleRefs() {
		if configrepo.IsCanonicalStaffTeamRef(shortName, rr.Role, &rr.Ref) {
			refs = append(refs, rr.Ref)
		}
	}
	return refs
}

func teamIDs(teams []configrepo.TeamRef) []int64 {
	ids := make([]int64, 0, len(teams))
	for _, t := range teams {
		if t.ID > 0 {
			ids = append(ids, t.ID)
		}
	}
	return ids
}

func create(client githubapi.Client, org string, body rulesetBody) error {
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

func update(client githubapi.Client, org string, id int64, body rulesetBody) error {
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
