package configrepo

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/githubtest"
)

const (
	testGroupOrg        = "acme"
	testGroupClassroom  = "cs101"
	testGroupAssignment = "project"
)

func groupSlug(t *testing.T, n int) string {
	t.Helper()
	return contract.GroupTeamName(testGroupClassroom, testGroupAssignment, n)
}

func groupRecord(t *testing.T, name string) string {
	t.Helper()
	record, err := MarshalGroupDescription(testGroupClassroom, testGroupAssignment, name)
	if err != nil {
		t.Fatalf("MarshalGroupDescription: %v", err)
	}
	return record
}

// groupTeamServer serves the org-teams listing plus a scripted create: the
// first `collide` POSTs 422 (name taken), then the create succeeds echoing
// the requested name. Existing teams appear in the listing.
func groupTeamServer(t *testing.T, existing []map[string]any, collide int) (*httptest.Server, *[]map[string]any) {
	t.Helper()
	posts := &[]map[string]any{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/orgs/"+testGroupOrg+"/teams" && r.Method == http.MethodGet:
			if r.URL.Query().Get("page") != "1" {
				_, _ = w.Write([]byte(`[]`))
				return
			}
			_ = json.NewEncoder(w).Encode(existing)
		case r.URL.Path == "/orgs/"+testGroupOrg+"/teams" && r.Method == http.MethodPost:
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			*posts = append(*posts, body)
			if len(*posts) <= collide {
				w.WriteHeader(http.StatusUnprocessableEntity)
				_, _ = w.Write([]byte(`{"message":"Name must be unique for this org"}`))
				return
			}
			name, _ := body["name"].(string)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": 900 + len(*posts), "slug": name})
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server, posts
}

// A fresh assignment allocates counter 1 and creates a SECRET,
// notifications-disabled team carrying the v1 record.
func TestCreateGroupTeam_FirstCounter(t *testing.T) {
	server, posts := groupTeamServer(t, nil, 0)
	client := githubtest.NewTestClient(t, server)

	slug, id, n, err := CreateGroupTeam(client, testGroupOrg, testGroupClassroom, testGroupAssignment, "The Sharks", []string{"ms-frizzle"}, contract.TeamFormationTeacher)
	if err != nil {
		t.Fatalf("CreateGroupTeam: %v", err)
	}
	if slug != groupSlug(t, 1) || n != 1 || id == 0 {
		t.Errorf("got (%q, %d, %d), want (%q, >0, 1)", slug, id, n, groupSlug(t, 1))
	}
	if len(*posts) != 1 {
		t.Fatalf("POSTs = %d, want 1", len(*posts))
	}
	body := (*posts)[0]
	if body["privacy"] != "secret" {
		t.Errorf("privacy = %v, want secret", body["privacy"])
	}
	if body["notification_setting"] != notificationsDisabled {
		t.Errorf("notification_setting = %v, want %s", body["notification_setting"], notificationsDisabled)
	}
	if body["description"] != groupRecord(t, "The Sharks") {
		t.Errorf("description = %v, want the v1 record", body["description"])
	}
	if maintainers, _ := body["maintainers"].([]any); len(maintainers) != 1 || maintainers[0] != "ms-frizzle" {
		t.Errorf("maintainers = %v, want [ms-frizzle]", body["maintainers"])
	}
}

// The listing seeds the lowest FREE counter (a deleted team's gap is reused),
// and a 422 (an invisible secret team won the counter) retries with the next.
func TestCreateGroupTeam_SkipsTakenAndRetriesOn422(t *testing.T) {
	existing := []map[string]any{
		{"id": 1, "slug": groupSlug(t, 1), "description": groupRecord(t, "")},
		{"id": 3, "slug": groupSlug(t, 3), "description": groupRecord(t, "")},
	}
	// Counter 2 looks free but 422s (someone else's secret team owns it).
	server, posts := groupTeamServer(t, existing, 1)
	client := githubtest.NewTestClient(t, server)

	slug, _, n, err := CreateGroupTeam(client, testGroupOrg, testGroupClassroom, testGroupAssignment, "", nil, contract.TeamFormationTeacher)
	if err != nil {
		t.Fatalf("CreateGroupTeam: %v", err)
	}
	if n != 4 || slug != groupSlug(t, 4) {
		t.Errorf("got counter %d (%q), want 4 (2 collided, 3 taken)", n, slug)
	}
	if got := (*posts)[0]["name"]; got != groupSlug(t, 2) {
		t.Errorf("first attempt = %v, want the lowest free counter %q", got, groupSlug(t, 2))
	}
	if got := (*posts)[1]["name"]; got != groupSlug(t, 4) {
		t.Errorf("retry = %v, want %q (3 was already taken in the listing)", got, groupSlug(t, 4))
	}
}

// Exhausting the retry budget fails with an actionable error, never an
// infinite loop.
func TestCreateGroupTeam_BoundedRetries(t *testing.T) {
	server, posts := groupTeamServer(t, nil, 1_000_000)
	client := githubtest.NewTestClient(t, server)

	_, _, _, err := CreateGroupTeam(client, testGroupOrg, testGroupClassroom, testGroupAssignment, "", nil, contract.TeamFormationTeacher)
	if err == nil || !strings.Contains(err.Error(), "could not allocate a group team counter") {
		t.Fatalf("err = %v, want the bounded-allocation failure", err)
	}
	if len(*posts) != 50 {
		t.Errorf("POST attempts = %d, want exactly the 50-counter bound", len(*posts))
	}
}

// ListAssignmentGroupTeams keeps only verified teams: wrong-prefix, human,
// record-less, and forged-record teams are all skipped.
func TestListAssignmentGroupTeams(t *testing.T) {
	otherPrefix := contract.GroupTeamName(testGroupClassroom, "other", 1)
	forged, err := MarshalGroupDescription(testGroupClassroom, "other", "")
	if err != nil {
		t.Fatal(err)
	}
	teams := []map[string]any{
		{"id": 11, "slug": groupSlug(t, 1), "description": groupRecord(t, "Alpha")},
		{"id": 12, "slug": groupSlug(t, 2), "description": "hand-edited"},
		{"id": 13, "slug": groupSlug(t, 3), "description": forged}, // record for another assignment
		{"id": 14, "slug": otherPrefix, "description": forged},     // another assignment's team
		{"id": 15, "slug": "classroom50-group-theory", "description": groupRecord(t, "")},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/orgs/"+testGroupOrg+"/teams" && r.Method == http.MethodGet:
			if r.URL.Query().Get("page") != "1" {
				_, _ = w.Write([]byte(`[]`))
				return
			}
			_ = json.NewEncoder(w).Encode(teams)
		case strings.HasSuffix(r.URL.Path, "/members") && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode([]map[string]any{{"login": "alice", "id": 1}, {"login": "bob", "id": 2}})
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	got, err := ListAssignmentGroupTeams(githubtest.NewTestClient(t, server), testGroupOrg, testGroupClassroom, testGroupAssignment)
	if err != nil {
		t.Fatalf("ListAssignmentGroupTeams: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("teams = %+v, want only the verified counter-1 team", got)
	}
	team := got[0]
	if team.Counter != 1 || team.ID != 11 || team.Record.Name != "Alpha" {
		t.Errorf("team = %+v, want counter 1 / id 11 / name Alpha", team)
	}
	if len(team.Members) != 2 || team.Members[0] != "alice" {
		t.Errorf("members = %v, want [alice bob]", team.Members)
	}
}

// DeleteGroupTeam is fail-closed on every guard, and 404 = already gone.
func TestDeleteGroupTeam(t *testing.T) {
	slug := groupSlug(t, 1)

	serve := func(t *testing.T, live map[string]any) (*httptest.Server, *[]string) {
		t.Helper()
		deleted := &[]string{}
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodGet:
				if live == nil {
					http.NotFound(w, r)
					return
				}
				_ = json.NewEncoder(w).Encode(live)
			case http.MethodDelete:
				*deleted = append(*deleted, strings.TrimPrefix(r.URL.Path, "/orgs/"+testGroupOrg+"/teams/"))
				w.WriteHeader(http.StatusNoContent)
			}
		}))
		t.Cleanup(server.Close)
		return server, deleted
	}

	t.Run("verified team deletes", func(t *testing.T) {
		server, deleted := serve(t, map[string]any{"id": 7, "slug": slug, "description": groupRecord(t, "")})
		if err := DeleteGroupTeam(githubtest.NewTestClient(t, server), testGroupOrg, slug, 7); err != nil {
			t.Fatalf("DeleteGroupTeam: %v", err)
		}
		if len(*deleted) != 1 || (*deleted)[0] != slug {
			t.Errorf("deleted = %v, want [%s]", *deleted, slug)
		}
	})

	t.Run("404 is already-gone success", func(t *testing.T) {
		server, deleted := serve(t, nil)
		if err := DeleteGroupTeam(githubtest.NewTestClient(t, server), testGroupOrg, slug, 7); err != nil {
			t.Fatalf("DeleteGroupTeam on a gone team: %v", err)
		}
		if len(*deleted) != 0 {
			t.Errorf("deleted = %v, want none", *deleted)
		}
	})

	t.Run("id mismatch refuses (reused slug)", func(t *testing.T) {
		server, deleted := serve(t, map[string]any{"id": 99, "slug": slug, "description": groupRecord(t, "")})
		err := DeleteGroupTeam(githubtest.NewTestClient(t, server), testGroupOrg, slug, 7)
		if err == nil || !strings.Contains(err.Error(), "refusing to delete") {
			t.Fatalf("err = %v, want the id-mismatch refusal", err)
		}
		if len(*deleted) != 0 {
			t.Errorf("deleted = %v despite the id mismatch", *deleted)
		}
	})

	t.Run("unverifiable record refuses", func(t *testing.T) {
		server, deleted := serve(t, map[string]any{"id": 7, "slug": slug, "description": "hand-edited"})
		err := DeleteGroupTeam(githubtest.NewTestClient(t, server), testGroupOrg, slug, 7)
		if err == nil || !strings.Contains(err.Error(), "classroom50/group/v1") {
			t.Fatalf("err = %v, want the record refusal", err)
		}
		if len(*deleted) != 0 {
			t.Errorf("deleted = %v despite the unverifiable record", *deleted)
		}
	})

	t.Run("non-group slug and zero id refuse without any request", func(t *testing.T) {
		server, deleted := serve(t, map[string]any{"id": 7, "slug": slug, "description": groupRecord(t, "")})
		client := githubtest.NewTestClient(t, server)
		if err := DeleteGroupTeam(client, testGroupOrg, "classroom50-cs101", 7); err == nil {
			t.Error("a classroom team slug must be refused")
		}
		if err := DeleteGroupTeam(client, testGroupOrg, slug, 0); err == nil {
			t.Error("a zero recorded id must be refused")
		}
		if len(*deleted) != 0 {
			t.Errorf("deleted = %v, want none", *deleted)
		}
	})
}

// SweepClassroomGroupTeams deletes exactly the verified teams whose record
// names this classroom — no config read involved — and reports per-team
// failures without stopping.
func TestSweepClassroomGroupTeams(t *testing.T) {
	mine := groupSlug(t, 1)
	otherClassroomSlug := contract.GroupTeamName("cs999", testGroupAssignment, 1)
	otherRecord, err := MarshalGroupDescription("cs999", testGroupAssignment, "")
	if err != nil {
		t.Fatal(err)
	}
	teams := []map[string]any{
		{"id": 1, "slug": mine, "description": groupRecord(t, "Alpha")},
		{"id": 2, "slug": otherClassroomSlug, "description": otherRecord},
		{"id": 3, "slug": "classroom50-group-theory", "description": groupRecord(t, "")},
		{"id": 4, "slug": groupSlug(t, 2), "description": "not a record"},
	}
	deleted := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/orgs/"+testGroupOrg+"/teams" && r.Method == http.MethodGet:
			if r.URL.Query().Get("page") != "1" {
				_, _ = w.Write([]byte(`[]`))
				return
			}
			_ = json.NewEncoder(w).Encode(teams)
		case r.Method == http.MethodGet:
			slug := strings.TrimPrefix(r.URL.Path, "/orgs/"+testGroupOrg+"/teams/")
			for _, team := range teams {
				if team["slug"] == slug {
					_ = json.NewEncoder(w).Encode(team)
					return
				}
			}
			http.NotFound(w, r)
		case r.Method == http.MethodDelete:
			deleted = append(deleted, strings.TrimPrefix(r.URL.Path, "/orgs/"+testGroupOrg+"/teams/"))
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	swept, failures, err := SweepClassroomGroupTeams(githubtest.NewTestClient(t, server), testGroupOrg, testGroupClassroom)
	if err != nil {
		t.Fatalf("SweepClassroomGroupTeams: %v", err)
	}
	if len(failures) != 0 {
		t.Errorf("failures = %v, want none", failures)
	}
	if fmt.Sprint(swept) != fmt.Sprint([]string{mine}) {
		t.Errorf("swept = %v, want only %q (other classroom, human, and record-less teams untouched)", swept, mine)
	}
	if fmt.Sprint(deleted) != fmt.Sprint([]string{mine}) {
		t.Errorf("deleted = %v, want only %q", deleted, mine)
	}
}
