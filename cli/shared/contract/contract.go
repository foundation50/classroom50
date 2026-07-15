// Package contract holds the cross-binary wire constants shared by the
// gh-teacher and gh-student CLIs (and, by value, the Python autograde/collect
// scripts): repo names, schema sentinels, assignment modes, the default
// autograder name. One place replaces per-module copies coupled only by
// "keep in lockstep" comments — drift here silently breaks a cross-binary
// handoff with no compile error.
//
// Values must stay byte-identical to the Python literals in
// cli/gh-teacher/skeleton/dotgithub/scripts/ (runner.py, collect_scores.py,
// materialize_tests.py) and the JSON Schemas under schemas/. Nothing links
// them at compile time — Python's skeleton_tests assert their own copies and
// don't import these constants — so Go<->Python agreement is convention, not
// enforced. contract_test.go pins the Go half: a Go-side edit fails a test,
// but the cross-language check stays manual.
package contract

import (
	"fmt"
	"strings"
)

const (
	// ConfigRepoName is the per-org classroom config repo. Hardcoded across
	// student repos and the collect-scores workflow — part of the public contract.
	ConfigRepoName = "classroom50"

	// AssignmentsSchemaV1 is the schema sentinel for <classroom>/assignments.json.
	AssignmentsSchemaV1 = "classroom50/assignments/v1"

	// DefaultAutograderName is the universal-shim autograder name; resolves to
	// the shim embedded in gh-student, not a per-classroom override.
	DefaultAutograderName = "default"

	// ModeIndividual and ModeGroup are the assignment modes: individual = one
	// repo per student; group = a shared repo teammates join.
	ModeIndividual = "individual"
	ModeGroup      = "group"

	// ResultFilename and ReleaseBodyFilename are the autograder's output
	// artifacts in the student workspace: the required result.json (the grading
	// payload collect-scores ingests) and the optional release-body.md. The
	// submit/allowed_files paths must never strip them. Mirror runner.py's
	// RESULT_FILENAME / RELEASE_BODY_FILENAME.
	ResultFilename      = "result.json"
	ReleaseBodyFilename = "release-body.md"

	// RosterFilename is the per-classroom roster file
	// (<classroom>/roster.csv). LegacyRosterFilename is the pre-rename name;
	// readers fall back to it so classrooms bootstrapped before the rename keep
	// working, and `gh teacher roster migrate` converges them. Writers always
	// target RosterFilename. Hand-mirrored with NO compile-time link in the web
	// GUI (web/src/util/rosterPath.ts) and the Python collect-scores script
	// (collect_scores.py ROSTER_FILENAME / LEGACY_ROSTER_FILENAME) — keep all
	// copies byte-identical; contract_test.go pins the Go half.
	RosterFilename       = "roster.csv"
	LegacyRosterFilename = "students.csv"

	// SecretPattern is the anchored regex a per-classroom capability-URL secret
	// must match: 4-64 lowercase-alphanumeric chars (one safe URL path segment
	// for `<classroom>/<secret>/...`). Single-sourced because the rule is a
	// cross-binary AND cross-language contract. Both Go modules compile their
	// regex from this (configrepo.SecretPattern, classroomcfg secretPattern);
	// the non-importable copies (runner.py, autograde-runner.yaml,
	// publish-pages.yaml, both schemas/, the web GUI) must stay byte-identical
	// and are pinned by contract_test.go.
	SecretPattern = "^[a-z0-9]{4,64}$"

	// SecretPatternDescription is the human-readable summary in the "invalid
	// secret" error, kept in lockstep with SecretPattern.
	SecretPatternDescription = "4-64 lowercase letters or digits ([a-z0-9])"

	// CommitPrefix marks every tool-authored commit so teacher and student can
	// tell them apart from their own in the repo history. Prepended (via
	// PrefixCommit) by every CLI commit path; hand-mirrored with NO compile-time
	// link in the web GUI (web/src/util/commit.ts COMMIT_PREFIX) and the
	// skeleton collect-scores.yaml workflow — keep all three byte-identical.
	CommitPrefix = "[Classroom 50]"
)

// requiredOAuthScopes is the unified OAuth scope set both CLIs request on top
// of gh's defaults. Identical across the two binaries (issue #246) so a user
// who authenticates for one never re-auths for the other.
//   - admin:org: org-membership/invite endpoints (`gh teacher invite`,
//     `gh teacher member list`, pending-invitation reads). Implies read:org.
//   - read:org:  the org-membership lookup in `gh student accept`. Kept
//     explicit for clarity and web-GUI parity even though admin:org implies it.
//   - repo:      assignment-repo creation, contents writes, collaborator mgmt.
//   - workflow:  committing .github/workflows/* via the Git Data API (both
//     `gh teacher init` and `gh student accept`); GitHub 404s that write
//     without it and gh adds it only incidentally.
//
// delete_repo is deliberately NOT here: it stays opt-in for `gh teacher
// teardown` (`gh teacher login -s delete_repo`) so nobody wipes an org by
// accident. The web GUI intentionally requests a superset (adds read:user and
// delete_repo), separate from this CLI-parity set.
var requiredOAuthScopes = []string{"admin:org", "read:org", "repo", "workflow"}

// RequiredOAuthScopes returns the unified OAuth scope set (a fresh copy so
// callers can't mutate the shared backing array). Both CLIs' RequiredScopes()
// and their auto-login path resolve to this.
func RequiredOAuthScopes() []string {
	return append([]string(nil), requiredOAuthScopes...)
}

// PrefixCommit prepends CommitPrefix, producing the canonical "[Classroom 50]
// <message>" form. Any trailing "(gh ... )" provenance hint inside message is
// preserved verbatim.
func PrefixCommit(message string) string {
	return CommitPrefix + " " + message
}

// AssignmentRepoPrefix is the single source of the assignment-repo name prefix
// `<classroom>-<assignment>-` (all lowercased). Both the producer
// (AssignmentRepoName) and consumers that strip it to recover the owner derive
// from this, so the `<classroom>-<assignment>-<owner>` shape can only change in
// one place. Cross-binary with NO compile-time link — keep byte-identical with
// the Python mirrors: runner.py::username_from_repo, and assignment_repo_name in
// collect_scores.py and regrade_repos.py. A drift here silently makes
// `gh teacher download` return zero repos and misidentifies every submission.
func AssignmentRepoPrefix(classroom, assignment string) string {
	return fmt.Sprintf("%s-%s-",
		strings.ToLower(classroom),
		strings.ToLower(assignment),
	)
}

// AssignmentRepoName is the canonical lowercased
// `<classroom>-<assignment>-<username>` assignment-repo name.
func AssignmentRepoName(classroom, assignment, username string) string {
	return AssignmentRepoPrefix(classroom, assignment) + strings.ToLower(username)
}
