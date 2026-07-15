package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/gh-student/internal/ui"
)

// TestCheckAcceptableMode pins the accept mode gate: individual, group, and
// empty (defaults to individual) are accepted; only an unknown mode errors.
// Group-shape coherence is a separate check (TestAssertModeCoherentForCreate).
func TestCheckAcceptableMode(t *testing.T) {
	cases := []struct {
		name    string
		mode    string
		wantErr bool
	}{
		{"empty", "", false},
		{"individual", "individual", false},
		{"group", "group", false},
		{"unknown mode", "team", true},
		{"uppercase group is not canonical", "GROUP", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := checkAcceptableMode("hello", tc.mode)
			if tc.wantErr && err == nil {
				t.Errorf("mode %q: expected an error, got nil", tc.mode)
			}
			if !tc.wantErr && err != nil {
				t.Errorf("mode %q: unexpected error %v", tc.mode, err)
			}
		})
	}
}

// TestAssertModeCoherentForCreate pins the fresh-create coherence gate: a
// group-shaped entry (max_group_size >= 2) whose mode isn't `group` is rejected
// (the founder would be under-privileged), while coherent and non-group-shaped
// entries pass. This gate must NOT run on the already-accepted reconcile path.
func TestAssertModeCoherentForCreate(t *testing.T) {
	cases := []struct {
		name         string
		mode         string
		maxGroupSize int
		wantErr      bool
	}{
		{"individual no size", "individual", 0, false},
		{"group with size", "group", 3, false},
		{"empty no size", "", 0, false},
		{"group size but empty mode is inconsistent", "", 3, true},
		{"group size but individual mode is inconsistent", "individual", 2, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := assertModeCoherentForCreate("hello", tc.mode, tc.maxGroupSize)
			if tc.wantErr && err == nil {
				t.Errorf("mode %q size %d: expected an error, got nil", tc.mode, tc.maxGroupSize)
			}
			if !tc.wantErr && err != nil {
				t.Errorf("mode %q size %d: unexpected error %v", tc.mode, tc.maxGroupSize, err)
			}
		})
	}
}

// TestCheckOrgStatus pins the wire -> OrgStatus decode that is the sole source
// of isOwner: an "admin" role must surface so an org owner is tolerated at the
// founder read-back, and a 404 must degrade to a StatusCode-only result.
func TestCheckOrgStatus(t *testing.T) {
	const org = "cs50"
	cases := []struct {
		name       string
		status     int
		body       string
		wantState  string
		wantRole   string
		wantStatus int
	}{
		{"active owner", http.StatusOK, `{"state":"active","role":"admin"}`, "active", "admin", http.StatusOK},
		{"active member", http.StatusOK, `{"state":"active","role":"member"}`, "active", "member", http.StatusOK},
		{"pending owner keeps role", http.StatusOK, `{"state":"pending","role":"admin"}`, "pending", "admin", http.StatusOK},
		{"not a member", http.StatusNotFound, `{}`, "", "", http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mux := http.NewServeMux()
			mux.HandleFunc("/user/memberships/orgs/"+org, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			})
			server := httptest.NewServer(mux)
			t.Cleanup(server.Close)
			client := newTestRESTClient(t, server)

			got, err := checkOrgStatus(client, org)
			if err != nil {
				t.Fatalf("checkOrgStatus returned error: %v", err)
			}
			if got.State != tc.wantState {
				t.Errorf("State = %q, want %q", got.State, tc.wantState)
			}
			if got.Role != tc.wantRole {
				t.Errorf("Role = %q, want %q", got.Role, tc.wantRole)
			}
			if got.StatusCode != tc.wantStatus {
				t.Errorf("StatusCode = %d, want %d", got.StatusCode, tc.wantStatus)
			}
		})
	}
}

// TestPermissionSatisfies pins the read-back decision, incl. the guard's
// boundary: a `maintain` founder (legacy collapses to "write") must FAIL a
// `push` target, so an ignored self-downgrade isn't passed green. isOwner
// relaxes a push target to accept the org owner's unavoidable residual admin.
func TestPermissionSatisfies(t *testing.T) {
	cases := []struct {
		name     string
		legacy   string
		roleName string
		want     string
		isOwner  bool
		ok       bool
	}{
		{"push grant reads role_name push", "write", "push", "push", false, true},
		{"push grant reads role_name write", "write", "write", "push", false, true},
		{"maintain must fail a push target", "write", "maintain", "push", false, false},
		{"admin must fail a push target", "admin", "admin", "push", false, false},
		{"read must fail a push target", "read", "read", "push", false, false},
		{"admin grant reads role_name admin", "admin", "admin", "admin", false, true},
		{"push must fail an admin target", "write", "push", "admin", false, false},
		{"empty role_name falls back to legacy write for push", "write", "", "push", false, true},
		{"empty role_name falls back to legacy admin for admin", "admin", "", "admin", false, true},
		{"empty role_name legacy write must fail admin", "write", "", "admin", false, false},
		{"owner admin satisfies a push target", "admin", "admin", "push", true, true},
		{"owner admin (legacy only) satisfies a push target", "admin", "", "push", true, true},
		{"owner still fails a maintain push target", "write", "maintain", "push", true, false},
		{"owner does not leak into an admin target", "write", "maintain", "admin", true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := permissionSatisfies(tc.legacy, tc.roleName, tc.want, tc.isOwner); got != tc.ok {
				t.Errorf("permissionSatisfies(%q,%q,%q,%v) = %v, want %v", tc.legacy, tc.roleName, tc.want, tc.isOwner, got, tc.ok)
			}
		})
	}
}

// TestFounderPermission pins the mode→role mapping: individual (and
// empty/unknown, which default to individual) gets least-privilege `push`,
// group gets `admin` so the founder can add teammates via `gh student invite`.
func TestFounderPermission(t *testing.T) {
	cases := []struct {
		mode string
		want string
	}{
		{"individual", "push"},
		{"", "push"},
		{"team", "push"}, // unknown modes default to individual (least privilege)
		{"group", "admin"},
	}
	for _, tc := range cases {
		t.Run(tc.mode, func(t *testing.T) {
			if got := founderPermission(tc.mode); got != tc.want {
				t.Errorf("founderPermission(%q) = %q, want %q", tc.mode, got, tc.want)
			}
		})
	}
}

// TestInviteFounder pins the grant + verification: accept PUTs the student at
// the requested role, then succeeds only when the read-back matches (a push
// grant reads back as legacy `write`). Asserts the exact PUT path/body.
func TestInviteFounder(t *testing.T) {
	const (
		org      = "cs50"
		repoName = "cs50-fall-2026-hello-alice"
		username = "alice"
	)
	collabPath := "/repos/" + org + "/" + repoName + "/collaborators/" + username
	permPath := collabPath + "/permission"

	// want is the role we set; legacyBack is what GitHub reports on the
	// read-back (push collapses to the legacy "write" role).
	cases := []struct {
		want       string
		legacyBack string
	}{
		{"push", "write"},
		{"admin", "admin"},
	}
	for _, tc := range cases {
		t.Run(tc.want, func(t *testing.T) {
			var gotPutPath, gotMethod string
			var gotBody map[string]any
			mux := http.NewServeMux()
			mux.HandleFunc(permPath, func(w http.ResponseWriter, _ *http.Request) {
				_ = json.NewEncoder(w).Encode(map[string]any{"permission": tc.legacyBack, "role_name": tc.want})
			})
			mux.HandleFunc(collabPath, func(w http.ResponseWriter, r *http.Request) {
				gotPutPath = r.URL.Path
				gotMethod = r.Method
				raw, _ := io.ReadAll(r.Body)
				_ = json.Unmarshal(raw, &gotBody)
				w.WriteHeader(http.StatusNoContent) // 204: updated directly
			})
			server := httptest.NewServer(mux)
			t.Cleanup(server.Close)
			client := newTestRESTClient(t, server)

			var out bytes.Buffer
			if err := inviteFounder(client, ui.NewForced(&out, false), false, username, org, repoName, tc.want, false); err != nil {
				t.Fatalf("inviteFounder returned error: %v", err)
			}

			if gotMethod != http.MethodPut {
				t.Errorf("method = %q, want PUT", gotMethod)
			}
			if gotPutPath != collabPath {
				t.Errorf("path = %q, want %q", gotPutPath, collabPath)
			}
			if perm := gotBody["permission"]; perm != tc.want {
				t.Errorf("collaborator permission = %v, want %q", perm, tc.want)
			}
		})
	}
}

// TestInviteFounder_VerificationFails proves the demotion is verified, not
// fire-and-forget: a read-back still reporting admin after a push grant must
// return an actionable error, not silently report success.
func TestInviteFounder_VerificationFails(t *testing.T) {
	const (
		org      = "cs50"
		repoName = "cs50-fall-2026-hello-alice"
		username = "alice"
	)
	collabPath := "/repos/" + org + "/" + repoName + "/collaborators/" + username

	mux := http.NewServeMux()
	mux.HandleFunc(collabPath+"/permission", func(w http.ResponseWriter, _ *http.Request) {
		// The downgrade didn't take — student is still admin.
		_ = json.NewEncoder(w).Encode(map[string]any{"permission": "admin", "role_name": "admin"})
	})
	mux.HandleFunc(collabPath, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := newTestRESTClient(t, server)

	var out bytes.Buffer
	err := inviteFounder(client, ui.NewForced(&out, false), false, username, org, repoName, "push", false)
	if err == nil {
		t.Fatalf("expected an error when the effective permission stays admin after a push grant, got nil")
	}
	if !strings.Contains(err.Error(), "push") || !strings.Contains(err.Error(), "admin") {
		t.Errorf("error should name the wanted (push) and actual (admin) roles, got: %v", err)
	}
}

// TestInviteFounder_OwnerTolerated proves an org owner can accept: the
// self-downgrade to push is silently ignored (owner keeps admin), but with
// isOwner set the read-back tolerates that residual admin instead of failing.
func TestInviteFounder_OwnerTolerated(t *testing.T) {
	const (
		org      = "cs50"
		repoName = "cs50-fall-2026-hello-alice"
		username = "alice"
	)
	collabPath := "/repos/" + org + "/" + repoName + "/collaborators/" + username

	mux := http.NewServeMux()
	mux.HandleFunc(collabPath+"/permission", func(w http.ResponseWriter, _ *http.Request) {
		// Owner can't self-downgrade; GitHub still reports admin.
		_ = json.NewEncoder(w).Encode(map[string]any{"permission": "admin", "role_name": "admin"})
	})
	mux.HandleFunc(collabPath, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := newTestRESTClient(t, server)

	var out bytes.Buffer
	if err := inviteFounder(client, ui.NewForced(&out, false), false, username, org, repoName, "push", true); err != nil {
		t.Fatalf("owner push grant reading back as admin should be tolerated, got: %v", err)
	}
}
