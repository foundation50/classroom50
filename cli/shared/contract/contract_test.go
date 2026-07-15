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
	}
	for _, tc := range cases {
		if tc.got != tc.want {
			t.Errorf("%s = %q, want %q (cross-binary contract drift — update every language copy in lockstep)", tc.name, tc.got, tc.want)
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
