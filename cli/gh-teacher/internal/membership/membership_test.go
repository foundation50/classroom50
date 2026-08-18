package membership

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/gh-teacher/internal/githubtest"
)

// postInvitationsErr drives a POST /orgs/{org}/invitations failure through
// ClassifyOrgInviteError by standing up a server that returns `status` (with
// optional X-OAuth-Scopes + a membership-state handler), then making the call.
func postInvitationsErr(t *testing.T, org, username string, status int, oauthScopes string, membershipState string) error {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/orgs/"+org+"/invitations", func(w http.ResponseWriter, r *http.Request) {
		if oauthScopes != "" {
			w.Header().Set("X-OAuth-Scopes", oauthScopes)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"message":"boom"}`))
	})
	if membershipState != "" {
		mux.HandleFunc("/orgs/"+org+"/memberships/"+username, func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]string{"state": membershipState})
		})
	}
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	// Drive through InviteOrgByID so the real POST → classify path runs.
	return InviteOrgByID(client, org, username, 42, "direct_member")
}

func TestClassifyOrgInviteError(t *testing.T) {
	t.Run("401 → authentication failed", func(t *testing.T) {
		err := postInvitationsErr(t, "o", "alice", http.StatusUnauthorized, "", "")
		if err == nil || !strings.Contains(err.Error(), "authentication failed") {
			t.Fatalf("err = %v, want 'authentication failed'", err)
		}
	})

	t.Run("403 with scopes lacking admin:org → missing-scope sentinel", func(t *testing.T) {
		err := postInvitationsErr(t, "o", "alice", http.StatusForbidden, "repo, read:org", "")
		if !errors.Is(err, ErrMissingOrgAdminScope) {
			t.Fatalf("err = %v, want ErrMissingOrgAdminScope", err)
		}
	})

	t.Run("403 with admin:org present → not-an-admin", func(t *testing.T) {
		err := postInvitationsErr(t, "o", "alice", http.StatusForbidden, "repo, admin:org", "")
		if err == nil || !strings.Contains(err.Error(), "must be an admin of o") {
			t.Fatalf("err = %v, want 'must be an admin'", err)
		}
	})

	t.Run("403 with no scopes header → generic guidance", func(t *testing.T) {
		err := postInvitationsErr(t, "o", "alice", http.StatusForbidden, "", "")
		if err == nil || !strings.Contains(err.Error(), "admin:org scope") {
			t.Fatalf("err = %v, want generic admin:org guidance", err)
		}
	})

	t.Run("404 → org not found", func(t *testing.T) {
		err := postInvitationsErr(t, "o", "alice", http.StatusNotFound, "", "")
		if err == nil || !strings.Contains(err.Error(), "organization not found") {
			t.Fatalf("err = %v, want 'organization not found'", err)
		}
	})

	t.Run("422 + active membership → already-member typed error", func(t *testing.T) {
		err := postInvitationsErr(t, "o", "alice", http.StatusUnprocessableEntity, "", "active")
		var known *OrgMembershipKnownError
		if !errors.As(err, &known) || known.State != "active" {
			t.Fatalf("err = %v, want OrgMembershipKnownError{State:active}", err)
		}
		if !strings.Contains(err.Error(), "already a member") {
			t.Errorf("message = %q, want 'already a member'", err.Error())
		}
	})

	t.Run("422 + pending membership → pending typed error", func(t *testing.T) {
		err := postInvitationsErr(t, "o", "alice", http.StatusUnprocessableEntity, "", "pending")
		var known *OrgMembershipKnownError
		if !errors.As(err, &known) || known.State != "pending" {
			t.Fatalf("err = %v, want OrgMembershipKnownError{State:pending}", err)
		}
		if !strings.Contains(err.Error(), "pending invitation") {
			t.Errorf("message = %q, want 'pending invitation'", err.Error())
		}
	})

	t.Run("422 with unknown membership state → wrapped POST error", func(t *testing.T) {
		// Membership GET returns a state we don't special-case → fall through.
		err := postInvitationsErr(t, "o", "alice", http.StatusUnprocessableEntity, "", "somethingelse")
		if err == nil || !strings.Contains(err.Error(), "POST orgs/o/invitations") {
			t.Fatalf("err = %v, want a wrapped 'POST orgs/o/invitations' error", err)
		}
		var known *OrgMembershipKnownError
		if errors.As(err, &known) {
			t.Errorf("unknown state should not produce OrgMembershipKnownError, got %v", known)
		}
	})

	t.Run("non-HTTP error → wrapped POST error", func(t *testing.T) {
		path := "orgs/o/invitations"
		err := ClassifyOrgInviteError(nil, "o", "alice", path, errors.New("network down"))
		if err == nil || !strings.Contains(err.Error(), "POST orgs/o/invitations") || !strings.Contains(err.Error(), "network down") {
			t.Fatalf("err = %v, want wrapped POST error carrying the cause", err)
		}
	})
}

// inviteByEmailServer stands up POST /orgs/o/invitations returning `status`
// (with optional X-OAuth-Scopes) and fails the test on ANY other route — an
// email invite has no username, so a membership-keyed follow-up would hit
// `/orgs/o/memberships/` and must never be attempted.
func inviteByEmailServer(t *testing.T, status int, oauthScopes string, capture *map[string]any) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/orgs/o/invitations", func(w http.ResponseWriter, r *http.Request) {
		if capture != nil {
			_ = json.NewDecoder(r.Body).Decode(capture)
		}
		if oauthScopes != "" {
			w.Header().Set("X-OAuth-Scopes", oauthScopes)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"id":1}`))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		http.NotFound(w, r)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

func TestInviteOrgByEmail(t *testing.T) {
	t.Run("posts email, direct_member role, and both team ids", func(t *testing.T) {
		var got map[string]any
		server := inviteByEmailServer(t, http.StatusCreated, "", &got)
		client := githubtest.NewTestClient(t, server)

		if err := InviteOrgByEmail(client, "o", "Alice@Example.com", []int64{11, 22}); err != nil {
			t.Fatalf("InviteOrgByEmail: %v", err)
		}
		if got["email"] != "Alice@Example.com" {
			t.Errorf("email = %v, want the address as passed", got["email"])
		}
		if got["role"] != "direct_member" {
			t.Errorf("role = %v, want direct_member", got["role"])
		}
		if _, ok := got["invitee_id"]; ok {
			t.Errorf("body carries invitee_id alongside email: %#v", got)
		}
		teamIDs, ok := got["team_ids"].([]any)
		if !ok || len(teamIDs) != 2 || teamIDs[0] != float64(11) || teamIDs[1] != float64(22) {
			t.Errorf("team_ids = %#v, want [11 22]", got["team_ids"])
		}
	})

	t.Run("omits team_ids when none are given", func(t *testing.T) {
		var got map[string]any
		server := inviteByEmailServer(t, http.StatusCreated, "", &got)
		client := githubtest.NewTestClient(t, server)

		if err := InviteOrgByEmail(client, "o", "alice@example.com", nil); err != nil {
			t.Fatalf("InviteOrgByEmail: %v", err)
		}
		if _, ok := got["team_ids"]; ok {
			t.Errorf("body carries an empty team_ids: %#v", got)
		}
	})

	t.Run("422 → already-invited-or-member sentinel, no username follow-up", func(t *testing.T) {
		// The mux fails the test on any non-/invitations route, so this also
		// pins that ClassifyOrgInviteError's username-keyed 422 lookup is bypassed.
		server := inviteByEmailServer(t, http.StatusUnprocessableEntity, "", nil)
		client := githubtest.NewTestClient(t, server)

		err := InviteOrgByEmail(client, "o", "alice@example.com", nil)
		if !errors.Is(err, ErrEmailAlreadyInvitedOrMember) {
			t.Fatalf("err = %v, want ErrEmailAlreadyInvitedOrMember", err)
		}
		if !strings.Contains(err.Error(), "alice@example.com") {
			t.Errorf("message = %q, want the invited address", err.Error())
		}
	})

	t.Run("other statuses keep the shared invite classification", func(t *testing.T) {
		cases := []struct {
			name   string
			status int
			scopes string
			want   string
		}{
			{"401", http.StatusUnauthorized, "", "authentication failed"},
			{"403 scope missing", http.StatusForbidden, "repo, read:org", "missing admin:org OAuth scope"},
			{"403 not admin", http.StatusForbidden, "repo, admin:org", "must be an admin of o"},
			{"404", http.StatusNotFound, "", "organization not found"},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				server := inviteByEmailServer(t, tc.status, tc.scopes, nil)
				client := githubtest.NewTestClient(t, server)

				err := InviteOrgByEmail(client, "o", "alice@example.com", nil)
				if err == nil || !strings.Contains(err.Error(), tc.want) {
					t.Fatalf("err = %v, want substring %q", err, tc.want)
				}
			})
		}
	})
}

func TestCancelOrgInvitation(t *testing.T) {
	newServer := func(t *testing.T, status int, gotMethod, gotPath *string) *httptest.Server {
		t.Helper()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if gotMethod != nil {
				*gotMethod, *gotPath = r.Method, r.URL.Path
			}
			w.WriteHeader(status)
		}))
		t.Cleanup(server.Close)
		return server
	}

	t.Run("204 → cancelled", func(t *testing.T) {
		var method, path string
		client := githubtest.NewTestClient(t, newServer(t, http.StatusNoContent, &method, &path))
		if err := CancelOrgInvitation(client, "o", 99); err != nil {
			t.Fatalf("CancelOrgInvitation: %v", err)
		}
		if method != http.MethodDelete || path != "/orgs/o/invitations/99" {
			t.Errorf("request = %s %s, want DELETE /orgs/o/invitations/99", method, path)
		}
	})

	t.Run("404 → already-gone sentinel, distinguishable from success", func(t *testing.T) {
		client := githubtest.NewTestClient(t, newServer(t, http.StatusNotFound, nil, nil))
		err := CancelOrgInvitation(client, "o", 99)
		if !errors.Is(err, ErrInvitationAlreadyGone) {
			t.Fatalf("err = %v, want ErrInvitationAlreadyGone", err)
		}
	})

	t.Run("500 → error, and not the already-gone sentinel", func(t *testing.T) {
		client := githubtest.NewTestClient(t, newServer(t, http.StatusInternalServerError, nil, nil))
		err := CancelOrgInvitation(client, "o", 99)
		if err == nil {
			t.Fatal("err = nil, want a non-nil error for a 5xx")
		}
		if errors.Is(err, ErrInvitationAlreadyGone) {
			t.Errorf("err = %v, must not read as already-gone", err)
		}
	})
}

func TestListPendingOrgInvitations(t *testing.T) {
	t.Run("surfaces email for email invitations and login for id ones", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get("page") != "1" {
				_, _ = w.Write([]byte(`[]`))
				return
			}
			_, _ = w.Write([]byte(`[
				{"id":1,"login":"alice","email":null,"role":"direct_member"},
				{"id":2,"login":null,"email":"bob@example.com","role":"direct_member"}
			]`))
		}))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		invites, err := ListPendingOrgInvitations(client, "o")
		if err != nil {
			t.Fatalf("ListPendingOrgInvitations: %v", err)
		}
		if len(invites) != 2 {
			t.Fatalf("got %d invitations, want 2: %#v", len(invites), invites)
		}
		if invites[0].Login != "alice" || invites[0].Email != "" || invites[0].ID != 1 {
			t.Errorf("invites[0] = %#v, want the login-keyed invitation", invites[0])
		}
		if invites[1].Email != "bob@example.com" || invites[1].Login != "" || invites[1].ID != 2 {
			t.Errorf("invites[1] = %#v, want the email-keyed invitation", invites[1])
		}
		if invites[1].Role != "direct_member" {
			t.Errorf("role = %q, want the raw API role (normalization is the caller's)", invites[1].Role)
		}
	})

	t.Run("paginates past the first page", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			page := 1
			if v := r.URL.Query().Get("page"); v != "" {
				_, _ = fmt.Sscanf(v, "%d", &page)
			}
			var batch []map[string]any
			for i := (page-1)*100 + 1; i <= 120 && i <= page*100; i++ {
				batch = append(batch, map[string]any{
					"id": i, "email": fmt.Sprintf("s%03d@example.com", i), "role": "direct_member",
				})
			}
			if batch == nil {
				batch = []map[string]any{}
			}
			_ = json.NewEncoder(w).Encode(batch)
		}))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		invites, err := ListPendingOrgInvitations(client, "o")
		if err != nil {
			t.Fatalf("ListPendingOrgInvitations: %v", err)
		}
		if len(invites) != 120 {
			t.Errorf("got %d invitations, want 120 (pagination across 2 pages)", len(invites))
		}
	})

	t.Run("403 without admin:org is a hard error, not an empty list", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("X-OAuth-Scopes", "repo, read:org")
			http.Error(w, "forbidden", http.StatusForbidden)
		}))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		_, err := ListPendingOrgInvitations(client, "o")
		if !errors.Is(err, ErrMissingOrgAdminScope) {
			t.Fatalf("err = %v, want ErrMissingOrgAdminScope", err)
		}
	})
}

func TestPendingOrgInvitationIsEmailKeyed(t *testing.T) {
	cases := []struct {
		name string
		inv  PendingOrgInvitation
		want bool
	}{
		{"email only", PendingOrgInvitation{ID: 1, Email: "ada@uni.edu"}, true},
		{"login only", PendingOrgInvitation{ID: 2, Login: "ada"}, false},
		// GitHub keys by one or the other; a payload carrying both is not an
		// address-keyed invitation and must not be cancelled as one.
		{"both", PendingOrgInvitation{ID: 3, Login: "ada", Email: "ada@uni.edu"}, false},
		{"neither", PendingOrgInvitation{ID: 4}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.inv.IsEmailKeyed(); got != tc.want {
				t.Errorf("IsEmailKeyed() = %v, want %v for %#v", got, tc.want, tc.inv)
			}
		})
	}
}

func TestListInvitationTeams(t *testing.T) {
	t.Run("returns the teams the invitation carries", func(t *testing.T) {
		var gotPath string
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotPath = r.URL.Path
			if r.URL.Query().Get("page") != "1" {
				_, _ = w.Write([]byte(`[]`))
				return
			}
			_, _ = w.Write([]byte(`[
				{"id":5,"slug":"classroom50-cs-principles"},
				{"id":7,"slug":"invite-abc123"}
			]`))
		}))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		teams, err := ListInvitationTeams(client, "o", 42)
		if err != nil {
			t.Fatalf("ListInvitationTeams: %v", err)
		}
		if gotPath != "/orgs/o/invitations/42/teams" {
			t.Errorf("path = %q, want /orgs/o/invitations/42/teams", gotPath)
		}
		if len(teams) != 2 || teams[0].Slug != "classroom50-cs-principles" || teams[1].ID != 7 {
			t.Errorf("teams = %#v, want both the classroom and invite teams", teams)
		}
	})

	t.Run("paginates past the first page", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			page := 1
			if v := r.URL.Query().Get("page"); v != "" {
				_, _ = fmt.Sscanf(v, "%d", &page)
			}
			var batch []map[string]any
			for i := (page-1)*100 + 1; i <= 105 && i <= page*100; i++ {
				batch = append(batch, map[string]any{"id": i, "slug": fmt.Sprintf("t%03d", i)})
			}
			if batch == nil {
				batch = []map[string]any{}
			}
			_ = json.NewEncoder(w).Encode(batch)
		}))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		teams, err := ListInvitationTeams(client, "o", 42)
		if err != nil {
			t.Fatalf("ListInvitationTeams: %v", err)
		}
		if len(teams) != 105 {
			t.Errorf("got %d teams, want 105 (pagination across 2 pages)", len(teams))
		}
	})

	// A caller uses this list to authorize a DELETE, so a degraded read must be
	// an error: an empty set would read as "another classroom's invitation".
	t.Run("failures are errors, never an empty set", func(t *testing.T) {
		cases := []struct {
			name   string
			status int
			scopes string
			want   string
		}{
			{"403 scope missing", http.StatusForbidden, "repo, read:org", "missing admin:org OAuth scope"},
			{"404", http.StatusNotFound, "", "not found or not accessible"},
			{"500", http.StatusInternalServerError, "", "GET orgs/o/invitations/42/teams"},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					if tc.scopes != "" {
						w.Header().Set("X-OAuth-Scopes", tc.scopes)
					}
					http.Error(w, "boom", tc.status)
				}))
				t.Cleanup(server.Close)
				client := githubtest.NewTestClient(t, server)

				teams, err := ListInvitationTeams(client, "o", 42)
				if err == nil {
					t.Fatalf("err = nil (teams = %#v), want a hard failure", teams)
				}
				if !strings.Contains(err.Error(), tc.want) {
					t.Errorf("err = %v, want substring %q", err, tc.want)
				}
			})
		}
	})
}

func TestLookupUser(t *testing.T) {
	t.Run("success returns login + id", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/users/alice", func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"login": "alice", "id": 7})
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		login, id, err := LookupUser(client, "alice")
		if err != nil || login != "alice" || id != 7 {
			t.Fatalf("LookupUser = (%q, %d, %v), want (alice, 7, nil)", login, id, err)
		}
	})

	t.Run("404 → friendly not-found", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/users/ghost", func(w http.ResponseWriter, r *http.Request) {
			http.NotFound(w, r)
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		_, _, err := LookupUser(client, "ghost")
		if err == nil || !strings.Contains(err.Error(), `GitHub user "ghost" not found`) {
			t.Fatalf("err = %v, want a 'GitHub user not found' message", err)
		}
	})
}

// TestInviteOrgByID_KnownErrorIsRecoverable pins the cross-package contract
// that internal/roster's inviteIfNotMember depends on: when InviteOrgByID hits a
// 422 for an already-active/pending user, it returns an error that callers
// in OTHER packages can recover via errors.As into *OrgMembershipKnownError
// and read the exported State field from. The .state -> exported .State
// rename in this slice is exactly what makes that read compile across the
// boundary; this test fails if the field is ever unexported again or the
// 422 path stops producing the typed error.
func TestInviteOrgByID_KnownErrorIsRecoverable(t *testing.T) {
	for _, tc := range []struct {
		name      string
		wantState string
	}{
		{"active", "active"},
		{"pending", "pending"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := postInvitationsErr(t, "o", "alice", http.StatusUnprocessableEntity, "", tc.wantState)
			var known *OrgMembershipKnownError
			if !errors.As(err, &known) {
				t.Fatalf("errors.As did not recover *OrgMembershipKnownError from %v", err)
			}
			// The exported field is what a different package (internal/roster) reads.
			if known.State != tc.wantState {
				t.Errorf("known.State = %q, want %q", known.State, tc.wantState)
			}
		})
	}
}
