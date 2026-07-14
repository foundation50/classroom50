package assignments

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHasTemplate(t *testing.T) {
	cases := []struct {
		name string
		tmpl *TemplateRef
		want bool
	}{
		{"nil template (template-less)", nil, false},
		{"complete template", &TemplateRef{Owner: "cs50", Repo: "hello", Branch: "main"}, true},
		{"missing branch", &TemplateRef{Owner: "cs50", Repo: "hello"}, false},
		{"missing owner", &TemplateRef{Repo: "hello", Branch: "main"}, false},
		{"empty non-nil", &TemplateRef{}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := (Entry{Template: tc.tmpl}).HasTemplate(); got != tc.want {
				t.Errorf("HasTemplate() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestPagesAssignmentsURL(t *testing.T) {
	// Public contract: publish-pages publishes `<classroom>/assignments.json`
	// at `https://<org>.github.io/classroom50/...`. A typo here 404s every
	// accept.
	got := pagesAssignmentsURL("cs50-fall-2026", "cs-principles", "")
	want := "https://cs50-fall-2026.github.io/classroom50/cs-principles/assignments.json"
	if got != want {
		t.Errorf("pagesAssignmentsURL = %q, want %q", got, want)
	}
}

func TestPagesAssignmentsURL_WithSecret(t *testing.T) {
	// A protected classroom inserts the capability-URL segment between the
	// classroom and the resource. Must match publish-pages.yaml and runner.py
	// exactly or a protected accept 404s.
	got := pagesAssignmentsURL("cs50-fall-2026", "cs-principles", "abc123")
	want := "https://cs50-fall-2026.github.io/classroom50/cs-principles/abc123/assignments.json"
	if got != want {
		t.Errorf("pagesAssignmentsURL with secret = %q, want %q", got, want)
	}
}

func TestPagesAutograderURL(t *testing.T) {
	// Mirrors publish-pages' `*/autograders/*.yaml` allow-list.
	got := pagesAutograderURL("cs50-fall-2026", "cs-principles", "", "default")
	want := "https://cs50-fall-2026.github.io/classroom50/cs-principles/autograders/default.yaml"
	if got != want {
		t.Errorf("pagesAutograderURL = %q, want %q", got, want)
	}
}

func TestAssignmentEntryResolveAutograder(t *testing.T) {
	// Empty Autograder resolves to "default"; explicit values round-trip.
	cases := []struct {
		in   Entry
		want string
	}{
		{Entry{}, "default"},
		{Entry{Autograder: ""}, "default"},
		{Entry{Autograder: "io-suite"}, "io-suite"},
		{Entry{Autograder: "python-pytest"}, "python-pytest"},
	}
	for _, tc := range cases {
		if got := tc.in.ResolveAutograder(); got != tc.want {
			t.Errorf("ResolveAutograder(%+v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestFetchAutograderWorkflow_HappyPath(t *testing.T) {
	// Fetched bytes round-trip verbatim into the student repo so the shim's
	// commit-time content matches Pages' published copy.
	body := "name: Autograde\n" +
		"on:\n" +
		"  push:\n" +
		"    tags: [\"submit/*\"]\n" +
		"permissions:\n" +
		"  contents: write\n" +
		"  statuses: write\n" +
		"jobs:\n" +
		"  autograde:\n" +
		"    runs-on: ubuntu-latest\n" +
		"    steps:\n" +
		"      - uses: actions/checkout@v6\n"

	server, cleanup := newAutograderServer(t, body, http.StatusOK)
	defer cleanup()

	wf, err := fetchAutograderWorkflowFromURL(context.Background(), server.URL+"/cs-principles/autograders/default.yaml", "default")
	if err != nil {
		t.Fatalf("fetchAutograderWorkflowFromURL: %v", err)
	}
	if wf.Content != body {
		t.Errorf("Content mismatch:\ngot:\n%s\nwant:\n%s", wf.Content, body)
	}
}

func TestFetchAutograderWorkflow_404SurfacesActionableGuidance(t *testing.T) {
	// 404 is the most likely failure (Pages not deployed yet or file deleted).
	// Error must name the autograder, URL, and fix.
	server, cleanup := newAutograderServer(t, "not found", http.StatusNotFound)
	defer cleanup()

	_, err := fetchAutograderWorkflowFromURL(context.Background(), server.URL+"/cs-principles/autograders/default.yaml", "default")
	if err == nil {
		t.Fatalf("expected 404 error, got nil")
	}
	for _, want := range []string{"\"default\"", "publish-pages", "404"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error should mention %q, got %q", want, err)
		}
	}
}

func TestFetchAutograderWorkflow_RejectsMalformedYAML(t *testing.T) {
	// Malformed YAML must fail at fetch time, before landing in the student
	// repo. The error is the signal the student forwards to the instructor.
	server, cleanup := newAutograderServer(t, "name: Autograde\non: { invalid: [\n", http.StatusOK)
	defer cleanup()

	_, err := fetchAutograderWorkflowFromURL(context.Background(), server.URL+"/cs-principles/autograders/default.yaml", "default")
	if err == nil {
		t.Fatalf("expected malformed-YAML error, got nil")
	}
	if !strings.Contains(err.Error(), "malformed YAML") {
		t.Errorf("err should mention 'malformed YAML', got %q", err)
	}
	if !strings.Contains(err.Error(), "\"default\"") {
		t.Errorf("err should name the autograder, got %q", err)
	}
}

func TestFetchAutograderWorkflow_RejectsEmptyBody(t *testing.T) {
	// Pages occasionally serves a stub during deployment. Empty body →
	// "retry" rather than an empty workflow on disk.
	server, cleanup := newAutograderServer(t, "   \n   \n", http.StatusOK)
	defer cleanup()

	_, err := fetchAutograderWorkflowFromURL(context.Background(), server.URL+"/cs-principles/autograders/default.yaml", "default")
	if err == nil {
		t.Fatalf("expected empty-body error, got nil")
	}
	if !strings.Contains(err.Error(), "empty body") {
		t.Errorf("err should mention 'empty body', got %q", err)
	}
}

// newAutograderServer mirrors newPagesServer, mounted at the autograders path.
func newAutograderServer(t *testing.T, body string, status int) (*httptest.Server, func()) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/cs-principles/autograders/default.yaml", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/yaml")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	})
	server := httptest.NewServer(mux)
	return server, server.Close
}

func TestFetchAssignmentEntry_HappyPath(t *testing.T) {
	body := `{
		"schema": "classroom50/assignments/v1",
		"assignments": [
			{
				"slug": "hello",
				"name": "Hello",
				"mode": "individual",
				"template": { "owner": "cs50", "repo": "hello-template", "branch": "main" }
			},
			{
				"slug": "intro",
				"name": "Intro",
				"mode": "individual",
				"template": { "owner": "cs50", "repo": "intro-template", "branch": "master" }
			}
		]
	}`
	entry, cleanup := fetchOneTestEntry(t, body, "hello")
	defer cleanup()

	if entry.Slug != "hello" {
		t.Errorf("Slug = %q, want %q", entry.Slug, "hello")
	}
	if entry.Mode != "individual" {
		t.Errorf("Mode = %q, want %q", entry.Mode, "individual")
	}
	if entry.Template == nil ||
		entry.Template.Owner != "cs50" || entry.Template.Repo != "hello-template" || entry.Template.Branch != "main" {
		t.Errorf("Template = %#v, want cs50/hello-template@main", entry.Template)
	}
}

func TestFetchAssignmentEntry_RejectsWrongSchema(t *testing.T) {
	body := `{"schema":"classroom50/assignments/v2","assignments":[]}`
	server, cleanup := newPagesServer(t, body, http.StatusOK)
	defer cleanup()

	_, err := fetchEntryFromURL(context.Background(), server.URL+"/cs-principles/assignments.json", "hello")
	if err == nil {
		t.Fatalf("expected error for v2 schema, got nil")
	}
	if !strings.Contains(err.Error(), "v1") {
		t.Errorf("error should mention v1 in the diagnostic, got %q", err)
	}
}

func TestFetchAssignmentEntry_ReturnsTypedNotFound(t *testing.T) {
	body := `{
		"schema": "classroom50/assignments/v1",
		"assignments": [
			{"slug":"hello","name":"Hello","mode":"individual","template":{"owner":"cs50","repo":"hello-template","branch":"main"}}
		]
	}`
	server, cleanup := newPagesServer(t, body, http.StatusOK)
	defer cleanup()

	_, err := fetchEntryFromURL(context.Background(), server.URL+"/cs-principles/assignments.json", "missing")
	if err == nil {
		t.Fatalf("expected error for missing slug, got nil")
	}
	if !IsNotFound(err) {
		t.Errorf("expected NotFoundError (so callers can branch via errors.As); got %T: %v", err, err)
	}
	// Should survive %w-chained wrapping at the call site.
	wrapped := errors.New("wrapped: " + err.Error())
	if IsNotFound(wrapped) {
		t.Errorf("IsNotFound should not match a string-wrapped error (lost typing)")
	}
}

func TestFetchAssignmentEntry_404Surfaces_PagesGuidance(t *testing.T) {
	// 404 → publish-pages hasn't run or the classroom arg is typo'd. Error
	// must give the student something to ask for.
	server, cleanup := newPagesServer(t, "not found", http.StatusNotFound)
	defer cleanup()

	_, err := fetchEntryFromURL(context.Background(), server.URL+"/cs-principles/assignments.json", "hello")
	if err == nil {
		t.Fatalf("expected error on 404, got nil")
	}
	wantSubstrings := []string{"404", "publish-pages"}
	for _, s := range wantSubstrings {
		if !strings.Contains(err.Error(), s) {
			t.Errorf("error should mention %q (actionable guidance), got %q", s, err)
		}
	}
}

// fetchOneTestEntry serves `body` at /cs-principles/assignments.json
// and runs fetchEntryFromURL against it.
func fetchOneTestEntry(t *testing.T, body, slug string) (Entry, func()) {
	t.Helper()
	server, cleanup := newPagesServer(t, body, http.StatusOK)

	entry, err := fetchEntryFromURL(context.Background(), server.URL+"/cs-principles/assignments.json", slug)
	if err != nil {
		cleanup()
		t.Fatalf("fetchAssignmentEntry: %v", err)
	}
	return entry, cleanup
}

// newPagesServer mounts `body`/`status` at the canonical
// assignments.json path; other paths 404 (pins the URL shape).
func newPagesServer(t *testing.T, body string, status int) (*httptest.Server, func()) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/cs-principles/assignments.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	})
	server := httptest.NewServer(mux)
	return server, server.Close
}

func TestEntryDecodesEmptyRepo(t *testing.T) {
	// empty_repo decodes when present and defaults to false when absent —
	// the accept flow branches on it, so the wire contract matters.
	var file assignmentsFile
	if err := json.Unmarshal([]byte(`{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {"slug": "bare", "name": "Bare", "mode": "individual", "autograder": "default", "empty_repo": true},
    {"slug": "hello", "name": "Hello", "mode": "individual", "autograder": "default"}
  ]
}`), &file); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !file.Assignments[0].EmptyRepo {
		t.Error("bare.EmptyRepo = false, want true")
	}
	if file.Assignments[1].EmptyRepo {
		t.Error("hello.EmptyRepo = true, want false (field absent)")
	}
}
