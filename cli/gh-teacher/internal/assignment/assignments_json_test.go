package assignment

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/contract"
)

func TestParseAssignments_Canonical(t *testing.T) {
	in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "cs50", "repo": "hello-template", "branch": "main" },
      "due": "2026-09-15T23:59:00-04:00",
      "mode": "individual",
      "autograder": "default"
    }
  ]
}`)
	file, err := ParseAssignments(in)
	if err != nil {
		t.Fatalf("ParseAssignments: %v", err)
	}
	if file.Schema != contract.AssignmentsSchemaV1 {
		t.Errorf("schema = %q, want %q", file.Schema, contract.AssignmentsSchemaV1)
	}
	if len(file.Assignments) != 1 {
		t.Fatalf("expected 1 assignment, got %d", len(file.Assignments))
	}
	got := file.Assignments[0]
	want := AssignmentEntry{
		Slug:       "hello",
		Name:       "Hello",
		Template:   &TemplateRef{Owner: "cs50", Repo: "hello-template", Branch: "main"},
		Due:        "2026-09-15T23:59:00-04:00",
		Mode:       "individual",
		Autograder: "default",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("entry mismatch:\n got: %#v\nwant: %#v", got, want)
	}
}

func TestParseAssignments_TemplateLess(t *testing.T) {
	// A template-less assignment omits the `template` block and parses to a
	// nil Template (accept-time creates an empty shim-only repo).
	in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "mode": "individual",
      "autograder": "default"
    }
  ]
}`)
	file, err := ParseAssignments(in)
	if err != nil {
		t.Fatalf("ParseAssignments (template-less): %v", err)
	}
	if len(file.Assignments) != 1 {
		t.Fatalf("expected 1 assignment, got %d", len(file.Assignments))
	}
	if got := file.Assignments[0].Template; got != nil {
		t.Errorf("Template = %+v, want nil for a template-less assignment", got)
	}
}

func TestEncodeAssignments_TemplateLessOmitsKey(t *testing.T) {
	// A nil Template must serialize with the `template` key ABSENT
	// (omitempty), and re-parse back to nil — the omitempty contract the
	// schema's optional-template relies on.
	file := AssignmentsJSON{
		Schema: contract.AssignmentsSchemaV1,
		Assignments: []AssignmentEntry{{
			Slug: "solo", Name: "Solo", Mode: "individual", Autograder: "default",
		}},
	}
	data, err := EncodeAssignments(file)
	if err != nil {
		t.Fatalf("EncodeAssignments: %v", err)
	}
	if strings.Contains(string(data), "\"template\"") {
		t.Errorf("encoded output contains a template key, want it omitted:\n%s", data)
	}
	round, err := ParseAssignments(data)
	if err != nil {
		t.Fatalf("ParseAssignments(round-trip): %v", err)
	}
	if round.Assignments[0].Template != nil {
		t.Errorf("round-tripped Template = %+v, want nil", round.Assignments[0].Template)
	}
}

func TestParseAssignments_RejectsPartialAndNullTemplate(t *testing.T) {
	// Parse path must reject a present-but-incomplete template and an
	// explicit null, keeping the CLI in lockstep with the JSON schema.
	cases := []struct {
		name        string
		template    string
		wantErrPart string
	}{
		{"partial: empty branch", `{"owner":"cs50","repo":"hello-template","branch":""}`, "branch"},
		{"partial: missing repo", `{"owner":"cs50","repo":"","branch":"main"}`, "template"},
		{"explicit null", `null`, "null"},
		{"empty object", `{}`, "template"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := []byte(`{"schema":"classroom50/assignments/v1","assignments":[{"slug":"hello","name":"Hello","template":` +
				tc.template + `,"mode":"individual","autograder":"default"}]}`)
			_, err := ParseAssignments(in)
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tc.wantErrPart)
			}
			if !strings.Contains(err.Error(), tc.wantErrPart) {
				t.Errorf("err = %q, want substring %q", err.Error(), tc.wantErrPart)
			}
		})
	}
}

func TestParseAssignments_AutograderField(t *testing.T) {
	// Explicit values round-trip verbatim; empty normalizes to
	// "default".
	in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "cs50", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "io-suite"
    },
    {
      "slug": "intro",
      "name": "Intro",
      "template": { "owner": "cs50", "repo": "intro-template", "branch": "main" },
      "mode": "individual"
    }
  ]
}`)
	file, err := ParseAssignments(in)
	if err != nil {
		t.Fatalf("ParseAssignments: %v", err)
	}
	if got := file.Assignments[0].Autograder; got != "io-suite" {
		t.Errorf("explicit autograder dropped: got %q, want %q", got, "io-suite")
	}
	if got := file.Assignments[1].Autograder; got != "default" {
		t.Errorf("missing autograder field should normalize to %q, got %q", "default", got)
	}
}

func TestParseAssignments_RejectsInvalidAutograder(t *testing.T) {
	// Path-traversal values must be rejected — the autograder name
	// flows into a contents-API path and a Pages URL.
	in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "cs50", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "../secrets.txt"
    }
  ]
}`)
	_, err := ParseAssignments(in)
	if err == nil {
		t.Fatalf("expected error for traversal autograder name, got nil")
	}
	if !strings.Contains(err.Error(), "autograder") {
		t.Errorf("err should mention `autograder`, got %q", err)
	}
}

func TestParseAssignments_TestsRoundTrip(t *testing.T) {
	// The declarative `tests` block (reintroduced atop the runner.py
	// architecture) parses, preserves every field, and survives a
	// re-encode/re-parse.
	in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "cs50", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default",
      "tests": [
        {
          "name": "compiles",
          "type": "run",
          "run": "gcc -o hello hello.c",
          "timeout": 30,
          "points": 1
        },
        {
          "name": "prints Hello, world!",
          "type": "io",
          "setup": "gcc -o hello hello.c",
          "run": "./hello",
          "expected": "Hello, world!",
          "comparison": "included",
          "timeout": 10,
          "points": 2
        }
      ]
    }
  ]
}`)
	file, err := ParseAssignments(in)
	if err != nil {
		t.Fatalf("ParseAssignments: %v", err)
	}
	tests := file.Assignments[0].Tests
	if len(tests) != 2 {
		t.Fatalf("expected 2 tests, got %d", len(tests))
	}
	if tests[0].Type != "run" || tests[0].Run != "gcc -o hello hello.c" || tests[0].Points != 1 {
		t.Errorf("run test fields not parsed: %#v", tests[0])
	}
	if tests[1].Type != "io" || tests[1].Comparison != "included" || tests[1].Expected != "Hello, world!" {
		t.Errorf("io test fields not parsed: %#v", tests[1])
	}

	// Re-encode and re-parse to confirm round-trip stability.
	encoded, err := EncodeAssignments(file)
	if err != nil {
		t.Fatalf("EncodeAssignments: %v", err)
	}
	again, err := ParseAssignments(encoded)
	if err != nil {
		t.Fatalf("re-parse: %v", err)
	}
	if !reflect.DeepEqual(again.Assignments[0].Tests, tests) {
		t.Errorf("tests not stable across round-trip:\n got: %#v\nwant: %#v", again.Assignments[0].Tests, tests)
	}
}

func TestParseAssignments_FeedbackPRRoundTrip(t *testing.T) {
	// feedback_pr=true parses, survives a re-encode/re-parse, and an
	// entry without the field defaults to false.
	in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "cs50", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default",
      "feedback_pr": true
    },
    {
      "slug": "world",
      "name": "World",
      "template": { "owner": "cs50", "repo": "world-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default"
    }
  ]
}`)
	file, err := ParseAssignments(in)
	if err != nil {
		t.Fatalf("ParseAssignments: %v", err)
	}
	if !file.Assignments[0].FeedbackPR {
		t.Errorf("hello.FeedbackPR = false, want true")
	}
	if file.Assignments[1].FeedbackPR {
		t.Errorf("world.FeedbackPR = true, want false (field absent)")
	}

	encoded, err := EncodeAssignments(file)
	if err != nil {
		t.Fatalf("EncodeAssignments: %v", err)
	}
	// false omits from the wire (omitempty); true must persist.
	if !strings.Contains(string(encoded), `"feedback_pr": true`) {
		t.Errorf("encoded missing feedback_pr:\n%s", encoded)
	}
	if strings.Contains(string(encoded), `"feedback_pr": false`) {
		t.Errorf("feedback_pr:false should omit, not serialize:\n%s", encoded)
	}
	again, err := ParseAssignments(encoded)
	if err != nil {
		t.Fatalf("re-parse: %v", err)
	}
	if !again.Assignments[0].FeedbackPR || again.Assignments[1].FeedbackPR {
		t.Errorf("feedback_pr not stable across round-trip: %#v", again.Assignments)
	}
}

func TestParseAssignments_AllowedFilesRoundTrip(t *testing.T) {
	// allowed_files parses, survives a re-encode/re-parse preserving
	// order, and an entry without the field decodes to a nil slice.
	in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "cs50", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default",
      "allowed_files": ["*", "!hello.py"]
    },
    {
      "slug": "world",
      "name": "World",
      "template": { "owner": "cs50", "repo": "world-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default"
    }
  ]
}`)
	file, err := ParseAssignments(in)
	if err != nil {
		t.Fatalf("ParseAssignments: %v", err)
	}
	if got := file.Assignments[0].AllowedFiles; len(got) != 2 || got[0] != "*" || got[1] != "!hello.py" {
		t.Errorf("hello.AllowedFiles = %#v, want [* !hello.py]", got)
	}
	if file.Assignments[1].AllowedFiles != nil {
		t.Errorf("world.AllowedFiles = %#v, want nil (field absent)", file.Assignments[1].AllowedFiles)
	}

	encoded, err := EncodeAssignments(file)
	if err != nil {
		t.Fatalf("EncodeAssignments: %v", err)
	}
	if !strings.Contains(string(encoded), `"allowed_files"`) {
		t.Errorf("encoded missing allowed_files:\n%s", encoded)
	}
	again, err := ParseAssignments(encoded)
	if err != nil {
		t.Fatalf("re-parse: %v", err)
	}
	if got := again.Assignments[0].AllowedFiles; len(got) != 2 || got[0] != "*" || got[1] != "!hello.py" {
		t.Errorf("allowed_files order not stable across round-trip: %#v", got)
	}
	if again.Assignments[1].AllowedFiles != nil {
		t.Errorf("absent allowed_files should round-trip nil, got %#v", again.Assignments[1].AllowedFiles)
	}
}

func TestParseAssignments_PassThresholdRoundTrip(t *testing.T) {
	// pass_threshold parses, survives a re-encode/re-parse, an explicit 0
	// stays 0 (distinct from absent), and an entry without the field decodes
	// to a nil pointer (feature off).
	in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "mode": "individual",
      "autograder": "default",
      "pass_threshold": 70
    },
    {
      "slug": "zero",
      "name": "Zero",
      "mode": "individual",
      "autograder": "default",
      "pass_threshold": 0
    },
    {
      "slug": "off",
      "name": "Off",
      "mode": "individual",
      "autograder": "default"
    }
  ]
}`)
	file, err := ParseAssignments(in)
	if err != nil {
		t.Fatalf("ParseAssignments: %v", err)
	}
	if got := file.Assignments[0].PassThreshold; got == nil || *got != 70 {
		t.Errorf("hello.PassThreshold = %v, want 70", got)
	}
	if got := file.Assignments[1].PassThreshold; got == nil || *got != 0 {
		t.Errorf("zero.PassThreshold = %v, want explicit 0 (not nil)", got)
	}
	if file.Assignments[2].PassThreshold != nil {
		t.Errorf("off.PassThreshold = %v, want nil (field absent)", file.Assignments[2].PassThreshold)
	}

	encoded, err := EncodeAssignments(file)
	if err != nil {
		t.Fatalf("EncodeAssignments: %v", err)
	}
	if !strings.Contains(string(encoded), `"pass_threshold": 0`) {
		t.Errorf("encoded missing explicit pass_threshold 0:\n%s", encoded)
	}
	again, err := ParseAssignments(encoded)
	if err != nil {
		t.Fatalf("re-parse: %v", err)
	}
	if got := again.Assignments[0].PassThreshold; got == nil || *got != 70 {
		t.Errorf("pass_threshold not stable across round-trip: %v", got)
	}
	if got := again.Assignments[1].PassThreshold; got == nil || *got != 0 {
		t.Errorf("explicit 0 not stable across round-trip: %v", got)
	}
	if again.Assignments[2].PassThreshold != nil {
		t.Errorf("absent pass_threshold should round-trip nil, got %v", again.Assignments[2].PassThreshold)
	}
}

func TestValidatePassThreshold(t *testing.T) {
	ptr := func(n int) *int { return &n }
	cases := []struct {
		name    string
		val     *int
		wantErr bool
	}{
		{"nil (off) is allowed", nil, false},
		{"0 is allowed", ptr(0), false},
		{"100 is allowed", ptr(100), false},
		{"mid-range is allowed", ptr(70), false},
		{"negative rejected", ptr(-1), true},
		{"over 100 rejected", ptr(101), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidatePassThreshold(tc.val)
			if tc.wantErr && err == nil {
				t.Errorf("ValidatePassThreshold(%v) = nil, want error", tc.val)
			}
			if !tc.wantErr && err != nil {
				t.Errorf("ValidatePassThreshold(%v) = %v, want nil", tc.val, err)
			}
		})
	}
}

func TestParseAssignments_RejectsOutOfRangePassThreshold(t *testing.T) {
	in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "mode": "individual",
      "autograder": "default",
      "pass_threshold": 150
    }
  ]
}`)
	if _, err := ParseAssignments(in); err == nil {
		t.Fatal("ParseAssignments accepted pass_threshold 150; want range error")
	}
}

func TestValidateAllowedFiles(t *testing.T) {
	cases := []struct {
		name     string
		patterns []string
		wantErr  bool
	}{
		{"nil is allowed", nil, false},
		{"empty slice is allowed", []string{}, false},
		{"valid allowlist", []string{"*", "!hello.py"}, false},
		{"empty pattern rejected", []string{"*", ""}, true},
		{"whitespace-only rejected", []string{"   "}, true},
		{"newline rejected", []string{"a\nb"}, true},
		{"NUL rejected", []string{"a\x00b"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateAllowedFiles(tc.patterns)
			if tc.wantErr && err == nil {
				t.Errorf("ValidateAllowedFiles(%#v): expected error, got nil", tc.patterns)
			}
			if !tc.wantErr && err != nil {
				t.Errorf("ValidateAllowedFiles(%#v): unexpected error %v", tc.patterns, err)
			}
		})
	}

	tooMany := make([]string, AllowedFilesCap+1)
	for i := range tooMany {
		tooMany[i] = "f"
	}
	if err := ValidateAllowedFiles(tooMany); err == nil {
		t.Errorf("ValidateAllowedFiles(%d patterns): expected over-cap error, got nil", len(tooMany))
	}
}

func TestParseAssignments_RejectsInvalidAllowedFiles(t *testing.T) {
	// A hand-edited manifest with an empty allowed_files pattern must
	// fail the parse-path validator (ValidateExistingEntry).
	in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "cs50", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default",
      "allowed_files": ["*", ""]
    }
  ]
}`)
	if _, err := ParseAssignments(in); err == nil {
		t.Fatal("expected parse error for empty allowed_files pattern, got nil")
	}
}

func TestParseAssignments_RejectsNonBoolFeedbackPR(t *testing.T) {
	// DisallowUnknownFields is satisfied (the field exists), but a
	// non-bool value must fail the JSON decode rather than coerce.
	in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "cs50", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default",
      "feedback_pr": "yes"
    }
  ]
}`)
	if _, err := ParseAssignments(in); err == nil {
		t.Fatal("expected parse error for non-bool feedback_pr, got nil")
	}
}

func TestParseAssignments_RejectsInvalidTest(t *testing.T) {
	// A malformed test (unknown type) must fail the parse-path
	// validator with the entry context attached.
	in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "cs50", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default",
      "tests": [
        { "name": "t1", "type": "diff", "run": "./hello", "points": 1 }
      ]
    }
  ]
}`)
	_, err := ParseAssignments(in)
	if err == nil {
		t.Fatalf("expected error for invalid test type, got nil")
	}
	if !strings.Contains(err.Error(), "type") {
		t.Errorf("err should mention the invalid `type`, got %q", err)
	}
}

func TestParseAssignments_RejectsUnknownTestField(t *testing.T) {
	// DisallowUnknownFields recurses into the test objects, so a
	// typo'd key (`compare` for `comparison`) surfaces as a decode
	// error instead of silently dropping on the next re-encode.
	in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "cs50", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default",
      "tests": [
        { "name": "t1", "type": "io", "run": "./hello", "expected": "x", "compare": "exact", "points": 1 }
      ]
    }
  ]
}`)
	_, err := ParseAssignments(in)
	if err == nil {
		t.Fatalf("expected decode error for unknown test field, got nil")
	}
	if !strings.Contains(err.Error(), "compare") {
		t.Errorf("err should name the offending field, got %q", err)
	}
}

func TestParseAssignments_EmptyAssignmentsArray(t *testing.T) {
	in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": []
}`)
	file, err := ParseAssignments(in)
	if err != nil {
		t.Fatalf("ParseAssignments: %v", err)
	}
	if file.Assignments == nil {
		t.Errorf("Assignments should be a non-nil empty slice (so a re-encode emits [], not null)")
	}
	if len(file.Assignments) != 0 {
		t.Errorf("expected 0 assignments, got %d", len(file.Assignments))
	}
}

func TestParseAssignments_NullAssignmentsField(t *testing.T) {
	// A teacher hand-editing the file to `null` (or omitting the
	// field entirely) must still parse cleanly — the normalizer
	// turns nil into [] so downstream encoders see a stable shape.
	in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": null
}`)
	file, err := ParseAssignments(in)
	if err != nil {
		t.Fatalf("ParseAssignments: %v", err)
	}
	if file.Assignments == nil || len(file.Assignments) != 0 {
		t.Errorf("expected Assignments to normalize to [], got %#v", file.Assignments)
	}
}

func TestParseAssignments_Rejects(t *testing.T) {
	cases := []struct {
		name        string
		in          string
		wantErrPart string
	}{
		{
			name:        "empty input",
			in:          "",
			wantErrPart: "empty",
		},
		{
			name:        "schema sentinel mismatch (v2)",
			in:          `{"schema":"classroom50/assignments/v2","assignments":[]}`,
			wantErrPart: "v1",
		},
		{
			name:        "schema sentinel mismatch (other)",
			in:          `{"schema":"something-else","assignments":[]}`,
			wantErrPart: "v1",
		},
		{
			name:        "missing schema",
			in:          `{"assignments":[]}`,
			wantErrPart: "schema",
		},
		{
			name:        "unknown top-level field",
			in:          `{"schema":"classroom50/assignments/v1","assignments":[],"extra":1}`,
			wantErrPart: "unknown field",
		},
		{
			name:        "entry missing required name",
			in:          `{"schema":"classroom50/assignments/v1","assignments":[{"slug":"hello","template":{"owner":"cs50","repo":"hello-template","branch":"main"},"mode":"individual","autograder":"default"}]}`,
			wantErrPart: "empty name",
		},
		{
			// `group` is now schema-legal; only arbitrary
			// strings trip the validator.
			name:        "entry with unsupported mode",
			in:          `{"schema":"classroom50/assignments/v1","assignments":[{"slug":"hello","name":"Hello","template":{"owner":"cs50","repo":"hello-template","branch":"main"},"mode":"team","autograder":"default"}]}`,
			wantErrPart: "invalid mode",
		},
		{
			name:        "entry with slug-pattern violation",
			in:          `{"schema":"classroom50/assignments/v1","assignments":[{"slug":"Hello","name":"Hello","template":{"owner":"cs50","repo":"hello-template","branch":"main"},"mode":"individual","autograder":"default"}]}`,
			wantErrPart: "slug",
		},
		{
			// Hand-edited or web-UI-inserted due values must meet
			// the same bar the --due flag enforces at write time.
			name:        "entry with non-RFC-3339 due",
			in:          `{"schema":"classroom50/assignments/v1","assignments":[{"slug":"hello","name":"Hello","template":{"owner":"cs50","repo":"hello-template","branch":"main"},"due":"2026-09-15","mode":"individual","autograder":"default"}]}`,
			wantErrPart: "RFC 3339",
		},
		{
			name:        "trailing content (e.g. botched merge)",
			in:          `{"schema":"classroom50/assignments/v1","assignments":[]}{"schema":"classroom50/assignments/v1","assignments":[]}`,
			wantErrPart: "after top-level value",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseAssignments([]byte(tc.in))
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tc.wantErrPart)
			}
			if !strings.Contains(err.Error(), tc.wantErrPart) {
				t.Errorf("err = %q, want substring %q", err.Error(), tc.wantErrPart)
			}
		})
	}
}

func TestEncodeAssignments_EmptyArrayWireShape(t *testing.T) {
	// nil and empty-slice MUST both produce `[]` so re-encodes don't
	// alternate between `null` and `[]` based on accident.
	for _, in := range []AssignmentsJSON{
		{Schema: contract.AssignmentsSchemaV1, Assignments: nil},
		{Schema: contract.AssignmentsSchemaV1, Assignments: []AssignmentEntry{}},
	} {
		data, err := EncodeAssignments(in)
		if err != nil {
			t.Fatalf("EncodeAssignments(%v): %v", in, err)
		}
		if !strings.Contains(string(data), `"assignments": []`) {
			t.Errorf("expected `\"assignments\": []`, got:\n%s", data)
		}
	}
}

func TestEncodeAssignments_NilFieldsRoundTrip(t *testing.T) {
	// Schema empty? EncodeAssignments fills it in.
	data, err := EncodeAssignments(AssignmentsJSON{})
	if err != nil {
		t.Fatalf("EncodeAssignments: %v", err)
	}
	if !strings.Contains(string(data), `"schema": "classroom50/assignments/v1"`) {
		t.Errorf("expected schema sentinel to be filled in, got:\n%s", data)
	}
}

func TestEncodeAssignments_RoundTrip(t *testing.T) {
	in := AssignmentsJSON{
		Schema: contract.AssignmentsSchemaV1,
		Assignments: []AssignmentEntry{
			{
				Slug:        "hello",
				Name:        "Hello",
				Description: "First assignment",
				Template:    &TemplateRef{Owner: "cs50", Repo: "hello-template", Branch: "main"},
				Due:         "2026-09-15T23:59:00-04:00",
				Mode:        "individual",
				Autograder:  "default",
			},
		},
	}
	encoded, err := EncodeAssignments(in)
	if err != nil {
		t.Fatalf("EncodeAssignments: %v", err)
	}
	decoded, err := ParseAssignments(encoded)
	if err != nil {
		t.Fatalf("ParseAssignments: %v", err)
	}
	if !reflect.DeepEqual(decoded, in) {
		t.Errorf("round-trip mismatch:\n got: %#v\nwant: %#v", decoded, in)
	}
}

func TestEncodeAssignments_NormalizesEmptyAutograder(t *testing.T) {
	// Empty autograder field is normalized to "default" on the way
	// out. The caller-side struct also isn't mutated (see the
	// defensive copy in EncodeAssignments).
	in := AssignmentsJSON{
		Schema: contract.AssignmentsSchemaV1,
		Assignments: []AssignmentEntry{
			{
				Slug:     "hello",
				Name:     "Hello",
				Template: &TemplateRef{Owner: "cs50", Repo: "hello-template", Branch: "main"},
				Mode:     "individual",
			},
		},
	}
	data, err := EncodeAssignments(in)
	if err != nil {
		t.Fatalf("EncodeAssignments: %v", err)
	}
	if !strings.Contains(string(data), `"autograder": "default"`) {
		t.Errorf("expected normalized `\"autograder\": \"default\"`, got:\n%s", data)
	}
	// Caller's slice must be untouched (regression guard for the
	// defensive copy).
	if in.Assignments[0].Autograder != "" {
		t.Errorf("caller's Autograder was mutated: got %q, want empty",
			in.Assignments[0].Autograder)
	}
}

func TestEncodeAssignments_OmitsOptionalEmptyFields(t *testing.T) {
	// Description and Due use `omitempty`. Empty values must not
	// appear in the encoded output so on-disk diffs stay minimal.
	in := AssignmentsJSON{
		Schema: contract.AssignmentsSchemaV1,
		Assignments: []AssignmentEntry{
			{
				Slug:       "hello",
				Name:       "Hello",
				Template:   &TemplateRef{Owner: "cs50", Repo: "hello-template", Branch: "main"},
				Mode:       "individual",
				Autograder: "default",
			},
		},
	}
	data, err := EncodeAssignments(in)
	if err != nil {
		t.Fatalf("EncodeAssignments: %v", err)
	}
	for _, omitted := range []string{`"description"`, `"due"`} {
		if strings.Contains(string(data), omitted) {
			t.Errorf("expected %s to be omitted (omitempty), got:\n%s", omitted, data)
		}
	}
}

func TestUpsertAssignment_AppendAndReplace(t *testing.T) {
	entries := []AssignmentEntry{
		{Slug: "hello", Name: "Hello"},
		{Slug: "intro", Name: "Intro"},
	}

	// New slug appends to the end.
	updated, replaced := UpsertAssignment(entries, AssignmentEntry{Slug: "goodbye", Name: "Goodbye"})
	if replaced {
		t.Errorf("appending a new slug should not report 'replaced'")
	}
	if len(updated) != 3 || updated[2].Slug != "goodbye" {
		t.Errorf("expected append at index 2, got %v", updated)
	}

	// Existing slug replaces in place — position preserved.
	updated2, replaced2 := UpsertAssignment(updated, AssignmentEntry{Slug: "intro", Name: "Intro v2"})
	if !replaced2 {
		t.Errorf("replacing an existing slug should report 'replaced'")
	}
	if len(updated2) != 3 || updated2[1].Slug != "intro" || updated2[1].Name != "Intro v2" {
		t.Errorf("expected in-place replace at index 1, got %v", updated2)
	}
}

func TestUpsertAssignment_CaseSensitive(t *testing.T) {
	// Slug validator only accepts lowercase, so case-insensitive
	// matching would just hide a validator-rejected typo. Verify
	// that "Hello" and "hello" are treated as distinct.
	entries := []AssignmentEntry{{Slug: "hello"}}
	updated, replaced := UpsertAssignment(entries, AssignmentEntry{Slug: "Hello"})
	if replaced {
		t.Errorf("case mismatch should NOT match existing slug")
	}
	if len(updated) != 2 {
		t.Errorf("expected append (no match), got len=%d", len(updated))
	}
}

func TestMaxGroupSize_RoundTripsAndBounds(t *testing.T) {
	// Group entries carry max_group_size (>= 2); 0 omits from the file.
	body := `{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "proj",
      "name": "Project",
      "template": { "owner": "o", "repo": "t", "branch": "main" },
      "mode": "group",
      "autograder": "default",
      "max_group_size": 4
    }
  ]
}`
	file, err := ParseAssignments([]byte(body))
	if err != nil {
		t.Fatalf("ParseAssignments: %v", err)
	}
	if file.Assignments[0].MaxGroupSize != 4 {
		t.Errorf("MaxGroupSize = %d, want 4", file.Assignments[0].MaxGroupSize)
	}
	encoded, err := EncodeAssignments(file)
	if err != nil {
		t.Fatalf("EncodeAssignments: %v", err)
	}
	if !strings.Contains(string(encoded), `"max_group_size": 4`) {
		t.Errorf("max_group_size should round-trip, got:\n%s", encoded)
	}

	// Unset omits from the file.
	file.Assignments[0].MaxGroupSize = 0
	encoded, err = EncodeAssignments(file)
	if err != nil {
		t.Fatalf("EncodeAssignments: %v", err)
	}
	if strings.Contains(string(encoded), "max_group_size") {
		t.Errorf("unset max_group_size should omit, got:\n%s", encoded)
	}

	// Out of bounds fails both validators.
	bad := file.Assignments[0]
	bad.MaxGroupSize = 9999
	if err := ValidateAssignmentEntry(bad); err == nil || !strings.Contains(err.Error(), "max_group_size") {
		t.Errorf("write-path validator should reject 9999, got %v", err)
	}
	if err := ValidateExistingEntry(bad); err == nil || !strings.Contains(err.Error(), "max_group_size") {
		t.Errorf("parse-path validator should reject 9999, got %v", err)
	}
}

func TestFindAssignment(t *testing.T) {
	entries := []AssignmentEntry{{Slug: "hello"}, {Slug: "intro"}}
	if idx, ok := FindAssignment(entries, "intro"); !ok || idx != 1 {
		t.Errorf("expected (1, true) for intro, got (%d, %v)", idx, ok)
	}
	if _, ok := FindAssignment(entries, "missing"); ok {
		t.Errorf("missing slug should not be found")
	}
	// Case-sensitive, mirroring UpsertAssignment.
	if _, ok := FindAssignment(entries, "Hello"); ok {
		t.Errorf("lookup should be case-sensitive")
	}
}

func TestRemoveAssignment(t *testing.T) {
	entries := []AssignmentEntry{
		{Slug: "hello"},
		{Slug: "intro"},
		{Slug: "goodbye"},
	}
	updated, removed := RemoveAssignment(entries, "intro")
	if !removed {
		t.Errorf("expected removed=true for matching slug")
	}
	if len(updated) != 2 || updated[0].Slug != "hello" || updated[1].Slug != "goodbye" {
		t.Errorf("expected ['hello','goodbye'], got %v", updated)
	}

	// Missing slug → no change, removed=false.
	stable, removed2 := RemoveAssignment(entries, "missing")
	if removed2 {
		t.Errorf("expected removed=false for non-matching slug")
	}
	if len(stable) != len(entries) {
		t.Errorf("expected no change, got len=%d", len(stable))
	}
}

func TestValidateAssignmentEntry_HappyPath(t *testing.T) {
	entry := AssignmentEntry{
		Slug:       "hello",
		Name:       "Hello",
		Template:   &TemplateRef{Owner: "cs50", Repo: "hello-template", Branch: "main"},
		Mode:       "individual",
		Autograder: "default",
	}
	if err := ValidateAssignmentEntry(entry); err != nil {
		t.Errorf("ValidateAssignmentEntry: %v", err)
	}
}

// TestValidateAssignmentEntry_TemplateLess: an entry with no template
// (nil Template) is valid on both the write and parse paths — it's a
// template-less assignment, accepted as an empty shim-only repo.
func TestValidateAssignmentEntry_TemplateLess(t *testing.T) {
	entry := AssignmentEntry{
		Slug:       "hello",
		Name:       "Hello",
		Mode:       "individual",
		Autograder: "default",
	}
	if err := ValidateAssignmentEntry(entry); err != nil {
		t.Errorf("ValidateAssignmentEntry(template-less): %v", err)
	}
	if err := ValidateExistingEntry(entry); err != nil {
		t.Errorf("ValidateExistingEntry(template-less): %v", err)
	}
}

// TestValidateAssignmentEntry_GroupMode: a group entry is schema-legal
// when it carries a usable max_group_size (>= 2).
func TestValidateAssignmentEntry_GroupMode(t *testing.T) {
	entry := AssignmentEntry{
		Slug:         "team-project",
		Name:         "Team Project",
		Template:     &TemplateRef{Owner: "cs50", Repo: "team-project-template", Branch: "main"},
		Mode:         "group",
		MaxGroupSize: 4,
		Autograder:   "default",
	}
	if err := ValidateAssignmentEntry(entry); err != nil {
		t.Errorf("ValidateAssignmentEntry(group): %v", err)
	}
}

// TestValidateAssignmentEntry_GroupModeRequiresSize: group mode without
// a usable size, and individual mode carrying a size, are both rejected.
func TestValidateAssignmentEntry_GroupModeRequiresSize(t *testing.T) {
	groupNoSize := AssignmentEntry{
		Slug: "team", Name: "Team",
		Template:   &TemplateRef{Owner: "cs50", Repo: "t", Branch: "main"},
		Mode:       "group",
		Autograder: "default",
	}
	if err := ValidateAssignmentEntry(groupNoSize); err == nil || !strings.Contains(err.Error(), "max_group_size") {
		t.Errorf("group without size: got %v, want a max_group_size error", err)
	}
	// Parse path is strict too (no legacy tolerance pre-launch): a group
	// entry with no/too-small size is rejected on read.
	if err := ValidateExistingEntry(groupNoSize); err == nil || !strings.Contains(err.Error(), "max_group_size") {
		t.Errorf("parse-path group without size: got %v, want a max_group_size error", err)
	}

	individualWithSize := AssignmentEntry{
		Slug: "solo", Name: "Solo",
		Template:     &TemplateRef{Owner: "cs50", Repo: "t", Branch: "main"},
		Mode:         "individual",
		MaxGroupSize: 3,
		Autograder:   "default",
	}
	if err := ValidateAssignmentEntry(individualWithSize); err == nil || !strings.Contains(err.Error(), "max_group_size") {
		t.Errorf("individual with size: got %v, want a max_group_size error", err)
	}
}

func TestValidateAssignmentEntry_Rejects(t *testing.T) {
	base := AssignmentEntry{
		Slug:       "hello",
		Name:       "Hello",
		Template:   &TemplateRef{Owner: "cs50", Repo: "hello-template", Branch: "main"},
		Mode:       "individual",
		Autograder: "default",
	}
	cases := []struct {
		name        string
		mutate      func(*AssignmentEntry)
		wantErrPart string
	}{
		{"empty slug", func(e *AssignmentEntry) { e.Slug = "" }, "slug"},
		{"slug pattern violation", func(e *AssignmentEntry) { e.Slug = "Hello" }, "slug"},
		{"empty name", func(e *AssignmentEntry) { e.Name = "" }, "--name"},
		{"empty mode", func(e *AssignmentEntry) { e.Mode = "" }, "mode"},
		{"unsupported mode", func(e *AssignmentEntry) { e.Mode = "team" }, "invalid mode"},
		{"empty template owner", func(e *AssignmentEntry) { e.Template.Owner = "" }, "template"},
		{"empty template repo", func(e *AssignmentEntry) { e.Template.Repo = "" }, "template"},
		{"empty template branch", func(e *AssignmentEntry) { e.Template.Branch = "" }, "branch"},
		{"empty autograder", func(e *AssignmentEntry) { e.Autograder = "" }, "autograder"},
		{"autograder traversal", func(e *AssignmentEntry) { e.Autograder = "../etc/passwd" }, "autograder"},
		{"due date-only", func(e *AssignmentEntry) { e.Due = "2026-09-15" }, "RFC 3339"},
		{"due missing timezone", func(e *AssignmentEntry) { e.Due = "2026-09-15T23:59:00" }, "RFC 3339"},
		{"due garbage", func(e *AssignmentEntry) { e.Due = "next Tuesday" }, "RFC 3339"},
		// due_meta, when present, must match the schema's shape — a
		// GUI/hand-edit can't smuggle a malformed provenance block past
		// the CLI while a schema-validating client would reject it.
		{"due_meta empty input", func(e *AssignmentEntry) {
			e.DueMeta = &DueMeta{Input: "", Offset: "-04:00", Source: DueSourceExplicit}
		}, "due_meta.input"},
		{"due_meta bad offset", func(e *AssignmentEntry) {
			e.DueMeta = &DueMeta{Input: "x", Offset: "Z", Source: DueSourceExplicit}
		}, "due_meta.offset"},
		{"due_meta bad source", func(e *AssignmentEntry) {
			e.DueMeta = &DueMeta{Input: "x", Offset: "-04:00", Source: "guessed"}
		}, "due_meta.source"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			entry := base
			// base.Template is a pointer shared across subtests; clone it
			// so a mutation case (e.g. clearing Template.Owner) doesn't
			// corrupt the shared base for later subtests.
			if base.Template != nil {
				tpl := *base.Template
				entry.Template = &tpl
			}
			tc.mutate(&entry)
			err := ValidateAssignmentEntry(entry)
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tc.wantErrPart)
			}
			if !strings.Contains(err.Error(), tc.wantErrPart) {
				t.Errorf("err = %q, want substring %q", err.Error(), tc.wantErrPart)
			}
		})
	}
}

func TestValidateAssignmentEntry_DueMeta(t *testing.T) {
	base := AssignmentEntry{
		Slug:       "hello",
		Name:       "Hello",
		Template:   &TemplateRef{Owner: "cs50", Repo: "hello-template", Branch: "main"},
		Mode:       "individual",
		Autograder: "default",
		Due:        "2026-09-16T03:59:00Z",
	}

	t.Run("due without due_meta validates (pre-due_meta files)", func(t *testing.T) {
		// Back-compat: files written before due_meta existed carry
		// `due` alone and must still validate.
		if err := ValidateAssignmentEntry(base); err != nil {
			t.Errorf("due-only entry should validate, got %v", err)
		}
	})

	t.Run("well-formed due_meta validates", func(t *testing.T) {
		e := base
		e.DueMeta = &DueMeta{
			Input: "2026-09-15T23:59:00", Zone: "America/New_York",
			Offset: "-04:00", Source: DueSourceAuto,
		}
		if err := ValidateAssignmentEntry(e); err != nil {
			t.Errorf("well-formed due_meta should validate, got %v", err)
		}
	})
}

func entriesWithSlugs(slugs ...string) []AssignmentEntry {
	out := make([]AssignmentEntry, len(slugs))
	for i, s := range slugs {
		out[i] = AssignmentEntry{Slug: s}
	}
	return out
}

// TestParseAssignments_PreservesUnknownEntryField pins the "tolerate AND
// preserve" rule: an unknown top-level entry key must NOT fail the parse and
// must round-trip verbatim through a re-encode.
func TestParseAssignments_PreservesUnknownEntryField(t *testing.T) {
	in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "mode": "individual",
      "autograder": "default",
      "future_field": {"nested": [1, 2, 3]},
      "another_future": "v2-only"
    }
  ]
}`)
	file, err := ParseAssignments(in)
	if err != nil {
		t.Fatalf("ParseAssignments must tolerate an unknown entry field: %v", err)
	}
	entry := file.Assignments[0]
	if entry.Extra == nil {
		t.Fatalf("unknown fields should be captured into Extra, got nil")
	}
	if _, ok := entry.Extra["future_field"]; !ok {
		t.Errorf("future_field not captured into Extra: %v", entry.Extra)
	}

	out, err := EncodeAssignments(file)
	if err != nil {
		t.Fatalf("EncodeAssignments: %v", err)
	}
	// Re-parse the re-encoded bytes and confirm the unknown fields survive.
	reparsed, err := ParseAssignments(out)
	if err != nil {
		t.Fatalf("re-parse of re-encoded file: %v\n%s", err, out)
	}
	got := reparsed.Assignments[0]
	if string(got.Extra["another_future"]) != `"v2-only"` {
		t.Errorf("another_future not preserved verbatim: %s", got.Extra["another_future"])
	}
	var nested map[string]any
	if err := json.Unmarshal(got.Extra["future_field"], &nested); err != nil {
		t.Fatalf("future_field not preserved as valid JSON: %v", err)
	}
	if !strings.Contains(string(out), "future_field") || !strings.Contains(string(out), "another_future") {
		t.Errorf("re-encoded file dropped an unknown field:\n%s", out)
	}
}

// TestParseAssignments_RejectsUnknownTopLevelKey confirms the ENVELOPE
// stays strict even though entries are tolerant.
func TestParseAssignments_RejectsUnknownTopLevelKey(t *testing.T) {
	in := []byte(`{"schema":"classroom50/assignments/v1","assignments":[],"extra":1}`)
	if _, err := ParseAssignments(in); err == nil {
		t.Fatal("unknown top-level envelope key must still be rejected")
	}
}

func TestSlugExistsFold(t *testing.T) {
	entries := entriesWithSlugs("hello", "Greet")
	cases := []struct {
		slug string
		want bool
	}{
		{"hello", true},
		{"HELLO", true}, // case-insensitive: slugs become repo path segments
		{"greet", true},
		{"missing", false},
	}
	for _, tc := range cases {
		if got := SlugExistsFold(entries, tc.slug); got != tc.want {
			t.Errorf("SlugExistsFold(%q) = %v, want %v", tc.slug, got, tc.want)
		}
	}
}

func TestNextAvailableSlug(t *testing.T) {
	cases := []struct {
		name    string
		entries []AssignmentEntry
		slug    string
		want    string
	}{
		{"free slug unchanged", entriesWithSlugs("other"), "hello", "hello"},
		{"first collision -> -2", entriesWithSlugs("hello"), "hello", "hello-2"},
		{"case-insensitive collision -> -2", entriesWithSlugs("Hello"), "hello", "hello-2"},
		{"skips taken suffixes", entriesWithSlugs("hello", "hello-2", "hello-3"), "hello", "hello-4"},
		{"base already -N increments from N+1", entriesWithSlugs("hello-2"), "hello-2", "hello-3"},
		{"base -N skips taken", entriesWithSlugs("hello-2", "hello-3"), "hello-2", "hello-4"},
		{"non-suffix trailing number is treated as base", entriesWithSlugs("week1"), "week1", "week1-2"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NextAvailableSlug(tc.entries, tc.slug)
			if err != nil {
				t.Fatalf("NextAvailableSlug(%q): unexpected error %v", tc.slug, err)
			}
			if got != tc.want {
				t.Errorf("NextAvailableSlug(%q) = %q, want %q", tc.slug, got, tc.want)
			}
		})
	}
}

// TestNextAvailableSlug_OverflowsCap pins that an auto-suffix exceeding the
// 39-char cap returns an actionable error rather than a too-long candidate.
func TestNextAvailableSlug_OverflowsCap(t *testing.T) {
	base := strings.Repeat("a", 39) // already at the cap; any "-N" overflows
	entries := entriesWithSlugs(base)
	if _, err := NextAvailableSlug(entries, base); err == nil {
		t.Fatal("expected an over-cap auto-suffix error, got nil")
	} else if !strings.Contains(err.Error(), "--slug") {
		t.Errorf("error should point at --slug, got %v", err)
	}
}
