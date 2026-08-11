package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/gh-student/internal/assignments"
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

// TestAssertAssignmentAcceptable pins the pre-generate access gates: an open
// assignment is accepted; a closed assignment refuses a NEW submission with a
// distinct message; and locked takes precedence over closed when both are set.
func TestAssertAssignmentAcceptable(t *testing.T) {
	cases := []struct {
		name       string
		entry      assignments.Entry
		wantErr    bool
		wantSubstr string
	}{
		{"open", assignments.Entry{}, false, ""},
		{
			"closed refuses a new submission",
			assignments.Entry{Closed: true},
			true,
			"closed to new submissions",
		},
		{
			"locked refuses accept",
			assignments.Entry{Locked: true},
			true,
			"locked by your teacher",
		},
		{
			"locked takes precedence over closed",
			assignments.Entry{Locked: true, Closed: true},
			true,
			"locked by your teacher",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := assertAssignmentAcceptable(tc.entry, "hello")
			if tc.wantErr && err == nil {
				t.Fatalf("expected an error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error %v", err)
			}
			if tc.wantErr && !strings.Contains(err.Error(), tc.wantSubstr) {
				t.Errorf("error %q missing substring %q", err.Error(), tc.wantSubstr)
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

// TestFounderPermission pins the mode+config→role mapping: with no configured
// student_permission, individual (and empty/unknown, which default to
// individual) gets least-privilege `push`, group gets `admin`. A configured
// value wins for individual; a group value below admin is clamped up to admin
// so the founder can add teammates via `gh student invite`.
func TestFounderPermission(t *testing.T) {
	cases := []struct {
		name              string
		mode              string
		studentPermission string
		want              string
	}{
		{"individual default", "individual", "", "push"},
		{"empty mode default", "", "", "push"},
		{"unknown mode default", "team", "", "push"}, // defaults to individual (least privilege)
		{"group default", "group", "", "admin"},
		{"individual configured admin", "individual", "admin", "admin"},
		{"individual configured pull", "individual", "pull", "pull"},
		{"individual configured maintain", "individual", "maintain", "maintain"},
		{"group clamps push up to admin", "group", "push", "admin"},
		{"group clamps pull up to admin", "group", "pull", "admin"},
		{"group configured admin", "group", "admin", "admin"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := founderPermission(tc.mode, tc.studentPermission); got != tc.want {
				t.Errorf("founderPermission(%q,%q) = %q, want %q", tc.mode, tc.studentPermission, got, tc.want)
			}
		})
	}
}

// TestInviteFounder pins the grant: accept PUTs the student at the requested
// role and trusts the PUT (no read-back — the self-downgrade read-back races an
// unbounded consistency window; the guard lives on the teacher write paths).
// Asserts the exact PUT path/body and that no permission read-back is made.
func TestInviteFounder(t *testing.T) {
	const (
		org      = "cs50"
		repoName = "cs50-fall-2026-hello-alice"
		username = "alice"
	)
	collabPath := "/repos/" + org + "/" + repoName + "/collaborators/" + username
	permPath := collabPath + "/permission"

	for _, want := range []string{"push", "admin", "pull"} {
		t.Run(want, func(t *testing.T) {
			var gotPutPath, gotMethod string
			var gotBody map[string]any
			var readBack bool
			mux := http.NewServeMux()
			mux.HandleFunc(permPath, func(w http.ResponseWriter, _ *http.Request) {
				readBack = true
				w.WriteHeader(http.StatusNotFound)
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
			if err := inviteFounder(client, ui.NewForced(&out, false), false, username, org, repoName, want); err != nil {
				t.Fatalf("inviteFounder returned error: %v", err)
			}

			if gotMethod != http.MethodPut {
				t.Errorf("method = %q, want PUT", gotMethod)
			}
			if gotPutPath != collabPath {
				t.Errorf("path = %q, want %q", gotPutPath, collabPath)
			}
			if perm := gotBody["permission"]; perm != want {
				t.Errorf("collaborator permission = %v, want %q", perm, want)
			}
			if readBack {
				t.Errorf("inviteFounder must not read the effective permission back (it races an unbounded window)")
			}
		})
	}
}

// TestInviteFounder_PropagatesGrantError proves a genuine grant failure (not a
// read-back) still surfaces: the PUT itself erroring must return an error.
func TestInviteFounder_PropagatesGrantError(t *testing.T) {
	const (
		org      = "cs50"
		repoName = "cs50-fall-2026-hello-alice"
		username = "alice"
	)
	collabPath := "/repos/" + org + "/" + repoName + "/collaborators/" + username

	mux := http.NewServeMux()
	mux.HandleFunc(collabPath, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound) // e.g. not an org member
		_ = json.NewEncoder(w).Encode(map[string]any{"message": "Not Found"})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := newTestRESTClient(t, server)

	var out bytes.Buffer
	if err := inviteFounder(client, ui.NewForced(&out, false), false, username, org, repoName, "push"); err == nil {
		t.Fatalf("expected an error when the collaborator PUT fails, got nil")
	}
}

// TestAssertEnrolledOrStaff pins the classroom-enrollment accept gate: a
// student-team member or any staff-team member passes; an active org member on
// no classroom team is rejected with a roster remedy; a transient (non-404)
// read fails OPEN by propagating the error rather than falsely blocking.
func TestAssertEnrolledOrStaff(t *testing.T) {
	const (
		org       = "cs50"
		classroom = "cs-fall"
		user      = "alice"
	)
	studentSlug := "classroom50-" + classroom
	taSlug := "classroom50-" + classroom + "-ta"

	cases := []struct {
		name           string
		activeMembers  map[string]bool
		transientTeams map[string]bool
		wantErr        bool
	}{
		{"student-team member enrolled", map[string]bool{studentSlug: true}, nil, false},
		{"ta staff member enrolled", map[string]bool{taSlug: true}, nil, false},
		{"active member on no team rejected", map[string]bool{}, nil, true},
		{"transient read fails open (propagates)", map[string]bool{}, map[string]bool{studentSlug: true}, true},
		// Student-team match must short-circuit BEFORE a later staff-team probe
		// can error, so an enrolled student is never blocked by an unrelated blip.
		{"student member short-circuits past a transient staff probe", map[string]bool{studentSlug: true}, map[string]bool{taSlug: true}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mux := http.NewServeMux()
			mux.HandleFunc("/orgs/"+org+"/teams/", func(w http.ResponseWriter, r *http.Request) {
				parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/orgs/"+org+"/teams/"), "/memberships/")
				slug := parts[0]
				switch {
				case tc.transientTeams[slug]:
					w.WriteHeader(http.StatusInternalServerError)
					_, _ = w.Write([]byte(`{}`))
				case tc.activeMembers[slug]:
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write([]byte(`{"state":"active"}`))
				default:
					w.WriteHeader(http.StatusNotFound)
					_, _ = w.Write([]byte(`{}`))
				}
			})
			server := httptest.NewServer(mux)
			t.Cleanup(server.Close)
			client := newTestRESTClient(t, server)

			err := assertEnrolledOrStaff(client, org, classroom, user)
			if tc.wantErr && err == nil {
				t.Errorf("expected an error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Errorf("unexpected error: %v", err)
			}
		})
	}
}
