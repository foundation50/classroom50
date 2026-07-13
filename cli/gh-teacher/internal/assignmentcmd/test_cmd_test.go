package assignmentcmd

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/githubtest"
)

// testCmdFixture wires the GitHub API surface the `assignment test`
// subcommands touch (branch resolve, assignments.json read, the
// autograder.py conflict probe, the commitTree write endpoints). Captured
// fields record what was committed.
type testCmdFixture struct {
	mu sync.Mutex
	// committed is the decoded blob uploaded via git/blobs, nil if none.
	committed []byte
	// treePath is the path of the single tree entry.
	treePath string
	// refPatched reports whether the branch ref was advanced.
	refPatched bool
}

// newTestCmdServer builds the fixture server. assignmentsBody is served
// for cs-principles/assignments.json; autograderExists controls the 200
// vs 404 of the cs-principles/autograders/hello/autograder.py probe.
func newTestCmdServer(t *testing.T, assignmentsBody string, autograderExists bool) (*httptest.Server, *testCmdFixture) {
	t.Helper()
	fix := &testCmdFixture{}

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/classroom50", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"default_branch": "main"})
	})
	mux.HandleFunc("/repos/o/classroom50/contents/cs-principles/assignments.json", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type":     "file",
			"content":  base64.StdEncoding.EncodeToString([]byte(assignmentsBody)),
			"encoding": "base64",
		})
	})
	mux.HandleFunc("/repos/o/classroom50/contents/cs-principles/autograders/hello/autograder.py", func(w http.ResponseWriter, r *http.Request) {
		if autograderExists {
			_ = json.NewEncoder(w).Encode(map[string]any{"type": "file"})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"message":"Not Found"}`)
	})
	// Skeleton-support probe (ensureDeclarativeTestsSupported): present
	// by default; TestRunAssignmentTestAdd_RequiresMaterializeScript
	// builds its own server with a 404 instead.
	mux.HandleFunc("/repos/o/classroom50/contents/.github/scripts/materialize_tests.py", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"type": "file"})
	})
	// Template repo probe used by the runAssignmentAdd tests.
	mux.HandleFunc("/repos/cs50/hello-template", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"is_template": true, "default_branch": "main"})
	})
	mux.HandleFunc("/repos/o/classroom50/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch {
			fix.mu.Lock()
			fix.refPatched = true
			fix.mu.Unlock()
			w.WriteHeader(http.StatusOK)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"object": map[string]string{"sha": "parent-sha"},
		})
	})
	mux.HandleFunc("/repos/o/classroom50/git/commits/parent-sha", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tree": map[string]string{"sha": "parent-tree"},
		})
	})
	mux.HandleFunc("/repos/o/classroom50/git/blobs", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Content  string `json:"content"`
			Encoding string `json:"encoding"`
		}
		_ = json.Unmarshal(body, &payload)
		if payload.Encoding == "base64" {
			decoded, _ := base64.StdEncoding.DecodeString(payload.Content)
			fix.mu.Lock()
			fix.committed = decoded
			fix.mu.Unlock()
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "blob-sha"})
	})
	mux.HandleFunc("/repos/o/classroom50/git/trees", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Tree []struct {
				Path string `json:"path"`
			} `json:"tree"`
		}
		_ = json.Unmarshal(body, &payload)
		if len(payload.Tree) == 1 {
			fix.mu.Lock()
			fix.treePath = payload.Tree[0].Path
			fix.mu.Unlock()
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-tree-sha"})
	})
	mux.HandleFunc("/repos/o/classroom50/git/commits", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-commit-sha"})
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server, fix
}

// helloAssignments returns an assignments.json body with one valid "hello"
// entry carrying the given tests array (raw JSON, e.g. `[]` or a populated
// array).
func helloAssignments(testsJSON string) string {
	tests := ""
	if testsJSON != "" {
		tests = `,
      "tests": ` + testsJSON
	}
	return `{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "cs50", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default"` + tests + `
    }
  ]
}`
}

// helloAddParams returns a baseline addAssignmentParams matching the `hello`
// fixture. Tests override only the fields they exercise.
func helloAddParams() addAssignmentParams {
	return addAssignmentParams{
		Org:        "o",
		Classroom:  "cs-principles",
		Slug:       "hello",
		Name:       "Hello",
		Tmpl:       &templateArg{Owner: "cs50", Repo: "hello-template"},
		Mode:       "individual",
		Autograder: "default",
	}
}

// decodeCommitted parses the assignments.json the fixture captured.
func decodeCommitted(t *testing.T, fix *testCmdFixture) assignment.AssignmentsJSON {
	t.Helper()
	fix.mu.Lock()
	defer fix.mu.Unlock()
	if fix.committed == nil {
		t.Fatal("no blob was committed")
	}
	file, err := assignment.ParseAssignments(fix.committed)
	if err != nil {
		t.Fatalf("committed assignments.json does not parse: %v", err)
	}
	return file
}

func TestRunAssignmentTestAdd_AppendsToEntry(t *testing.T) {
	server, fix := newTestCmdServer(t, helloAssignments(""), false)
	client := githubtest.NewTestClient(t, server)

	var stdout bytes.Buffer
	spec := assignment.TestSpec{Name: "compiles", Type: "run", Run: "gcc -o hello hello.c", Points: 1}
	if err := runAssignmentTestAdd(client, &stdout, "o", "cs-principles", "hello", spec); err != nil {
		t.Fatalf("runAssignmentTestAdd: %v", err)
	}

	file := decodeCommitted(t, fix)
	tests := file.Assignments[0].Tests
	if len(tests) != 1 || tests[0].Name != "compiles" || tests[0].Run != "gcc -o hello hello.c" {
		t.Errorf("committed tests = %#v, want the added spec", tests)
	}
	fix.mu.Lock()
	if fix.treePath != "cs-principles/assignments.json" {
		t.Errorf("commit path = %q, want cs-principles/assignments.json", fix.treePath)
	}
	if !fix.refPatched {
		t.Error("branch ref was never advanced")
	}
	fix.mu.Unlock()
	if !strings.Contains(stdout.String(), `added test "compiles"`) {
		t.Errorf("stdout = %q, want added confirmation", stdout.String())
	}
}

func TestRunAssignmentTestAdd_ReplacesByName(t *testing.T) {
	existing := `[{"name":"compiles","type":"run","run":"old","points":1}]`
	server, fix := newTestCmdServer(t, helloAssignments(existing), false)
	client := githubtest.NewTestClient(t, server)

	var stdout bytes.Buffer
	spec := assignment.TestSpec{Name: "compiles", Type: "run", Run: "new", Points: 3}
	if err := runAssignmentTestAdd(client, &stdout, "o", "cs-principles", "hello", spec); err != nil {
		t.Fatalf("runAssignmentTestAdd: %v", err)
	}

	tests := decodeCommitted(t, fix).Assignments[0].Tests
	if len(tests) != 1 || tests[0].Run != "new" || tests[0].Points != 3 {
		t.Errorf("committed tests = %#v, want in-place replace", tests)
	}
	if !strings.Contains(stdout.String(), `updated test "compiles"`) {
		t.Errorf("stdout = %q, want updated confirmation", stdout.String())
	}
}

func TestRunAssignmentTestAdd_RejectsExistingAutograder(t *testing.T) {
	server, fix := newTestCmdServer(t, helloAssignments(""), true)
	client := githubtest.NewTestClient(t, server)

	var stdout bytes.Buffer
	spec := assignment.TestSpec{Name: "compiles", Type: "run", Run: "true", Points: 1}
	err := runAssignmentTestAdd(client, &stdout, "o", "cs-principles", "hello", spec)
	if err == nil {
		t.Fatal("expected mutual-exclusion error, got nil")
	}
	for _, want := range []string{"mutually exclusive", "cs-principles/autograders/hello/autograder.py"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("err = %q, want substring %q", err.Error(), want)
		}
	}
	fix.mu.Lock()
	if fix.committed != nil || fix.refPatched {
		t.Error("conflict must not land a commit")
	}
	fix.mu.Unlock()
}

func TestRunAssignmentTestAdd_UnregisteredSlugFails(t *testing.T) {
	// assignments.json exists but has no "hello" entry. The autograder
	// probe still 404s (fixture default), so the slug lookup is what
	// trips.
	empty := `{"schema":"classroom50/assignments/v1","assignments":[]}`
	server, fix := newTestCmdServer(t, empty, false)
	client := githubtest.NewTestClient(t, server)

	var stdout bytes.Buffer
	spec := assignment.TestSpec{Name: "compiles", Type: "run", Run: "true", Points: 1}
	err := runAssignmentTestAdd(client, &stdout, "o", "cs-principles", "hello", spec)
	if err == nil {
		t.Fatal("expected unregistered-slug error, got nil")
	}
	for _, want := range []string{`assignment "hello" is not registered`, "gh teacher assignment add"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("err = %q, want substring %q", err.Error(), want)
		}
	}
	fix.mu.Lock()
	if fix.committed != nil {
		t.Error("missing slug must not land a commit")
	}
	fix.mu.Unlock()
}

func TestRunAssignmentTestAdd_RequiresMaterializeScript(t *testing.T) {
	// A config repo whose skeleton predates materialize_tests.py must be
	// rejected: the tests would land in assignments.json but never reach
	// the Pages bundle, so they'd silently never grade.
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/classroom50", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"default_branch": "main"})
	})
	mux.HandleFunc("/repos/o/classroom50/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "parent-sha"}})
	})
	mux.HandleFunc("/repos/o/classroom50/git/commits/parent-sha", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"tree": map[string]string{"sha": "parent-tree"}})
	})
	mux.HandleFunc("/repos/o/classroom50/contents/.github/scripts/materialize_tests.py", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"message":"Not Found"}`)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var stdout bytes.Buffer
	spec := assignment.TestSpec{Name: "compiles", Type: "run", Run: "true", Points: 1}
	err := runAssignmentTestAdd(client, &stdout, "o", "cs-principles", "hello", spec)
	if err == nil {
		t.Fatal("expected missing-skeleton error, got nil")
	}
	for _, want := range []string{"materialize_tests.py", "gh teacher init o"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("err = %q, want substring %q", err.Error(), want)
		}
	}
}

func TestRunAssignmentAdd_WithTestsPersists(t *testing.T) {
	server, fix := newTestCmdServer(t, helloAssignments(""), false)
	client := githubtest.NewTestClient(t, server)

	tests := []assignment.TestSpec{{Name: "compiles", Type: "run", Run: "true", Points: 1}}
	var stdout, stderr bytes.Buffer
	p := helloAddParams()
	p.Tests = tests
	err := runAssignmentAdd(client, &stdout, &stderr, p)
	if err != nil {
		t.Fatalf("runAssignmentAdd: %v", err)
	}
	got := decodeCommitted(t, fix).Assignments[0].Tests
	if len(got) != 1 || got[0].Name != "compiles" {
		t.Errorf("committed tests = %#v, want the --tests array", got)
	}
}

func TestRunAssignmentAdd_GroupModePersists(t *testing.T) {
	server, fix := newTestCmdServer(t, helloAssignments(""), false)
	client := githubtest.NewTestClient(t, server)

	var stdout, stderr bytes.Buffer
	p := helloAddParams()
	p.Mode = "group"
	p.MaxGroupSize = 3
	err := runAssignmentAdd(client, &stdout, &stderr, p)
	if err != nil {
		t.Fatalf("runAssignmentAdd(group): %v", err)
	}
	entry := decodeCommitted(t, fix).Assignments[0]
	if entry.Mode != "group" || entry.MaxGroupSize != 3 {
		t.Errorf("committed entry = mode %q max_group_size %d, want group/3", entry.Mode, entry.MaxGroupSize)
	}
}

func TestRunAssignmentAdd_AllowedFilesPersists(t *testing.T) {
	server, fix := newTestCmdServer(t, helloAssignments(""), false)
	client := githubtest.NewTestClient(t, server)

	var stdout, stderr bytes.Buffer
	p := helloAddParams()
	p.AllowedFiles = []string{"*", "!hello.py"}
	err := runAssignmentAdd(client, &stdout, &stderr, p)
	if err != nil {
		t.Fatalf("runAssignmentAdd(allowed-files): %v", err)
	}
	got := decodeCommitted(t, fix).Assignments[0].AllowedFiles
	if len(got) != 2 || got[0] != "*" || got[1] != "!hello.py" {
		t.Errorf("committed allowed_files = %#v, want [* !hello.py] (order preserved)", got)
	}
}

// TestRunAssignmentAdd_TemplateLessPersists drives the headline feature:
// `assignment add` with no --template (tmpl == nil) skips the template probe,
// commits a nil Template, and prints "no template".
func TestRunAssignmentAdd_TemplateLessPersists(t *testing.T) {
	server, fix := newTestCmdServer(t, helloAssignments(""), false)
	client := githubtest.NewTestClient(t, server)

	var stdout, stderr bytes.Buffer
	p := helloAddParams()
	p.Slug = "solo"
	p.Name = "Solo"
	p.Tmpl = nil
	err := runAssignmentAdd(client, &stdout, &stderr, p)
	if err != nil {
		t.Fatalf("runAssignmentAdd(template-less): %v", err)
	}
	committed := decodeCommitted(t, fix)
	idx, ok := assignment.FindAssignment(committed.Assignments, "solo")
	if !ok {
		t.Fatalf("entry %q not committed", "solo")
	}
	if committed.Assignments[idx].Template != nil {
		t.Errorf("committed Template = %+v, want nil for a template-less add", committed.Assignments[idx].Template)
	}
	if !strings.Contains(stdout.String(), "no template") {
		t.Errorf("stdout = %q, want it to mention \"no template\"", stdout.String())
	}
}

// TestRunAssignmentAdd_DropsTemplateWarns: re-adding a previously
// templated assignment without --template lands the (now template-less)
// entry but warns loudly that the template was dropped.
func TestRunAssignmentAdd_DropsTemplateWarns(t *testing.T) {
	// Seed an existing templated `hello` entry, then re-add it with tmpl=nil.
	server, fix := newTestCmdServer(t, helloAssignments(""), false)
	client := githubtest.NewTestClient(t, server)

	var stdout, stderr bytes.Buffer
	p := helloAddParams()
	p.Tmpl = nil
	err := runAssignmentAdd(client, &stdout, &stderr, p)
	if err != nil {
		t.Fatalf("runAssignmentAdd(re-add template-less): %v", err)
	}
	entry := decodeCommitted(t, fix).Assignments[0]
	if entry.Template != nil {
		t.Errorf("committed Template = %+v, want nil after template-less re-add", entry.Template)
	}
	if !strings.Contains(stderr.String(), "dropped its template") {
		t.Errorf("stderr = %q, want a dropped-template warning", stderr.String())
	}
}

// TestRunAssignmentAdd_DropsAllowedFilesWarns: re-adding an assignment
// that had an allowed_files allowlist, without --allowed-files, lands the
// (now unrestricted) entry but warns that the allowlist was dropped.
func TestRunAssignmentAdd_DropsAllowedFilesWarns(t *testing.T) {
	seeded := `{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "cs50", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default",
      "allowed_files": ["*", "!hello.py"]
    }
  ]
}`
	server, fix := newTestCmdServer(t, seeded, false)
	client := githubtest.NewTestClient(t, server)

	var stdout, stderr bytes.Buffer
	err := runAssignmentAdd(client, &stdout, &stderr, helloAddParams())
	if err != nil {
		t.Fatalf("runAssignmentAdd(re-add without --allowed-files): %v", err)
	}
	if got := decodeCommitted(t, fix).Assignments[0].AllowedFiles; len(got) != 0 {
		t.Errorf("replace without --allowed-files should drop the allowlist, got %#v", got)
	}
	if !strings.Contains(stderr.String(), "dropped its 2 allowed_files pattern(s)") {
		t.Errorf("stderr = %q, want a dropped-allowed_files warning", stderr.String())
	}
}

// TestRunAssignmentAdd_ExplicitEmptyAllowedFilesClearsSilently: passing
// an explicit empty allowlist is a deliberate clear, not an omission, so
// it must not warn. (nil = omitted/warn; non-nil empty = clear/silent.)
func TestRunAssignmentAdd_ExplicitEmptyAllowedFilesClearsSilently(t *testing.T) {
	seeded := `{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "cs50", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default",
      "allowed_files": ["*", "!hello.py"]
    }
  ]
}`
	server, fix := newTestCmdServer(t, seeded, false)
	client := githubtest.NewTestClient(t, server)

	var stdout, stderr bytes.Buffer
	p := helloAddParams()
	p.AllowedFiles = []string{}
	err := runAssignmentAdd(client, &stdout, &stderr, p)
	if err != nil {
		t.Fatalf("runAssignmentAdd(explicit empty allowed_files): %v", err)
	}
	if got := decodeCommitted(t, fix).Assignments[0].AllowedFiles; len(got) != 0 {
		t.Errorf("explicit empty --allowed-files should clear, got %#v", got)
	}
	if strings.Contains(stderr.String(), "allowed_files") {
		t.Errorf("stderr = %q, explicit clear must not warn", stderr.String())
	}
}

// TestPassThresholdFromFlag covers the tri-state flag->pointer mapping that
// is the entire reason pass_threshold is a *int: omitted (flag unchanged)
// must stay nil (feature off), while an explicit --pass-threshold 0 must be
// a non-nil *int(0) (a real 0% bar), distinct from absent.
func TestPassThresholdFromFlag(t *testing.T) {
	if got := passThresholdFromFlag(false, 0); got != nil {
		t.Errorf("unchanged flag = %v, want nil (feature off)", got)
	}
	if got := passThresholdFromFlag(false, 70); got != nil {
		t.Errorf("unchanged flag with stale default = %v, want nil regardless of value", got)
	}
	if got := passThresholdFromFlag(true, 0); got == nil || *got != 0 {
		t.Errorf("--pass-threshold 0 = %v, want explicit *int(0), not nil", got)
	}
	if got := passThresholdFromFlag(true, 70); got == nil || *got != 70 {
		t.Errorf("--pass-threshold 70 = %v, want *int(70)", got)
	}
}

// TestRunAssignmentAdd_PassThresholdPersists: an explicit pass_threshold
// reaches the committed assignments.json (incl. an explicit 0, which must
// not be confused with absent/off).
func TestRunAssignmentAdd_PassThresholdPersists(t *testing.T) {
	for _, tc := range []struct {
		name string
		val  int
	}{
		{"seventy", 70},
		{"explicit zero", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server, fix := newTestCmdServer(t, helloAssignments(""), false)
			client := githubtest.NewTestClient(t, server)

			var stdout, stderr bytes.Buffer
			p := helloAddParams()
			v := tc.val
			p.PassThreshold = &v
			if err := runAssignmentAdd(client, &stdout, &stderr, p); err != nil {
				t.Fatalf("runAssignmentAdd(pass-threshold): %v", err)
			}
			got := decodeCommitted(t, fix).Assignments[0].PassThreshold
			if got == nil || *got != tc.val {
				t.Errorf("committed pass_threshold = %v, want %d (explicit, distinct from absent)", got, tc.val)
			}
		})
	}
}

// TestRunAssignmentAdd_DropsPassThresholdWarns: re-adding an assignment
// that had a GUI-set pass_threshold, without --pass-threshold, lands the
// (now threshold-less) entry but warns that the passing bar was dropped —
// mirroring the tests/template/allowed_files drop warnings.
func TestRunAssignmentAdd_DropsPassThresholdWarns(t *testing.T) {
	seeded := `{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "cs50", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default",
      "pass_threshold": 70
    }
  ]
}`
	server, fix := newTestCmdServer(t, seeded, false)
	client := githubtest.NewTestClient(t, server)

	var stdout, stderr bytes.Buffer
	err := runAssignmentAdd(client, &stdout, &stderr, helloAddParams())
	if err != nil {
		t.Fatalf("runAssignmentAdd(re-add without --pass-threshold): %v", err)
	}
	if got := decodeCommitted(t, fix).Assignments[0].PassThreshold; got != nil {
		t.Errorf("replace without --pass-threshold should drop the bar, got %v", got)
	}
	if !strings.Contains(stderr.String(), "dropped its pass_threshold (70%)") {
		t.Errorf("stderr = %q, want a dropped-pass_threshold warning", stderr.String())
	}
}

// archivedClassroomAddServer serves just enough of the config repo for
// runAssignmentAdd's build callback to reach ensureClassroomActive (which
// runs before any assignments read): branch resolution, the ref read, and
// an archived cs-principles/classroom.json. A committed blob would mean the
// refusal failed to short-circuit.
func archivedClassroomAddServer(t *testing.T, fix *testCmdFixture) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/classroom50", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"default_branch": "main"})
	})
	mux.HandleFunc("/repos/o/classroom50/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "parent-sha"}})
	})
	mux.HandleFunc("/repos/o/classroom50/git/commits/parent-sha", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"tree": map[string]string{"sha": "parent-tree"}})
	})
	// The template probe runs (and must pass) before the build callback
	// where ensureClassroomActive fires, so serve a valid template.
	mux.HandleFunc("/repos/cs50/hello-template", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"is_template": true, "default_branch": "main"})
	})
	mux.HandleFunc("/repos/o/classroom50/contents/cs-principles/classroom.json", func(w http.ResponseWriter, r *http.Request) {
		body := `{"schema":"classroom50/classroom/v1","name":"CS Principles","short_name":"cs-principles","term":"","org":"o","active":false}`
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type":     "file",
			"content":  base64.StdEncoding.EncodeToString([]byte(body)),
			"encoding": "base64",
		})
	})
	// A blob upload would mean the archived refusal didn't fire.
	mux.HandleFunc("/repos/o/classroom50/git/blobs", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct{ Content, Encoding string }
		_ = json.Unmarshal(body, &payload)
		if payload.Encoding == "base64" {
			decoded, _ := base64.StdEncoding.DecodeString(payload.Content)
			fix.mu.Lock()
			fix.committed = decoded
			fix.mu.Unlock()
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "blob-sha"})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

// TestRunAssignmentAdd_WarnsOnNonMainTemplateBranch pins the U7 warning:
// a template whose default branch isn't `main` still succeeds, but the teacher
// is warned that the assignment (and student autograding) key off that branch.
func TestRunAssignmentAdd_WarnsOnNonMainTemplateBranch(t *testing.T) {
	// A dedicated server whose template probe reports a master default branch.
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/classroom50", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"default_branch": "main"})
	})
	mux.HandleFunc("/repos/o/classroom50/contents/cs-principles/assignments.json", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type":     "file",
			"content":  base64.StdEncoding.EncodeToString([]byte(helloAssignments(""))),
			"encoding": "base64",
		})
	})
	mux.HandleFunc("/repos/cs50/hello-template", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"is_template": true, "default_branch": "master"})
	})
	mux.HandleFunc("/repos/o/classroom50/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch {
			w.WriteHeader(http.StatusOK)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "parent-sha"}})
	})
	mux.HandleFunc("/repos/o/classroom50/git/commits/parent-sha", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"tree": map[string]string{"sha": "parent-tree"}})
	})
	mux.HandleFunc("/repos/o/classroom50/git/blobs", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "blob-sha"})
	})
	mux.HandleFunc("/repos/o/classroom50/git/trees", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-tree-sha"})
	})
	mux.HandleFunc("/repos/o/classroom50/git/commits", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-commit-sha"})
	})
	masterServer := httptest.NewServer(mux)
	t.Cleanup(masterServer.Close)
	client := githubtest.NewTestClient(t, masterServer)

	var stdout, stderr bytes.Buffer
	if err := runAssignmentAdd(client, &stdout, &stderr, helloAddParams()); err != nil {
		t.Fatalf("runAssignmentAdd(master template): %v", err)
	}
	if !strings.Contains(stderr.String(), `default branch "master"`) {
		t.Errorf("expected a non-main branch warning, stderr = %q", stderr.String())
	}
}

// TestRunAssignmentAdd_NoWarnOnMainTemplateBranch is the negative: a `main`
// template default branch adds no warning.
func TestRunAssignmentAdd_NoWarnOnMainTemplateBranch(t *testing.T) {
	server, _ := newTestCmdServer(t, helloAssignments(""), false)
	client := githubtest.NewTestClient(t, server)

	var stdout, stderr bytes.Buffer
	if err := runAssignmentAdd(client, &stdout, &stderr, helloAddParams()); err != nil {
		t.Fatalf("runAssignmentAdd(main template): %v", err)
	}
	if strings.Contains(stderr.String(), "not \"main\"") {
		t.Errorf("main template should not warn, stderr = %q", stderr.String())
	}
}

// TestRunAssignmentAdd_RefusesArchivedTarget pins the add-path archived
// refusal branch (assignment.go ensureClassroomActive): `assignment add`
// into an archived (active:false) classroom is refused and lands no blob,
// mirroring TestRunAssignmentReuse_RefusesArchivedTarget.
func TestRunAssignmentAdd_RefusesArchivedTarget(t *testing.T) {
	fix := &testCmdFixture{}
	server := archivedClassroomAddServer(t, fix)
	client := githubtest.NewTestClient(t, server)

	var stdout, stderr bytes.Buffer
	err := runAssignmentAdd(client, &stdout, &stderr, helloAddParams())
	if err == nil || !strings.Contains(err.Error(), "archived") {
		t.Fatalf("expected an archived-target refusal, got %v", err)
	}
	fix.mu.Lock()
	committed := fix.committed
	fix.mu.Unlock()
	if committed != nil {
		t.Errorf("archived refusal must not commit a blob, got %q", committed)
	}
}

// TestRunAssignmentAdd_PreservesUnknownEntryField pins the "tolerate AND
// preserve" rule: an unknown top-level entry key (written by a newer binary/GUI)
// must survive a re-run of `assignment add`, which rebuilds the entry from
// flags. Without the Extra carry-forward the upsert would silently drop it.
func TestRunAssignmentAdd_PreservesUnknownEntryField(t *testing.T) {
	seeded := `{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "cs50", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default",
      "future_field": {"nested": [1, 2, 3]}
    }
  ]
}`
	server, fix := newTestCmdServer(t, seeded, false)
	client := githubtest.NewTestClient(t, server)

	var stdout, stderr bytes.Buffer
	if err := runAssignmentAdd(client, &stdout, &stderr, helloAddParams()); err != nil {
		t.Fatalf("runAssignmentAdd(re-add over an entry with an unknown field): %v", err)
	}
	got := decodeCommitted(t, fix).Assignments[0]
	var nested map[string]any
	if err := json.Unmarshal(got.Extra["future_field"], &nested); err != nil {
		t.Fatalf("add upsert dropped/mangled the unknown future_field; Extra = %v, err = %v", got.Extra, err)
	}
	if _, ok := nested["nested"]; !ok {
		t.Errorf("future_field not preserved verbatim: %v", nested)
	}
	fix.mu.Lock()
	committed := string(fix.committed)
	fix.mu.Unlock()
	if !strings.Contains(committed, "future_field") {
		t.Errorf("committed blob dropped future_field:\n%s", committed)
	}
}

// TestRunAssignmentAdd_ExplicitZeroPassThresholdNotDropped: an explicit
// --pass-threshold 0 on re-add is a real 0% bar, not an omission, so it
// must persist and must not warn.
func TestRunAssignmentAdd_ExplicitZeroPassThresholdNotDropped(t *testing.T) {
	seeded := `{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "cs50", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default",
      "pass_threshold": 70
    }
  ]
}`
	server, fix := newTestCmdServer(t, seeded, false)
	client := githubtest.NewTestClient(t, server)

	var stdout, stderr bytes.Buffer
	p := helloAddParams()
	zero := 0
	p.PassThreshold = &zero
	if err := runAssignmentAdd(client, &stdout, &stderr, p); err != nil {
		t.Fatalf("runAssignmentAdd(explicit 0 pass-threshold): %v", err)
	}
	got := decodeCommitted(t, fix).Assignments[0].PassThreshold
	if got == nil || *got != 0 {
		t.Errorf("explicit --pass-threshold 0 should persist as 0, got %v", got)
	}
	if strings.Contains(stderr.String(), "dropped its pass_threshold") {
		t.Errorf("stderr = %q, an explicit 0 is not a drop and must not warn", stderr.String())
	}
}

func TestRunAssignmentAdd_TestsRejectedWithAutograder(t *testing.T) {
	server, fix := newTestCmdServer(t, helloAssignments(""), true)
	client := githubtest.NewTestClient(t, server)

	tests := []assignment.TestSpec{{Name: "compiles", Type: "run", Run: "true", Points: 1}}
	var stdout, stderr bytes.Buffer
	p := helloAddParams()
	p.Tests = tests
	err := runAssignmentAdd(client, &stdout, &stderr, p)
	if err == nil || !strings.Contains(err.Error(), "mutually exclusive") {
		t.Fatalf("expected mutual-exclusion error, got %v", err)
	}
	fix.mu.Lock()
	if fix.committed != nil || fix.refPatched {
		t.Error("conflict must not land a commit")
	}
	fix.mu.Unlock()
}

func TestRunAssignmentAdd_ReplaceWithoutTestsWarns(t *testing.T) {
	// Upsert replaces the whole entry, so re-running add without --tests
	// drops previously authored tests — pinned here with the warning.
	existing := `[
    {"name":"compiles","type":"run","run":"true","points":1},
    {"name":"prints","type":"io","run":"./hello","expected":"hi","comparison":"included","points":2}
  ]`
	server, fix := newTestCmdServer(t, helloAssignments(existing), false)
	client := githubtest.NewTestClient(t, server)

	var stdout, stderr bytes.Buffer
	err := runAssignmentAdd(client, &stdout, &stderr, helloAddParams())
	if err != nil {
		t.Fatalf("runAssignmentAdd: %v", err)
	}
	if got := decodeCommitted(t, fix).Assignments[0].Tests; len(got) != 0 {
		t.Errorf("replace without --tests should drop tests, got %#v", got)
	}
	if !strings.Contains(stderr.String(), "dropped its 2 declarative test(s)") {
		t.Errorf("stderr = %q, want dropped-tests warning", stderr.String())
	}
}

func TestRunAssignmentAdd_ExplicitEmptyTestsClearsSilently(t *testing.T) {
	// `--tests` with a literal `[]` is a deliberate clear (non-nil empty
	// slice), not an accidental omission — no warning.
	existing := `[{"name":"compiles","type":"run","run":"true","points":1}]`
	server, fix := newTestCmdServer(t, helloAssignments(existing), false)
	client := githubtest.NewTestClient(t, server)

	var stdout, stderr bytes.Buffer
	p := helloAddParams()
	p.Tests = []assignment.TestSpec{}
	err := runAssignmentAdd(client, &stdout, &stderr, p)
	if err != nil {
		t.Fatalf("runAssignmentAdd: %v", err)
	}
	if got := decodeCommitted(t, fix).Assignments[0].Tests; len(got) != 0 {
		t.Errorf("explicit empty --tests should clear, got %#v", got)
	}
	if strings.Contains(stderr.String(), "dropped") {
		t.Errorf("stderr = %q, explicit clear must not warn", stderr.String())
	}
}

func TestRunAssignmentTestRemove_HappyPath(t *testing.T) {
	existing := `[
    {"name":"compiles","type":"run","run":"gcc -o hello hello.c","points":1},
    {"name":"prints","type":"io","run":"./hello","expected":"hi","comparison":"included","points":2}
  ]`
	server, fix := newTestCmdServer(t, helloAssignments(existing), false)
	client := githubtest.NewTestClient(t, server)

	var stdout bytes.Buffer
	if err := runAssignmentTestRemove(client, &stdout, "o", "cs-principles", "hello", "compiles"); err != nil {
		t.Fatalf("runAssignmentTestRemove: %v", err)
	}

	tests := decodeCommitted(t, fix).Assignments[0].Tests
	if len(tests) != 1 || tests[0].Name != "prints" {
		t.Errorf("committed tests = %#v, want only %q left", tests, "prints")
	}
	if !strings.Contains(stdout.String(), `removed test "compiles"`) {
		t.Errorf("stdout = %q, want removed confirmation", stdout.String())
	}
}

func TestRunAssignmentTestRemove_MissingNameIsNoOp(t *testing.T) {
	existing := `[{"name":"compiles","type":"run","run":"true","points":1}]`
	server, fix := newTestCmdServer(t, helloAssignments(existing), false)
	client := githubtest.NewTestClient(t, server)

	var stdout bytes.Buffer
	if err := runAssignmentTestRemove(client, &stdout, "o", "cs-principles", "hello", "nope"); err != nil {
		t.Fatalf("idempotent remove should exit clean, got: %v", err)
	}
	fix.mu.Lock()
	if fix.committed != nil || fix.refPatched {
		t.Error("no-op remove must not land a commit")
	}
	fix.mu.Unlock()
	if !strings.Contains(stdout.String(), "nothing to do") {
		t.Errorf("stdout = %q, want no-op note", stdout.String())
	}
}

func TestRunAssignmentTestRemove_UnregisteredSlugFails(t *testing.T) {
	empty := `{"schema":"classroom50/assignments/v1","assignments":[]}`
	server, _ := newTestCmdServer(t, empty, false)
	client := githubtest.NewTestClient(t, server)

	var stdout bytes.Buffer
	err := runAssignmentTestRemove(client, &stdout, "o", "cs-principles", "hello", "compiles")
	if err == nil || !strings.Contains(err.Error(), `assignment "hello" is not registered`) {
		t.Fatalf("expected unregistered-slug error, got %v", err)
	}
}

func TestRunAssignmentTestList_Names(t *testing.T) {
	existing := `[
    {"name":"compiles","type":"run","run":"true","points":1},
    {"name":"prints","type":"io","run":"./hello","expected":"hi","comparison":"included","points":2}
  ]`
	server, fix := newTestCmdServer(t, helloAssignments(existing), false)
	client := githubtest.NewTestClient(t, server)

	var stdout, stderr bytes.Buffer
	if err := runAssignmentTestList(client, &stdout, &stderr, "o", "cs-principles", "hello", false, false); err != nil {
		t.Fatalf("runAssignmentTestList: %v", err)
	}
	if got := stdout.String(); got != "compiles\nprints\n" {
		t.Errorf("stdout = %q, want one name per line", got)
	}
	if !strings.Contains(stderr.String(), "2 tests") {
		t.Errorf("stderr = %q, want count summary", stderr.String())
	}
	fix.mu.Lock()
	if fix.committed != nil || fix.refPatched {
		t.Error("list is read-only; no commit may land")
	}
	fix.mu.Unlock()
}

func TestRunAssignmentTestList_JSONAndQuiet(t *testing.T) {
	existing := `[{"name":"compiles","type":"run","run":"true","points":1}]`
	server, _ := newTestCmdServer(t, helloAssignments(existing), false)
	client := githubtest.NewTestClient(t, server)

	var stdout, stderr bytes.Buffer
	if err := runAssignmentTestList(client, &stdout, &stderr, "o", "cs-principles", "hello", true, true); err != nil {
		t.Fatalf("runAssignmentTestList: %v", err)
	}
	var got []assignment.TestSpec
	if err := json.Unmarshal(stdout.Bytes(), &got); err != nil {
		t.Fatalf("stdout is not a JSON array of specs: %v\n%s", err, stdout.String())
	}
	if len(got) != 1 || got[0].Name != "compiles" {
		t.Errorf("json specs = %#v", got)
	}
	if stderr.Len() != 0 {
		t.Errorf("stderr = %q, want empty under --quiet", stderr.String())
	}
}

func TestRunAssignmentTestList_EmptyEmitsJSONArray(t *testing.T) {
	server, _ := newTestCmdServer(t, helloAssignments(""), false)
	client := githubtest.NewTestClient(t, server)

	var stdout, stderr bytes.Buffer
	if err := runAssignmentTestList(client, &stdout, &stderr, "o", "cs-principles", "hello", true, false); err != nil {
		t.Fatalf("runAssignmentTestList: %v", err)
	}
	if got := strings.TrimSpace(stdout.String()); got != "[]" {
		t.Errorf("stdout = %q, want [] for an assignment with no tests", got)
	}
	if !strings.Contains(stderr.String(), "no declarative tests") {
		t.Errorf("stderr = %q, want no-tests hint", stderr.String())
	}
}

func TestValidateModeAndSizeFlags(t *testing.T) {
	cases := []struct {
		name         string
		mode         string
		maxGroupSize int
		sizeProvided bool
		wantMode     string
		wantErrPart  string // "" = expect success
	}{
		{"individual default, no size", "", 0, false, "individual", ""},
		{"explicit individual, no size", "individual", 0, false, "individual", ""},
		{"individual with size rejected", "individual", 3, true, "", "only valid with --mode group"},
		{"group with valid size", "group", 3, true, "group", ""},
		{"group without size rejected", "group", 0, false, "", "must be >= 2"},
		{"group with size 1 rejected", "group", 1, true, "", "must be >= 2"},
		{"group above cap rejected", "group", 101, true, "", "max_group_size"},
		{"unknown mode rejected", "team", 0, false, "", "invalid --mode"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotMode, err := validateModeAndSizeFlags(tc.mode, tc.maxGroupSize, tc.sizeProvided)
			if tc.wantErrPart == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if gotMode != tc.wantMode {
					t.Errorf("mode = %q, want %q", gotMode, tc.wantMode)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErrPart) {
				t.Fatalf("err = %v, want substring %q", err, tc.wantErrPart)
			}
		})
	}
}

// privateTemplateFixture records the team repo-access calls made during
// an assignment add against a private template.
type privateTemplateFixture struct {
	mu          sync.Mutex
	grantPUT    bool   // PUT .../teams/{slug}/repos/{owner}/{repo} fired
	grantPath   string // the path of that PUT
	committed   bool   // a blob (the assignments.json write) was uploaded
	teamHasRepo bool   // controls the GET access-probe result (204 vs 404)
}

// newPrivateTemplateServer builds a fixture exercising the assignment
// add → private-template matrix. templateOwner/templatePrivate shape the
// template probe; the team grant endpoints are wired so the test can
// assert whether a read grant fired.
func newPrivateTemplateServer(t *testing.T, templateOwner string, templatePrivate bool) (*httptest.Server, *privateTemplateFixture) {
	t.Helper()
	fix := &privateTemplateFixture{}
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/classroom50", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"default_branch": "main"})
	})
	mux.HandleFunc("/repos/o/classroom50/contents/cs-principles/assignments.json", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type":     "file",
			"content":  base64.StdEncoding.EncodeToString([]byte(`{"schema":"classroom50/assignments/v1","assignments":[]}`)),
			"encoding": "base64",
		})
	})
	// classroom.json carries the team ref that resolveClassroomTeam reads
	// for the grant (authoritative slug; never re-derived).
	mux.HandleFunc("/repos/o/classroom50/contents/cs-principles/classroom.json", func(w http.ResponseWriter, r *http.Request) {
		body := `{"schema":"classroom50/classroom/v1","name":"CS Principles","short_name":"cs-principles","term":"","org":"o","team":{"id":4242,"slug":"classroom50-cs-principles"}}`
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type":     "file",
			"content":  base64.StdEncoding.EncodeToString([]byte(body)),
			"encoding": "base64",
		})
	})
	// Template probe — the test controls owner + visibility.
	mux.HandleFunc("/repos/"+templateOwner+"/hello-template", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"is_template": true, "default_branch": "main", "private": templatePrivate,
		})
	})
	// commitTree write endpoints.
	mux.HandleFunc("/repos/o/classroom50/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch {
			w.WriteHeader(http.StatusOK)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "parent-sha"}})
	})
	mux.HandleFunc("/repos/o/classroom50/git/commits/parent-sha", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"tree": map[string]string{"sha": "parent-tree"}})
	})
	mux.HandleFunc("/repos/o/classroom50/git/blobs", func(w http.ResponseWriter, r *http.Request) {
		fix.mu.Lock()
		fix.committed = true
		fix.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "blob-sha"})
	})
	mux.HandleFunc("/repos/o/classroom50/git/trees", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-tree-sha"})
	})
	mux.HandleFunc("/repos/o/classroom50/git/commits", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-commit-sha"})
	})
	// Team repo-access probe + grant. GET → 204/404 per teamHasRepo;
	// PUT → records the grant.
	mux.HandleFunc("/orgs/o/teams/classroom50-cs-principles/repos/o/hello-template", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			fix.mu.Lock()
			has := fix.teamHasRepo
			fix.mu.Unlock()
			if has {
				w.WriteHeader(http.StatusNoContent)
			} else {
				w.WriteHeader(http.StatusNotFound)
			}
		case http.MethodPut:
			fix.mu.Lock()
			fix.grantPUT = true
			fix.grantPath = r.URL.Path
			fix.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		}
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server, fix
}

func TestRunAssignmentAdd_RejectsOutOfOrgPrivateTemplate(t *testing.T) {
	// Rule 5: a private template outside the org is rejected before any
	// commit, because students could never be granted access to it.
	server, fix := newPrivateTemplateServer(t, "some-teacher", true)
	client := githubtest.NewTestClient(t, server)

	var stdout, stderr bytes.Buffer
	p := helloAddParams()
	p.Tmpl = &templateArg{Owner: "some-teacher", Repo: "hello-template"}
	err := runAssignmentAdd(client, &stdout, &stderr, p)
	if err == nil || !strings.Contains(err.Error(), "private and outside the org") {
		t.Fatalf("expected out-of-org private rejection, got %v", err)
	}
	fix.mu.Lock()
	defer fix.mu.Unlock()
	if fix.committed {
		t.Error("rejected assignment must not land a commit")
	}
	if fix.grantPUT {
		t.Error("rejected assignment must not grant team access")
	}
}

func TestRunAssignmentAdd_GrantsTeamReadForInOrgPrivateTemplate(t *testing.T) {
	// In-org private template: the classroom team is granted pull so
	// rostered students can generate from it.
	server, fix := newPrivateTemplateServer(t, "o", true)
	client := githubtest.NewTestClient(t, server)

	var stdout, stderr bytes.Buffer
	p := helloAddParams()
	p.Tmpl = &templateArg{Owner: "o", Repo: "hello-template"}
	err := runAssignmentAdd(client, &stdout, &stderr, p)
	if err != nil {
		t.Fatalf("runAssignmentAdd: %v", err)
	}
	fix.mu.Lock()
	defer fix.mu.Unlock()
	if !fix.committed {
		t.Error("assignment should have committed")
	}
	if !fix.grantPUT {
		t.Fatal("expected a team read grant PUT for an in-org private template")
	}
	if !strings.Contains(stdout.String(), "granted classroom team") {
		t.Errorf("stdout = %q, want grant confirmation", stdout.String())
	}
}

func TestRunAssignmentAdd_SkipsGrantWhenTeamAlreadyHasAccess(t *testing.T) {
	// Idempotency: if the team already has access, no PUT fires.
	server, fix := newPrivateTemplateServer(t, "o", true)
	fix.teamHasRepo = true
	client := githubtest.NewTestClient(t, server)

	var stdout, stderr bytes.Buffer
	p := helloAddParams()
	p.Tmpl = &templateArg{Owner: "o", Repo: "hello-template"}
	err := runAssignmentAdd(client, &stdout, &stderr, p)
	if err != nil {
		t.Fatalf("runAssignmentAdd: %v", err)
	}
	fix.mu.Lock()
	defer fix.mu.Unlock()
	if fix.grantPUT {
		t.Error("team already had access; no grant PUT should fire")
	}
}

func TestRunAssignmentAdd_InOrgPrivateNoTeamErrors(t *testing.T) {
	// A classroom with no team block (pre-feature) + an in-org private
	// template: the assignment commits, then the grant step returns an
	// actionable error pointing at `classroom add` rather than a raw 404.
	fresh := http.NewServeMux()
	fresh.HandleFunc("/repos/o/classroom50", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"default_branch": "main"})
	})
	fresh.HandleFunc("/repos/o/classroom50/contents/cs-principles/assignments.json", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type": "file", "encoding": "base64",
			"content": base64.StdEncoding.EncodeToString([]byte(`{"schema":"classroom50/assignments/v1","assignments":[]}`)),
		})
	})
	fresh.HandleFunc("/repos/o/classroom50/contents/cs-principles/classroom.json", func(w http.ResponseWriter, r *http.Request) {
		// No team block — a pre-feature classroom.
		body := `{"schema":"classroom50/classroom/v1","name":"CS","short_name":"cs-principles","term":"","org":"o"}`
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type": "file", "encoding": "base64",
			"content": base64.StdEncoding.EncodeToString([]byte(body)),
		})
	})
	fresh.HandleFunc("/repos/o/hello-template", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"is_template": true, "default_branch": "main", "private": true})
	})
	fresh.HandleFunc("/repos/o/classroom50/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch {
			w.WriteHeader(http.StatusOK)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "parent-sha"}})
	})
	fresh.HandleFunc("/repos/o/classroom50/git/commits/parent-sha", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"tree": map[string]string{"sha": "parent-tree"}})
	})
	fresh.HandleFunc("/repos/o/classroom50/git/blobs", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "blob-sha"})
	})
	fresh.HandleFunc("/repos/o/classroom50/git/trees", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-tree-sha"})
	})
	fresh.HandleFunc("/repos/o/classroom50/git/commits", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-commit-sha"})
	})
	srv := httptest.NewServer(fresh)
	t.Cleanup(srv.Close)
	client := githubtest.NewTestClient(t, srv)

	var stdout, stderr bytes.Buffer
	p := helloAddParams()
	p.Tmpl = &templateArg{Owner: "o", Repo: "hello-template"}
	err := runAssignmentAdd(client, &stdout, &stderr, p)
	if err == nil || !strings.Contains(err.Error(), "has no team to grant read") {
		t.Fatalf("expected actionable no-team error, got %v", err)
	}
}
