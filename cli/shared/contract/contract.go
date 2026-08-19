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
	_ "embed"
	"fmt"
	"strings"
	"time"
)

const (
	// ConfigRepoName is the per-org classroom config repo. Hardcoded across
	// student repos and the collect-scores workflow — part of the public contract.
	ConfigRepoName = "classroom50"

	// AssignmentsSchemaV1 is the schema sentinel for <classroom>/assignments.json.
	AssignmentsSchemaV1 = "classroom50/assignments/v1"

	// TeamSchemaV1 is the schema sentinel for the bootstrap JSON stored in a
	// classroom's secret student-team description (`classroom50-<short>`). Lets a
	// plain org member enumerate their classrooms and read the capability secret
	// without config-repo access. Mirrored in schemas/classroom-team-v1.schema.json
	// and the web reader (web/src/util/teamDescription.ts) with NO compile-time
	// link — keep byte-identical; contract_test.go pins the Go half.
	TeamSchemaV1 = "classroom50/team/v1"

	// InviteTeamPrefix and InviteHashHexLen describe the per-invite secret teams
	// that retain an invited email address until the student accepts:
	// `invite-<16 lowercase hex>`, a SHA-256 prefix over the classroom and
	// address (schemas/invite-v1.schema.json). The web app and `gh teacher
	// roster invite` are both writers, and both read the other's teams, so the
	// name derivation is a two-way contract.
	// Matching the FULL shape matters — `invite-` alone is a namespace a human
	// team can land in ("Invite Only" slugs to `invite-only`), which a sweep must
	// never delete. Mirrored in web/src/util/inviteTeam.ts
	// (INVITE_TEAM_PREFIX / INVITE_HASH_HEX_LEN) with NO compile-time link — keep
	// byte-identical; contract_test.go pins the Go half and the shared vectors in
	// cli/shared/testdata/invite_vectors.json pin both writers' output.
	InviteTeamPrefix = "invite-"
	InviteHashHexLen = 16

	// InviteSchemaV1 is the schema sentinel for the invite record stored in a
	// per-invite secret team's description. Mirrored in
	// schemas/invite-v1.schema.json and the web writer
	// (web/src/util/inviteTeam.ts INVITE_DESCRIPTION_SCHEMA) with NO
	// compile-time link — keep byte-identical; contract_test.go pins the Go half.
	InviteSchemaV1 = "classroom50/invite/v1"

	// InviteProvisionalDescription is what an invite team is CREATED with, so a
	// run that dies before dropping its creator leaves a team holding no email.
	// It deliberately does not parse as a v1 record, which is what makes either
	// tool's reconcile skip such a team instead of reaping it. Both the web app
	// and `gh teacher roster invite` create these teams and read the other's,
	// so the exact bytes are a two-way contract: mirrored in
	// web/src/github-core/mutations/inviteTeams.ts (PROVISIONAL_DESCRIPTION) with
	// NO compile-time link — keep byte-identical; contract_test.go pins the Go half.
	InviteProvisionalDescription = "classroom50: preparing invite"

	// InviteTeamGCMinAge is how old a MEMBER-LESS invite team must be before a
	// reconcile may reap it, so a team created moments before its org invitation
	// lands (or read mid-creation by the other writer) is never mistaken for a
	// cancelled invite. Both writers reconcile, so the gate must be identical on
	// both sides or one would reap the other's fresh invites: mirrored in
	// web/src/domain/students/inviteRecoveries.ts (INVITE_TEAM_GC_MIN_AGE_MS)
	// with NO compile-time link, pinned on each side.
	InviteTeamGCMinAge = 24 * time.Hour

	// DefaultAutograderName is the universal-shim autograder name; resolves to
	// the shim embedded in gh-student, not a per-classroom override.
	DefaultAutograderName = "default"

	// ModeIndividual and ModeGroup are the assignment modes: individual = one
	// repo per student; group = a shared repo teammates join.
	ModeIndividual = "individual"
	ModeGroup      = "group"

	// SubmissionModeEveryPush and SubmissionModeTag are the assignment
	// submission_mode values: every-push = the shim grades every push to the
	// default branch plus submit/* tags (the wire default — writers omit it);
	// tag = the shim grades ONLY submit/* tag pushes, which the submit clients
	// create. Mirrored in the assignments-v1 schema enum and the web
	// SUBMISSION_MODES; pinned by contract_test.go and the schema-parity tests.
	SubmissionModeEveryPush = "every-push"
	SubmissionModeTag       = "tag"

	// GradingModeOff, GradingModeAuto, and GradingModeManual are the assignment
	// grading.mode values — the teacher's grading intent as a first-class GUI
	// choice. auto = autograded (ABSENT reads as auto, so existing files are
	// unchanged); manual = the teacher records scores by hand (requires
	// max_points); off = not graded. Orthogonal to the autograding tri-state and
	// to collection (nothing in the grading pipeline reads grading). Mirrored in
	// the assignments-v1 schema enum and the web GRADING_MODES; pinned by the
	// schema-parity tests.
	GradingModeOff    = "off"
	GradingModeAuto   = "auto"
	GradingModeManual = "manual"

	// SubmitTagPrefix is the tag namespace that marks a grading submission:
	// only submit/* tag Releases count as submissions everywhere (runner,
	// collect_scores.py SUBMIT_TAG_PREFIX, regrade_repos.py, the web
	// SUBMISSION_TAG_PREFIX). Hand-mirrored with NO compile-time link — keep
	// byte-identical; contract_test.go pins the Go half.
	SubmitTagPrefix = "submit/"

	// Repo collaborator permission levels, GitHub's low-to-high ladder. Used
	// for an assignment's optional student_permission (the access the enrolled
	// student gets on their own repo at accept time) and mirrored in the web
	// RepoAccessPermission union and the assignments-v1 schema enum.
	PermissionPull     = "pull"
	PermissionTriage   = "triage"
	PermissionPush     = "push"
	PermissionMaintain = "maintain"
	PermissionAdmin    = "admin"

	// ResultFilename and ReleaseBodyFilename are the autograder's output
	// artifacts in the student workspace: the required result.json (the grading
	// payload collect-scores ingests) and the optional release-body.md. The
	// submit/allowed_files paths must never strip them. Mirror runner.py's
	// RESULT_FILENAME / RELEASE_BODY_FILENAME.
	ResultFilename      = "result.json"
	ReleaseBodyFilename = "release-body.md"

	// RosterFilename is the per-classroom roster file
	// (<classroom>/roster.csv). Hand-mirrored with NO compile-time link in the
	// web GUI (web/src/util/rosterPath.ts) and the Python collect-scores script
	// (collect_scores.py ROSTER_FILENAME) — keep all copies byte-identical;
	// contract_test.go pins the Go half.
	RosterFilename = "roster.csv"

	// ServiceTokenSecretName is the repo-level Actions secret on the classroom50 repository
	// holding the fine-grained PAT that collect-scores.yaml / regrade.yaml
	// consume. Hand-mirrored with NO compile-time link in the collect-scores /
	// regrade workflow YAML, the gh-teacher servicetoken package (SecretName),
	// and the web GUI (web/src/github-core/queries/releaseRunReads.ts
	// SERVICE_TOKEN_SECRET_NAME) — keep byte-identical; contract_test.go pins
	// the Go half.
	ServiceTokenSecretName = "CLASSROOM50_SERVICE_TOKEN"

	// ServiceTokenExpiresAtVar is the repo-level Actions VARIABLE (readable,
	// unlike the secret) recording the service token's expected expiry as an
	// RFC 3339 timestamp, so the web GUI can show an expiry countdown and warn
	// before the nightly collect breaks. Advisory only: it records the teacher's
	// chosen `expires_in`, which GitHub does not echo back for a fine-grained
	// PAT. Currently WRITTEN ONLY BY THE WEB GUI on save/rotate; the CLI
	// rotate/init path provisions the secret without it, so a CLI-provisioned
	// token reads back with no recorded expiry (the web health chip then shows
	// "expiry not tracked", not a false "healthy"). Hand-mirrored (no
	// compile-time link) in the web GUI — keep byte-identical.
	ServiceTokenExpiresAtVar = "CLASSROOM50_SERVICE_TOKEN_EXPIRES_AT"

	// ServiceTokenNameVar is the repo-level Actions VARIABLE recording the
	// service token's display NAME. GitHub does not expose a fine-grained PAT's
	// name via the API, so this is the label Classroom 50 shows for the token
	// (prefilled into the token-creation form and renamable afterward). Advisory
	// only, and — like ServiceTokenExpiresAtVar — currently written only by the
	// web GUI. Hand-mirrored (no compile-time link) in the web GUI — keep
	// byte-identical.
	ServiceTokenNameVar = "CLASSROOM50_SERVICE_TOKEN_NAME"

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

	// FeedbackBaseBranch is the frozen Feedback-PR base branch, pinned at each
	// student repo's baseline (accept) commit so the PR diff always shows the
	// full body of work. Created by whichever side gets there first — `gh
	// student accept` / the web accept flow (issue #228) or the autograde
	// runner — and locked against student updates by the
	// `classroom50-feedback-base-lock` org ruleset. Hand-mirrored with NO
	// compile-time link in ensure_feedback_pr.py (BASE_BRANCH) and the web GUI
	// (web/src/domain/assignments/feedbackPr.ts) — keep byte-identical.
	FeedbackBaseBranch = "feedback"

	// FeedbackPRTitle is the Feedback PR's title. Byte-identical with
	// ensure_feedback_pr.py's `--title` and the web GUI so the runner and both
	// accept clients produce indistinguishable PRs.
	FeedbackPRTitle = "Feedback"

	// MetadataPath is the in-repo accept marker (`.classroom50.yaml`) every
	// accept client writes in its accept commit. It doubles as the Feedback-PR
	// baseline anchor: the runner and the checkout-less API clients resolve the
	// frozen `feedback` base as "the (oldest) commit touching this path", so the
	// commit subject carries no contract — only the path does. Hand-mirrored with
	// NO compile-time link in runner.py (ACCEPT_MARKER_PATH), the web GUI, and
	// schemas/repo-config-v1.schema.json — keep byte-identical; contract_test.go
	// pins the Go half.
	MetadataPath = ".classroom50.yaml"

	// FeedbackTemplateMaxBytes caps the teacher-supplied pull_request_template.md
	// read so an oversized/binary file can't overflow GitHub's PR-body ceiling
	// (~65_536 chars); an over-limit file falls back to the built-in body, like
	// a missing one. Byte-based; the web copy (TEMPLATE_PR_BODY_MAX_BYTES) and
	// the runner (_TEMPLATE_PR_BODY_MAX_BYTES) must use the same byte semantics.
	FeedbackTemplateMaxBytes = 60_000
)

// FeedbackTemplatePaths are GitHub's native pull request template locations,
// probed in this order to source the Feedback PR body when an assignment sets
// feedback_pr_template. Hand-mirrored with NO compile-time link in the web GUI
// (TEMPLATE_PR_BODY_PATHS) and the runner (_TEMPLATE_PR_BODY_PATHS) — keep the
// list and order byte-identical; contract_test.go pins the Go half.
var FeedbackTemplatePaths = []string{
	".github/pull_request_template.md",
	"pull_request_template.md",
	"docs/pull_request_template.md",
}

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
// accident. The web GUI matches that posture — it adds read:user to this set but
// requests delete_repo only on demand, when a teacher elevates for teardown.
var requiredOAuthScopes = []string{"admin:org", "read:org", "repo", "workflow"}

// RequiredOAuthScopes returns the unified OAuth scope set (a fresh copy so
// callers can't mutate the shared backing array). Both CLIs' RequiredScopes()
// and their auto-login path resolve to this.
func RequiredOAuthScopes() []string {
	return append([]string(nil), requiredOAuthScopes...)
}

// scopeImpliedBy maps an OAuth scope to the broader scopes that include it.
// GitHub normalizes granted scopes, dropping any implied by a broader one, so a
// token with `admin:org` reports only that; a whole-token match for `read:org`
// would then wrongly report it missing. Single source of the OAuth scope
// hierarchy for both CLIs — the shared auto-login scope probe (ghauth) and
// gh-teacher's init preflight / validate both resolve through it, so a
// required-scope change can't make two paths disagree. Kept in contract (a pure
// package, no go-gh client dependency) so the pure validators can share it.
// Extend when a new required scope has implied parents.
var scopeImpliedBy = map[string][]string{
	"read:org":  {"admin:org", "write:org"},
	"write:org": {"admin:org"},
}

// ParseScopeList splits an X-OAuth-Scopes header value (a comma-separated OAuth
// scope list) into trimmed, non-empty scopes. Single source of the scope-list
// parse shared by both CLIs' scope checks. Returns nil for an empty list.
func ParseScopeList(list string) []string {
	var scopes []string
	for _, s := range strings.Split(list, ",") {
		if s = strings.TrimSpace(s); s != "" {
			scopes = append(scopes, s)
		}
	}
	return scopes
}

// ScopeSatisfiedBy reports whether a token whose granted OAuth scopes are keyed
// true in have satisfies the single scope want, honoring the scope hierarchy (a
// broader granted scope covers the narrower one it implies).
func ScopeSatisfiedBy(have map[string]bool, want string) bool {
	if have[want] {
		return true
	}
	for _, broader := range scopeImpliedBy[want] {
		if have[broader] {
			return true
		}
	}
	return false
}

// ScopesSatisfy reports whether granted covers every scope in required,
// honoring the OAuth scope hierarchy (e.g. admin:org implies read:org and
// write:org). Elements are trimmed; empty required is vacuously satisfied.
func ScopesSatisfy(granted, required []string) bool {
	have := make(map[string]bool, len(granted))
	for _, g := range granted {
		have[strings.TrimSpace(g)] = true
	}
	for _, r := range required {
		if !ScopeSatisfiedBy(have, strings.TrimSpace(r)) {
			return false
		}
	}
	return true
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

// FeedbackOpenCommitMessage is the empty commit `gh student accept` / the web
// accept flow pushes so the accept-time Feedback PR has a commit to hang on
// (GitHub rejects a zero-diff PR with "No commits between ..."). The `[skip
// ci]` body line keeps the autograde shim from running on it; if GitHub ever
// stopped honoring the token the run would be noisy but harmless (the runner
// grades an unchanged tree). Hand-mirrored with NO compile-time link in the
// web GUI (web/src/domain/assignments/feedbackPr.ts) — keep byte-identical.
func FeedbackOpenCommitMessage() string {
	return PrefixCommit("Open Feedback PR (gh student accept)") + "\n\n[skip ci]"
}

// FeedbackLabelForMode is the Feedback PR's mode label and color, mirroring
// GitHub Classroom's Individual/Group feedback labels so a teacher can tell
// the modes apart at a glance. Unknown modes fall back to individual.
// Byte-identical with ensure_feedback_pr.py `_LABELS` / `label_for_mode` and
// the web GUI — the runner adopts the accept-time PR, so both sides must
// produce the same label or teachers see two.
func FeedbackLabelForMode(mode string) (name, color string) {
	if strings.TrimSpace(strings.ToLower(mode)) == ModeGroup {
		return "Group Assignment", "5319E7"
	}
	return "Individual Assignment", "0E8A16"
}

// SubmissionModes is every valid assignments.json submission_mode value.
// Single-sources the allow-list; the schema enum in assignments-v1.schema.json
// and the web SUBMISSION_MODES mirror it (parity-tested on both sides).
var SubmissionModes = []string{SubmissionModeEveryPush, SubmissionModeTag}

// IsValidSubmissionMode reports whether m is one of the SubmissionModes.
func IsValidSubmissionMode(m string) bool {
	for _, allowed := range SubmissionModes {
		if m == allowed {
			return true
		}
	}
	return false
}

// GradingModes is every valid assignments.json grading.mode value.
// Single-sources the allow-list; the schema enum in assignments-v1.schema.json
// and the web GRADING_MODES mirror it (parity-tested on both sides).
var GradingModes = []string{GradingModeOff, GradingModeAuto, GradingModeManual}

// IsValidGradingMode reports whether m is one of the GradingModes.
func IsValidGradingMode(m string) bool {
	for _, allowed := range GradingModes {
		if m == allowed {
			return true
		}
	}
	return false
}

// BuildSubmitTag is the canonical submission tag for a commit:
// submit/<UTC-timestamp>-<short-sha>. Byte-format-identical with the runner's
// tag-minting step in autograde-runner.yaml and regrade_repos.py's
// build_submit_tag — the short-SHA suffix prevents collisions when two
// submissions land in the same UTC second.
func BuildSubmitTag(now time.Time, sha string) string {
	short := sha
	if len(short) > 7 {
		short = short[:7]
	}
	return SubmitTagPrefix + now.UTC().Format("2006-01-02T15-04-05Z") + "-" + short
}

// ShimUpdateCommitMessage is the commit message for a submission-mode shim
// retrofit in a student repo. The `[skip ci]` body line is load-bearing: a
// tag→every-push retrofit commit carries the restored push trigger, and
// without it the shim would grade the retrofit commit itself (pushes with a
// user OAuth token DO fire workflows). The runner's shim-update detection is
// the backstop. Hand-mirrored with NO compile-time link in the web GUI
// (web/src/domain/assignments/submissionTrigger.ts) — keep byte-identical.
func ShimUpdateCommitMessage(mode string) string {
	return PrefixCommit("Update autograder trigger to "+mode+" (submission-mode)") + "\n\n[skip ci]"
}

// RepoPermissions is GitHub's collaborator permission ladder, low to high.
// Single-sources the assignment student_permission allow-list; the web mirror
// is RepoAccessPermission and the schema enum in assignments-v1.schema.json.
var RepoPermissions = []string{
	PermissionPull, PermissionTriage, PermissionPush, PermissionMaintain, PermissionAdmin,
}

// IsValidRepoPermission reports whether p is one of the RepoPermissions.
func IsValidRepoPermission(p string) bool {
	for _, allowed := range RepoPermissions {
		if p == allowed {
			return true
		}
	}
	return false
}

// DefaultStudentPermission is the accept-time role a student gets on their own
// repo when an assignment sets no student_permission: least-privilege push for
// individual, admin for group (a group founder must manage collaborators).
// Mirrors the web founderPermission default and gh-student's.
func DefaultStudentPermission(mode string) string {
	if strings.TrimSpace(strings.ToLower(mode)) == ModeGroup {
		return PermissionAdmin
	}
	return PermissionPush
}

// feedbackPRBodyTemplate is the single canonical source for the built-in
// Feedback PR body, shared as a build-time source across Go, TypeScript
// (web imports it via `?raw`), and Python (mirrored, pinned by the golden).
// It carries three placeholder tokens — HEAD_BRANCH, RELEASE_URL, BASE_BRANCH —
// substituted at render time. Edit this .md to change the body everywhere;
// then regenerate the golden (`go test ./contract -run TestFeedbackPRBody -update`)
// and the per-language verify tests will confirm every copy still matches.
//
//go:embed feedbackPrBody.md
var feedbackPRBodyTemplate string

// FeedbackPRBody is the built-in Feedback PR body, rendered from the canonical
// feedbackPrBody.md by substituting the head branch, the static release URL,
// and the frozen base branch. It stays byte-identical with the output of
// ensure_feedback_pr.py's pr_body(head, release_url) and the web GUI copy
// (feedbackPr.ts), pinned by the cross-language golden.
//
// releaseURL is the static `https://github.com/{org}/{repo}/releases/latest`
// pointer (not a pinned tag) so the link self-updates as submissions publish;
// once written at PR creation it never needs rewriting.
func FeedbackPRBody(head, releaseURL string) string {
	return strings.NewReplacer(
		"HEAD_BRANCH", head,
		"RELEASE_URL", releaseURL,
		"BASE_BRANCH", FeedbackBaseBranch,
	).Replace(feedbackPRBodyTemplate)
}

// StaffRole is a per-classroom staff role backing the web GUI's in-app roles.
// Each maps to a `secret` GitHub team named `classroom50-<short>-<role>`.
// Mirrors web StaffRole (web/src/types/classroom.ts) and gh-teacher
// configrepo.StaffRole — a cross-tool contract with no compile-time link.
type StaffRole string

const (
	RoleTeacher StaffRole = "teacher"
	RoleHeadTA  StaffRole = "hta"
	RoleTA      StaffRole = "ta"
)

// StaffRoles is every staff role, in rank order (teacher, then the head-TA
// middle tier, then ta). Mirrors web STAFF_ROLES.
var StaffRoles = []StaffRole{
	RoleTeacher,
	RoleHeadTA,
	RoleTA,
}

// ClassroomStudentTeamSlug is the single source of the student team slug
// `classroom50-<short>`. The short-name is canonical (lowercase alnum +
// hyphens), so the slug equals the name. Byte-mirrors web classroomTeamSlug and
// gh-teacher classroomTeamName — keep in lockstep (pinned by contract_test.go).
func ClassroomStudentTeamSlug(shortName string) string {
	return ConfigRepoName + "-" + shortName
}

// StaffTeamSlug is the single source of a staff-role team slug
// `classroom50-<short>-<role>`. Byte-mirrors web classroomTeamSlug(short, role)
// and gh-teacher staffTeamName.
func StaffTeamSlug(shortName string, role StaffRole) string {
	return ConfigRepoName + "-" + shortName + "-" + string(role)
}

// ClassroomTeamSlugs is the full set of team slugs whose membership means a
// user is enrolled in a classroom: the student team plus every staff team.
// Single-sources the "is enrolled?" slug enumeration so a role change can't
// drift the gate. Ordered student-first so a sequential caller can
// short-circuit on the common case.
func ClassroomTeamSlugs(shortName string) []string {
	slugs := []string{ClassroomStudentTeamSlug(shortName)}
	for _, role := range StaffRoles {
		slugs = append(slugs, StaffTeamSlug(shortName, role))
	}
	return slugs
}
