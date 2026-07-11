package contract

import (
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
