package assignment

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateRuntime_HostPaths(t *testing.T) {
	cases := []struct {
		name    string
		runtime RuntimeRef
		wantErr string
	}{
		{
			name:    "empty is valid",
			runtime: RuntimeRef{},
		},
		{
			name:    "ubuntu-latest with python",
			runtime: RuntimeRef{RunsOn: RunsOn{"ubuntu-latest"}, Python: "3.12"},
		},
		{
			name:    "all language fields",
			runtime: RuntimeRef{Python: "3.12", Node: "20", Java: "21", Go: "1.23", Rust: "1.79"},
		},
		{
			name:    "apt packages",
			runtime: RuntimeRef{Apt: []string{"build-essential", "valgrind", "lib-fake.dev"}},
		},
		{
			name:    "self-hosted single label accepted",
			runtime: RuntimeRef{RunsOn: RunsOn{"self-hosted"}},
		},
		{
			name:    "custom multi-label runs-on accepted",
			runtime: RuntimeRef{RunsOn: RunsOn{"self-hosted", "gpu", "linux-x64"}},
		},
		{
			name:    "custom runner with language toolchain accepted",
			runtime: RuntimeRef{RunsOn: RunsOn{"self-hosted"}, Python: "3.12"},
		},
		{
			name:    "arbitrary unknown label accepted (no allow-list)",
			runtime: RuntimeRef{RunsOn: RunsOn{"ubuntu-30.04"}},
		},
		{
			name:    "runs-on label with whitespace rejected",
			runtime: RuntimeRef{RunsOn: RunsOn{"self hosted"}},
			wantErr: "runtime.runs-on",
		},
		{
			name:    "runs-on label with shell metacharacters rejected",
			runtime: RuntimeRef{RunsOn: RunsOn{"self-hosted; rm -rf /"}},
			wantErr: "runtime.runs-on",
		},
		{
			name:    "too many runs-on labels rejected",
			runtime: RuntimeRef{RunsOn: RunsOn{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"}},
			wantErr: "max 10",
		},
		{
			name:    "blank label in runs-on rejected",
			runtime: RuntimeRef{RunsOn: RunsOn{""}},
			wantErr: "runtime.runs-on",
		},
		{
			name:    "python version with semicolon rejected",
			runtime: RuntimeRef{Python: "3.12; rm -rf /"},
			wantErr: "runtime.python",
		},
		{
			name:    "rust channel specifier accepted",
			runtime: RuntimeRef{Rust: "stable"},
		},
		{
			name:    "rust version with semicolon rejected",
			runtime: RuntimeRef{Rust: "1.79; rm -rf /"},
			wantErr: "runtime.rust",
		},
		{
			name:    "apt with shell metacharacters rejected",
			runtime: RuntimeRef{Apt: []string{"build-essential;rm"}},
			wantErr: "runtime.apt",
		},
		{
			name:    "apt with uppercase rejected",
			runtime: RuntimeRef{Apt: []string{"Foo"}},
			wantErr: "runtime.apt",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateRuntime(tc.runtime)
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

func TestValidateRuntime_ContainerPaths(t *testing.T) {
	cases := []struct {
		name    string
		runtime RuntimeRef
		wantErr string
	}{
		{
			name: "image only",
			runtime: RuntimeRef{
				Container: &ContainerSpec{Image: "ghcr.io/cs50/grading-env:1.2"},
			},
		},
		{
			name: "container on a self-hosted runner accepted",
			runtime: RuntimeRef{
				RunsOn:    RunsOn{"self-hosted", "linux"},
				Container: &ContainerSpec{Image: "ghcr.io/cs50/grading-env:1.2"},
			},
		},
		{
			name: "image with apt rejected",
			runtime: RuntimeRef{
				Container: &ContainerSpec{Image: "ubuntu:24.04"},
				Apt:       []string{"build-essential"},
			},
			wantErr: "runtime.apt is not allowed when runtime.container",
		},
		{
			name: "macos runs-on with container rejected",
			runtime: RuntimeRef{
				RunsOn:    RunsOn{"macos-latest"},
				Container: &ContainerSpec{Image: "ubuntu:24.04"},
			},
			wantErr: "Ubuntu hosts only",
		},
		{
			name: "windows label in multi-label array with container rejected",
			runtime: RuntimeRef{
				RunsOn:    RunsOn{"self-hosted", "windows-2022"},
				Container: &ContainerSpec{Image: "ubuntu:24.04"},
			},
			wantErr: "Ubuntu hosts only",
		},
		{
			name: "empty image rejected",
			runtime: RuntimeRef{
				Container: &ContainerSpec{Image: ""},
			},
			wantErr: "runtime.container.image must not be empty",
		},
		{
			name: "image with shell metacharacters rejected",
			runtime: RuntimeRef{
				Container: &ContainerSpec{Image: "ubuntu:24.04;rm"},
			},
			wantErr: "characters other than",
		},
		{
			name: "user 32-char accepted (boundary)",
			runtime: RuntimeRef{
				Container: &ContainerSpec{
					Image: "cs50/cli:latest",
					User:  "a" + strings.Repeat("b", 31), // first char + 31 = 32
				},
			},
		},
		{
			name: "user 33-char rejected (over boundary)",
			runtime: RuntimeRef{
				Container: &ContainerSpec{
					Image: "cs50/cli:latest",
					User:  "a" + strings.Repeat("b", 32), // first char + 32 = 33
				},
			},
			wantErr: "runtime.container.user",
		},
		{
			name: "user trailing colon rejected",
			runtime: RuntimeRef{
				Container: &ContainerSpec{Image: "cs50/cli:latest", User: "1000:"},
			},
			wantErr: "runtime.container.user",
		},
		{
			name: "user multi-colon rejected",
			runtime: RuntimeRef{
				Container: &ContainerSpec{Image: "cs50/cli:latest", User: "1000:1000:1000"},
			},
			wantErr: "runtime.container.user",
		},
		{
			name: "user leading underscore accepted",
			runtime: RuntimeRef{
				Container: &ContainerSpec{Image: "cs50/cli:latest", User: "_appuser"},
			},
		},
		{
			name: "user root accepted",
			runtime: RuntimeRef{
				Container: &ContainerSpec{Image: "cs50/cli:latest", User: "root"},
			},
		},
		{
			name: "user numeric uid accepted",
			runtime: RuntimeRef{
				Container: &ContainerSpec{Image: "cs50/cli:latest", User: "0"},
			},
		},
		{
			name: "user uid:gid accepted",
			runtime: RuntimeRef{
				Container: &ContainerSpec{Image: "cs50/cli:latest", User: "1000:1000"},
			},
		},
		{
			name: "user with shell metacharacters rejected",
			runtime: RuntimeRef{
				Container: &ContainerSpec{Image: "cs50/cli:latest", User: "root; rm -rf /"},
			},
			wantErr: "runtime.container.user",
		},
		{
			name: "user with leading hyphen rejected",
			runtime: RuntimeRef{
				Container: &ContainerSpec{Image: "cs50/cli:latest", User: "-rm"},
			},
			wantErr: "runtime.container.user",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateRuntime(tc.runtime)
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

func TestParseRuntimeFile_Empty(t *testing.T) {
	got, err := ParseRuntimeFile("")
	if err != nil {
		t.Fatalf("empty path should be no-op, got error: %v", err)
	}
	if got != nil {
		t.Errorf("empty path should yield nil RuntimeRef, got %#v", got)
	}
}

func TestParseRuntimeFile_HappyPath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.json")
	body := `{
  "runs-on": "ubuntu-latest",
  "python": "3.12",
  "apt": ["build-essential"]
}
`
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	got, err := ParseRuntimeFile(path)
	if err != nil {
		t.Fatalf("ParseRuntimeFile: %v", err)
	}
	if got == nil {
		t.Fatal("got nil RuntimeRef on happy path")
		return
	}
	if len(got.RunsOn) != 1 || got.RunsOn[0] != "ubuntu-latest" || got.Python != "3.12" {
		t.Errorf("fields not parsed: %#v", got)
	}
	if len(got.Apt) != 1 || got.Apt[0] != "build-essential" {
		t.Errorf("apt not parsed: %#v", got.Apt)
	}
}

func TestParseRuntimeFile_UnknownField(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.json")
	// Typo: `run-on` instead of `runs-on`. DisallowUnknownFields
	// must surface this as a decode error rather than silently
	// falling through to defaults.
	body := `{"run-on": "ubuntu-latest"}`
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, err := ParseRuntimeFile(path)
	if err == nil {
		t.Fatal("expected decode error for unknown field, got nil")
	}
	if !strings.Contains(err.Error(), "run-on") {
		t.Errorf("error should name the offending field, got %q", err)
	}
}

func TestParseRuntimeFile_TrailingContentRejected(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.json")
	body := `{"runs-on": "ubuntu-latest"} {"extra": "object"}`
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, err := ParseRuntimeFile(path)
	if err == nil {
		t.Fatal("expected error for trailing content, got nil")
	}
}

func TestParseRuntimeFile_ValidationFailureWrapsPath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.json")
	// A runs-on label with a space fails injection validation; the
	// wrapped error must still name the offending file path.
	body := `{"runs-on": "self hosted"}`
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, err := ParseRuntimeFile(path)
	if err == nil {
		t.Fatal("expected validation error, got nil")
	}
	if !strings.Contains(err.Error(), path) {
		t.Errorf("error should reference the offending file path, got %q", err)
	}
}

func TestValidateAssignmentEntry_RuntimePropagates(t *testing.T) {
	// Bad runtime block must fail ValidateAssignmentEntry — the
	// write path uses the same validator under the hood.
	entry := AssignmentEntry{
		Slug:       "hello",
		Name:       "Hello",
		Template:   &TemplateRef{Owner: "cs50", Repo: "hello-template", Branch: "main"},
		Mode:       "individual",
		Autograder: "default",
		Runtime:    &RuntimeRef{Apt: []string{"BAD;PKG"}},
	}
	err := ValidateAssignmentEntry(entry)
	if err == nil {
		t.Fatal("expected runtime validation to bubble up, got nil")
	}
	if !strings.Contains(err.Error(), "runtime.apt") {
		t.Errorf("err should mention runtime.apt, got %q", err)
	}
}

func TestParseAssignments_RuntimeRoundTrips(t *testing.T) {
	in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "cs50", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default",
      "runtime": {
        "runs-on": "ubuntu-latest",
        "python": "3.12",
        "apt": ["build-essential"]
      }
    }
  ]
}`)
	file, err := ParseAssignments(in)
	if err != nil {
		t.Fatalf("ParseAssignments: %v", err)
	}
	got := file.Assignments[0].Runtime
	if got == nil {
		t.Fatal("runtime block dropped on parse")
		return
	}
	if len(got.RunsOn) != 1 || got.RunsOn[0] != "ubuntu-latest" || got.Python != "3.12" || len(got.Apt) != 1 {
		t.Errorf("runtime fields not parsed: %#v", got)
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
	if again.Assignments[0].Runtime == nil {
		t.Fatal("runtime block dropped on re-encode")
	}
}

func TestParseAssignments_RejectsInvalidRuntime(t *testing.T) {
	in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "cs50", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default",
      "runtime": {
        "runs-on": "self hosted grading"
      }
    }
  ]
}`)
	_, err := ParseAssignments(in)
	if err == nil {
		t.Fatal("expected parse to reject a runs-on label with spaces, got nil")
	}
	if !strings.Contains(err.Error(), "runtime.runs-on") {
		t.Errorf("err should reference runtime.runs-on, got %q", err)
	}
}

func TestParseAssignments_CustomRunnerArrayRoundTrips(t *testing.T) {
	in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "heavy",
      "name": "Heavy",
      "template": { "owner": "cs50", "repo": "heavy-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default",
      "runtime": {
        "runs-on": ["self-hosted", "gpu"],
        "python": "3.12"
      }
    }
  ]
}`)
	file, err := ParseAssignments(in)
	if err != nil {
		t.Fatalf("ParseAssignments: %v", err)
	}
	rt := file.Assignments[0].Runtime
	if rt == nil {
		t.Fatal("runtime block dropped on parse")
		return
	}
	if len(rt.RunsOn) != 2 || rt.RunsOn[0] != "self-hosted" || rt.RunsOn[1] != "gpu" {
		t.Errorf("runs-on labels not parsed: %#v", rt.RunsOn)
	}

	encoded, err := EncodeAssignments(file)
	if err != nil {
		t.Fatalf("EncodeAssignments: %v", err)
	}
	// A multi-label runs-on must re-encode as a JSON array.
	if !strings.Contains(string(encoded), `"runs-on": [`) {
		t.Errorf("multi-label runs-on should re-encode as a JSON array, got:\n%s", encoded)
	}
	again, err := ParseAssignments(encoded)
	if err != nil {
		t.Fatalf("re-parse: %v", err)
	}
	if len(again.Assignments[0].Runtime.RunsOn) != 2 {
		t.Fatal("runs-on labels dropped on re-encode")
	}
}

func TestParseAssignments_SingleLabelRunsOnEncodesAsString(t *testing.T) {
	// A single-label runs-on must round-trip as a JSON string (not a
	// one-element array), matching what teachers write and GitHub
	// Actions' own canonical form.
	in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "cs50", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default",
      "runtime": { "runs-on": "self-hosted" }
    }
  ]
}`)
	file, err := ParseAssignments(in)
	if err != nil {
		t.Fatalf("ParseAssignments: %v", err)
	}
	if got := file.Assignments[0].Runtime.RunsOn; len(got) != 1 || got[0] != "self-hosted" {
		t.Errorf("runs-on not parsed: %#v", got)
	}
	encoded, err := EncodeAssignments(file)
	if err != nil {
		t.Fatalf("EncodeAssignments: %v", err)
	}
	if !strings.Contains(string(encoded), `"runs-on": "self-hosted"`) {
		t.Errorf("single-label runs-on should re-encode as a JSON string, got:\n%s", encoded)
	}
}

// TestParseAssignments_RejectsDegenerateRunsOn pins the three-surface
// alignment: an omitted runs-on means default, but the present-but-
// empty forms ("" and []) are rejected at parse time, matching the
// inline-Python validator and the schema (oneOf, minItems:1).
func TestParseAssignments_RejectsDegenerateRunsOn(t *testing.T) {
	cases := []struct {
		name    string
		runsOn  string
		wantErr string
	}{
		{"empty string", `""`, "empty string"},
		{"empty array", `[]`, "empty array"},
		{"array with non-string element", `[1]`, "only strings"},
		{"wrong type number", `123`, "label string or an array"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "cs50", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default",
      "runtime": { "runs-on": ` + tc.runsOn + ` }
    }
  ]
}`)
			_, err := ParseAssignments(in)
			if err == nil {
				t.Fatalf("expected parse to reject runs-on %s, got nil", tc.runsOn)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("err for runs-on %s should contain %q, got %q", tc.runsOn, tc.wantErr, err)
			}
		})
	}
}

// TestParseAssignments_OmittedRunsOnIsDefault confirms the one valid
// "use the default" shape: runs-on absent entirely (not "" or []).
func TestParseAssignments_OmittedRunsOnIsDefault(t *testing.T) {
	in := []byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "cs50", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default",
      "runtime": { "python": "3.12" }
    }
  ]
}`)
	file, err := ParseAssignments(in)
	if err != nil {
		t.Fatalf("ParseAssignments: %v", err)
	}
	if got := file.Assignments[0].Runtime.RunsOn; len(got) != 0 {
		t.Errorf("omitted runs-on should yield an empty RunsOn, got %#v", got)
	}
}
