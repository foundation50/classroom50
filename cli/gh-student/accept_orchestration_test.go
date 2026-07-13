package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundation50/classroom50-cli-shared/ghutil"
	"github.com/foundation50/gh-student/internal/assignments"
	"github.com/foundation50/gh-student/internal/classroomcfg"
	"github.com/foundation50/gh-student/internal/ui"
)

// writePermissionReadback answers GET .../collaborators/{u}/permission with the
// effective role GitHub would report for a grant of `set`: push collapses to
// the legacy "write" role, admin stays admin. Lets the accept tests satisfy
// inviteFounder's post-grant verification.
func writePermissionReadback(w http.ResponseWriter, set string) {
	legacy, role := set, set
	if set == "push" {
		legacy, role = "write", "push"
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"permission": legacy, "role_name": role})
}

func TestCreateTemplatedPrivateAssignmentRepoInOrg(t *testing.T) {
	tmpl := assignments.TemplateRef{Owner: "cs50", Repo: "hello-template", Branch: "main"}

	t.Run("success: generate then patch, returns new repo", func(t *testing.T) {
		var generated, patched bool
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/cs50/hello-template/generate", func(w http.ResponseWriter, r *http.Request) {
			generated = true
			_ = json.NewEncoder(w).Encode(map[string]string{
				"full_name":      "o/cs-principles-hello-alice",
				"html_url":       "https://github.com/o/cs-principles-hello-alice",
				"default_branch": "main",
			})
		})
		mux.HandleFunc("/repos/o/cs-principles-hello-alice", func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPatch {
				patched = true
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
		client := newTestRESTClient(t, server)

		var out bytes.Buffer
		htmlURL, fullName, branch, already, err := createTemplatedPrivateAssignmentRepoInOrg(client, ui.NewForced(&out, false), false, "alice", "cs-principles", "hello", "o", tmpl)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if already {
			t.Error("alreadyExisted = true, want false on a fresh create")
		}
		if branch != "main" {
			t.Errorf("branch = %q, want main", branch)
		}
		if !generated || !patched {
			t.Errorf("generated=%v patched=%v, want both true", generated, patched)
		}
		if fullName != "o/cs-principles-hello-alice" || !strings.Contains(htmlURL, "cs-principles-hello-alice") {
			t.Errorf("got (%q, %q), want the generated repo coordinates", htmlURL, fullName)
		}
	})

	t.Run("master-default org: generated repo's branch (not the template's) is returned", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/cs50/hello-template/generate", func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]string{
				"full_name":      "o/cs-principles-hello-alice",
				"html_url":       "https://github.com/o/cs-principles-hello-alice",
				"default_branch": "master",
			})
		})
		mux.HandleFunc("/repos/o/cs-principles-hello-alice", func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]string{
				"full_name":      "o/cs-principles-hello-alice",
				"html_url":       "https://github.com/o/cs-principles-hello-alice",
				"default_branch": "master",
			})
		})
		mux.HandleFunc("/repos/o/cs-principles-hello-alice/branches", func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode([]map[string]string{{"name": "master"}})
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)

		var out bytes.Buffer
		_, _, branch, _, err := createTemplatedPrivateAssignmentRepoInOrg(newTestRESTClient(t, server), ui.NewForced(&out, false), false, "alice", "cs-principles", "hello", "o", tmpl)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if branch != "master" {
			t.Errorf("branch = %q, want master (the generated repo's default branch)", branch)
		}
	})

	t.Run("stale default_branch: settles to the branch that materializes", func(t *testing.T) {
		var branchesGets int
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/cs50/hello-template/generate", func(w http.ResponseWriter, r *http.Request) {
			// Generate echoes the transient org default `main`, but the template
			// really produces `master`.
			_ = json.NewEncoder(w).Encode(map[string]string{
				"full_name":      "o/cs-principles-hello-alice",
				"html_url":       "https://github.com/o/cs-principles-hello-alice",
				"default_branch": "main",
			})
		})
		mux.HandleFunc("/repos/o/cs-principles-hello-alice/branches", func(w http.ResponseWriter, _ *http.Request) {
			branchesGets++
			_ = json.NewEncoder(w).Encode([]map[string]string{{"name": "master"}})
		})
		mux.HandleFunc("/repos/o/cs-principles-hello-alice", func(w http.ResponseWriter, r *http.Request) {
			body := map[string]string{
				"full_name": "o/cs-principles-hello-alice",
				"html_url":  "https://github.com/o/cs-principles-hello-alice",
			}
			if r.Method == http.MethodGet {
				// The settled repo reports the real branch.
				body["default_branch"] = "master"
			}
			_ = json.NewEncoder(w).Encode(body)
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)

		var out bytes.Buffer
		_, _, branch, _, err := createTemplatedPrivateAssignmentRepoInOrg(newTestRESTClient(t, server), ui.NewForced(&out, false), false, "alice", "cs-principles", "hello", "o", tmpl)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if branchesGets == 0 {
			t.Error("expected the settle-resolver to poll the branches endpoint")
		}
		if branch != "master" {
			t.Errorf("branch = %q, want master (the branch that materialized, not the stale main echo)", branch)
		}
	})

	t.Run("422 already-exists short-circuits to alreadyExisted via follow-up GET", func(t *testing.T) {
		var patchAttempted bool
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/cs50/hello-template/generate", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"message":"Repository creation failed: name already exists on this account"}`))
		})
		mux.HandleFunc("/repos/o/cs-principles-hello-alice", func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPatch {
				patchAttempted = true
			}
			_ = json.NewEncoder(w).Encode(map[string]string{
				"full_name": "o/cs-principles-hello-alice",
				"html_url":  "https://github.com/o/cs-principles-hello-alice",
			})
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)
		client := newTestRESTClient(t, server)

		var out bytes.Buffer
		_, fullName, _, already, err := createTemplatedPrivateAssignmentRepoInOrg(client, ui.NewForced(&out, false), false, "alice", "cs-principles", "hello", "o", tmpl)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !already {
			t.Error("alreadyExisted = false, want true on a 422 already-exists")
		}
		if patchAttempted {
			t.Error("PATCH should be skipped on the already-exists path")
		}
		if fullName != "o/cs-principles-hello-alice" {
			t.Errorf("fullName = %q, want the existing repo from the follow-up GET", fullName)
		}
	})

	t.Run("404 on generate → cross-org visibility message", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/cs50/hello-template/generate", func(w http.ResponseWriter, r *http.Request) {
			http.NotFound(w, r)
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)
		client := newTestRESTClient(t, server)

		var out bytes.Buffer
		_, _, _, _, err := createTemplatedPrivateAssignmentRepoInOrg(client, ui.NewForced(&out, false), false, "alice", "cs-principles", "hello", "o", tmpl)
		if err == nil || !strings.Contains(err.Error(), "not accessible to you") {
			t.Fatalf("err = %v, want the cross-org 'not accessible' message", err)
		}
	})
}

func TestCreateEmptyPrivateAssignmentRepoInOrg(t *testing.T) {
	t.Run("success: POST orgs/{org}/repos with auto_init, returns default_branch", func(t *testing.T) {
		var created, patched bool
		var createBody map[string]any
		mux := http.NewServeMux()
		mux.HandleFunc("/orgs/o/repos", func(w http.ResponseWriter, r *http.Request) {
			created = true
			_ = json.NewDecoder(r.Body).Decode(&createBody)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"full_name":      "o/cs-principles-solo-alice",
				"html_url":       "https://github.com/o/cs-principles-solo-alice",
				"default_branch": "main",
			})
		})
		mux.HandleFunc("/repos/o/cs-principles-solo-alice", func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPatch {
				patched = true
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"full_name":      "o/cs-principles-solo-alice",
				"html_url":       "https://github.com/o/cs-principles-solo-alice",
				"default_branch": "main",
			})
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)
		client := newTestRESTClient(t, server)

		var out bytes.Buffer
		htmlURL, fullName, branch, already, err := createEmptyPrivateAssignmentRepoInOrg(client, ui.NewForced(&out, false), false, "alice", "cs-principles", "solo", "o")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if already {
			t.Error("alreadyExisted = true, want false on a fresh create")
		}
		if !created || !patched {
			t.Errorf("created=%v patched=%v, want both true", created, patched)
		}
		if createBody["auto_init"] != true || createBody["private"] != true {
			t.Errorf("create body = %v, want auto_init:true private:true", createBody)
		}
		if branch != "main" {
			t.Errorf("default branch = %q, want main", branch)
		}
		if fullName != "o/cs-principles-solo-alice" || !strings.Contains(htmlURL, "cs-principles-solo-alice") {
			t.Errorf("got (%q, %q), want the created repo coordinates", htmlURL, fullName)
		}
	})

	t.Run("empty default_branch in response falls back to main", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/orgs/o/repos", func(w http.ResponseWriter, r *http.Request) {
			// Response omits default_branch entirely.
			_ = json.NewEncoder(w).Encode(map[string]any{
				"full_name": "o/cs-principles-solo-alice",
				"html_url":  "https://github.com/o/cs-principles-solo-alice",
			})
		})
		mux.HandleFunc("/repos/o/cs-principles-solo-alice", func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"full_name": "o/cs-principles-solo-alice",
				"html_url":  "https://github.com/o/cs-principles-solo-alice",
			})
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)
		client := newTestRESTClient(t, server)

		var out bytes.Buffer
		_, _, branch, _, err := createEmptyPrivateAssignmentRepoInOrg(client, ui.NewForced(&out, false), false, "alice", "cs-principles", "solo", "o")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if branch != "main" {
			t.Errorf("default branch = %q, want fallback to main when the response omits it", branch)
		}
	})

	t.Run("422 already-exists short-circuits via follow-up GET, skips PATCH", func(t *testing.T) {
		var patchAttempted bool
		mux := http.NewServeMux()
		mux.HandleFunc("/orgs/o/repos", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"message":"Repository creation failed: name already exists on this account"}`))
		})
		mux.HandleFunc("/repos/o/cs-principles-solo-alice", func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPatch {
				patchAttempted = true
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"full_name":      "o/cs-principles-solo-alice",
				"html_url":       "https://github.com/o/cs-principles-solo-alice",
				"default_branch": "main",
			})
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)
		client := newTestRESTClient(t, server)

		var out bytes.Buffer
		_, fullName, branch, already, err := createEmptyPrivateAssignmentRepoInOrg(client, ui.NewForced(&out, false), false, "alice", "cs-principles", "solo", "o")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !already {
			t.Error("alreadyExisted = false, want true on a 422 already-exists")
		}
		if patchAttempted {
			t.Error("PATCH should be skipped on the already-exists path")
		}
		if branch != "main" {
			t.Errorf("default branch = %q, want main from the follow-up GET", branch)
		}
		if fullName != "o/cs-principles-solo-alice" {
			t.Errorf("fullName = %q, want the existing repo from the follow-up GET", fullName)
		}
	})
}

// repoFileExists underpins the self-healing branch (probe .classroom50.yaml on
// an already-existing repo) and the post-provision verification. 200 → true,
// 404 → false, other statuses → error.
func TestRepoFileExists(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		want    bool
		wantErr bool
	}{
		{"present (200)", http.StatusOK, true, false},
		{"missing (404)", http.StatusNotFound, false, false},
		{"transient (500) propagates", http.StatusInternalServerError, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mux := http.NewServeMux()
			mux.HandleFunc("/repos/o/r/contents/.classroom50.yaml", func(w http.ResponseWriter, _ *http.Request) {
				if tc.status == http.StatusOK {
					_ = json.NewEncoder(w).Encode(map[string]any{"type": "file", "name": ".classroom50.yaml"})
					return
				}
				w.WriteHeader(tc.status)
			})
			server := httptest.NewServer(mux)
			t.Cleanup(server.Close)
			client := newTestRESTClient(t, server)

			got, err := repoFileExists(client, "o", "r", ".classroom50.yaml")
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected an error for status %d, got nil", tc.status)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Errorf("repoFileExists = %v, want %v", got, tc.want)
			}
		})
	}
}

// verifyProvisioned passes when the accept marker (.classroom50.yaml) is
// readable. DropFiles lands it and the autograde workflow in one atomic Tree
// commit, so the marker's presence implies the workflow's. The read-back polls
// through the contents API's post-commit consistency lag: a marker missing on
// the first read but present on a retry succeeds; a persistently missing one
// fails with an actionable re-run hint.
func TestVerifyProvisioned(t *testing.T) {
	const repo = "cs-principles-hello-alice"

	// Shrink the backoff so the retry-path tests stay fast.
	origBackoff := verifyProvisionBackoff
	verifyProvisionBackoff = time.Millisecond
	t.Cleanup(func() { verifyProvisionBackoff = origBackoff })

	t.Run("marker present -> ok", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/o/"+repo+"/contents/.classroom50.yaml", func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"type": "file"})
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)
		if err := verifyProvisioned(newTestRESTClient(t, server), "o", repo); err != nil {
			t.Fatalf("verifyProvisioned: unexpected error: %v", err)
		}
	})

	t.Run("marker 404 on first read then present -> ok (rides out contents lag)", func(t *testing.T) {
		var calls int
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/o/"+repo+"/contents/.classroom50.yaml", func(w http.ResponseWriter, _ *http.Request) {
			calls++
			if calls < 2 {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"type": "file"})
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)
		if err := verifyProvisioned(newTestRESTClient(t, server), "o", repo); err != nil {
			t.Fatalf("verifyProvisioned should retry past a transient 404, got: %v", err)
		}
		if calls < 2 {
			t.Errorf("expected a retry after the first 404, got %d call(s)", calls)
		}
	})

	t.Run("marker persistently missing -> error with re-run hint", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/o/"+repo+"/contents/.classroom50.yaml", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNotFound)
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)
		err := verifyProvisioned(newTestRESTClient(t, server), "o", repo)
		if err == nil {
			t.Fatal("expected an error when the accept marker is persistently missing, got nil")
		}
		if !strings.Contains(err.Error(), "re-run") {
			t.Errorf("error should carry a re-run hint, got: %v", err)
		}
	})
}

// TestAcceptIntoRepo_SelfHealFork is the end-to-end test of accept's headline
// self-healing behavior. It drives acceptIntoRepo (the post-create tail of
// acceptAssignment, split out so it runs without the up-front Pages fetch)
// against an httptest GitHub server, asserting both branches: an
// already-provisioned repo is left untouched, and a half-provisioned one is
// repaired by re-running the idempotent provisioning.
func TestAcceptIntoRepo_SelfHealFork(t *testing.T) {
	const (
		org      = "o"
		repoName = "cs-principles-hello-alice"
	)
	markerPath := "/repos/" + org + "/" + repoName + "/contents/.classroom50.yaml"

	// Keep the verify-poll fast if the heal path reaches it.
	origBackoff := verifyProvisionBackoff
	verifyProvisionBackoff = time.Millisecond
	t.Cleanup(func() { verifyProvisionBackoff = origBackoff })

	baseParams := func() acceptRepoParams {
		var errBuf bytes.Buffer
		ownerID := int64(4242)
		return acceptRepoParams{
			org:            org,
			classroom:      "cs-principles",
			assignment:     "hello",
			username:       "alice",
			ownerID:        &ownerID,
			acceptedAt:     "2026-06-01T14:33:11Z",
			repoName:       repoName,
			branch:         "main",
			shim:           "shim-content",
			autograderName: "default",
			fullName:       org + "/" + repoName,
			htmlURL:        "https://github.com/" + org + "/" + repoName,
			alreadyExisted: true,
			// A buffer-backed spinner is non-active (non-TTY), matching a
			// piped/CI run; Start/Stop just emit plain lines.
			createSp:  ui.NewForced(&errBuf, false).Spinner("Creating"),
			createMsg: "Creating",
		}
	}

	t.Run("already accepted (marker present) -> reconciles founder role, no file re-provision", func(t *testing.T) {
		var collaboratorPerm string
		var collaboratorPut, treeWrite bool
		mux := http.NewServeMux()
		mux.HandleFunc(markerPath, func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"type": "file"})
		})
		// The founder role is reconciled (idempotent PUT downgrades a repo
		// granted admin under an older release); capture the permission.
		mux.HandleFunc("/repos/"+org+"/"+repoName+"/collaborators/alice/permission", func(w http.ResponseWriter, _ *http.Request) {
			writePermissionReadback(w, collaboratorPerm)
		})
		mux.HandleFunc("/repos/"+org+"/"+repoName+"/collaborators/alice", func(w http.ResponseWriter, r *http.Request) {
			collaboratorPut = true
			var body map[string]any
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &body)
			collaboratorPerm, _ = body["permission"].(string)
			w.WriteHeader(http.StatusNoContent)
		})
		// Any file re-provision (tree commit) here is a bug — the repo is done.
		mux.HandleFunc("/repos/"+org+"/"+repoName+"/git/trees", func(w http.ResponseWriter, _ *http.Request) {
			treeWrite = true
			_ = json.NewEncoder(w).Encode(map[string]string{"sha": "t"})
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)

		var out bytes.Buffer
		err := acceptIntoRepo(newTestRESTClient(t, server), ui.NewForced(&out, false), false, &out, baseParams())
		if err != nil {
			t.Fatalf("acceptIntoRepo: unexpected error: %v", err)
		}
		if !collaboratorPut {
			t.Errorf("an already-provisioned repo must still reconcile the founder role (no collaborator PUT issued)")
		}
		// baseParams leaves mode empty (individual): reconcile downgrades to push.
		if collaboratorPerm != "push" {
			t.Errorf("reconciled individual founder permission = %q, want \"push\" (heals a stale admin grant down)", collaboratorPerm)
		}
		if treeWrite {
			t.Errorf("an already-provisioned repo must not re-provision files (unexpected tree write)")
		}
		if !strings.Contains(out.String(), "already accepted") {
			t.Errorf("expected an already-accepted report on stdout:\n%s", out.String())
		}
	})

	t.Run("already accepted group repo -> reconciles founder to admin", func(t *testing.T) {
		var collaboratorPerm string
		mux := http.NewServeMux()
		mux.HandleFunc(markerPath, func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"type": "file"})
		})
		mux.HandleFunc("/repos/"+org+"/"+repoName+"/collaborators/alice/permission", func(w http.ResponseWriter, _ *http.Request) {
			writePermissionReadback(w, collaboratorPerm)
		})
		mux.HandleFunc("/repos/"+org+"/"+repoName+"/collaborators/alice", func(w http.ResponseWriter, r *http.Request) {
			var body map[string]any
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &body)
			collaboratorPerm, _ = body["permission"].(string)
			w.WriteHeader(http.StatusNoContent)
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)

		p := baseParams()
		p.mode = "group"
		var out bytes.Buffer
		if err := acceptIntoRepo(newTestRESTClient(t, server), ui.NewForced(&out, false), false, &out, p); err != nil {
			t.Fatalf("acceptIntoRepo (group already-accepted): unexpected error: %v", err)
		}
		// A group founder must stay admin on reconcile, else `gh student invite` breaks.
		if collaboratorPerm != "admin" {
			t.Errorf("reconciled group founder permission = %q, want \"admin\"", collaboratorPerm)
		}
	})

	t.Run("already accepted repo still reports success when the best-effort reconcile fails", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc(markerPath, func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"type": "file"})
		})
		// Reconcile fails (e.g. transient 5xx / SSO 403 / departed founder): a
		// healthy already-accepted repo must NOT fail the re-run over it.
		mux.HandleFunc("/repos/"+org+"/"+repoName+"/collaborators/alice", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusServiceUnavailable)
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)

		var out bytes.Buffer
		if err := acceptIntoRepo(newTestRESTClient(t, server), ui.NewForced(&out, false), false, &out, baseParams()); err != nil {
			t.Fatalf("a healthy already-accepted repo must not fail when the reconcile errs: %v", err)
		}
		if !strings.Contains(out.String(), "already accepted") {
			t.Errorf("expected an already-accepted report despite the reconcile failure:\n%s", out.String())
		}
	})

	t.Run("half-provisioned (marker missing) -> re-provisions and repairs", func(t *testing.T) {
		var (
			markerReads     int
			collaboratorPut bool
			treeWrite       bool
			refPatched      bool
			blobBodies      []string
		)
		mux := http.NewServeMux()
		// Marker: absent until the heal commit lands, present afterward.
		mux.HandleFunc(markerPath, func(w http.ResponseWriter, _ *http.Request) {
			markerReads++
			if refPatched {
				_ = json.NewEncoder(w).Encode(map[string]any{"type": "file"})
				return
			}
			w.WriteHeader(http.StatusNotFound)
		})
		// Provisioning: role grant (baseParams mode is empty -> push).
		mux.HandleFunc("/repos/"+org+"/"+repoName+"/collaborators/alice/permission", func(w http.ResponseWriter, _ *http.Request) {
			writePermissionReadback(w, "push")
		})
		mux.HandleFunc("/repos/"+org+"/"+repoName+"/collaborators/alice", func(w http.ResponseWriter, _ *http.Request) {
			collaboratorPut = true
			w.WriteHeader(http.StatusNoContent)
		})
		// Provisioning: DropFiles -> WaitForStableBranch (stable SHA),
		// then the Tree-commit dance.
		mux.HandleFunc("/repos/"+org+"/"+repoName+"/branches/main", func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"commit": map[string]any{"sha": "stable"}})
		})
		mux.HandleFunc("/repos/"+org+"/"+repoName+"/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodGet:
				_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "parent"}})
			case http.MethodPatch:
				refPatched = true
				w.WriteHeader(http.StatusOK)
			}
		})
		mux.HandleFunc("/repos/"+org+"/"+repoName+"/git/commits/parent", func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"tree": map[string]string{"sha": "parent-tree"}})
		})
		mux.HandleFunc("/repos/"+org+"/"+repoName+"/git/blobs", func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			blobBodies = append(blobBodies, string(body))
			_ = json.NewEncoder(w).Encode(map[string]string{"sha": "blob"})
		})
		mux.HandleFunc("/repos/"+org+"/"+repoName+"/git/trees", func(w http.ResponseWriter, _ *http.Request) {
			treeWrite = true
			_ = json.NewEncoder(w).Encode(map[string]string{"sha": "tree"})
		})
		mux.HandleFunc("/repos/"+org+"/"+repoName+"/git/commits", func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]string{"sha": "commit"})
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)

		var out bytes.Buffer
		err := acceptIntoRepo(newTestRESTClient(t, server), ui.NewForced(&out, false), false, &out, baseParams())
		if err != nil {
			t.Fatalf("acceptIntoRepo (heal): unexpected error: %v", err)
		}
		if !collaboratorPut || !treeWrite || !refPatched {
			t.Errorf("heal path must re-provision (collaboratorPut=%v treeWrite=%v refPatched=%v)", collaboratorPut, treeWrite, refPatched)
		}
		// The marker is probed for the fork decision (1) and again by the
		// post-provision verifyProvisioned (>=1), so it must be read >1 time.
		if markerReads < 2 {
			t.Errorf("expected the marker to be re-read after provisioning, got %d read(s)", markerReads)
		}
		if !strings.Contains(out.String(), "already accepted") {
			t.Errorf("a healed already-existing repo still reports already-accepted:\n%s", out.String())
		}
		// The healed commit must carry the repo-config v1 identity shape;
		// one of the uploaded blobs is the rendered .classroom50.yaml.
		var sawV1Marker bool
		for _, raw := range blobBodies {
			var blob struct {
				Content string `json:"content"`
			}
			if json.Unmarshal([]byte(raw), &blob) != nil {
				continue
			}
			decoded, err := ghutil.DecodeContentsBase64(blob.Content)
			if err != nil {
				continue
			}
			body := string(decoded)
			if strings.Contains(body, classroomcfg.SchemaRepoConfigV1) &&
				strings.Contains(body, `username: "alice"`) &&
				strings.Contains(body, "\n  id: 4242\n") {
				sawV1Marker = true
			}
		}
		if !sawV1Marker {
			t.Errorf("healed .classroom50.yaml must carry the v1 schema sentinel + owner identity; blobs:\n%v", blobBodies)
		}
	})

	t.Run("freshly created (not alreadyExisted) -> provisions with the mode's role", func(t *testing.T) {
		cases := []struct {
			name     string
			mode     string
			wantPerm string
		}{
			{"individual grants push", "", "push"},
			{"group grants admin", "group", "admin"},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				var (
					collaboratorPut  bool
					collaboratorPerm string
					treeWrite        bool
					refPatched       bool
				)
				mux := http.NewServeMux()
				// Fresh create skips the fork's marker probe; the marker is only
				// read by the post-provision verifyProvisioned, and must be
				// present (the commit just landed it).
				mux.HandleFunc(markerPath, func(w http.ResponseWriter, _ *http.Request) {
					_ = json.NewEncoder(w).Encode(map[string]any{"type": "file"})
				})
				mux.HandleFunc("/repos/"+org+"/"+repoName+"/collaborators/alice/permission", func(w http.ResponseWriter, _ *http.Request) {
					writePermissionReadback(w, collaboratorPerm)
				})
				mux.HandleFunc("/repos/"+org+"/"+repoName+"/collaborators/alice", func(w http.ResponseWriter, r *http.Request) {
					collaboratorPut = true
					var body map[string]any
					raw, _ := io.ReadAll(r.Body)
					_ = json.Unmarshal(raw, &body)
					collaboratorPerm, _ = body["permission"].(string)
					w.WriteHeader(http.StatusNoContent)
				})
				mux.HandleFunc("/repos/"+org+"/"+repoName+"/branches/main", func(w http.ResponseWriter, _ *http.Request) {
					_ = json.NewEncoder(w).Encode(map[string]any{"commit": map[string]any{"sha": "stable"}})
				})
				mux.HandleFunc("/repos/"+org+"/"+repoName+"/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
					switch r.Method {
					case http.MethodGet:
						_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "parent"}})
					case http.MethodPatch:
						refPatched = true
						w.WriteHeader(http.StatusOK)
					}
				})
				mux.HandleFunc("/repos/"+org+"/"+repoName+"/git/commits/parent", func(w http.ResponseWriter, _ *http.Request) {
					_ = json.NewEncoder(w).Encode(map[string]any{"tree": map[string]string{"sha": "parent-tree"}})
				})
				mux.HandleFunc("/repos/"+org+"/"+repoName+"/git/blobs", func(w http.ResponseWriter, _ *http.Request) {
					_ = json.NewEncoder(w).Encode(map[string]string{"sha": "blob"})
				})
				mux.HandleFunc("/repos/"+org+"/"+repoName+"/git/trees", func(w http.ResponseWriter, _ *http.Request) {
					treeWrite = true
					_ = json.NewEncoder(w).Encode(map[string]string{"sha": "tree"})
				})
				mux.HandleFunc("/repos/"+org+"/"+repoName+"/git/commits", func(w http.ResponseWriter, _ *http.Request) {
					_ = json.NewEncoder(w).Encode(map[string]string{"sha": "commit"})
				})
				server := httptest.NewServer(mux)
				t.Cleanup(server.Close)

				p := baseParams()
				p.alreadyExisted = false
				p.mode = tc.mode
				var out bytes.Buffer
				err := acceptIntoRepo(newTestRESTClient(t, server), ui.NewForced(&out, false), false, &out, p)
				if err != nil {
					t.Fatalf("acceptIntoRepo (fresh): unexpected error: %v", err)
				}
				if !collaboratorPut || !treeWrite || !refPatched {
					t.Errorf("fresh path must provision (collaboratorPut=%v treeWrite=%v refPatched=%v)", collaboratorPut, treeWrite, refPatched)
				}
				if collaboratorPerm != tc.wantPerm {
					t.Errorf("mode %q founder permission = %q, want %q", tc.mode, collaboratorPerm, tc.wantPerm)
				}
				// A first-time accept reports "Assignment accepted:", NOT the
				// "already accepted" wording the alreadyExisted branches use.
				if !strings.Contains(out.String(), "Assignment accepted:") {
					t.Errorf("a fresh accept should report 'Assignment accepted:':\n%s", out.String())
				}
				if strings.Contains(out.String(), "already accepted") {
					t.Errorf("a fresh accept must not use the already-accepted wording:\n%s", out.String())
				}
			})
		}
	})
}
