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

// TestInviteUserAsAdmin pins the founder-admin grant: accept must keep the
// student as an `admin` collaborator (not the old `maintain`), because only an
// admin can manage collaborators for the founder-driven group-invite flow. A
// regression to a weaker permission silently breaks `gh student invite`, so
// assert the exact PUT path and request body.
func TestInviteUserAsAdmin(t *testing.T) {
	const (
		org      = "cs50"
		repoName = "cs50-fall-2026-hello-alice"
		username = "alice"
	)
	wantPath := "/repos/" + org + "/" + repoName + "/collaborators/" + username

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
	if err := inviteUserAsAdmin(client, ui.NewForced(&out, false), false, username, org, repoName); err != nil {
		t.Fatalf("inviteUserAsAdmin returned error: %v", err)
	}

	if gotMethod != http.MethodPut {
		t.Errorf("method = %q, want PUT", gotMethod)
	}
	if gotPath != wantPath {
		t.Errorf("path = %q, want %q", gotPath, wantPath)
	}
	if perm := gotBody["permission"]; perm != "admin" {
		t.Errorf("collaborator permission = %v, want \"admin\" (regression to maintain/push breaks gh student invite)", perm)
	}
}
