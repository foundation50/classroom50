package validate

import (
	"strings"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/contract"
)

func TestScopeListContains(t *testing.T) {
	// Whole-token match against the comma-separated X-OAuth-Scopes list.
	cases := []struct {
		name   string
		scopes string
		want   string
		found  bool
	}{
		{"present among several", "admin:org, gist, repo, workflow", "workflow", true},
		{"absent", "admin:org, gist, repo", "workflow", false},
		{"single value", "workflow", "workflow", true},
		{"empty list", "", "workflow", false},
		{"no substring match", "admin:org", "org", false},
		{"surrounding spaces trimmed", "  workflow  ,repo", "workflow", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ScopeListContains(tc.scopes, tc.want); got != tc.found {
				t.Fatalf("ScopeListContains(%q, %q) = %v, want %v", tc.scopes, tc.want, got, tc.found)
			}
		})
	}
}

func TestScopeListSatisfies(t *testing.T) {
	// A broader granted scope satisfies the narrower one it implies —
	// GitHub normalizes the header, so requesting `admin:org` + `read:org`
	// returns only `admin:org`, and a plain read:org check would wrongly
	// see it as missing.
	cases := []struct {
		name    string
		scopes  string
		want    string
		satisfy bool
	}{
		{"exact match", "admin:org, repo, workflow", "repo", true},
		{"read:org satisfied by admin:org (the normalization case)", "admin:org, repo, workflow", "read:org", true},
		{"read:org satisfied by write:org", "write:org, repo", "read:org", true},
		{"write:org satisfied by admin:org", "admin:org", "write:org", true},
		{"read:org present literally", "read:org, repo", "read:org", true},
		{"read:org genuinely missing", "repo, workflow", "read:org", false},
		{"non-implied scope still requires exact match", "admin:org", "workflow", false},
		{"admin:org not implied by read:org (no upward implication)", "read:org", "admin:org", false},
		{"empty list", "", "read:org", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ScopeListSatisfies(tc.scopes, tc.want); got != tc.satisfy {
				t.Fatalf("ScopeListSatisfies(%q, %q) = %v, want %v", tc.scopes, tc.want, got, tc.satisfy)
			}
		})
	}
}

func TestShortName_LabelFlowsIntoError(t *testing.T) {
	// The label is part of the error surface — callers pass
	// "slug", "short-name", or "classroom" and the teacher should
	// see that exact noun back. Pin it so a refactor can't quietly
	// hardcode a single label.
	cases := []struct {
		label    string
		name     string
		wantPart string
	}{
		{"slug", "Bad-Slug", `invalid slug "Bad-Slug"`},
		{"short-name", "Bad-Short", `invalid short-name "Bad-Short"`},
		{"classroom", "Bad-Classroom", `invalid classroom "Bad-Classroom"`},
	}
	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			err := ShortName(tc.name, tc.label)
			if err == nil {
				t.Fatalf("ShortName(%q, %q) = nil, want error", tc.name, tc.label)
			}
			if !strings.Contains(err.Error(), tc.wantPart) {
				t.Fatalf("err = %q, want substring %q", err.Error(), tc.wantPart)
			}
			// Every error must carry the pattern description so a
			// hand-editor learns the rule without external docs.
			if !strings.Contains(err.Error(), ShortNamePatternDescription) {
				t.Errorf("err = %q, want substring %q", err.Error(), ShortNamePatternDescription)
			}
		})
	}
}

func TestOrgClassroom(t *testing.T) {
	t.Run("trims and returns valid args", func(t *testing.T) {
		org, classroom, err := OrgClassroom([]string{"  cs50-fall-2026 ", " cs-principles "})
		if err != nil {
			t.Fatalf("OrgClassroom: %v", err)
		}
		if org != "cs50-fall-2026" || classroom != "cs-principles" {
			t.Errorf("got (%q, %q), want trimmed (cs50-fall-2026, cs-principles)", org, classroom)
		}
	})

	t.Run("empty org rejected", func(t *testing.T) {
		_, _, err := OrgClassroom([]string{"   ", "cs-principles"})
		if err == nil || !strings.Contains(err.Error(), "org must not be empty") {
			t.Fatalf("err = %v, want 'org must not be empty'", err)
		}
	})

	t.Run("empty classroom rejected", func(t *testing.T) {
		_, _, err := OrgClassroom([]string{"cs50-fall-2026", "  "})
		if err == nil || !strings.Contains(err.Error(), "classroom short-name must not be empty") {
			t.Fatalf("err = %v, want 'classroom short-name must not be empty'", err)
		}
	})

	t.Run("invalid classroom short-name rejected via ShortName", func(t *testing.T) {
		_, _, err := OrgClassroom([]string{"cs50-fall-2026", "Bad_Name!"})
		if err == nil || !strings.Contains(err.Error(), ShortNamePatternDescription) {
			t.Fatalf("err = %v, want the short-name pattern error", err)
		}
	})

	t.Run("invalid org rejected via OrgName", func(t *testing.T) {
		_, _, err := OrgClassroom([]string{"bad org!", "cs-principles"})
		if err == nil || !strings.Contains(err.Error(), "invalid org") {
			t.Fatalf("err = %v, want an 'invalid org' error", err)
		}
	})
}

func TestOrgName(t *testing.T) {
	valid := []string{
		"cs50",
		"CS50",           // org logins allow uppercase (case-insensitive)
		"Foundation50",   // mixed case
		"cs50-fall-2026", // internal hyphens
		"a",              // single char is a valid login
		"1password",      // may start with a digit
	}
	for _, org := range valid {
		if err := OrgName(org); err != nil {
			t.Errorf("OrgName(%q) = %v, want nil", org, err)
		}
	}

	invalid := []string{
		"",                      // empty
		"-leadinghyphen",        // leading hyphen
		"trailinghyphen-",       // trailing hyphen
		"double--hyphen",        // consecutive hyphens
		"has space",             // space
		"has/slash",             // path separator (the traversal case)
		"has.dot",               // dot
		strings.Repeat("a", 40), // over 39 chars
	}
	for _, org := range invalid {
		if err := OrgName(org); err == nil {
			t.Errorf("OrgName(%q) = nil, want an error", org)
		}
	}
}

func TestClassroomShortNameBudget(t *testing.T) {
	if err := ClassroomShortNameBudget(strings.Repeat("a", contract.ClassroomShortNameMaxLen)); err != nil {
		t.Errorf("a cap-length short-name must pass, got %v", err)
	}
	err := ClassroomShortNameBudget(strings.Repeat("a", contract.ClassroomShortNameMaxLen+1))
	if err == nil {
		t.Fatal("an over-cap short-name must fail")
	}
	// The error must be actionable: name the cap and the reason.
	if !strings.Contains(err.Error(), "capped at 40") || !strings.Contains(err.Error(), "<short-name>-<assignment>-<username>") {
		t.Errorf("err = %q, want the cap and the repo-name shape named", err.Error())
	}
}

func TestComposedRepoNameBudget(t *testing.T) {
	// Exactly at the limit: classroom(30) + 1 + slug(29) + 1 + 39 = 100.
	if err := ComposedRepoNameBudget(strings.Repeat("a", 30), strings.Repeat("b", 29)); err != nil {
		t.Errorf("an exactly-100 composition must pass, got %v", err)
	}
	// One over: the error names the remaining slug budget (59 - 30 = 29).
	err := ComposedRepoNameBudget(strings.Repeat("a", 30), strings.Repeat("b", 30))
	if err == nil {
		t.Fatal("a 101-char worst case must fail")
	}
	if !strings.Contains(err.Error(), "at most 29 characters") {
		t.Errorf("err = %q, want the remaining slug budget (29) named", err.Error())
	}
	// A classroom leaving no room for even a 2-char slug points at a new
	// classroom instead of an impossible shorter slug.
	err = ComposedRepoNameBudget(strings.Repeat("a", 58), "bb")
	if err == nil {
		t.Fatal("a no-room classroom must fail")
	}
	if !strings.Contains(err.Error(), "no room for any slug") {
		t.Errorf("err = %q, want the no-room phrasing", err.Error())
	}
}

func TestComposedRepoNameOverflows(t *testing.T) {
	cases := []struct {
		name          string
		classroom     string
		slug          string
		wantWorstCase int
		wantOverflow  bool
	}{
		// 2 + 1 + 2 + 1 + 39 = 45, well under 100.
		{"short pair", "cs", "hw", 45, false},
		// Exactly at the limit: classroom(30) + 1 + slug(29) + 1 + 39 = 100.
		{"exactly 100", strings.Repeat("a", 30), strings.Repeat("b", 29), 100, false},
		// One over: classroom(30) + 1 + slug(30) + 1 + 39 = 101.
		{"one over", strings.Repeat("a", 30), strings.Repeat("b", 30), 101, true},
		// Two max-length segments: 100 + 1 + 100 + 1 + 39 = 241.
		{"both maxed", strings.Repeat("a", 100), strings.Repeat("b", 100), 241, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			worst, overflows := ComposedRepoNameOverflows(tc.classroom, tc.slug)
			if worst != tc.wantWorstCase {
				t.Errorf("worstCase = %d, want %d", worst, tc.wantWorstCase)
			}
			if overflows != tc.wantOverflow {
				t.Errorf("overflows = %v, want %v", overflows, tc.wantOverflow)
			}
		})
	}
}
