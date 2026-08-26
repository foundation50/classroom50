package assignment

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
)

func intPtr(n int) *int { return &n }

func boolPtr(b bool) *bool { return &b }

func TestValidateTestSpec(t *testing.T) {
	cases := []struct {
		name    string
		spec    TestSpec
		wantErr string
	}{
		{
			name: "valid run test",
			spec: TestSpec{Name: "compiles", Type: "run", Run: "gcc -o hello hello.c", Points: 1},
		},
		{
			name: "valid run test with explicit exit code",
			spec: TestSpec{Name: "fails as expected", Type: "run", Run: "./hello --bad", ExitCode: intPtr(1), Points: 1},
		},
		{
			name: "valid io test (included)",
			spec: TestSpec{Name: "prints hi", Type: "io", Run: "./hello", Expected: "hi", Comparison: "included", Points: 2},
		},
		{
			name: "valid io test (regex, uncompiled by design)",
			spec: TestSpec{Name: "greets", Type: "io", Run: "./hello", Expected: "^hi(?=,)", Comparison: "regex", Points: 1},
		},
		{
			name: "valid io test with expected-file",
			spec: TestSpec{Name: "matches fixture", Type: "io", Run: "./hello", ExpectedFile: "expected.txt", Comparison: "exact", Points: 1},
		},
		{
			name: "valid io test with empty expected (exact)",
			spec: TestSpec{Name: "silent", Type: "io", Run: "./quiet", Comparison: "exact", Points: 1},
		},
		{
			name: "valid python test",
			spec: TestSpec{Name: "pytest", Type: "python", Run: "python -m pytest -q", Timeout: 120, Points: 10},
		},
		{
			name:    "empty name",
			spec:    TestSpec{Type: "run", Run: "x", Points: 1},
			wantErr: "name must not be empty",
		},
		{
			name:    "name too long",
			spec:    TestSpec{Name: strings.Repeat("a", 101), Type: "run", Run: "x", Points: 1},
			wantErr: "exceeds",
		},
		{
			name:    "name with newline",
			spec:    TestSpec{Name: "a\nb", Type: "run", Run: "x", Points: 1},
			wantErr: "control characters",
		},
		{
			name:    "invalid type",
			spec:    TestSpec{Name: "t", Type: "diff", Run: "x", Points: 1},
			wantErr: "invalid type",
		},
		{
			name:    "empty run",
			spec:    TestSpec{Name: "t", Type: "run", Points: 1},
			wantErr: "run must not be empty",
		},
		{
			name:    "timeout below floor",
			spec:    TestSpec{Name: "t", Type: "run", Run: "x", Timeout: -5, Points: 1},
			wantErr: "timeout",
		},
		{
			name:    "timeout above ceiling",
			spec:    TestSpec{Name: "t", Type: "run", Run: "x", Timeout: 601, Points: 1},
			wantErr: "timeout",
		},
		{
			name: "timeout zero is allowed (means default)",
			spec: TestSpec{Name: "t", Type: "run", Run: "x", Timeout: 0, Points: 1},
		},
		{
			name:    "negative points",
			spec:    TestSpec{Name: "t", Type: "run", Run: "x", Points: -1},
			wantErr: "points",
		},
		{
			name:    "points over cap",
			spec:    TestSpec{Name: "t", Type: "run", Run: "x", Points: 1001},
			wantErr: "points",
		},
		{
			name:    "io test missing comparison",
			spec:    TestSpec{Name: "t", Type: "io", Run: "x", Expected: "y", Points: 1},
			wantErr: "comparison",
		},
		{
			name:    "io test invalid comparison",
			spec:    TestSpec{Name: "t", Type: "io", Run: "x", Expected: "y", Comparison: "fuzzy", Points: 1},
			wantErr: "comparison",
		},
		{
			name:    "io test included with no expected rejected",
			spec:    TestSpec{Name: "t", Type: "io", Run: "x", Comparison: "included", Points: 1},
			wantErr: "matches everything",
		},
		{
			name:    "io test regex with no expected rejected",
			spec:    TestSpec{Name: "t", Type: "io", Run: "x", Comparison: "regex", Points: 1},
			wantErr: "matches everything",
		},
		{
			name: "io test included with expected-file accepted",
			spec: TestSpec{Name: "t", Type: "io", Run: "x", ExpectedFile: "out.txt", Comparison: "included", Points: 1},
		},
		{
			name:    "io test input and input-file both set",
			spec:    TestSpec{Name: "t", Type: "io", Run: "x", Input: "a", InputFile: "in.txt", Expected: "y", Comparison: "exact", Points: 1},
			wantErr: "input and input-file are mutually exclusive",
		},
		{
			name:    "io test expected and expected-file both set",
			spec:    TestSpec{Name: "t", Type: "io", Run: "x", Expected: "y", ExpectedFile: "out.txt", Comparison: "exact", Points: 1},
			wantErr: "expected and expected-file are mutually exclusive",
		},
		{
			name:    "io test with exit-code rejected",
			spec:    TestSpec{Name: "t", Type: "io", Run: "x", Expected: "y", Comparison: "exact", ExitCode: intPtr(0), Points: 1},
			wantErr: "exit-code is not valid for an io test",
		},
		{
			name:    "run test with comparison rejected",
			spec:    TestSpec{Name: "t", Type: "run", Run: "x", Comparison: "exact", Points: 1},
			wantErr: "only valid for an io test",
		},
		{
			name:    "run test with expected rejected",
			spec:    TestSpec{Name: "t", Type: "run", Run: "x", Expected: "y", Points: 1},
			wantErr: "only valid for an io test",
		},
		{
			name:    "python test with input rejected",
			spec:    TestSpec{Name: "t", Type: "python", Run: "pytest", Input: "a", Points: 1},
			wantErr: "only valid for an io test",
		},
		{
			name:    "python test with exit-code rejected",
			spec:    TestSpec{Name: "t", Type: "python", Run: "pytest", ExitCode: intPtr(0), Points: 1},
			wantErr: "exit-code is only valid for a run test",
		},
		{
			name:    "run test exit-code out of range",
			spec:    TestSpec{Name: "t", Type: "run", Run: "x", ExitCode: intPtr(256), Points: 1},
			wantErr: "exit-code",
		},
		{
			name: "valid failure-details and show-output",
			spec: TestSpec{Name: "t", Type: "run", Run: "x", Points: 1,
				FailureDetails: "actual-only", ShowOutput: boolPtr(true)},
		},
		{
			name: "explicit show-output false accepted",
			spec: TestSpec{Name: "t", Type: "run", Run: "x", Points: 1, ShowOutput: boolPtr(false)},
		},
		{
			name:    "invalid failure-details",
			spec:    TestSpec{Name: "t", Type: "run", Run: "x", Points: 1, FailureDetails: "loud"},
			wantErr: "failure-details",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateTestSpec(tc.spec)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error %q missing substring %q", err, tc.wantErr)
			}
		})
	}
}

func TestValidateTests_CountCap(t *testing.T) {
	// Distinct names so the count cap (not the duplicate check) trips.
	tests := make([]TestSpec, maxTestsPerAssignment+1)
	for i := range tests {
		tests[i] = TestSpec{Name: "test-" + strconv.Itoa(i), Type: "run", Run: "x", Points: 1}
	}
	err := ValidateTests(tests)
	if err == nil {
		t.Fatal("expected count-cap error, got nil")
	}
	if !strings.Contains(err.Error(), "too many tests") {
		t.Errorf("err should mention the count cap, got %q", err)
	}
}

func TestValidateTests_DuplicateName(t *testing.T) {
	tests := []TestSpec{
		{Name: "dup", Type: "run", Run: "x", Points: 1},
		{Name: "dup", Type: "run", Run: "y", Points: 1},
	}
	err := ValidateTests(tests)
	if err == nil {
		t.Fatal("expected duplicate-name error, got nil")
	}
	if !strings.Contains(err.Error(), "duplicate test name") {
		t.Errorf("err should mention duplicate name, got %q", err)
	}
}

func TestValidateTests_IndexInError(t *testing.T) {
	tests := []TestSpec{
		{Name: "ok", Type: "run", Run: "x", Points: 1},
		{Name: "bad", Type: "nope", Run: "x", Points: 1},
	}
	err := ValidateTests(tests)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "tests[1]") {
		t.Errorf("err should point at the offending index, got %q", err)
	}
}

func TestValidateAssignmentEntry_TestsPropagate(t *testing.T) {
	// A bad test must fail ValidateAssignmentEntry -- the write path
	// runs the same validator (mirrors the runtime-propagation guard).
	entry := AssignmentEntry{
		Slug:       "hello",
		Name:       "Hello",
		Template:   &TemplateRef{Owner: "cs50", Repo: "hello-template", Branch: "main"},
		Mode:       "individual",
		Autograder: "default",
		Tests:      []TestSpec{{Name: "t", Type: "io", Run: "x", Comparison: "fuzzy", Points: 1}},
	}
	err := ValidateAssignmentEntry(entry)
	if err == nil {
		t.Fatal("expected test validation to bubble up, got nil")
	}
	if !strings.Contains(err.Error(), "comparison") {
		t.Errorf("err should mention comparison, got %q", err)
	}
}

func TestParseTestsFile_EmptyPathIsNoOp(t *testing.T) {
	got, err := ParseTestsFile("")
	if err != nil {
		t.Fatalf("empty path should be a no-op, got error: %v", err)
	}
	if got != nil {
		t.Errorf("empty path should yield nil tests, got %#v", got)
	}
}

func TestParseTestsFileFrom_Stdin(t *testing.T) {
	body := `[{"name":"compiles","type":"run","run":"true","points":1}]`
	got, err := parseTestsFileFrom("-", strings.NewReader(body))
	if err != nil {
		t.Fatalf("parseTestsFileFrom: %v", err)
	}
	if len(got) != 1 || got[0].Name != "compiles" || got[0].Type != "run" {
		t.Errorf("stdin tests not parsed: %#v", got)
	}
}

func TestParseTestsFile_HappyPath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tests.json")
	body := `[
  {"name":"compiles","type":"run","run":"gcc -o hello hello.c","points":1},
  {"name":"prints","type":"io","run":"./hello","expected":"hi","comparison":"included","points":2}
]`
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	got, err := ParseTestsFile(path)
	if err != nil {
		t.Fatalf("ParseTestsFile: %v", err)
	}
	if len(got) != 2 || got[0].Name != "compiles" || got[1].Comparison != "included" {
		t.Errorf("tests not parsed: %#v", got)
	}
}

func TestParseTestsFile_UnknownFieldRejected(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tests.json")
	// `compare` is not a field (it's `comparison`); DisallowUnknownFields
	// must reject it rather than silently dropping it.
	body := `[{"name":"t","type":"io","run":"x","expected":"y","compare":"exact","points":1}]`
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, err := ParseTestsFile(path)
	if err == nil || !strings.Contains(err.Error(), "compare") {
		t.Fatalf("expected unknown-field error naming `compare`, got %v", err)
	}
}

func TestParseTestsFile_ValidationFailureWrapsPath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tests.json")
	body := `[{"name":"t","type":"nope","run":"x","points":1}]`
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, err := ParseTestsFile(path)
	if err == nil {
		t.Fatal("expected validation error, got nil")
	}
	if !strings.Contains(err.Error(), path) || !strings.Contains(err.Error(), "type") {
		t.Errorf("error should reference the path and the bad field, got %q", err)
	}
}

func TestParseTestsFile_EmptyFileRejected(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tests.json")
	if err := os.WriteFile(path, []byte("   \n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, err := ParseTestsFile(path)
	if err == nil || !strings.Contains(err.Error(), "empty") {
		t.Fatalf("expected empty-file error, got %v", err)
	}
}

func TestParseTestsFile_TrailingContentRejected(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tests.json")
	body := `[{"name":"t","type":"run","run":"x","points":1}] [1]`
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := ParseTestsFile(path); err == nil {
		t.Fatal("expected trailing-content error, got nil")
	}
}

func TestUpsertTest_AppendAndReplace(t *testing.T) {
	tests := []TestSpec{{Name: "a", Type: "run", Run: "x", Points: 1}}

	updated, replaced := UpsertTest(tests, TestSpec{Name: "a", Type: "run", Run: "y", Points: 2})
	if !replaced {
		t.Errorf("same name should replace")
	}
	if len(updated) != 1 || updated[0].Run != "y" || updated[0].Points != 2 {
		t.Errorf("expected in-place replace, got %#v", updated)
	}

	updated2, replaced2 := UpsertTest(updated, TestSpec{Name: "b", Type: "run", Run: "z", Points: 1})
	if replaced2 {
		t.Errorf("new name should append, not replace")
	}
	if len(updated2) != 2 || updated2[1].Name != "b" {
		t.Errorf("expected append at index 1, got %#v", updated2)
	}
}

func TestRemoveTest(t *testing.T) {
	tests := []TestSpec{{Name: "a"}, {Name: "b"}, {Name: "c"}}
	next, removed := RemoveTest(tests, "b")
	if !removed || len(next) != 2 || next[0].Name != "a" || next[1].Name != "c" {
		t.Errorf("expected ['a','c'], got %#v (removed=%v)", next, removed)
	}
	stable, removed2 := RemoveTest(tests, "missing")
	if removed2 {
		t.Errorf("missing name should not report removed")
	}
	if len(stable) != len(tests) {
		t.Errorf("missing name should not change the slice")
	}
}

func TestPerAssignmentAutograderPath(t *testing.T) {
	if got := PerAssignmentAutograderPath("cs-principles", "hello"); got != "cs-principles/autograders/hello/autograder.py" {
		t.Errorf("unexpected path %q", got)
	}
}

func TestValidateTestDefaults(t *testing.T) {
	cases := []struct {
		name     string
		defaults TestDefaults
		wantErr  string
	}{
		{name: "empty is valid", defaults: TestDefaults{}},
		{name: "valid values", defaults: TestDefaults{FailureDetails: "none", ShowOutput: boolPtr(true)}},
		{name: "explicit full", defaults: TestDefaults{FailureDetails: "full"}},
		{
			name:     "invalid failure-details",
			defaults: TestDefaults{FailureDetails: "loud"},
			wantErr:  "failure-details",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateTestDefaults(tc.defaults)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("expected error containing %q, got %v", tc.wantErr, err)
			}
		})
	}
}

// TestParseTestsFile_ShowOutputFalseRoundTrips pins the *bool contract: an
// explicit show-output:false must survive a parse (it overrides a
// test_defaults show-output:true), while an absent field stays nil.
func TestParseTestsFile_ShowOutputFalseRoundTrips(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tests.json")
	body := `[
  {"name":"opts-out","type":"run","run":"x","points":1,"show-output":false,"failure-details":"actual-only"},
  {"name":"inherits","type":"run","run":"x","points":1}
]`
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	got, err := ParseTestsFile(path)
	if err != nil {
		t.Fatalf("ParseTestsFile: %v", err)
	}
	if got[0].ShowOutput == nil || *got[0].ShowOutput {
		t.Errorf("explicit show-output:false lost: %#v", got[0].ShowOutput)
	}
	if got[0].FailureDetails != "actual-only" {
		t.Errorf("failure-details lost: %q", got[0].FailureDetails)
	}
	if got[1].ShowOutput != nil {
		t.Errorf("absent show-output must stay nil, got %#v", got[1].ShowOutput)
	}
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(raw), `"show-output":false`) {
		t.Errorf("explicit false must re-emit on the wire, got %s", raw)
	}
	if strings.Count(string(raw), `"show-output"`) != 1 {
		t.Errorf("absent show-output must stay omitted on the wire, got %s", raw)
	}
}

// TestFailureDetailsEnumParity pins the failure-details allow-list against the
// JSON schema enum (the declared source of truth); the web mirror
// (TEST_FAILURE_DETAILS_LEVELS) is pinned against the same enum by a vitest.
// Compared as sorted sets: the schema lists the default (`full`) first, while
// the Go slice is sorted for stable error messages.
func TestFailureDetailsEnumParity(t *testing.T) {
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
			Test struct {
				Properties struct {
					FailureDetails struct {
						Enum []string `json:"enum"`
					} `json:"failure-details"`
				} `json:"properties"`
			} `json:"test"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatalf("parse schema: %v", err)
	}
	schemaEnum := append([]string(nil), schema.Defs.Test.Properties.FailureDetails.Enum...)
	if len(schemaEnum) == 0 {
		t.Fatalf("schema failure-details enum not found; did the $defs shape change?")
	}
	sort.Strings(schemaEnum)
	goLevels := append([]string(nil), failureDetailsLevels...)
	sort.Strings(goLevels)
	if !reflect.DeepEqual(schemaEnum, goLevels) {
		t.Errorf("failure-details drift: schema enum %v != failureDetailsLevels %v — update every mirror in lockstep (schema, tests.go, runner.py, web TEST_FAILURE_DETAILS_LEVELS)",
			schemaEnum, goLevels)
	}
}
