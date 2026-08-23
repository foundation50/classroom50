package classroom

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/githubtest"
)

func TestTargetTemplateName(t *testing.T) {
	cases := []struct {
		slug, suffix, want string
	}{
		{"readability", "", "readability"},
		{"readability", "migrated", "readability-migrated"},
		{"hello", "v2", "hello-v2"},
	}
	for _, tc := range cases {
		got := targetTemplateName(tc.slug, tc.suffix)
		if got != tc.want {
			t.Errorf("targetTemplateName(%q, %q) = %q, want %q", tc.slug, tc.suffix, got, tc.want)
		}
	}
}

func TestSplitOwnerRepo(t *testing.T) {
	cases := []struct {
		in        string
		wantOwner string
		wantRepo  string
		wantErr   bool
	}{
		{"classroom50test/readability", "classroom50test", "readability", false},
		{"cs50/hello-template", "cs50", "hello-template", false},
		{"", "", "", true},
		{"no-slash", "", "", true},
		{"too/many/slashes", "", "", true},
		{"/empty-owner", "", "", true},
		{"empty-repo/", "", "", true},
	}
	for _, tc := range cases {
		o, r, err := splitOwnerRepo(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Errorf("splitOwnerRepo(%q) = (%q, %q, nil), want error", tc.in, o, r)
			}
			continue
		}
		if err != nil {
			t.Errorf("splitOwnerRepo(%q): unexpected error %v", tc.in, err)
		}
		if o != tc.wantOwner || r != tc.wantRepo {
			t.Errorf("splitOwnerRepo(%q) = (%q, %q), want (%q, %q)", tc.in, o, r, tc.wantOwner, tc.wantRepo)
		}
	}
}

func TestProbeTargetRepo(t *testing.T) {
	cases := []struct {
		name           string
		status         int
		body           string
		wantExists     bool
		wantIsTemplate bool
		wantBranch     string
	}{
		{"404 missing", 404, `{"message":"Not Found"}`, false, false, ""},
		{"200 template", 200, `{"is_template":true,"default_branch":"main"}`, true, true, "main"},
		{"200 not template", 200, `{"is_template":false,"default_branch":"master"}`, true, false, "master"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer server.Close()
			got, err := probeTargetRepo(githubtest.NewTestClient(t, server), "o", "r")
			if err != nil {
				t.Fatalf("probeTargetRepo: %v", err)
			}
			if got.Exists != tc.wantExists || got.IsTemplate != tc.wantIsTemplate || got.Branch != tc.wantBranch {
				t.Errorf("probeTargetRepo = %+v, want exists=%v isTemplate=%v branch=%q",
					got, tc.wantExists, tc.wantIsTemplate, tc.wantBranch)
			}
		})
	}
}

func TestVerifySourceIsTemplate(t *testing.T) {
	cases := []struct {
		name       string
		status     int
		body       string
		wantTpl    bool
		wantErr    bool
		wantErrSub string
	}{
		{"is template", 200, `{"is_template":true}`, true, false, ""},
		{"not template", 200, `{"is_template":false}`, false, false, ""},
		{"404 inaccessible", 404, `{"message":"Not Found"}`, false, true, "not accessible"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer server.Close()
			got, err := verifySourceIsTemplate(githubtest.NewTestClient(t, server), "o", "r")
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error containing %q", tc.wantErrSub)
				}
				if !strings.Contains(err.Error(), tc.wantErrSub) {
					t.Errorf("err = %v, want substring %q", err, tc.wantErrSub)
				}
				return
			}
			if err != nil {
				t.Fatalf("verifySourceIsTemplate: %v", err)
			}
			if got != tc.wantTpl {
				t.Errorf("verifySourceIsTemplate = %v, want %v", got, tc.wantTpl)
			}
		})
	}
}

func TestGenerateFromTemplate(t *testing.T) {
	t.Run("happy path", func(t *testing.T) {
		var gotBody map[string]any
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/repos/src-owner/src-repo/generate" {
				t.Errorf("unexpected path %q", r.URL.Path)
			}
			if r.Method != http.MethodPost {
				t.Errorf("method = %s, want POST", r.Method)
			}
			body, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(body, &gotBody)
			w.WriteHeader(http.StatusCreated)
			_, _ = io.WriteString(w, `{"default_branch":"main"}`)
		}))
		defer server.Close()

		branch, err := generateFromTemplate(githubtest.NewTestClient(t, server),
			"src-owner", "src-repo", "tgt-org", "tgt-repo", "desc", true)
		if err != nil {
			t.Fatalf("generateFromTemplate: %v", err)
		}
		if branch != "main" {
			t.Errorf("branch = %q, want main", branch)
		}
		if gotBody["owner"] != "tgt-org" || gotBody["name"] != "tgt-repo" {
			t.Errorf("body = %+v, want owner=tgt-org name=tgt-repo", gotBody)
		}
		if gotBody["private"] != true {
			t.Errorf("private = %v, want true (must inherit source privacy)", gotBody["private"])
		}
		if gotBody["include_all_branches"] != true {
			t.Errorf("include_all_branches = %v, want true", gotBody["include_all_branches"])
		}
	})

	t.Run("server error", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = io.WriteString(w, `{"message":"name already exists"}`)
		}))
		defer server.Close()
		_, err := generateFromTemplate(githubtest.NewTestClient(t, server),
			"src", "src", "tgt", "tgt", "", false)
		if err == nil {
			t.Fatalf("expected error")
		}
		if !strings.Contains(err.Error(), "422") {
			t.Errorf("err = %v, want '422' substring", err)
		}
	})

	t.Run("missing default_branch defensive", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusCreated)
			_, _ = io.WriteString(w, `{}`)
		}))
		defer server.Close()
		_, err := generateFromTemplate(githubtest.NewTestClient(t, server),
			"src", "src", "tgt", "tgt", "", false)
		if err == nil || !strings.Contains(err.Error(), "default_branch") {
			t.Errorf("expected default_branch error, got %v", err)
		}
	})
}

func TestMarkAsTemplate(t *testing.T) {
	t.Run("happy path", func(t *testing.T) {
		var gotBody map[string]any
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPatch {
				t.Errorf("method = %s, want PATCH", r.Method)
			}
			body, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(body, &gotBody)
			w.WriteHeader(http.StatusOK)
		}))
		defer server.Close()
		if err := markAsTemplate(githubtest.NewTestClient(t, server), "o", "r"); err != nil {
			t.Fatalf("markAsTemplate: %v", err)
		}
		if gotBody["is_template"] != true {
			t.Errorf("body = %+v, want is_template:true", gotBody)
		}
	})

	t.Run("403 propagates", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusForbidden)
		}))
		defer server.Close()
		err := markAsTemplate(githubtest.NewTestClient(t, server), "o", "r")
		if err == nil || !strings.Contains(err.Error(), "403") {
			t.Errorf("expected 403 error, got %v", err)
		}
	})
}

// TestWaitForStableBranch_HappyPath: a server returning the same
// SHA on every read makes the helper return after one 500ms sleep.
// The "never stabilizes" path is covered by the production code's
// non-fatal warn-and-continue treatment in copyOneTemplate (its
// 20-iteration backoff makes a direct unit test too slow).
func TestWaitForStableBranch_HappyPath(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"commit":{"sha":"abc"}}`)
	}))
	defer server.Close()
	if err := githubapi.WaitForStableBranch(githubtest.NewTestClient(t, server), "o", "r", "main"); err != nil {
		t.Errorf("waitForStableBranch: %v", err)
	}
}

func TestCountTemplateActions(t *testing.T) {
	resolved := []resolvedTemplate{
		{Action: templateActionGenerated},
		{Action: templateActionGenerated},
		{Action: templateActionReused},
		{Action: templateActionSkipped},
	}
	g, r, s := countTemplateActions(resolved)
	if g != 2 || r != 1 || s != 1 {
		t.Errorf("countTemplateActions = (%d, %d, %d), want (2, 1, 1)", g, r, s)
	}
}

// TestCopyOneTemplate exercises every branch of the per-assignment
// decision table without invoking the orchestrator.
func TestCopyOneTemplate(t *testing.T) {
	// Per-test mux: route by path.
	withMux := func(routes map[string]http.HandlerFunc) (*httptest.Server, func()) {
		mux := http.NewServeMux()
		for path, h := range routes {
			mux.HandleFunc(path, h)
		}
		server := httptest.NewServer(mux)
		return server, server.Close
	}

	a := func(slug, fullName string, isPrivate bool) classroomAssignmentDetail {
		return classroomAssignmentDetail{
			ID:    1,
			Slug:  slug,
			Title: slug,
			Type:  "individual",
			StarterCodeRepo: &classroomStarterCodeRepo{
				FullName: fullName,
				Private:  isPrivate,
			},
		}
	}

	t.Run("skipped when no starter_code_repository", func(t *testing.T) {
		var errOut bytes.Buffer
		detail := classroomAssignmentDetail{ID: 1, Slug: "noop", Type: "individual"}
		got, err := copyOneTemplate(nil, &errOut, "tgt", "", "cs", 42, detail)
		if err != nil {
			t.Fatalf("copyOneTemplate: %v", err)
		}
		if got.Action != templateActionSkipped {
			t.Errorf("action = %s, want skipped", got.Action)
		}
		if !strings.Contains(errOut.String(), "no starter_code_repository") {
			t.Errorf("errOut = %q, want 'no starter_code_repository'", errOut.String())
		}
	})

	// Pre-validation guards: a bad slug/type must skip BEFORE any
	// API write happens — otherwise the template-copy phase
	// orphans repos that the commit phase would then drop.
	t.Run("skipped when slug fails shortNamePattern (pre-validation)", func(t *testing.T) {
		var errOut bytes.Buffer
		detail := classroomAssignmentDetail{ID: 1, Slug: "Bad-Slug", Type: "individual"}
		got, err := copyOneTemplate(nil, &errOut, "tgt", "", "cs", 42, detail)
		if err != nil {
			t.Fatalf("copyOneTemplate: %v", err)
		}
		if got.Action != templateActionSkipped {
			t.Errorf("action = %s, want skipped", got.Action)
		}
		if !strings.Contains(got.SkipReason, "invalid slug") {
			t.Errorf("skip reason = %q, want 'invalid slug'", got.SkipReason)
		}
	})

	t.Run("skipped when type is unknown (pre-validation)", func(t *testing.T) {
		var errOut bytes.Buffer
		detail := classroomAssignmentDetail{ID: 1, Slug: "hello", Type: "weird"}
		got, err := copyOneTemplate(nil, &errOut, "tgt", "", "cs", 42, detail)
		if err != nil {
			t.Fatalf("copyOneTemplate: %v", err)
		}
		if got.Action != templateActionSkipped {
			t.Errorf("action = %s, want skipped", got.Action)
		}
		if !strings.Contains(got.SkipReason, "unknown type") {
			t.Errorf("skip reason = %q, want 'unknown type'", got.SkipReason)
		}
	})

	// #691: a slug that composes past GitHub's repo-name limit with the target
	// short-name is skipped BEFORE any API write, like the other
	// pre-validation guards. "cs" leaves a 57-char budget; 58 exceeds it.
	t.Run("skipped when slug exceeds the composed repo-name budget (pre-validation)", func(t *testing.T) {
		var errOut bytes.Buffer
		detail := classroomAssignmentDetail{ID: 1, Slug: strings.Repeat("s", 58), Type: "individual"}
		got, err := copyOneTemplate(nil, &errOut, "tgt", "", "cs", 42, detail)
		if err != nil {
			t.Fatalf("copyOneTemplate: %v", err)
		}
		if got.Action != templateActionSkipped {
			t.Errorf("action = %s, want skipped", got.Action)
		}
		if !strings.Contains(got.SkipReason, "repo-name limit") {
			t.Errorf("skip reason = %q, want 'repo-name limit'", got.SkipReason)
		}
	})

	// copyOneTemplate uses the classroomID parameter (NOT
	// a.Classroom.ID, which the Classroom API doesn't reliably
	// populate on assignment-detail responses) for the generated
	// repo description.
	t.Run("generated description uses caller-supplied classroomID", func(t *testing.T) {
		var gotDescription string
		server, cleanup := withMux(map[string]http.HandlerFunc{
			"/repos/src/hello": func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.WriteString(w, `{"is_template":true}`)
			},
			"/repos/tgt/hello": func(w http.ResponseWriter, r *http.Request) {
				switch r.Method {
				case http.MethodGet:
					w.WriteHeader(http.StatusNotFound)
				case http.MethodPatch:
					w.WriteHeader(http.StatusOK)
				}
			},
			"/repos/src/hello/generate": func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				var p struct {
					Description string `json:"description"`
				}
				_ = json.Unmarshal(body, &p)
				gotDescription = p.Description
				w.WriteHeader(http.StatusCreated)
				_, _ = io.WriteString(w, `{"default_branch":"main"}`)
			},
			"/repos/tgt/hello/branches/main": func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.WriteString(w, `{"commit":{"sha":"stable-sha"}}`)
			},
		})
		defer cleanup()
		// a.Classroom.ID stays zero; the caller passes 95884.
		_, err := copyOneTemplate(githubtest.NewTestClient(t, server), io.Discard, "tgt", "", "cs", 95884, a("hello", "src/hello", false))
		if err != nil {
			t.Fatalf("copyOneTemplate: %v", err)
		}
		if !strings.Contains(gotDescription, "classroom 95884") {
			t.Errorf("description = %q, want 'classroom 95884' (must use caller-supplied ID, not a.Classroom.ID)", gotDescription)
		}
	})

	t.Run("skipped when source repo is not a template", func(t *testing.T) {
		server, cleanup := withMux(map[string]http.HandlerFunc{
			"/repos/src/hello": func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.WriteString(w, `{"is_template":false}`)
			},
		})
		defer cleanup()
		var errOut bytes.Buffer
		got, err := copyOneTemplate(githubtest.NewTestClient(t, server), &errOut, "tgt", "", "cs", 42, a("hello", "src/hello", false))
		if err != nil {
			t.Fatalf("copyOneTemplate: %v", err)
		}
		if got.Action != templateActionSkipped {
			t.Errorf("action = %s, want skipped", got.Action)
		}
		if !strings.Contains(errOut.String(), "not a template") {
			t.Errorf("errOut = %q, want 'not a template'", errOut.String())
		}
	})

	t.Run("reused when target exists and is_template", func(t *testing.T) {
		server, cleanup := withMux(map[string]http.HandlerFunc{
			"/repos/src/hello": func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.WriteString(w, `{"is_template":true}`)
			},
			"/repos/tgt/hello": func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.WriteString(w, `{"is_template":true,"default_branch":"main"}`)
			},
		})
		defer cleanup()
		var errOut bytes.Buffer
		got, err := copyOneTemplate(githubtest.NewTestClient(t, server), &errOut, "tgt", "", "cs", 42, a("hello", "src/hello", false))
		if err != nil {
			t.Fatalf("copyOneTemplate: %v", err)
		}
		if got.Action != templateActionReused {
			t.Errorf("action = %s, want reused", got.Action)
		}
		if got.Template != (assignment.TemplateRef{Owner: "tgt", Repo: "hello", Branch: "main"}) {
			t.Errorf("template = %+v, want tgt/hello@main", got.Template)
		}
		if !strings.Contains(errOut.String(), "Reusing existing template") {
			t.Errorf("errOut = %q, want 'Reusing existing template'", errOut.String())
		}
	})

	t.Run("collision: target exists and is NOT a template", func(t *testing.T) {
		server, cleanup := withMux(map[string]http.HandlerFunc{
			"/repos/src/hello": func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.WriteString(w, `{"is_template":true}`)
			},
			"/repos/tgt/hello": func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.WriteString(w, `{"is_template":false,"default_branch":"main"}`)
			},
		})
		defer cleanup()
		var errOut bytes.Buffer
		got, err := copyOneTemplate(githubtest.NewTestClient(t, server), &errOut, "tgt", "", "cs", 42, a("hello", "src/hello", false))
		if err != nil {
			t.Fatalf("copyOneTemplate: %v", err)
		}
		if got.Action != templateActionSkipped {
			t.Errorf("action = %s, want skipped", got.Action)
		}
		if !strings.Contains(got.SkipReason, "already exists and is not a template") {
			t.Errorf("skip reason = %q, want 'already exists and is not a template'", got.SkipReason)
		}
		if !strings.Contains(errOut.String(), "--template-suffix") {
			t.Errorf("errOut = %q, want hint about --template-suffix", errOut.String())
		}
	})

	t.Run("generated end-to-end", func(t *testing.T) {
		var (
			generateCalled bool
			patchCalled    bool
		)
		server, cleanup := withMux(map[string]http.HandlerFunc{
			"/repos/src/hello": func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.WriteString(w, `{"is_template":true}`)
			},
			"/repos/tgt/hello": func(w http.ResponseWriter, r *http.Request) {
				switch r.Method {
				case http.MethodGet:
					w.WriteHeader(http.StatusNotFound)
				case http.MethodPatch:
					patchCalled = true
					w.WriteHeader(http.StatusOK)
				}
			},
			"/repos/src/hello/generate": func(w http.ResponseWriter, r *http.Request) {
				generateCalled = true
				w.WriteHeader(http.StatusCreated)
				_, _ = io.WriteString(w, `{"default_branch":"main"}`)
			},
			// Branch ref is stable on first read (same SHA on
			// every poll) so waitForStableBranch returns after
			// one 500ms sleep.
			"/repos/tgt/hello/branches/main": func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.WriteString(w, `{"commit":{"sha":"stable-sha"}}`)
			},
		})
		defer cleanup()
		var errOut bytes.Buffer
		got, err := copyOneTemplate(githubtest.NewTestClient(t, server), &errOut, "tgt", "", "cs", 42, a("hello", "src/hello", true))
		if err != nil {
			t.Fatalf("copyOneTemplate: %v", err)
		}
		if got.Action != templateActionGenerated {
			t.Errorf("action = %s, want generated", got.Action)
		}
		if got.Template != (assignment.TemplateRef{Owner: "tgt", Repo: "hello", Branch: "main"}) {
			t.Errorf("template = %+v, want tgt/hello@main", got.Template)
		}
		if !generateCalled {
			t.Errorf("generate endpoint never hit")
		}
		if !patchCalled {
			t.Errorf("is_template PATCH never hit")
		}
	})

	t.Run("template-suffix renames target", func(t *testing.T) {
		var probedPath string
		server, cleanup := withMux(map[string]http.HandlerFunc{
			"/repos/src/hello": func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.WriteString(w, `{"is_template":true}`)
			},
			"/repos/tgt/hello-migrated": func(w http.ResponseWriter, r *http.Request) {
				switch r.Method {
				case http.MethodGet:
					probedPath = r.URL.Path
					w.WriteHeader(http.StatusNotFound)
				case http.MethodPatch:
					w.WriteHeader(http.StatusOK)
				}
			},
			"/repos/src/hello/generate": func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				var p struct {
					Name string `json:"name"`
				}
				_ = json.Unmarshal(body, &p)
				if p.Name != "hello-migrated" {
					t.Errorf("generate name = %q, want hello-migrated", p.Name)
				}
				w.WriteHeader(http.StatusCreated)
				_, _ = io.WriteString(w, fmt.Sprintf(`{"default_branch":"main","name":%q}`, p.Name))
			},
			"/repos/tgt/hello-migrated/branches/main": func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.WriteString(w, `{"commit":{"sha":"stable-sha"}}`)
			},
		})
		defer cleanup()
		var errOut bytes.Buffer
		got, err := copyOneTemplate(githubtest.NewTestClient(t, server), &errOut, "tgt", "migrated", "cs", 42, a("hello", "src/hello", false))
		if err != nil {
			t.Fatalf("copyOneTemplate: %v", err)
		}
		if got.Template.Repo != "hello-migrated" {
			t.Errorf("template repo = %q, want hello-migrated", got.Template.Repo)
		}
		if probedPath != "/repos/tgt/hello-migrated" {
			t.Errorf("probe path = %q, want /repos/tgt/hello-migrated", probedPath)
		}
	})
}
