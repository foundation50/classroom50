package assignment

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/contract"
)

// TestValidateSubmissionTags pins the writer-side gate: empty and valid
// pattern lists pass; excludes, bad charset, duplicates, and over-cap fail.
func TestValidateSubmissionTags(t *testing.T) {
	for _, ok := range [][]string{
		nil,
		{},
		{"phase1", "phase2", "complete"},
		{"v*", "release-[0-9]", "a/b?", "vv+", "milestone.**"},
	} {
		if err := ValidateSubmissionTags(ok); err != nil {
			t.Errorf("ValidateSubmissionTags(%v) = %v, want nil", ok, err)
		}
	}
	for _, tc := range []struct {
		patterns []string
		wantSub  string
	}{
		{[]string{"!v*"}, "exclude"},
		{[]string{`ta"g`}, "only letters"},
		{[]string{"has space"}, "only letters"},
		{[]string{"dup", "dup"}, "more than once"},
		{[]string{""}, "only letters"},
		// Stacked/leading quantifiers: possessive in Python, compile error
		// in Go/JS — the one construct where the four matcher copies would
		// diverge, so the writer refuses it (see IsSafeSubmissionTagPattern).
		{[]string{"v*+"}, "follow another glob quantifier"},
		{[]string{"a++"}, "follow another glob quantifier"},
		{[]string{"x?+"}, "follow another glob quantifier"},
		{[]string{"m**+"}, "follow another glob quantifier"},
		{[]string{"+lead"}, "cannot start a pattern"},
		{[]string{"?lead"}, "cannot start a pattern"},
	} {
		err := ValidateSubmissionTags(tc.patterns)
		if err == nil || !strings.Contains(err.Error(), tc.wantSub) {
			t.Errorf("ValidateSubmissionTags(%v) = %v, want error containing %q", tc.patterns, err, tc.wantSub)
		}
	}
	over := make([]string, SubmissionTagsCap+1)
	for i := range over {
		over[i] = "t" + strings.Repeat("x", i+1)
	}
	if err := ValidateSubmissionTags(over); err == nil {
		t.Error("ValidateSubmissionTags(over-cap) = nil, want error")
	}
}

// TestSubmissionTagsSchemaParity pins the hand-mirrored constants against the
// schema (declared source of truth): maxItems vs SubmissionTagsCap and
// items.pattern vs contract.SubmissionTagCharsetRE. The web mirror
// (SUBMISSION_TAGS_CAP / SUBMISSION_TAG_PATTERN_RE) is pinned by its own
// vitest against the same schema.
func TestSubmissionTagsSchemaParity(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(root, "schemas", "assignments-v1.schema.json"))
	if err != nil {
		t.Fatalf("read schema: %v", err)
	}
	var schema struct {
		Defs struct {
			Assignment struct {
				Properties struct {
					SubmissionTags struct {
						MaxItems int `json:"maxItems"`
						Items    struct {
							Pattern string `json:"pattern"`
						} `json:"items"`
					} `json:"submission_tags"`
				} `json:"properties"`
			} `json:"assignment"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatalf("parse schema: %v", err)
	}
	st := schema.Defs.Assignment.Properties.SubmissionTags
	if st.MaxItems != SubmissionTagsCap {
		t.Errorf("schema submission_tags.maxItems = %d, want SubmissionTagsCap %d — update every mirror in lockstep", st.MaxItems, SubmissionTagsCap)
	}
	// The schema pattern is the same charset class; compare modulo the JSON
	// escaping of [ and ]. (The stacked-quantifier rule is validator-only —
	// JSON Schema patterns must stay Go-RE2-compilable, which rules out the
	// lookahead an ECMA encoding of that rule would need.)
	wantPattern := `^[A-Za-z0-9._/*?+\[\]-]+$`
	if st.Items.Pattern != wantPattern {
		t.Errorf("schema submission_tags.items.pattern = %q, want %q (mirror of contract.SubmissionTagCharsetRE)", st.Items.Pattern, wantPattern)
	}
	if got := contract.SubmissionTagCharsetRE.String(); got != wantPattern {
		t.Errorf("contract.SubmissionTagCharsetRE = %q, want %q", got, wantPattern)
	}
}

// TestSubmissionTags_RoundTrip pins the wire behavior: submission_tags is a
// KNOWN key (decodes onto the struct, not Extra) and survives a
// read-modify-write verbatim.
func TestSubmissionTags_RoundTrip(t *testing.T) {
	in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    { "slug": "proj", "name": "Project", "mode": "individual", "autograder": "default", "submission_tags": ["phase1", "phase2", "complete"] }
  ]
}`)
	file, err := ParseAssignments(in)
	if err != nil {
		t.Fatalf("ParseAssignments: %v", err)
	}
	got := file.Assignments[0].SubmissionTags
	if len(got) != 3 || got[0] != "phase1" || got[2] != "complete" {
		t.Errorf("SubmissionTags = %v, want [phase1 phase2 complete]", got)
	}
	if len(file.Assignments[0].Extra) != 0 {
		t.Errorf("submission_tags leaked into Extra: %v", file.Assignments[0].Extra)
	}
	out, err := EncodeAssignments(file)
	if err != nil {
		t.Fatalf("EncodeAssignments: %v", err)
	}
	if !strings.Contains(string(out), `"submission_tags"`) {
		t.Errorf("encoded output lost submission_tags:\n%s", out)
	}
}

// TestParseAssignments_InvalidSubmissionTags pins the read-side hard error.
func TestParseAssignments_InvalidSubmissionTags(t *testing.T) {
	in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    { "slug": "proj", "name": "Project", "mode": "individual", "autograder": "default", "submission_tags": ["!v*"] }
  ]
}`)
	if _, err := ParseAssignments(in); err == nil {
		t.Fatal("ParseAssignments accepted an exclude submission_tags pattern")
	} else if !strings.Contains(err.Error(), "submission_tags") {
		t.Errorf("error %v does not mention submission_tags", err)
	}
}

// TestValidateAssignmentEntry_SubmissionTagsEmptyRepo pins that milestone tags
// are PERMITTED on a bare repo: no shim triggers on them, but they still define
// what the submissions page counts as a submission.
func TestValidateAssignmentEntry_SubmissionTagsEmptyRepo(t *testing.T) {
	entry := AssignmentEntry{
		Slug: "bare", Name: "Bare", Mode: "individual", Autograder: "default",
		EmptyRepo: true, SubmissionTags: []string{"phase1"},
	}
	if err := ValidateAssignmentEntry(entry); err != nil {
		t.Fatalf("ValidateAssignmentEntry rejected empty_repo + submission_tags: %v", err)
	}
}
