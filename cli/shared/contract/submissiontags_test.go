package contract

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestMatchesSubmissionTag_SharedFixtureParity runs the shared golden cases so
// the Go matcher and its web/Python mirrors stay in lockstep — same role the
// control_path_cases.json fixture plays for the allowed_files keep-set.
func TestMatchesSubmissionTag_SharedFixtureParity(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "testdata", "submission_tag_match_cases.json"))
	if err != nil {
		t.Fatalf("read shared fixture: %v", err)
	}
	var fixture struct {
		Cases []struct {
			Patterns []string `json:"patterns"`
			Tag      string   `json:"tag"`
			Matches  bool     `json:"matches"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse shared fixture: %v", err)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("shared fixture has no cases; did the file move?")
	}
	for _, c := range fixture.Cases {
		if got := MatchesSubmissionTag(c.Patterns, c.Tag); got != c.Matches {
			t.Errorf("MatchesSubmissionTag(%v, %q) = %v, want %v", c.Patterns, c.Tag, got, c.Matches)
		}
	}
}

// TestMatchesSubmissionTag_UncompilablePatternFailsClosed pins the fail-closed
// contract: a pattern the translator can't compile matches nothing (never
// everything) — writer validation should prevent these, but the runner
// re-checks hand-edited manifests.
func TestMatchesSubmissionTag_UncompilablePatternFailsClosed(t *testing.T) {
	// A reversed character-class range ([z-a]) fails regexp compilation.
	if MatchesSubmissionTag([]string{"[z-a]"}, "m") {
		t.Error("uncompilable pattern must match nothing")
	}
	// A bad pattern must not poison a later good one.
	if !MatchesSubmissionTag([]string{"[z-a]", "good"}, "good") {
		t.Error("a later valid pattern must still match")
	}
}

// TestShimTagsList_FailsClosedOnUnsafePatterns pins the render chokepoint:
// the shim writers (gh-student accept, gh-teacher retrofit, and the web
// mirrors) consume the PUBLISHED manifest, so an unsafe pattern that
// bypassed write-time validation must drop the ENTIRE milestone set — the
// rendered tags line falls back to the canonical `"submit/*"` alone rather
// than splicing hostile or divergent content into a student repo's workflow.
func TestShimTagsList_FailsClosedOnUnsafePatterns(t *testing.T) {
	if got := ShimTagsList(nil); got != `"submit/*"` {
		t.Errorf("ShimTagsList(nil) = %q, want the bare canonical entry", got)
	}
	if got := ShimTagsList([]string{"phase1", "v*"}); got != `"phase1", "v*", "submit/*"` {
		t.Errorf("ShimTagsList(safe) = %q", got)
	}
	for _, patterns := range [][]string{
		{"v*+"},           // stacked quantifier (Python-divergent)
		{"phase1", "a++"}, // one bad drops ALL (all-or-nothing)
		{`ta"g`},          // quote would break the YAML string
		{"has space"},     // charset
		{"+lead"},         // leading quantifier
	} {
		if got := ShimTagsList(patterns); got != `"submit/*"` {
			t.Errorf("ShimTagsList(%v) = %q, want fail-closed %q", patterns, got, `"submit/*"`)
		}
	}
	over := make([]string, SubmissionTagsCap+1)
	for i := range over {
		over[i] = "t" + string(rune('a'+i%26))
	}
	// Over-cap also fails closed (dups in `over` are irrelevant here).
	if got := ShimTagsList(over); got != `"submit/*"` {
		t.Errorf("ShimTagsList(over-cap) = %q, want fail-closed", got)
	}
}

// TestMatchesSubmissionTag_StackedQuantifiersFailClosed pins the guard the
// fixture also covers, plus the property that motivates it: these patterns
// must match NOTHING here (and in the web/Python mirrors) even though
// Python's regex dialect would happily compile them possessively.
func TestMatchesSubmissionTag_StackedQuantifiersFailClosed(t *testing.T) {
	for _, pattern := range []string{"v*+", "a++", "x?+", "m**+", "+lead", "?lead"} {
		if MatchesSubmissionTag([]string{pattern}, "v1") {
			t.Errorf("MatchesSubmissionTag([%q], \"v1\") = true, want fail-closed false", pattern)
		}
		if !IsSafeSubmissionTagPattern("phase1") || IsSafeSubmissionTagPattern(pattern) {
			t.Errorf("IsSafeSubmissionTagPattern(%q) should be false (and phase1 true)", pattern)
		}
	}
}
