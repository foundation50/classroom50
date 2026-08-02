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
				HasIssues: false, HasWiki: true, HasProjects: false, HasPullRequests: boolPtr(false),
			},
			want: map[string]any{
				"has_issues":        false,
				"has_wiki":          true,
				"has_projects":      false,
				"has_pull_requests": false,
			},
		},
		{
			// GitHub's repo object omits has_pull_requests, so a template GET
			// decodes it to a nil pointer. On inherit that key must be OMITTED
			// (not forced false), matching the web resolveRepoFeaturesPatch.
			name:      "templated + no override omits has_pull_requests when the template GET lacks it",
			features:  nil,
			templated: true,
			template: &GeneratedRepo{
				HasIssues: true, HasWiki: false, HasProjects: true, HasPullRequests: nil,
			},
			want: map[string]any{
				"has_issues":   true,
				"has_wiki":     false,
				"has_projects": true,
			},
		},
		{
			name:      "template-less + no override omits every key (GitHub create defaults)",
			features:  nil,
			templated: false,
			want:      map[string]any{},
		},
		{
			name:      "explicit issues:false on a templated assignment is sent",
			features:  &assignments.RepoFeatures{Issues: boolPtr(false)},
			templated: true,
			template:  &GeneratedRepo{HasIssues: true, HasWiki: true, HasProjects: true, HasPullRequests: boolPtr(true)},
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
			template:  &GeneratedRepo{HasIssues: false, HasWiki: false, HasProjects: false, HasPullRequests: boolPtr(false)},
			want: map[string]any{
				"has_issues":        true,
				"has_wiki":          false,
				"has_projects":      false,
				"has_pull_requests": false,
			},
		},
		{
			name:      "template-less honors explicit-on and omits the rest (GitHub defaults)",
			features:  &assignments.RepoFeatures{Wiki: boolPtr(true)},
			templated: false,
			want: map[string]any{
				"has_wiki": true,
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, _ := resolveRepoFeaturePatchBody(tc.features, tc.templated, tc.template)
			if len(got) != len(tc.want) {
				t.Fatalf("body keys = %v, want %v", got, tc.want)
			}
			for k, v := range tc.want {
				if got[k] != v {
					t.Errorf("body[%q] = %v, want %v", k, got[k], v)
				}
			}
			// Guard the omit cases precisely: a leaked key the resolver should
			// have omitted must fail here, not slip past the count check.
			for k := range got {
				if _, ok := tc.want[k]; !ok {
					t.Errorf("body carries unexpected key %q = %v", k, got[k])
				}
			}
		})
	}
}

// resolveRepoFeaturePatchBody's second return is the explicit-only body: the
// keys the teacher forced (non-nil features.*), so the caller can retry with
// just those when the full body (including inherited keys) is rejected.
func TestResolveRepoFeaturePatchBody_ExplicitSubset(t *testing.T) {
	// Templated inherit with one forced key: full carries all inherited + the
	// forced key; explicit carries only the forced key.
	full, explicit := resolveRepoFeaturePatchBody(
		&assignments.RepoFeatures{Issues: boolPtr(false)},
		true,
		&GeneratedRepo{HasIssues: true, HasWiki: true, HasProjects: true, HasPullRequests: boolPtr(true)},
	)
	if len(full) != 4 {
		t.Errorf("full body = %v, want all four keys", full)
	}
	if len(explicit) != 1 || explicit["has_issues"] != false {
		t.Errorf("explicit body = %v, want only has_issues:false", explicit)
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

// When the full PATCH (inherited + forced keys) is rejected because an org bans
// an INHERITED key (e.g. org-wide projects disabled), accept must retry with
// only the teacher-forced keys so the forced override still lands. Here the
// template has everything ON (so inherit resolves has_projects:true, which the
// org rejects), while the teacher forced issues OFF — the retry must send
// exactly {has_issues:false} and succeed.
func TestTemplatedFeaturePatchRetriesWithForcedKeysOnly(t *testing.T) {
	tmpl := assignments.TemplateRef{Owner: "cs50", Repo: "hello-template", Branch: "main"}
	var patchBodies []map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/cs50/hello-template/generate", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"full_name":      "o/cs-principles-hello-alice",
			"html_url":       "https://github.com/o/cs-principles-hello-alice",
			"default_branch": "main",
		})
	})
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
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			patchBodies = append(patchBodies, body)
			// Reject any body that tries to enable projects (org-wide disabled).
			if v, ok := body["has_projects"].(bool); ok && v {
				w.WriteHeader(http.StatusUnprocessableEntity)
				_ = json.NewEncoder(w).Encode(map[string]string{"message": "Projects are disabled for this organization"})
				return
			}
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
		&assignments.RepoFeatures{Issues: boolPtr(false)}, // forced OFF; projects inherited ON
	)
	if err != nil {
		t.Fatalf("accept must not fail: %v", err)
	}
	if len(patchBodies) != 2 {
		t.Fatalf("expected 2 PATCH attempts (full then forced-only), got %d: %v", len(patchBodies), patchBodies)
	}
	// First attempt is the full body (has_projects:true -> 422).
	if v, ok := patchBodies[0]["has_projects"].(bool); !ok || !v {
		t.Errorf("first PATCH = %v, want the full body with has_projects:true", patchBodies[0])
	}
	// Retry carries ONLY the teacher-forced key and lands.
	if len(patchBodies[1]) != 1 {
		t.Errorf("retry PATCH = %v, want only the forced key", patchBodies[1])
	}
	if v, ok := patchBodies[1]["has_issues"].(bool); !ok || v {
		t.Errorf("retry PATCH has_issues = %v, want false (the teacher's forced override survives)", patchBodies[1]["has_issues"])
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
	// Force a feature so a PATCH is actually sent (a nil/all-default template-
	// less assignment now sends none); the org rejects it and accept must still
	// succeed.
	htmlURL, _, branch, _, err := createEmptyPrivateAssignmentRepoInOrg(
		newTestRESTClient(t, server), ui.NewForced(&out, false), false,
		"alice", "cs-principles", "solo", "o", true,
		&assignments.RepoFeatures{Projects: boolPtr(true)},
	)
	if err != nil {
		t.Fatalf("empty accept must not fail when the feature PATCH is rejected: %v", err)
	}
	if htmlURL == "" || branch != "main" {
		t.Errorf("expected created repo coordinates from the create echo; got url=%q branch=%q", htmlURL, branch)
	}
}
