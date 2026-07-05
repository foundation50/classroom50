package assignment

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
)

// Declarative tests: a teacher attaches small io/run/python tests to an
// assignment in assignments.json instead of writing an autograder.py.
// publish-pages materializes them; runner.py grades them. This file is the
// write/parse-time validator; the runner re-validates at grade time since
// assignments.json is hand-editable.
//
// `run`/`setup` are deliberately NOT injection-checked: they're teacher-authored
// shell by design, travel to the grade job as bundle data (never interpolated
// into workflow YAML), and students can't edit assignments.json.

// TestSpec is one declarative test of one of three types:
//
//   - "io": feed Input (or InputFile) on stdin, compare stdout to Expected
//     (or ExpectedFile) per Comparison.
//   - "run": pass iff the exit code matches ExitCode (default 0).
//   - "python": run pytest; points split across discovered cases.
//
// Points has no omitempty so a 0-point informational test reads explicitly.
type TestSpec struct {
	Name         string `json:"name"`
	Type         string `json:"type"`
	Setup        string `json:"setup,omitempty"`
	Run          string `json:"run"`
	Input        string `json:"input,omitempty"`
	InputFile    string `json:"input-file,omitempty"`
	Expected     string `json:"expected,omitempty"`
	ExpectedFile string `json:"expected-file,omitempty"`
	Comparison   string `json:"comparison,omitempty"`
	Timeout      int    `json:"timeout,omitempty"`
	ExitCode     *int   `json:"exit-code,omitempty"`
	Points       int    `json:"points"`
}

const (
	testTypeIO     = "io"
	testTypeRun    = "run"
	testTypePython = "python"
)

// testTypes is the allow-list, sorted so error messages stay stable.
var testTypes = []string{testTypeIO, testTypePython, testTypeRun}

// Comparison modes for io tests (GitHub Classroom's Included/Exact/Regex).
// `regex` is evaluated by Python's `re` at grade time, not Go's RE2 — see
// validateIOFields.
const (
	comparisonIncluded = "included"
	comparisonExact    = "exact"
	comparisonRegex    = "regex"
)

// comparisonModes is the allow-list, sorted.
var comparisonModes = []string{comparisonExact, comparisonIncluded, comparisonRegex}

// Bounds: generous for real assignments, tight enough that a hand-edited
// assignments.json can't wedge the gradebook or blow the contents-API ceiling.
const (
	maxTestsPerAssignment = 100
	minTimeoutSeconds     = 1
	maxTimeoutSeconds     = 600
	maxTestPoints         = 1000
	maxTestNameLen        = 100
	minExitCode           = 0
	maxExitCode           = 255
)

func isValidTestType(s string) bool {
	for _, t := range testTypes {
		if s == t {
			return true
		}
	}
	return false
}

func isValidComparison(s string) bool {
	for _, c := range comparisonModes {
		if s == c {
			return true
		}
	}
	return false
}

// ValidateTests checks an assignment's test list on both paths: count cap,
// per-spec validation, and unique names (a name is its identity in result.json
// and the release body).
func ValidateTests(tests []TestSpec) error {
	if len(tests) > maxTestsPerAssignment {
		return fmt.Errorf("too many tests: %d exceeds the per-assignment cap of %d", len(tests), maxTestsPerAssignment)
	}
	seen := make(map[string]bool, len(tests))
	for i, t := range tests {
		if err := ValidateTestSpec(t); err != nil {
			return fmt.Errorf("tests[%d]: %w", i, err)
		}
		if seen[t.Name] {
			return fmt.Errorf("tests[%d]: duplicate test name %q (names must be unique within an assignment)", i, t.Name)
		}
		seen[t.Name] = true
	}
	return nil
}

// ValidateTestSpec checks one test. Field applicability is strict (io-only
// fields rejected on run/python, exit-code only on run) so a mistyped spec
// fails loudly.
func ValidateTestSpec(t TestSpec) error {
	if t.Name == "" {
		return errors.New("name must not be empty")
	}
	if len(t.Name) > maxTestNameLen {
		return fmt.Errorf("name %q exceeds %d bytes", t.Name, maxTestNameLen)
	}
	if err := validateNoControlChars(t.Name, "name"); err != nil {
		return err
	}
	if !isValidTestType(t.Type) {
		return fmt.Errorf("invalid type %q: must be one of %v", t.Type, testTypes)
	}
	if t.Run == "" {
		return errors.New("run must not be empty")
	}
	if t.Timeout != 0 && (t.Timeout < minTimeoutSeconds || t.Timeout > maxTimeoutSeconds) {
		return fmt.Errorf("timeout %d must be between %d and %d seconds (0 means use the default)", t.Timeout, minTimeoutSeconds, maxTimeoutSeconds)
	}
	if t.Points < 0 || t.Points > maxTestPoints {
		return fmt.Errorf("points %d must be between 0 and %d", t.Points, maxTestPoints)
	}

	if t.Type == testTypeIO {
		return validateIOFields(t)
	}
	return validateNonIOFields(t)
}

// validateIOFields enforces the io-test shape: valid comparison mode,
// inline-vs-file fields mutually exclusive, no exit-code.
func validateIOFields(t TestSpec) error {
	if !isValidComparison(t.Comparison) {
		return fmt.Errorf("comparison %q invalid for an io test: must be one of %v", t.Comparison, comparisonModes)
	}
	if t.Input != "" && t.InputFile != "" {
		return errors.New("input and input-file are mutually exclusive")
	}
	if t.Expected != "" && t.ExpectedFile != "" {
		return errors.New("expected and expected-file are mutually exclusive")
	}
	// `included`/`regex` against an empty expected match everything (a
	// silently-always-passing test), so reject. `exact` is exempt: empty
	// legitimately means "expect empty output".
	if t.Comparison != comparisonExact && t.Expected == "" && t.ExpectedFile == "" {
		return fmt.Errorf("an io test with comparison %q needs a non-empty expected or expected-file (an empty expected matches everything)", t.Comparison)
	}
	if t.ExitCode != nil {
		return errors.New(`exit-code is not valid for an io test (use type "run")`)
	}
	// `regex` is NOT compile-checked here: the grader uses Python's `re`, which
	// accepts constructs RE2 rejects. A bad pattern surfaces at grade time.
	return nil
}

// validateNonIOFields rejects io-only fields on run/python tests and
// bounds exit-code (run only).
func validateNonIOFields(t TestSpec) error {
	for _, f := range []struct{ name, value string }{
		{"input", t.Input},
		{"input-file", t.InputFile},
		{"expected", t.Expected},
		{"expected-file", t.ExpectedFile},
		{"comparison", t.Comparison},
	} {
		if f.value != "" {
			return fmt.Errorf("%s is only valid for an io test, not a %s test", f.name, t.Type)
		}
	}
	if t.ExitCode != nil {
		if t.Type != testTypeRun {
			return fmt.Errorf("exit-code is only valid for a run test, not a %s test", t.Type)
		}
		if *t.ExitCode < minExitCode || *t.ExitCode > maxExitCode {
			return fmt.Errorf("exit-code %d must be between %d and %d", *t.ExitCode, minExitCode, maxExitCode)
		}
	}
	return nil
}

// validateNoControlChars rejects ASCII control characters in values that
// get echoed into logs and the Markdown release body.
func validateNoControlChars(s, label string) error {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("%s must not contain control characters", label)
		}
	}
	return nil
}

// ParseTestsFile loads and validates `--tests <path>` (`-` = stdin): a bare
// JSON array of test specs. Empty path → (nil, nil). DisallowUnknownFields so a
// typo'd key fails loudly.
func ParseTestsFile(path string) ([]TestSpec, error) {
	return parseTestsFileFrom(path, os.Stdin)
}

// parseTestsFileFrom is the testable seam for ParseTestsFile.
func parseTestsFileFrom(path string, stdin io.Reader) ([]TestSpec, error) {
	if path == "" {
		return nil, nil
	}
	var (
		data  []byte
		err   error
		label string
	)
	if path == "-" {
		data, err = io.ReadAll(stdin)
		label = "<stdin>"
	} else {
		data, err = os.ReadFile(path)
		label = path
	}
	if err != nil {
		return nil, fmt.Errorf("read --tests %s: %w", label, err)
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return nil, fmt.Errorf("--tests %s is empty", label)
	}
	var tests []TestSpec
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&tests); err != nil {
		return nil, fmt.Errorf("parse --tests %s: %w", label, err)
	}
	if err := expectEOF(dec); err != nil {
		return nil, fmt.Errorf("parse --tests %s: %w", label, err)
	}
	if err := ValidateTests(tests); err != nil {
		return nil, fmt.Errorf("--tests %s: %w", label, err)
	}
	return tests, nil
}

// UpsertTest replaces a test by Name (position-preserving) or appends it.
// Returns the slice and whether an existing test was replaced.
func UpsertTest(tests []TestSpec, spec TestSpec) ([]TestSpec, bool) {
	for i := range tests {
		if tests[i].Name == spec.Name {
			tests[i] = spec
			return tests, true
		}
	}
	return append(tests, spec), false
}

// RemoveTest drops a test by Name. Returns the slice and whether a test
// was removed.
func RemoveTest(tests []TestSpec, name string) ([]TestSpec, bool) {
	for i := range tests {
		if tests[i].Name == name {
			return append(tests[:i], tests[i+1:]...), true
		}
	}
	return tests, false
}

// PerAssignmentAutograderPath is the config-repo path of a slug's hand-written
// entrypoint, probed by the tests-vs-autograder.py conflict check.
func PerAssignmentAutograderPath(classroom, slug string) string {
	return classroom + "/autograders/" + slug + "/autograder.py"
}
