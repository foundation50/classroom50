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
// empty (defaults to individual) are accepted; an unknown mode errors; and a
// group-shaped entry (max_group_size >= 2) whose mode isn't `group` is rejected
// as inconsistent metadata (the founder would be under-privileged).
func TestCheckAcceptableMode(t *testing.T) {
	cases := []struct {
		name         string
		mode         string
		maxGroupSize int
		wantErr      bool
	}{
		{"empty", "", 0, false},
		{"individual", "individual", 0, false},
		{"group", "group", 3, false},
		{"unknown mode", "team", 0, true},
		{"uppercase group is not canonical", "GROUP", 0, true},
		{"group size but empty mode is inconsistent", "", 3, true},
		{"group size but individual mode is inconsistent", "individual", 2, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := checkAcceptableMode("hello", tc.mode, tc.maxGroupSize)
			if tc.wantErr && err == nil {
				t.Errorf("mode %q size %d: expected an error, got nil", tc.mode, tc.maxGroupSize)
			}
			if !tc.wantErr && err != nil {
				t.Errorf("mode %q size %d: unexpected error %v", tc.mode, tc.maxGroupSize, err)
			}
		})
	}
}

// TestFounderPermission pins the mode→role mapping: individual (and
// empty/unknown, which default to individual) gets least-privilege `push` —
// enough to push and trigger autograding but not to delete/transfer the repo
// or manage collaborators — while group gets `admin` so the founder can add
// teammates via `gh student invite`. A regression here either over-privileges
// individual students or silently breaks the group-invite flow.
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

// TestInviteFounder pins the founder grant + verification: accept PUTs the
// student at the requested role, then reads the effective permission back and
// succeeds only when it matches (a push grant reads back as the legacy `write`
// role). Asserts the exact PUT path/body so a wrong verb/path/role regresses.
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
		want      string
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
			if err := inviteFounder(client, ui.NewForced(&out, false), false, username, org, repoName, tc.want); err != nil {
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
// fire-and-forget: when the read-back still reports admin after we set push
// (the self-downgrade was ignored), inviteFounder returns an actionable error
// rather than silently reporting success.
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
	err := inviteFounder(client, ui.NewForced(&out, false), false, username, org, repoName, "push")
	if err == nil {
		t.Fatalf("expected an error when the effective permission stays admin after a push grant, got nil")
	}
	if !strings.Contains(err.Error(), "push") || !strings.Contains(err.Error(), "admin") {
		t.Errorf("error should name the wanted (push) and actual (admin) roles, got: %v", err)
	}
}
