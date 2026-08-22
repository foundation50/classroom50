// Package validate holds gh-teacher's identifier validators (org logins,
// classroom short-names, assignment slugs) — pure functions shared across
// commands with no GitHub-client dependency.
package validate

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/foundation50/classroom50-cli-shared/contract"
)

// ShortNamePattern: classroom short-names and assignment slugs both flow into
// student-repo names and the contents/tree API. Exposed for the few call sites
// that match directly; most callers should use ShortName for the standard error.
//
// The cap is 100 per segment, matching GitHub's repo-name limit — NOT a full
// guarantee: `<classroom>-<assignment>-<username>` can exceed 100 even when each
// part is legal. Budgeting the segments against each other is open work
// (foundation50/classroom50#691); until then an overflow surfaces as a legible
// "name too long" error at accept.
var ShortNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,99}$`)

// ShortNamePatternDescription: human-readable summary of ShortNamePattern,
// embedded in every "invalid <thing>" error.
const ShortNamePatternDescription = "^[a-z0-9][a-z0-9-]{1,99}$ (2-100 chars, lowercase letters/digits/hyphens, starting with a letter or digit)"

// ShortName checks name against ShortNamePattern with a label-prefixed error.
// Same rule for classroom short-names and slugs (both flow into repo names) and
// keeps traversal-style values out of the contents/tree API.
func ShortName(name, label string) error {
	if !ShortNamePattern.MatchString(name) {
		return fmt.Errorf("invalid %s %q: must match %s", label, name, ShortNamePatternDescription)
	}
	return nil
}

// orgNamePattern matches a GitHub org login: alphanumeric segments joined by
// single hyphens, 1-39 chars, case-insensitive. Laxer than ShortNamePattern
// (allows uppercase) so a real org like "CS50" validates, while traversal/garbage
// (slashes, dots, spaces) is rejected before a mid-call 404.
var orgNamePattern = regexp.MustCompile(`^[a-zA-Z0-9](-?[a-zA-Z0-9])*$`)

const orgNamePatternDescription = "1-39 alphanumeric characters with non-consecutive internal hyphens (a GitHub organization login)"

// OrgName checks org against orgNamePattern, catching typos with a clear
// message rather than a mid-command 404.
func OrgName(org string) error {
	if len(org) > 39 || !orgNamePattern.MatchString(org) {
		return fmt.Errorf("invalid org %q: must be %s", org, orgNamePatternDescription)
	}
	return nil
}

// OrgClassroom trims and validates the common `<org> <classroom>` pair: both
// non-empty, org satisfies OrgName, classroom satisfies ShortName.
func OrgClassroom(args []string) (org, classroom string, err error) {
	org = strings.TrimSpace(args[0])
	classroom = strings.TrimSpace(args[1])
	if org == "" {
		return "", "", errors.New("org must not be empty")
	}
	if err := OrgName(org); err != nil {
		return "", "", err
	}
	if classroom == "" {
		return "", "", errors.New("classroom short-name must not be empty")
	}
	if err := ShortName(classroom, "classroom"); err != nil {
		return "", "", err
	}
	return org, classroom, nil
}

// GitHubRepoNameMaxLen is GitHub's hard limit on a repository name; the
// student-repo name `<classroom>-<assignment>-<username>` is measured against it.
const GitHubRepoNameMaxLen = 100

// GitHubLoginMaxLen is GitHub's maximum login length — the worst-case
// `<username>` when budgeting the composed student-repo name.
const GitHubLoginMaxLen = 39

// ComposedRepoNameOverflows reports whether the longest student-repo name a
// classroom+assignment pair can produce (worst-case 39-char username) exceeds
// GitHub's repo-name limit; see ShortNamePattern and #691. The name shape comes
// from contract.AssignmentRepoPrefix so it can't drift from the real one.
func ComposedRepoNameOverflows(classroom, slug string) (worstCase int, overflows bool) {
	worstCase = len(contract.AssignmentRepoPrefix(classroom, slug)) + GitHubLoginMaxLen
	return worstCase, worstCase > GitHubRepoNameMaxLen
}

// ScopeListContains reports whether the comma-separated OAuth scope
// list (an X-OAuth-Scopes header value) includes want.
func ScopeListContains(scopes, want string) bool {
	for _, s := range contract.ParseScopeList(scopes) {
		if s == want {
			return true
		}
	}
	return false
}

// ScopeListSatisfies reports whether the X-OAuth-Scopes list satisfies want,
// treating a broader granted scope as covering the narrower one it implies. Use
// this (not ScopeListContains) when checking whether a token can perform an
// operation. Resolves through contract.ScopeSatisfiedBy so the auto-login probe
// (shared ghauth) and this preflight check share one scope hierarchy.
func ScopeListSatisfies(scopes, want string) bool {
	granted := make(map[string]bool)
	for _, s := range contract.ParseScopeList(scopes) {
		granted[s] = true
	}
	return contract.ScopeSatisfiedBy(granted, want)
}
