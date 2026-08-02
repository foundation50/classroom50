package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/foundation50/gh-student/internal/assignments"
	"github.com/foundation50/gh-student/internal/ui"
)

func boolPtr(b bool) *bool { return &b }

func TestResolveRepoFeaturePatchBody(t *testing.T) {
	cases := []struct {
		name      string
		features  *assignments.RepoFeatures
		templated bool
		template  *GeneratedRepo
		want      map[string]any
	}{
		{
			name:      "templated + no override + no template read -> omit all (GitHub defaults)",
			features:  nil,
			templated: true,
			template:  nil,
			want:      map[string]any{},
		},
		{
			name:      "templated + no override inherits the TEMPLATE's live has_* values",
			features:  nil,
			templated: true,
			template: &GeneratedRepo{
				HasIssues: false, HasWiki: true, HasProjects: false, HasPullRequests: false,
			},
			want: map[string]any{
				"has_issues":        false,
				"has_wiki":          true,
				"has_projects":      false,
				"has_pull_requests": false,
			},
		},
		{
			name:      "template-less + no override resolves to all-off",
			features:  nil,
			templated: false,
			want: map[string]any{
				"has_issues":        false,
				"has_wiki":          false,
				"has_projects":      false,
				"has_pull_requests": false,
			},
		},
		{
			name:      "explicit issues:false on a templated assignment is sent",
			features:  &assignments.RepoFeatures{Issues: boolPtr(false)},
			templated: true,
			template:  &GeneratedRepo{HasIssues: true, HasWiki: true, HasProjects: true, HasPullRequests: true},
			want: map[string]any{
				// explicit false overrides the template's true; the other three
				// inherit the template's true.
				"has_issues":        false,
				"has_wiki":          true,
				"has_projects":      true,
				"has_pull_requests": true,
			},
		},
		{
			name:      "explicit wins over template; absent keys inherit template",
			features:  &assignments.RepoFeatures{Issues: boolPtr(true)},
			templated: true,
			template:  &GeneratedRepo{HasIssues: false, HasWiki: false, HasProjects: false, HasPullRequests: false},
			want: map[string]any{
				"has_issues":        true,
				"has_wiki":          false,
				"has_projects":      false,
				"has_pull_requests": false,
			},
		},
		{
			name:      "template-less honors explicit-on and defaults the rest off",
			features:  &assignments.RepoFeatures{Wiki: boolPtr(true)},
			templated: false,
			want: map[string]any{
				"has_issues":        false,
				"has_wiki":          true,
				"has_projects":      false,
				"has_pull_requests": false,
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := resolveRepoFeaturePatchBody(tc.features, tc.templated, tc.template)
			if len(got) != len(tc.want) {
				t.Fatalf("body keys = %v, want %v", got, tc.want)
			}
			for k, v := range tc.want {
				if got[k] != v {
					t.Errorf("body[%q] = %v, want %v", k, got[k], v)
				}
			}
		})
	}
}

// A templated assignment with no repo_features override must INHERIT the
// template's live feature settings — GitHub's POST /generate does NOT copy
// them, so accept reads the template and PATCHes the generated repo to match.
func TestTemplatedInheritAppliesTemplateFeatures(t *testing.T) {
	tmpl := assignments.TemplateRef{Owner: "cs50", Repo: "hello-template", Branch: "main"}
	var patchBody map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/cs50/hello-template/generate", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"full_name":      "o/cs-principles-hello-alice",
			"html_url":       "https://github.com/o/cs-principles-hello-alice",
			"default_branch": "main",
		})
	})
	// The template read: it has Wiki on, everything else off.
	mux.HandleFunc("/repos/cs50/hello-template", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"full_name":         "cs50/hello-template",
			"default_branch":    "main",
			"has_issues":        false,
			"has_wiki":          true,
			"has_projects":      false,
			"has_pull_requests": false,
		})
	})
	mux.HandleFunc("/repos/o/cs-principles-hello-alice", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch {
			_ = json.NewDecoder(r.Body).Decode(&patchBody)
		}
		_ = json.NewEncoder(w).Encode(map[string]string{
			"full_name":      "o/cs-principles-hello-alice",
			"html_url":       "https://github.com/o/cs-principles-hello-alice",
			"default_branch": "main",
		})
	})
	mux.HandleFunc("/repos/o/cs-principles-hello-alice/branches", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]string{{"name": "main"}})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	var out bytes.Buffer
	_, _, branch, _, err := createTemplatedPrivateAssignmentRepoInOrg(
		newTestRESTClient(t, server), ui.NewForced(&out, false), false,
		"alice", "cs-principles", "hello", "o", tmpl, nil, /* inherit */
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if patchBody == nil {
		t.Fatal("no PATCH sent, but a templated inherit must PATCH the template's features")
	}
	// The generated repo must be PATCHed to match the template exactly.
	for k, want := range map[string]bool{
		"has_issues": false, "has_wiki": true, "has_projects": false, "has_pull_requests": false,
	} {
		if v, ok := patchBody[k].(bool); !ok || v != want {
			t.Errorf("patch %q = %v, want %v (inherited from template)", k, patchBody[k], want)
		}
	}
	if branch != "main" {
		t.Errorf("branch = %q, want main", branch)
	}
}

// An explicit override on a templated assignment wins for the set key; absent
// keys inherit the template's live values.
func TestTemplatedExplicitOverridePatchesSetKeys(t *testing.T) {
	tmpl := assignments.TemplateRef{Owner: "cs50", Repo: "hello-template", Branch: "main"}
	var patchBody map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/cs50/hello-template/generate", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"full_name":      "o/cs-principles-hello-alice",
			"html_url":       "https://github.com/o/cs-principles-hello-alice",
			"default_branch": "main",
		})
	})
	// Template has everything ON; the teacher forces issues OFF.
	mux.HandleFunc("/repos/cs50/hello-template", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"full_name":         "cs50/hello-template",
			"default_branch":    "main",
			"has_issues":        true,
			"has_wiki":          true,
			"has_projects":      true,
			"has_pull_requests": true,
		})
	})
	mux.HandleFunc("/repos/o/cs-principles-hello-alice", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch {
			_ = json.NewDecoder(r.Body).Decode(&patchBody)
		}
		_ = json.NewEncoder(w).Encode(map[string]string{
			"full_name":      "o/cs-principles-hello-alice",
			"html_url":       "https://github.com/o/cs-principles-hello-alice",
			"default_branch": "main",
		})
	})
	mux.HandleFunc("/repos/o/cs-principles-hello-alice/branches", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]string{{"name": "main"}})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	var out bytes.Buffer
	_, _, _, _, err := createTemplatedPrivateAssignmentRepoInOrg(
		newTestRESTClient(t, server), ui.NewForced(&out, false), false,
		"alice", "cs-principles", "hello", "o", tmpl,
		&assignments.RepoFeatures{Issues: boolPtr(false)},
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if patchBody == nil {
		t.Fatal("no PATCH sent, but an explicit override must PATCH")
	}
	// Explicit false wins for issues; the rest inherit the template's true.
	for k, want := range map[string]bool{
		"has_issues": false, "has_wiki": true, "has_projects": true, "has_pull_requests": true,
	} {
		if v, ok := patchBody[k].(bool); !ok || v != want {
			t.Errorf("patch %q = %v, want %v", k, patchBody[k], want)
		}
	}
}

// Fail-open: a repo-feature PATCH that GitHub rejects (e.g. org disables a
// feature org-wide) must NOT fail an otherwise-successful accept. The repo was
// already created; the feature override is best-effort (mirrors the web
// patchRepoSurface contract).
func TestTemplatedFeaturePatchFailsOpen(t *testing.T) {
	tmpl := assignments.TemplateRef{Owner: "cs50", Repo: "hello-template", Branch: "main"}
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/cs50/hello-template/generate", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"full_name":      "o/cs-principles-hello-alice",
			"html_url":       "https://github.com/o/cs-principles-hello-alice",
			"default_branch": "main",
		})
	})
	mux.HandleFunc("/repos/o/cs-principles-hello-alice", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch {
			w.WriteHeader(http.StatusUnprocessableEntity)
			_ = json.NewEncoder(w).Encode(map[string]string{"message": "Projects are disabled for this organization"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{
			"full_name":      "o/cs-principles-hello-alice",
			"html_url":       "https://github.com/o/cs-principles-hello-alice",
			"default_branch": "main",
		})
	})
	mux.HandleFunc("/repos/o/cs-principles-hello-alice/branches", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]string{{"name": "main"}})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	var out bytes.Buffer
	htmlURL, _, branch, _, err := createTemplatedPrivateAssignmentRepoInOrg(
		newTestRESTClient(t, server), ui.NewForced(&out, false), false,
		"alice", "cs-principles", "hello", "o", tmpl,
		&assignments.RepoFeatures{Projects: boolPtr(true)}, // forces a PATCH that 422s
	)
	if err != nil {
		t.Fatalf("accept must not fail when the feature PATCH is rejected (fail-open): %v", err)
	}
	if htmlURL == "" {
		t.Error("expected the created repo URL despite the failed feature PATCH")
	}
	if branch != "main" {
		t.Errorf("branch = %q, want main (generate echo, since PATCH failed)", branch)
	}
}

// The template-less path also fails open on a rejected feature PATCH.
func TestEmptyFeaturePatchFailsOpen(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/orgs/o/repos", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"full_name":      "o/cs-principles-solo-alice",
			"html_url":       "https://github.com/o/cs-principles-solo-alice",
			"default_branch": "main",
		})
	})
	mux.HandleFunc("/repos/o/cs-principles-solo-alice", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch {
			w.WriteHeader(http.StatusUnprocessableEntity)
			_ = json.NewEncoder(w).Encode(map[string]string{"message": "disabled"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{
			"full_name":      "o/cs-principles-solo-alice",
			"html_url":       "https://github.com/o/cs-principles-solo-alice",
			"default_branch": "main",
		})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	var out bytes.Buffer
	htmlURL, _, branch, _, err := createEmptyPrivateAssignmentRepoInOrg(
		newTestRESTClient(t, server), ui.NewForced(&out, false), false,
		"alice", "cs-principles", "solo", "o", true, nil,
	)
	if err != nil {
		t.Fatalf("empty accept must not fail when the feature PATCH is rejected: %v", err)
	}
	if htmlURL == "" || branch != "main" {
		t.Errorf("expected created repo coordinates from the create echo; got url=%q branch=%q", htmlURL, branch)
	}
}
