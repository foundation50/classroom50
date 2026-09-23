package contract

import (
	_ "embed"
	"strings"
)

// AutogradeShimPath is the default autograde shim's path inside every student
// repo. Hand-mirrored with NO compile-time link in the web
// (AUTOGRADE_SHIM_PATH, web/src/domain/assignments/submissionTrigger.ts) and
// runner.py's SHIM_UPDATE_COMMIT_PATHS. Keep byte-identical.
const AutogradeShimPath = ".github/workflows/autograde.yaml"

// defaultShimTemplate is the universal autograde shim: the same body for every
// student repo across every org, with the per-repo values left as placeholders.
// Both `gh student accept` and `gh teacher assignment enable-autograder` render
// it, so it lives here rather than in either command's module. Kept as a real
// YAML file so actionlint can validate it (lint-ci.yaml).
//
//go:embed autograde-shim.yaml
var defaultShimTemplate string

const (
	shimOrgPlaceholder          = "{{ORG}}"
	shimBranchPlaceholder       = "{{BRANCH}}"
	shimConfigBranchPlaceholder = "{{CONFIG_BRANCH}}"
	defaultShimBranch           = "main"
)

// shimBranchTriggerLine is the exact `on.push.branches` line of the template
// (before substitution). Tag submission mode removes it so the shim triggers
// only on tag pushes. Pinned by shim_test.go so a template edit can't silently
// break the line surgery.
const shimBranchTriggerLine = "    branches: [\"" + shimBranchPlaceholder + "\"]\n"

// shimTagsTriggerLine is the exact `on.push.tags` line of the template.
// Milestone submission_tags widen it to their union with submit/*.
const shimTagsTriggerLine = "    tags: [\"submit/*\"]\n"

// RenderDefaultShim returns the default shim with the org, submission-branch,
// and config-repo-branch placeholders substituted. Empty branches default to
// main.
//
// submissionMode SubmissionModeTag drops the branch-push trigger line so only
// submission-tag pushes grade; any other value (including "" and every-push)
// keeps the every-push shim byte-identical. submissionTags widen the tags
// trigger to their union with the always-on submit/* namespace; empty keeps
// the tags line verbatim. The two are orthogonal.
//
// The mode/tags edits are exact-line surgery rather than template branches so
// the template stays one lintable file. If a line ever changes shape the tests
// fail, and the fallback is still a valid every-push shim rather than garbage.
func RenderDefaultShim(org, branch, configBranch, submissionMode string, submissionTags []string) string {
	if branch == "" {
		branch = defaultShimBranch
	}
	if configBranch == "" {
		configBranch = defaultShimBranch
	}
	shim := defaultShimTemplate
	if submissionMode == SubmissionModeTag {
		shim = strings.Replace(shim, shimBranchTriggerLine, "", 1)
	}
	if len(submissionTags) > 0 {
		shim = strings.Replace(shim, shimTagsTriggerLine,
			"    tags: ["+ShimTagsList(submissionTags)+"]\n", 1)
	}
	out := strings.ReplaceAll(shim, shimOrgPlaceholder, org)
	out = strings.ReplaceAll(out, shimBranchPlaceholder, branch)
	out = strings.ReplaceAll(out, shimConfigBranchPlaceholder, configBranch)
	return out
}

// ShimBackfillCommitMessage is the message of the commit that adds the default
// shim to a student repo accepted while the built-in autograder was off
// (`gh teacher assignment enable-autograder` / the gradebook bulk action).
// The `[skip ci]` body line keeps the freshly added push trigger from grading
// the commit itself; runner.py's shim-update detection is the backstop.
// Hand-mirrored with NO compile-time link in the web
// (web/src/util/commit.ts, SHIM_BACKFILL_COMMIT_MESSAGE) and in
// collect_scores.py's TOOL_COMMIT_SUBJECTS. Keep byte-identical.
func ShimBackfillCommitMessage() string {
	return PrefixCommit("Add autograde workflow (enable-autograder)") + "\n\n[skip ci]"
}

// ShimBackfillCommitSubject is ShimBackfillCommitMessage's first line. Every
// baseline reader compares the marker's introducing commit against it: a
// marker the backfill added belongs to a repo accepted without one
// (no_autograder), whose baseline is the ROOT commit, and moving the baseline
// onto the backfill would strand a Feedback PR frozen at the root behind the
// runner's base check for the repo's whole life. Hand-mirrored in runner.py
// and collect_scores.py (SHIM_BACKFILL_COMMIT_SUBJECT) and the web
// (getMarkerBaseline).
func ShimBackfillCommitSubject() string {
	return CommitSubject(ShimBackfillCommitMessage())
}

// CommitSubject is a commit message's first line, trimmed: the part the tool's
// bookkeeping commits are matched on, since their `[skip ci]` marker lives in
// the body.
func CommitSubject(message string) string {
	subject, _, _ := strings.Cut(message, "\n")
	return strings.TrimSpace(subject)
}
