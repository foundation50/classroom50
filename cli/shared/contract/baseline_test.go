package contract

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The shared golden cases keep this rule, the web baselineSource, and the
// Python readers in lockstep; a drift in any one of them failed silently before
// this fixture existed (regrade_repos.py shipped without the backfill check).
func TestResolveBaselineSource_SharedFixtureParity(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "testdata", "baseline_source_cases.json"))
	if err != nil {
		t.Fatalf("read shared fixture: %v", err)
	}
	var fixture struct {
		BackfillSubject string `json:"backfill_subject"`
		Cases           []struct {
			Name           string  `json:"name"`
			MarkerMessage  *string `json:"marker_message"`
			RootIsBaseline bool    `json:"root_is_baseline"`
			Expected       string  `json:"expected"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse shared fixture: %v", err)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("shared fixture has no cases; did the file move?")
	}
	if fixture.BackfillSubject != ShimBackfillCommitSubject() {
		t.Fatalf("fixture backfill_subject %q != ShimBackfillCommitSubject() %q", fixture.BackfillSubject, ShimBackfillCommitSubject())
	}
	for _, c := range fixture.Cases {
		message, hasMarker := "", false
		if c.MarkerMessage != nil {
			message, hasMarker = *c.MarkerMessage, true
		}
		if got := ResolveBaselineSource(message, hasMarker, c.RootIsBaseline); string(got) != c.Expected {
			t.Errorf("%s: ResolveBaselineSource(%q, %v, %v) = %q, want %q", c.Name, message, hasMarker, c.RootIsBaseline, got, c.Expected)
		}
	}
}
