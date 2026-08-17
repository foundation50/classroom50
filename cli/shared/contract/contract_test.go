package contract

import (
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// updateGolden regenerates testdata/feedback_pr_body.golden from the canonical
// feedbackPrBody.md when set (`go test ./contract -run TestFeedbackPRBody
// -update`). The golden is the .md rendered with the HEAD_BRANCH/RELEASE_URL
// tokens left literal and only BASE_BRANCH resolved, so the Go/TS/Python verify
// tests can each assert their render equals it.
var updateGolden = flag.Bool("update", false, "regenerate the feedback PR body golden from feedbackPrBody.md")

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
		// InviteTeamPrefix is mirrored, with NO compile-time link, in the web
		// writer (web/src/util/inviteTeam.ts INVITE_TEAM_PREFIX). Update both
		// copies in lockstep on change.
		{"InviteTeamPrefix", InviteTeamPrefix, "invite-"},
		{"DefaultAutograderName", DefaultAutograderName, "default"},
		{"ModeIndividual", ModeIndividual, "individual"},
		{"ModeGroup", ModeGroup, "group"},
		// SubmissionMode values are mirrored, with NO compile-time link, in the
		// assignments-v1 schema enum (parity-pinned by
		// TestSubmissionModeEnumParity in gh-teacher), the web SUBMISSION_MODES,
		// and the runner's inline validator. Update every copy in lockstep.
		{"SubmissionModeEveryPush", SubmissionModeEveryPush, "every-push"},
		{"SubmissionModeTag", SubmissionModeTag, "tag"},
		// SubmitTagPrefix is mirrored, with NO compile-time link, in runner.py /
		// collect_scores.py / regrade_repos.py (SUBMIT_TAG_PREFIX), the
		// autograde-runner.yaml tag step, and the web SUBMISSION_TAG_PREFIX
		// (releaseRunReads.ts). Update every copy in lockstep on change.
		{"SubmitTagPrefix", SubmitTagPrefix, "submit/"},
		{"ResultFilename", ResultFilename, "result.json"},
		{"ReleaseBodyFilename", ReleaseBodyFilename, "release-body.md"},
		// RosterFilename is mirrored, with NO compile-time link, in the web GUI
		// (web/src/util/rosterPath.ts) and the Python collect-scores script
		// (collect_scores.py). Update every copy in lockstep on change.
		{"RosterFilename", RosterFilename, "roster.csv"},
		// ServiceTokenSecretName / ServiceTokenExpiresAtVar / ServiceTokenNameVar
		// are mirrored, with NO compile-time link, in the collect-scores /
		// regrade workflow YAML, the gh-teacher servicetoken package
		// (SecretName), and the web GUI
		// (web/src/github-core/queries/releaseRunReads.ts). Update every copy in
		// lockstep on change.
		{"ServiceTokenSecretName", ServiceTokenSecretName, "CLASSROOM50_SERVICE_TOKEN"},
		{
			"ServiceTokenExpiresAtVar",
			ServiceTokenExpiresAtVar,
			"CLASSROOM50_SERVICE_TOKEN_EXPIRES_AT",
		},
		{
			"ServiceTokenNameVar",
			ServiceTokenNameVar,
			"CLASSROOM50_SERVICE_TOKEN_NAME",
		},
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
// The set is ordered student-first. Update every copy in lockstep on change.
func TestClassroomTeamSlugs(t *testing.T) {
	if got := ClassroomStudentTeamSlug("cs101"); got != "classroom50-cs101" {
		t.Errorf("ClassroomStudentTeamSlug = %q, want %q", got, "classroom50-cs101")
	}
	if got := StaffTeamSlug("cs101", RoleTeacher); got != "classroom50-cs101-teacher" {
		t.Errorf("StaffTeamSlug(teacher) = %q, want %q", got, "classroom50-cs101-teacher")
	}
	if got := StaffTeamSlug("cs101", RoleHeadTA); got != "classroom50-cs101-hta" {
		t.Errorf("StaffTeamSlug(hta) = %q, want %q", got, "classroom50-cs101-hta")
	}
	// A classroom short-name may contain hyphens; the slug must not mangle them.
	want := []string{
		"classroom50-cs-principles",
		"classroom50-cs-principles-teacher",
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

// TestBuildSubmitTag pins the submit/<UTC-timestamp>-<short-sha> format
// byte-identical with the runner's tag-minting step (autograde-runner.yaml)
// and regrade_repos.py's build_submit_tag — no compile-time link.
func TestBuildSubmitTag(t *testing.T) {
	at := time.Date(2026, 8, 3, 14, 30, 5, 0, time.UTC)
	got := BuildSubmitTag(at, "abcdef0123456789")
	want := "submit/2026-08-03T14-30-05Z-abcdef0"
	if got != want {
		t.Errorf("BuildSubmitTag = %q, want %q", got, want)
	}
	// Non-UTC input must normalize to UTC (the runner uses `date -u`).
	est := time.FixedZone("EST", -5*60*60)
	if got := BuildSubmitTag(at.In(est), "abcdef0123456789"); got != want {
		t.Errorf("BuildSubmitTag(non-UTC) = %q, want %q", got, want)
	}
	// A short SHA is used as-is rather than sliced out of range.
	if got := BuildSubmitTag(at, "abc"); got != "submit/2026-08-03T14-30-05Z-abc" {
		t.Errorf("BuildSubmitTag(short sha) = %q", got)
	}
}

// TestShimUpdateCommitMessage pins the retrofit commit message: the [skip ci]
// body line is load-bearing (a tag→every-push retrofit commit carries the
// restored push trigger and must not grade itself), and the web GUI mirrors
// the whole string with NO compile-time link.
func TestShimUpdateCommitMessage(t *testing.T) {
	got := ShimUpdateCommitMessage(SubmissionModeTag)
	want := "[Classroom 50] Update autograder trigger to tag (submission-mode)\n\n[skip ci]"
	if got != want {
		t.Errorf("ShimUpdateCommitMessage = %q, want %q", got, want)
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

// TestFeedbackPRBody pins the built-in body against the cross-language golden.
// Note what this actually guards: Go (//go:embed) and TS (Vite ?raw) both RENDER
// from feedbackPrBody.md, so they cannot drift from it in prose — this test's
// render==golden check is an identity check for the Go side and, together with
// the web ?raw test, guards that both toolchains yield byte-identical bytes for
// the same .md (catching a trailing-newline / line-ending regression). The one
// copy that CAN drift in wording is the runner's hand-mirrored pr_body (Python),
// which its own skeleton test pins to this same golden. The .md is the single
// source of truth; regenerate the golden via
// `go test ./contract -run TestFeedbackPRBody -update` after editing it.
func TestFeedbackPRBody(t *testing.T) {
	rendered := FeedbackPRBody("HEAD_BRANCH", "RELEASE_URL")
	if *updateGolden {
		if err := os.WriteFile(filepath.Clean(feedbackPRBodyGoldenPath), []byte(rendered), 0o644); err != nil {
			t.Fatalf("update golden: %v", err)
		}
		t.Logf("regenerated %s from feedbackPrBody.md", feedbackPRBodyGoldenPath)
		return
	}

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
	if rendered != string(golden) {
		t.Errorf("FeedbackPRBody no longer matches %s; edit the canonical feedbackPrBody.md, then regenerate with `go test ./contract -run TestFeedbackPRBody -update` (the web and Python verify tests assert against the same golden)",
			feedbackPRBodyGoldenPath)
	}
}

// feedbackPRBodyGoldenPath locates the rendered-body golden, also consumed by
// the Python (skeleton_tests) and TypeScript (web) mirror tests.
const feedbackPRBodyGoldenPath = "testdata/feedback_pr_body.golden"

// TestFeedbackTemplateContract pins the feedback_pr_template read contract that
// the two Go readers (gh-student, gh-teacher) share from here and that the web
// GUI (TEMPLATE_PR_BODY_PATHS / TEMPLATE_PR_BODY_MAX_BYTES) and the runner
// (_TEMPLATE_PR_BODY_PATHS / _TEMPLATE_PR_BODY_MAX_BYTES) hand-mirror. A change
// here must move those copies too — the paths and their order decide which
// pull_request_template.md wins, and the byte cap decides which file every
// creator accepts/rejects, so drift would make creators disagree on the body.
func TestFeedbackTemplateContract(t *testing.T) {
	wantPaths := []string{
		".github/pull_request_template.md",
		"pull_request_template.md",
		"docs/pull_request_template.md",
	}
	if len(FeedbackTemplatePaths) != len(wantPaths) {
		t.Fatalf("FeedbackTemplatePaths = %v, want %v", FeedbackTemplatePaths, wantPaths)
	}
	for i, want := range wantPaths {
		if FeedbackTemplatePaths[i] != want {
			t.Errorf("FeedbackTemplatePaths[%d] = %q, want %q (mirror web + runner if changed)", i, FeedbackTemplatePaths[i], want)
		}
	}
	if FeedbackTemplateMaxBytes != 60_000 {
		t.Errorf("FeedbackTemplateMaxBytes = %d, want 60000 (byte-based; mirror web TEMPLATE_PR_BODY_MAX_BYTES + runner)", FeedbackTemplateMaxBytes)
	}
}

// TestScopesSatisfy pins the single OAuth scope-hierarchy source both CLIs
// share (the shared auto-login probe and gh-teacher's init preflight): a
// superset satisfies, and GitHub's org implications (admin:org ⊇ write:org ⊇
// read:org) are honored so a normalized grant isn't wrongly reported missing.
func TestScopesSatisfy(t *testing.T) {
	cases := []struct {
		name     string
		granted  []string
		required []string
		want     bool
	}{
		{"exact match", []string{"repo", "workflow"}, []string{"repo", "workflow"}, true},
		{"superset satisfies", []string{"repo", "workflow", "gist"}, []string{"repo"}, true},
		{"unified grant satisfies unified required", []string{"admin:org", "repo", "workflow"}, RequiredOAuthScopes(), true},
		{"admin:org implies read:org", []string{"admin:org"}, []string{"read:org"}, true},
		{"admin:org implies write:org", []string{"admin:org"}, []string{"write:org"}, true},
		{"write:org implies read:org", []string{"write:org"}, []string{"read:org"}, true},
		{"write:org does not imply admin:org", []string{"write:org"}, []string{"admin:org"}, false},
		{"read:org does not imply admin:org", []string{"read:org"}, []string{"admin:org"}, false},
		{"missing workflow", []string{"admin:org", "repo"}, []string{"admin:org", "repo", "workflow"}, false},
		{"empty required is satisfied", []string{"repo"}, nil, true},
		{"whitespace tolerated", []string{" repo ", "workflow"}, []string{"repo", "workflow"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ScopesSatisfy(tc.granted, tc.required); got != tc.want {
				t.Errorf("ScopesSatisfy(%v, %v) = %v, want %v", tc.granted, tc.required, got, tc.want)
			}
		})
	}
}

// TestParseScopeList pins the shared X-OAuth-Scopes parse: GitHub returns a
// comma-space-separated list, possibly empty, possibly with stray spaces.
func TestParseScopeList(t *testing.T) {
	cases := []struct {
		name string
		list string
		want []string
	}{
		{"empty", "", nil},
		{"single", "repo", []string{"repo"}},
		{"comma-space separated", "admin:org, read:org, repo, workflow", []string{"admin:org", "read:org", "repo", "workflow"}},
		{"stray spaces and empties", " repo ,, workflow ", []string{"repo", "workflow"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseScopeList(tc.list)
			if len(got) != len(tc.want) {
				t.Fatalf("ParseScopeList(%q) = %v, want %v", tc.list, got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("ParseScopeList(%q) = %v, want %v", tc.list, got, tc.want)
				}
			}
		})
	}
}
