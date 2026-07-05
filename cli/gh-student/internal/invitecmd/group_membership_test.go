package invitecmd

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/foundation50/gh-student/internal/classroomcfg"
	"github.com/foundation50/gh-student/internal/githubtest"
	"github.com/foundation50/gh-student/internal/reponame"
)

func TestGroupRepoOwner(t *testing.T) {
	cfg := &classroomcfg.Config{Classroom: "cs-principles", Assignment: "project1"}
	cases := []struct {
		repo string
		want string
	}{
		{"cs-principles-project1-alice", "alice"},
		{"CS-Principles-Project1-Alice", "alice"}, // lowercased
		{"cs-principles-project1-bob-jones", "bob-jones"},
		{"unrelated-repo", ""}, // no matching prefix
	}
	for _, tc := range cases {
		if got := groupRepoOwner(tc.repo, cfg); got != tc.want {
			t.Errorf("groupRepoOwner(%q) = %q, want %q", tc.repo, got, tc.want)
		}
	}
}

// TestGroupRepoOwnerRoundTripsAssignmentRepoName pins the producer
// (reponame.Name) and consumer (groupRepoOwner) to the same
// `<classroom>-<assignment>-<owner>` shape. Both derive from reponame.Prefix,
// so a future separator/casing change can't drift one side into silently
// returning "" (which would disable the cap).
func TestGroupRepoOwnerRoundTripsAssignmentRepoName(t *testing.T) {
	cases := []struct {
		classroom, assignment, owner string
	}{
		{"cs-principles", "project1", "alice"},
		{"CS-Principles", "Project1", "Bob-Jones"},
		{"cs50", "hello", "cs50-duck"},
	}
	for _, tc := range cases {
		cfg := &classroomcfg.Config{Classroom: tc.classroom, Assignment: tc.assignment}
		repo := reponame.Name(tc.classroom, tc.assignment, tc.owner)
		if got, want := groupRepoOwner(repo, cfg), strings.ToLower(tc.owner); got != want {
			t.Errorf("groupRepoOwner(reponame.Name(%q,%q,%q)=%q) = %q, want %q",
				tc.classroom, tc.assignment, tc.owner, repo, got, want)
		}
	}
}

func TestListGroupMemberLogins_KeepsFounderExcludesOtherAdmins(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/cs-hw-alice/collaborators", func(w http.ResponseWriter, r *http.Request) {
		// teacher = admin (excluded), alice = admin (founder, kept),
		// bob = push (kept).
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"login": "teacher", "role_name": "admin"},
			{"login": "alice", "role_name": "admin"},
			{"login": "bob", "role_name": "push"},
		})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	got, err := listGroupMemberLogins(context.Background(), client, "o", "cs-hw-alice", "alice")
	if err != nil {
		t.Fatalf("listGroupMemberLogins: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d members %v, want 2 (founder kept, non-founder admin excluded)", len(got), got)
	}
	var sawAlice, sawTeacher bool
	for _, l := range got {
		sawAlice = sawAlice || strings.EqualFold(l, "alice")
		sawTeacher = sawTeacher || strings.EqualFold(l, "teacher")
	}
	if !sawAlice {
		t.Errorf("founder 'alice' must be kept: %v", got)
	}
	if sawTeacher {
		t.Errorf("non-founder admin 'teacher' must be excluded: %v", got)
	}
}

// TestListGroupMemberLogins_FollowsLinkHeader exercises the authoritative
// Link-following branch: page 1 advertises `rel="next"` (a cursor URL), page 2
// omits it. The handler ignores the `page` query and dispatches on the cursor,
// so the walk must have followed the server-supplied Link, not a synthesized
// page number.
func TestListGroupMemberLogins_FollowsLinkHeader(t *testing.T) {
	var server *httptest.Server
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/cs-hw-alice/collaborators", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("cursor") == "two" {
			// Final page, no Link rel=next → loop must stop.
			_ = json.NewEncoder(w).Encode([]map[string]any{{"login": "bob", "role_name": "push"}})
			return
		}
		// Page 1: advertise the next page via Link (cursor-based). The proof
		// is that the walk reached page 2 via the cursor URL (the handler
		// errors on an unexpected path); FullPageNoNextLinkStops proves Link
		// beats the length heuristic.
		w.Header().Set("Link", `<`+server.URL+`/repos/o/cs-hw-alice/collaborators?cursor=two>; rel="next"`)
		_ = json.NewEncoder(w).Encode([]map[string]any{{"login": "alice", "role_name": "admin"}})
	})
	server = httptest.NewServer(mux)
	t.Cleanup(server.Close)

	got, err := listGroupMemberLogins(context.Background(), githubtest.NewTestClient(t, server), "o", "cs-hw-alice", "alice")
	if err != nil {
		t.Fatalf("listGroupMemberLogins: %v", err)
	}
	// alice (founder admin, kept) + bob (push) across the two Link-chained pages.
	if len(got) != 2 {
		t.Fatalf("got %d members %v, want 2 (Link-driven page 1 + page 2)", len(got), got)
	}
	var sawAlice, sawBob bool
	for _, l := range got {
		sawAlice = sawAlice || l == "alice"
		sawBob = sawBob || l == "bob"
	}
	if !sawAlice || !sawBob {
		t.Errorf("expected both pages merged (alice + bob), got %v", got)
	}
}

// TestListGroupMemberLogins_FullPageNoNextLinkStops asserts a full page
// carrying a Link header WITHOUT rel=next (the last page) terminates the walk
// in one request, rather than the len==perPage short-page heuristic forcing an
// extra fetch. Proves Link is authoritative over page length.
func TestListGroupMemberLogins_FullPageNoNextLinkStops(t *testing.T) {
	const perPage = 100
	var requests int
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/cs-hw-alice/collaborators", func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("Link", `<https://api.github.com/repos/o/cs-hw-alice/collaborators?page=1>; rel="prev"`)
		batch := make([]map[string]any, 0, perPage)
		for i := 0; i < perPage; i++ {
			batch = append(batch, map[string]any{"login": "m" + strconv.Itoa(i), "role_name": "push"})
		}
		_ = json.NewEncoder(w).Encode(batch)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	got, err := listGroupMemberLogins(context.Background(), githubtest.NewTestClient(t, server), "o", "cs-hw-alice", "alice")
	if err != nil {
		t.Fatalf("listGroupMemberLogins: %v", err)
	}
	if len(got) != perPage {
		t.Fatalf("got %d members, want %d from the single (last) page", len(got), perPage)
	}
	if requests != 1 {
		t.Errorf("made %d requests, want 1 — a Link without rel=next must stop the walk", requests)
	}
}

func TestCheckGroupSizeBeforeInvite(t *testing.T) {
	// Repo with 2 student members (alice founder + bob); teacher admin excluded.
	server := func() *httptest.Server {
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/o/cs-hw-alice/collaborators", func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"login": "teacher", "role_name": "admin"},
				{"login": "alice", "role_name": "admin"},
				{"login": "bob", "role_name": "push"},
			})
		})
		return httptest.NewServer(mux)
	}

	t.Run("allows a new member when under the cap", func(t *testing.T) {
		s := server()
		t.Cleanup(s.Close)
		// 2 members, max 3 → adding carol is fine.
		if err := checkGroupSizeBeforeInvite(context.Background(), githubtest.NewTestClient(t, s), "o", "cs-hw-alice", "alice", "carol", 3); err != nil {
			t.Errorf("expected carol to be allowed (2 < 3), got %v", err)
		}
	})

	t.Run("refuses a new member at the cap", func(t *testing.T) {
		s := server()
		t.Cleanup(s.Close)
		// 2 members, max 2 → adding carol is refused.
		err := checkGroupSizeBeforeInvite(context.Background(), githubtest.NewTestClient(t, s), "o", "cs-hw-alice", "alice", "carol", 2)
		if err == nil || !strings.Contains(err.Error(), "group is full") {
			t.Fatalf("expected 'group is full' error at the cap, got %v", err)
		}
	})

	t.Run("re-inviting an existing member is never blocked", func(t *testing.T) {
		s := server()
		t.Cleanup(s.Close)
		// At the cap (2/2) but bob is already a member → no-op, allowed.
		if err := checkGroupSizeBeforeInvite(context.Background(), githubtest.NewTestClient(t, s), "o", "cs-hw-alice", "alice", "bob", 2); err != nil {
			t.Errorf("re-inviting existing member 'bob' must not be blocked, got %v", err)
		}
	})

	t.Run("max <= 0 means no limit", func(t *testing.T) {
		s := server()
		t.Cleanup(s.Close)
		// maxGroupSize 0 → no enforcement, no API call needed, allowed.
		if err := checkGroupSizeBeforeInvite(context.Background(), githubtest.NewTestClient(t, s), "o", "cs-hw-alice", "alice", "carol", 0); err != nil {
			t.Errorf("max<=0 should impose no limit, got %v", err)
		}
	})
}

// TestListGroupMemberLogins_Pagination exercises the multi-page walk: a first
// page of exactly perPage (100) entries forces a second-page fetch, and both
// must be merged. A mock that only ever returns a short batch never exercises
// this, so a broken continuation that undercounts members — wrongly letting an
// invite past the cap — would otherwise pass silently.
func TestListGroupMemberLogins_Pagination(t *testing.T) {
	const perPage = 100
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/cs-hw-alice/collaborators", func(w http.ResponseWriter, r *http.Request) {
		page := r.URL.Query().Get("page")
		var batch []map[string]any
		switch page {
		case "1":
			// A full page → the loop must fetch page 2.
			for i := 0; i < perPage; i++ {
				batch = append(batch, map[string]any{
					"login":     "member" + strconv.Itoa(i),
					"role_name": "push",
				})
			}
		case "2":
			// Short final page → loop terminates.
			batch = []map[string]any{{"login": "lastone", "role_name": "push"}}
		default:
			t.Errorf("unexpected page %q (loop should stop after the short page 2)", page)
		}
		_ = json.NewEncoder(w).Encode(batch)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	got, err := listGroupMemberLogins(context.Background(), githubtest.NewTestClient(t, server), "o", "cs-hw-alice", "alice")
	if err != nil {
		t.Fatalf("listGroupMemberLogins: %v", err)
	}
	if len(got) != perPage+1 {
		t.Fatalf("got %d members, want %d (both pages merged)", len(got), perPage+1)
	}
	if got[len(got)-1] != "lastone" {
		t.Errorf("page 2 not merged: last login = %q, want \"lastone\"", got[len(got)-1])
	}
}

// TestListGroupMemberLogins_PageCap asserts the enumeration fails closed (no
// partial count) when every page stays full past the 100-page cap, rather than
// silently returning a truncated member list.
func TestListGroupMemberLogins_PageCap(t *testing.T) {
	const perPage = 100
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/cs-hw-alice/collaborators", func(w http.ResponseWriter, r *http.Request) {
		// Always return a full page → the loop never sees a short batch
		// and must hit the maxPages cap.
		batch := make([]map[string]any, 0, perPage)
		for i := 0; i < perPage; i++ {
			batch = append(batch, map[string]any{"login": "m" + strconv.Itoa(i), "role_name": "push"})
		}
		_ = json.NewEncoder(w).Encode(batch)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	got, err := listGroupMemberLogins(context.Background(), githubtest.NewTestClient(t, server), "o", "cs-hw-alice", "alice")
	if err == nil || !strings.Contains(err.Error(), "page cap") {
		t.Fatalf("expected a 'page cap' error when pages never end, got logins=%v err=%v", got, err)
	}
	if got != nil {
		t.Errorf("expected nil logins on the cap error (no partial count), got %v", got)
	}
}
