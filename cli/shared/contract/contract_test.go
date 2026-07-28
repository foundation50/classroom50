package contract

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestContractLiterals is a change-detector pinning each cross-binary constant
// to its exact wire value. These must stay byte-identical to the Python scripts
// (runner.py, collect_scores.py, materialize_tests.py) and the JSON Schemas
// under schemas/, which assert their own copies. With no compile-time link
// across languages, an accidental edit here (a typo, a unilateral v1->v2 bump)
// would compile and pass every other Go test while silently breaking
// outcome-equivalence with the GUI, the Python autograde/collect pipeline, and
// already-bootstrapped repos. On a genuine change, update this test AND every
// cross-language copy in lockstep.
func TestContractLiterals(t *testing.T) {
	cases := []struct {
		name string
		got  string
		want string
	}{
		{"ConfigRepoName", ConfigRepoName, "classroom50"},
		{"AssignmentsSchemaV1", AssignmentsSchemaV1, "classroom50/assignments/v1"},
		{"TeamSchemaV1", TeamSchemaV1, "classroom50/team/v1"},
		{"DefaultAutograderName", DefaultAutograderName, "default"},
		{"ModeIndividual", ModeIndividual, "individual"},
		{"ModeGroup", ModeGroup, "group"},
		{"ResultFilename", ResultFilename, "result.json"},
		{"ReleaseBodyFilename", ReleaseBodyFilename, "release-body.md"},
		// RosterFilename / LegacyRosterFilename are mirrored, with NO
		// compile-time link, in the web GUI (web/src/util/rosterPath.ts) and the
		// Python collect-scores script (collect_scores.py). Update every copy in
		// lockstep on change.
		{"RosterFilename", RosterFilename, "roster.csv"},
		{"LegacyRosterFilename", LegacyRosterFilename, "students.csv"},
		// SecretPattern / SecretPatternDescription are mirrored, with NO
		// compile-time link, in: cli/gh-teacher/skeleton/dotgithub/scripts/runner.py
		// (re.fullmatch r"[a-z0-9]{4,64}"), autograde-runner.yaml (_SECRET),
		// publish-pages.yaml (dest_prefix, both steps' shared helper),
		// schemas/classroom-v1.schema.json, schemas/repo-config-v1.schema.json,
		// and the web GUI validator. Update every copy in lockstep on change.
		{"SecretPattern", SecretPattern, "^[a-z0-9]{4,64}$"},
		{"SecretPatternDescription", SecretPatternDescription, "4-64 lowercase letters or digits ([a-z0-9])"},
		// CommitPrefix is mirrored, with NO compile-time link, in the web GUI
		// (web/src/util/commit.ts COMMIT_PREFIX) and
		// cli/gh-teacher/skeleton/dotgithub/workflows/collect-scores.yaml.
		// Update every copy in lockstep on change.
		{"CommitPrefix", CommitPrefix, "[Classroom 50]"},
		// FeedbackBaseBranch / FeedbackPRTitle are mirrored, with NO
		// compile-time link, in ensure_feedback_pr.py (BASE_BRANCH, --title) and
		// the web GUI (web/src/domain/assignments/feedbackPr.ts). The branch
		// name is also baked into already-deployed org rulesets
		// (classroom50-feedback-base-lock) — changing it strands them.
		{"FeedbackBaseBranch", FeedbackBaseBranch, "feedback"},
		{"FeedbackPRTitle", FeedbackPRTitle, "Feedback"},
		// MetadataPath is mirrored, with NO compile-time link, in runner.py
		// (ACCEPT_MARKER_PATH), the web GUI, and
		// schemas/repo-config-v1.schema.json. It anchors the Feedback-PR
		// baseline, so a drift silently breaks base-SHA resolution across
		// tools. Update every copy in lockstep on change.
		{"MetadataPath", MetadataPath, ".classroom50.yaml"},
	}
	for _, tc := range cases {
		if tc.got != tc.want {
			t.Errorf("%s = %q, want %q (cross-binary contract drift — update every language copy in lockstep)", tc.name, tc.got, tc.want)
		}
	}
}

// TestClassroomTeamSlugs pins the team-slug formula and the full enrolled-set
// enumeration. These are byte-mirrored, with NO compile-time link, in the web
// GUI (web/src/util/teamSlug.ts classroomTeamSlug / classroomTeamSlugs) and
// gh-teacher (internal/configrepo/team.go classroomTeamName / staffTeamName).
// The set is ordered student-first and includes the legacy instructor team so a
// not-yet-migrated staffer still reads as enrolled. Update every copy in
// lockstep on change.
func TestClassroomTeamSlugs(t *testing.T) {
	if got := ClassroomStudentTeamSlug("cs101"); got != "classroom50-cs101" {
		t.Errorf("ClassroomStudentTeamSlug = %q, want %q", got, "classroom50-cs101")
	}
	if got := StaffTeamSlug("cs101", RoleTeacher); got != "classroom50-cs101-teacher" {
		t.Errorf("StaffTeamSlug(teacher) = %q, want %q", got, "classroom50-cs101-teacher")
	}
	if got := StaffTeamSlug("cs101", RoleInstructor); got != "classroom50-cs101-instructor" {
		t.Errorf("StaffTeamSlug(instructor) = %q, want %q", got, "classroom50-cs101-instructor")
	}
	// A classroom short-name may contain hyphens; the slug must not mangle them.
	want := []string{
		"classroom50-cs-principles",
		"classroom50-cs-principles-teacher",
		"classroom50-cs-principles-instructor",
		"classroom50-cs-principles-hta",
		"classroom50-cs-principles-ta",
	}
	got := ClassroomTeamSlugs("cs-principles")
	if len(got) != len(want) {
		t.Fatalf("ClassroomTeamSlugs len = %d, want %d (%v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("ClassroomTeamSlugs[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

// TestAssignmentRepoName pins the lowercasing of all three segments and the
// prefix/name relationship (owner is recoverable by stripping the prefix).
// Cross-language agreement with the Python mirrors is enforced separately by
// TestAssignmentRepoName_SharedFixtureParity.
func TestAssignmentRepoName(t *testing.T) {
	if got := AssignmentRepoPrefix("CS101", "HW1"); got != "cs101-hw1-" {
		t.Errorf("AssignmentRepoPrefix = %q, want %q", got, "cs101-hw1-")
	}
	if got := AssignmentRepoName("CS101", "HW1", "Alice"); got != "cs101-hw1-alice" {
		t.Errorf("AssignmentRepoName = %q, want %q", got, "cs101-hw1-alice")
	}
	// Name must be exactly Prefix + lowercased username, so a consumer that
	// strips the prefix recovers the owner.
	prefix := AssignmentRepoPrefix("cs101", "hw1")
	name := AssignmentRepoName("cs101", "hw1", "bob")
	if !strings.HasPrefix(name, prefix) {
		t.Errorf("AssignmentRepoName %q does not start with AssignmentRepoPrefix %q", name, prefix)
	}
	if owner := strings.TrimPrefix(name, prefix); owner != "bob" {
		t.Errorf("owner recovered from %q = %q, want %q", name, owner, "bob")
	}
}

// sharedRepoNameCasesPath locates the cross-language golden fixture, also
// consumed by the Python mirror tests (runner.py, collect_scores.py,
// regrade_repos.py), relative to this package.
const sharedRepoNameCasesPath = "../testdata/assignment_repo_name_cases.json"

// TestAssignmentRepoName_SharedFixtureParity runs the shared golden cases so the
// Go formula and the by-value Python mirrors can't drift: a one-sided edit fails
// on the other language's copy of these same cases.
func TestAssignmentRepoName_SharedFixtureParity(t *testing.T) {
	raw, err := os.ReadFile(filepath.Clean(sharedRepoNameCasesPath))
	if err != nil {
		t.Fatalf("read shared fixture: %v", err)
	}
	var doc struct {
		Cases []struct {
			Classroom  string `json:"classroom"`
			Assignment string `json:"assignment"`
			Username   string `json:"username"`
			Name       string `json:"name"`
			Owner      string `json:"owner"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse shared fixture: %v", err)
	}
	if len(doc.Cases) == 0 {
		t.Fatal("shared fixture has no cases")
	}
	for _, c := range doc.Cases {
		if got := AssignmentRepoName(c.Classroom, c.Assignment, c.Username); got != c.Name {
			t.Errorf("AssignmentRepoName(%q,%q,%q) = %q, want %q",
				c.Classroom, c.Assignment, c.Username, got, c.Name)
		}
		// owner is the tail the Python mirror recovers by stripping the prefix.
		prefix := AssignmentRepoPrefix(c.Classroom, c.Assignment)
		if owner := strings.TrimPrefix(c.Name, prefix); owner != c.Owner {
			t.Errorf("owner recovered from %q = %q, want %q", c.Name, owner, c.Owner)
		}
	}
}

// TestRequiredOAuthScopes pins the unified CLI scope set (issue #246): both
// binaries request exactly these, and delete_repo stays out (opt-in for
// teardown). This list is the behavior oracle for the login command and the
// teacher preflight; changes must move in lockstep with those and the wiki
// scope tables.
func TestRequiredOAuthScopes(t *testing.T) {
	want := []string{"admin:org", "read:org", "repo", "workflow"}
	got := RequiredOAuthScopes()
	if len(got) != len(want) {
		t.Fatalf("RequiredOAuthScopes() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("RequiredOAuthScopes()[%d] = %q, want %q", i, got[i], want[i])
		}
	}
	// delete_repo is intentionally opt-in (guards accidental org teardown).
	if strings.Contains(strings.Join(got, ","), "delete_repo") {
		t.Errorf("delete_repo must NOT be in the default scope set: %v", got)
	}
	// Fresh copy each call: mutating the result must not corrupt the shared set.
	RequiredOAuthScopes()[0] = "tampered"
	if RequiredOAuthScopes()[0] != "admin:org" {
		t.Error("RequiredOAuthScopes() must return a defensive copy")
	}
}

// TestPrefixCommit pins the canonical "[Classroom 50] <message>" shape so the
// separator (a single space) can't drift from the web GUI's prefixCommit.
func TestPrefixCommit(t *testing.T) {
	got := PrefixCommit("Add cs-principles classroom (gh teacher classroom add)")
	want := "[Classroom 50] Add cs-principles classroom (gh teacher classroom add)"
	if got != want {
		t.Errorf("PrefixCommit = %q, want %q", got, want)
	}
}

// TestFeedbackOpenCommitMessage pins the accept-time empty commit's message:
// the [skip ci] body line is load-bearing (it keeps the autograde shim from
// running on the diff-less commit), and the web GUI mirrors the whole string
// with NO compile-time link.
func TestFeedbackOpenCommitMessage(t *testing.T) {
	got := FeedbackOpenCommitMessage()
	want := "[Classroom 50] Open Feedback PR (gh student accept)\n\n[skip ci]"
	if got != want {
		t.Errorf("FeedbackOpenCommitMessage = %q, want %q", got, want)
	}
}

// TestFeedbackLabelForMode pins the mode labels/colors to
// ensure_feedback_pr.py's _LABELS (no compile-time link): the runner adopts
// the accept-time PR, so a drift would make teachers see two labels.
func TestFeedbackLabelForMode(t *testing.T) {
	cases := []struct {
		mode, name, color string
	}{
		{ModeGroup, "Group Assignment", "5319E7"},
		{"  GROUP ", "Group Assignment", "5319E7"},
		{ModeIndividual, "Individual Assignment", "0E8A16"},
		{"", "Individual Assignment", "0E8A16"},     // unknown -> individual,
		{"solo", "Individual Assignment", "0E8A16"}, // like label_for_mode
	}
	for _, tc := range cases {
		name, color := FeedbackLabelForMode(tc.mode)
		if name != tc.name || color != tc.color {
			t.Errorf("FeedbackLabelForMode(%q) = (%q,%q), want (%q,%q)",
				tc.mode, name, color, tc.name, tc.color)
		}
	}
}

// TestFeedbackPRBody pins the body BYTE-for-byte against the cross-language
// golden that gh-teacher's skeleton test (Python) and the web suite (TypeScript)
// assert against too, so a one-sided prose edit fails on every side. It also
// re-states the load-bearing properties, since the golden alone would not say
// WHY they matter: the release URL MUST be embedded — the runner's
// backfill_release_link() rewrites any open Feedback PR whose body lacks it,
// clobbering an accept-time body without it — and the head branch and frozen
// base are named.
func TestFeedbackPRBody(t *testing.T) {
	body := FeedbackPRBody("main", "https://github.com/o/r/releases/latest")
	for _, want := range []string{
		"https://github.com/o/r/releases/latest",
		"`main`",
		"`" + FeedbackBaseBranch + "`",
		"**Don't close or merge this pull request**",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("FeedbackPRBody missing %q", want)
		}
	}

	golden, err := os.ReadFile(filepath.Clean(feedbackPRBodyGoldenPath))
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	if got := FeedbackPRBody("HEAD_BRANCH", "RELEASE_URL"); got != string(golden) {
		t.Errorf("FeedbackPRBody no longer matches %s; if intentional, update pr_body in ensure_feedback_pr.py and feedbackPrBody in web/src/domain/assignments/feedbackPr.ts too, then regenerate the golden",
			feedbackPRBodyGoldenPath)
	}
}

// feedbackPRBodyGoldenPath locates the rendered-body golden, also consumed by
// the Python (skeleton_tests) and TypeScript (web) mirror tests.
const feedbackPRBodyGoldenPath = "testdata/feedback_pr_body.golden"
