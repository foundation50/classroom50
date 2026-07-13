package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/foundation50/gh-student/internal/ui"
)

// TestCheckAcceptableMode pins the lifted accept seam: group is now accepted
// (previously rejected), individual and empty are accepted, and only an
// unrecognized mode errors.
func TestCheckAcceptableMode(t *testing.T) {
	cases := []struct {
		mode    string
		wantErr bool
	}{
		{"", false},
		{"individual", false},
		{"group", false},
		{"team", true},
		{"GROUP", true}, // case-sensitive; the canonical value is lowercase
	}
	for _, tc := range cases {
		t.Run(tc.mode, func(t *testing.T) {
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

// TestFounderPermission pins the mode→role mapping: individual (and
// empty/unknown, which default to individual) gets least-privilege `write` —
// enough to push and trigger autograding but not to delete/transfer the repo
// or manage collaborators — while group keeps `admin` so the founder can add
// teammates via `gh student invite`. A regression here either over-privileges
// individual students or silently breaks the group-invite flow.
func TestFounderPermission(t *testing.T) {
	cases := []struct {
		mode string
		want string
	}{
		{"individual", "write"},
		{"", "write"},
		{"team", "write"}, // unknown modes default to individual (least privilege)
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

// TestInviteFounder pins the founder collaborator grant: accept must PUT the
// student as a collaborator at the requested permission. Assert the exact PUT
// path and request body so a regression to a wrong verb/path/role is caught.
func TestInviteFounder(t *testing.T) {
	const (
		org      = "cs50"
		repoName = "cs50-fall-2026-hello-alice"
		username = "alice"
	)
	wantPath := "/repos/" + org + "/" + repoName + "/collaborators/" + username

	for _, permission := range []string{"write", "admin"} {
		t.Run(permission, func(t *testing.T) {
			var gotPath, gotMethod string
			var gotBody map[string]any
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotPath = r.URL.Path
				gotMethod = r.Method
				raw, _ := io.ReadAll(r.Body)
				_ = json.Unmarshal(raw, &gotBody)
				w.WriteHeader(http.StatusNoContent) // 204: added directly
			}))
			t.Cleanup(server.Close)
			client := newTestRESTClient(t, server)

			var out bytes.Buffer
			if err := inviteFounder(client, ui.NewForced(&out, false), false, username, org, repoName, permission); err != nil {
				t.Fatalf("inviteFounder returned error: %v", err)
			}

			if gotMethod != http.MethodPut {
				t.Errorf("method = %q, want PUT", gotMethod)
			}
			if gotPath != wantPath {
				t.Errorf("path = %q, want %q", gotPath, wantPath)
			}
			if perm := gotBody["permission"]; perm != permission {
				t.Errorf("collaborator permission = %v, want %q", perm, permission)
			}
		})
	}
}
