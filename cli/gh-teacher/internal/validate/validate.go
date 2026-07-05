// Package validate holds gh-teacher's identifier validators (org logins,
// classroom short-names, assignment slugs) — pure functions shared across
// commands with no GitHub-client dependency.
package validate

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// ShortNamePattern: classroom short-names and assignment slugs both flow into
// student-repo names and the contents/tree API. Exposed for the few call sites
// that match directly; most callers should use ShortName for the standard error.
var ShortNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,38}$`)

// ShortNamePatternDescription: human-readable summary of ShortNamePattern,
// embedded in every "invalid <thing>" error.
const ShortNamePatternDescription = "^[a-z0-9][a-z0-9-]{1,38}$ (2-39 chars, lowercase letters/digits/hyphens, starting with a letter or digit)"

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

// ScopeListContains reports whether the comma-separated OAuth scope
// list (an X-OAuth-Scopes header value) includes want.
func ScopeListContains(scopes, want string) bool {
	for _, s := range strings.Split(scopes, ",") {
		if strings.TrimSpace(s) == want {
			return true
		}
	}
	return false
}

// scopeImpliedBy maps an OAuth scope to broader scopes that include it. GitHub
// normalizes granted scopes, dropping any implied by a broader one, so a token
// with `admin:org` reports only that and a whole-token match for `read:org`
// would wrongly report it missing. Only the org hierarchy is listed (the only
// implication in gh-teacher's scopes); extend if a new required scope has
// implied parents.
var scopeImpliedBy = map[string][]string{
	"read:org":  {"admin:org", "write:org"},
	"write:org": {"admin:org"},
}

// ScopeListSatisfies reports whether the X-OAuth-Scopes list satisfies want,
// treating a broader granted scope as covering the narrower one it implies. Use
// this (not ScopeListContains) when checking whether a token can perform an
// operation.
func ScopeListSatisfies(scopes, want string) bool {
	if ScopeListContains(scopes, want) {
		return true
	}
	for _, broader := range scopeImpliedBy[want] {
		if ScopeListContains(scopes, broader) {
			return true
		}
	}
	return false
}
