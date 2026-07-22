package assignmentcmd

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/foundation50/gh-teacher/internal/assignment"
)

func TestParseTemplateRef_HappyPaths(t *testing.T) {
	// Empty branch is the sentinel for "use template's default_branch"
	// (resolveTemplateBranch fills it in).
	cases := []struct {
		in         string
		wantOwner  string
		wantRepo   string
		wantBranch string
	}{
		{"cs50/hello-template", "cs50", "hello-template", ""},
		{"cs50/hello-template@main", "cs50", "hello-template", "main"},
		// Branch with `/` is legal — refs/heads/feature/foo is valid.
		{"cs50/hello-template@feature/foo", "cs50", "hello-template", "feature/foo"},
		{"cs50/hello-template@v0.1-beta", "cs50", "hello-template", "v0.1-beta"},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got, err := parseTemplateRef(tc.in)
			if err != nil {
				t.Fatalf("parseTemplateRef(%q): %v", tc.in, err)
			}
			if got.Owner != tc.wantOwner || got.Repo != tc.wantRepo || got.Branch != tc.wantBranch {
				t.Errorf("parseTemplateRef(%q) = %#v, want owner=%q repo=%q branch=%q",
					tc.in, got, tc.wantOwner, tc.wantRepo, tc.wantBranch)
			}
		})
	}
}

func TestParseTemplateRef_Rejects(t *testing.T) {
	cases := []struct {
		name        string
		in          string
		wantErrPart string
	}{
		{"empty input", "", "empty"},
		{"single segment, no slash", "hello-template", "expected"},
		{"empty owner", "/hello-template", "expected"},
		{"empty repo", "cs50/", "expected"},
		{"empty repo with branch", "cs50/@main", "expected"},
		{"too many slashes outside branch", "cs50/foo/bar", "expected"},
		{"empty branch after @", "cs50/hello-template@", "branch is empty"},
		{"double @", "cs50/hello-template@main@v2", "@"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseTemplateRef(tc.in)
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tc.wantErrPart)
			}
			if !strings.Contains(err.Error(), tc.wantErrPart) {
				t.Fatalf("err = %q, want substring %q", err.Error(), tc.wantErrPart)
			}
		})
	}
}

func TestNormalizeDueDate(t *testing.T) {
	// Pin the local zone so zone-less inputs normalize
	// deterministically. localDueLocation() reads $TZ via
	// LoadLocation, so this controls auto-detection regardless of the
	// host's time.Local. 2026-09-15 is EDT (-04:00) in New York.
	t.Setenv("TZ", "America/New_York")

	cases := []struct {
		name     string
		in       string
		wantOut  string
		wantMeta *assignment.DueMeta
		wantErr  bool
	}{
		// --due is optional.
		{name: "empty is optional", in: "", wantOut: "", wantMeta: nil},
		// Explicit offset -> same instant, stored as UTC.
		{
			name:     "explicit offset normalizes to UTC",
			in:       "2026-09-15T23:59:00-04:00",
			wantOut:  "2026-09-16T03:59:00Z",
			wantMeta: &assignment.DueMeta{Input: "2026-09-15T23:59:00-04:00", Offset: "-04:00", Source: assignment.DueSourceExplicit},
		},
		{
			name:     "Z stays UTC",
			in:       "2026-09-15T23:59:00Z",
			wantOut:  "2026-09-15T23:59:00Z",
			wantMeta: &assignment.DueMeta{Input: "2026-09-15T23:59:00Z", Offset: "+00:00", Source: assignment.DueSourceExplicit},
		},
		// Sub-second precision parses but is dropped on the UTC
		// re-format -- deadlines don't need it.
		{
			name:     "sub-second precision is dropped",
			in:       "2026-09-15T23:59:00.123Z",
			wantOut:  "2026-09-15T23:59:00Z",
			wantMeta: &assignment.DueMeta{Input: "2026-09-15T23:59:00.123Z", Offset: "+00:00", Source: assignment.DueSourceExplicit},
		},
		// Zone-less -> adopt the detected local zone, then UTC. This
		// is the requirement-2 path; due_meta records the detection.
		{
			name:     "zone-less adopts detected local zone",
			in:       "2026-09-15T23:59:00",
			wantOut:  "2026-09-16T03:59:00Z",
			wantMeta: &assignment.DueMeta{Input: "2026-09-15T23:59:00", Zone: "America/New_York", Offset: "-04:00", Source: assignment.DueSourceAuto},
		},
		// Date-only is ambiguous (which time of day?) -- still
		// rejected; require a full timestamp.
		{name: "date only is rejected", in: "2026-09-15", wantErr: true},
		{name: "garbage is rejected", in: "next Tuesday", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, meta, err := normalizeDueDate(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error for %q, got nil", tc.in)
				}
				return
			}
			if err != nil {
				t.Fatalf("normalizeDueDate(%q): %v", tc.in, err)
			}
			if got != tc.wantOut {
				t.Errorf("normalizeDueDate(%q) out = %q, want %q", tc.in, got, tc.wantOut)
			}
			if !reflect.DeepEqual(meta, tc.wantMeta) {
				t.Errorf("normalizeDueDate(%q) meta = %#v, want %#v", tc.in, meta, tc.wantMeta)
			}
		})
	}
}

func TestNormalizeDueDate_UnresolvableTZ(t *testing.T) {
	t.Setenv("TZ", "Definitely/NotAZone")

	// Zone-less input depends entirely on the local zone, which can't
	// be resolved -- must fail loudly, not silently normalize in a
	// fallback zone (would store the wrong instant).
	if _, _, err := normalizeDueDate("2026-09-15T23:59:00"); err == nil {
		t.Error("expected error for zone-less --due when $TZ is unresolvable, got nil")
	}

	// An explicit offset doesn't need the local zone, so a bad $TZ
	// must not block it.
	got, meta, err := normalizeDueDate("2026-09-15T23:59:00-04:00")
	if err != nil {
		t.Fatalf("explicit-offset --due should ignore a bad $TZ, got %v", err)
	}
	if got != "2026-09-16T03:59:00Z" {
		t.Errorf("out = %q, want 2026-09-16T03:59:00Z", got)
	}
	if meta == nil || meta.Source != assignment.DueSourceExplicit {
		t.Errorf("meta = %#v, want explicit-offset provenance", meta)
	}
}

func TestResolveTemplateBranch(t *testing.T) {
	// Each row covers one branch of the post-HTTP decision tree so a
	// change to validateTemplateRepo's response handling can't
	// silently drop a guard: not-a-template, explicit-@branch
	// retention, default_branch fallback, empty-default_branch error.
	cases := []struct {
		name        string
		arg         templateArg
		isTemplate  bool
		defaultBr   string
		wantRef     assignment.TemplateRef
		wantErrPart string // empty → expect success
	}{
		{
			name:        "not a template",
			arg:         templateArg{Owner: "cs50", Repo: "hello-template"},
			isTemplate:  false,
			defaultBr:   "main",
			wantErrPart: "not a template repository",
		},
		{
			name:       "explicit @branch retained even when default_branch differs",
			arg:        templateArg{Owner: "cs50", Repo: "hello-template", Branch: "feature/foo"},
			isTemplate: true,
			defaultBr:  "main",
			wantRef:    assignment.TemplateRef{Owner: "cs50", Repo: "hello-template", Branch: "feature/foo"},
		},
		{
			name:       "no @branch falls back to default_branch (master)",
			arg:        templateArg{Owner: "cs50", Repo: "hello-template"},
			isTemplate: true,
			defaultBr:  "master",
			wantRef:    assignment.TemplateRef{Owner: "cs50", Repo: "hello-template", Branch: "master"},
		},
		{
			name:       "no @branch falls back to default_branch (main)",
			arg:        templateArg{Owner: "cs50", Repo: "hello-template"},
			isTemplate: true,
			defaultBr:  "main",
			wantRef:    assignment.TemplateRef{Owner: "cs50", Repo: "hello-template", Branch: "main"},
		},
		{
			name:        "no @branch and empty default_branch → defensive error",
			arg:         templateArg{Owner: "cs50", Repo: "hello-template"},
			isTemplate:  true,
			defaultBr:   "",
			wantErrPart: "has no default branch",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolveTemplateBranch(tc.arg, tc.isTemplate, tc.defaultBr)
			if tc.wantErrPart != "" {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil (returned %#v)", tc.wantErrPart, got)
				}
				if !strings.Contains(err.Error(), tc.wantErrPart) {
					t.Fatalf("err = %q, want substring %q", err.Error(), tc.wantErrPart)
				}
				return
			}
			if err != nil {
				t.Fatalf("resolveTemplateBranch: %v", err)
			}
			if got != tc.wantRef {
				t.Errorf("resolveTemplateBranch = %#v, want %#v", got, tc.wantRef)
			}
		})
	}
}

func TestFormatAssignmentListJSON(t *testing.T) {
	t.Run("empty entries serialize as `[]\\n`", func(t *testing.T) {
		// nil and empty-slice MUST both produce `[]` so downstream
		// consumers (jq, agents) see a stable empty array, not `null`.
		for _, in := range [][]assignment.AssignmentEntry{nil, {}} {
			got, err := formatAssignmentListJSON(in)
			if err != nil {
				t.Fatalf("formatAssignmentListJSON(%v): %v", in, err)
			}
			if string(got) != "[]\n" {
				t.Errorf("formatAssignmentListJSON(%v) = %q, want %q", in, got, "[]\n")
			}
		}
	})

	t.Run("populated entries preserve every field and use 2-space indent", func(t *testing.T) {
		entries := []assignment.AssignmentEntry{
			{
				Slug:          "hello",
				Name:          "Hello",
				Description:   "First assignment",
				Template:      &assignment.TemplateRef{Owner: "cs50", Repo: "hello-template", Branch: "main"},
				Due:           "2026-09-15T23:59:00-04:00",
				Mode:          "individual",
				Autograder:    "default",
				ReleaseAssets: []string{"report.pdf", "plots/chart.png"},
			},
		}
		got, err := formatAssignmentListJSON(entries)
		if err != nil {
			t.Fatalf("formatAssignmentListJSON: %v", err)
		}
		// Smoke check field presence; full round-trip is in
		// TestEncodeAssignments_RoundTrip. Here we just confirm the
		// bare-array shape and on-disk indent.
		str := string(got)
		for _, want := range []string{
			`"slug": "hello"`,
			`"name": "Hello"`,
			`"description": "First assignment"`,
			`"branch": "main"`,
			`"autograder": "default"`,
		} {
			if !strings.Contains(str, want) {
				t.Errorf("output missing %q\nfull output:\n%s", want, str)
			}
		}
		// `list --json` emits the bare array (not the file envelope)
		// so callers can pipe through `jq '.[].slug'` cleanly.
		if strings.Contains(str, `"schema"`) || strings.Contains(str, `"assignments"`) {
			t.Errorf("output should be the bare entries array, not the file envelope:\n%s", str)
		}
		// Tests field should be gone from the on-disk shape.
		if strings.Contains(str, `"tests"`) {
			t.Errorf("output should NOT contain the legacy `tests` field:\n%s", str)
		}
		var decoded []assignment.AssignmentEntry
		if err := json.Unmarshal(got, &decoded); err != nil {
			t.Fatalf("decode assignment list JSON: %v", err)
		}
		if !reflect.DeepEqual(
			decoded[0].ReleaseAssets,
			[]string{"report.pdf", "plots/chart.png"},
		) {
			t.Fatalf("JSON release_assets = %#v", decoded[0].ReleaseAssets)
		}
	})

	t.Run("empty autograder normalizes to \"default\"", func(t *testing.T) {
		// Matches assignment.EncodeAssignments's on-disk shape so consumers see
		// the uniform default.
		entries := []assignment.AssignmentEntry{
			{
				Slug:     "intro",
				Name:     "Intro",
				Template: &assignment.TemplateRef{Owner: "cs50", Repo: "intro-template", Branch: "main"},
				Mode:     "individual",
			},
		}
		got, err := formatAssignmentListJSON(entries)
		if err != nil {
			t.Fatalf("formatAssignmentListJSON: %v", err)
		}
		if !strings.Contains(string(got), `"autograder": "default"`) {
			t.Errorf("expected `\"autograder\": \"default\"`, got:\n%s", got)
		}
	})
}

func TestSummarizeAssignmentList(t *testing.T) {
	// Pin the pluralization plus the empty-case "next action" hint
	// — the hint is the only part naming a follow-on command, so a
	// teacher on a fresh classroom can act without consulting docs.
	cases := []struct {
		count    int
		wantPart string
	}{
		{0, "no assignments registered yet"},
		{0, "gh teacher assignment add cs50-fall-2026 cs-principles <slug>"},
		{1, "1 assignment"},
		{2, "2 assignments"},
		{42, "42 assignments"},
	}
	for _, tc := range cases {
		got := summarizeAssignmentList("cs50-fall-2026", "cs-principles", tc.count)
		if !strings.Contains(got, tc.wantPart) {
			t.Errorf("summarizeAssignmentList(count=%d) = %q, want substring %q", tc.count, got, tc.wantPart)
		}
		// Every summary must surface the file path so a teacher can
		// find it without leaving the terminal.
		if !strings.Contains(got, "cs50-fall-2026/classroom50/cs-principles/assignments.json") {
			t.Errorf("summarizeAssignmentList(count=%d) should include the full file path, got %q", tc.count, got)
		}
	}

	// Pluralization boundary: 1 → singular, 2 → plural. A naive
	// Contains("assignments") would always pass because of
	// `assignments.json` in the file path; match the count-prefixed
	// phrase to isolate grammar.
	one := summarizeAssignmentList("o", "c", 1)
	two := summarizeAssignmentList("o", "c", 2)
	if strings.Contains(one, "1 assignments") {
		t.Errorf("count=1 should use singular `1 assignment`, got plural in %q", one)
	}
	if !strings.Contains(two, "2 assignments") {
		t.Errorf("count=2 should use plural `2 assignments`, got %q", two)
	}
}

func TestAssignmentsFilePath(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"cs-principles", "cs-principles/assignments.json"},
		{"intro-java", "intro-java/assignments.json"},
	}
	for _, tc := range cases {
		if got := assignmentsFilePath(tc.in); got != tc.want {
			t.Errorf("assignmentsFilePath(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestValidateEmptyRepoFlags(t *testing.T) {
	cases := []struct {
		name           string
		state          emptyRepoFlagState
		wantFeedbackPR bool
		wantErrSub     string // empty = expect success
	}{
		{
			name:           "off passes feedback_pr through (default true)",
			state:          emptyRepoFlagState{EmptyRepo: false, FeedbackPR: true},
			wantFeedbackPR: true,
		},
		{
			name:           "off passes explicit feedback_pr=false through",
			state:          emptyRepoFlagState{EmptyRepo: false, FeedbackPR: false, FeedbackPRChanged: true},
			wantFeedbackPR: false,
		},
		{
			name: "on with untouched feedback_pr default coerces to false",
			// --feedback-pr defaults to true; without an explicit flag the
			// default must be silently overridden, not an error.
			state:          emptyRepoFlagState{EmptyRepo: true, FeedbackPR: true, FeedbackPRChanged: false},
			wantFeedbackPR: false,
		},
		{
			name:           "on with explicit feedback_pr=false is fine",
			state:          emptyRepoFlagState{EmptyRepo: true, FeedbackPR: false, FeedbackPRChanged: true},
			wantFeedbackPR: false,
		},
		{
			name:       "on with explicit feedback_pr=true conflicts",
			state:      emptyRepoFlagState{EmptyRepo: true, FeedbackPR: true, FeedbackPRChanged: true},
			wantErrSub: "--feedback-pr",
		},
		{
			name:       "on with template conflicts",
			state:      emptyRepoFlagState{EmptyRepo: true, Template: true},
			wantErrSub: "--template",
		},
		{
			name:       "on with tests conflicts",
			state:      emptyRepoFlagState{EmptyRepo: true, Tests: true},
			wantErrSub: "--tests",
		},
		{
			name:       "on with allowed-files conflicts",
			state:      emptyRepoFlagState{EmptyRepo: true, AllowedFiles: true},
			wantErrSub: "--allowed-files",
		},
		{
			name:       "on with pass-threshold conflicts",
			state:      emptyRepoFlagState{EmptyRepo: true, PassThresholdChanged: true},
			wantErrSub: "--pass-threshold",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := validateEmptyRepoFlags(tc.state)
			if tc.wantErrSub != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErrSub) {
					t.Fatalf("got err %v, want one mentioning %q", err, tc.wantErrSub)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.wantFeedbackPR {
				t.Errorf("feedbackPR = %v, want %v", got, tc.wantFeedbackPR)
			}
		})
	}
}
