package configrepo

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/gh-teacher/internal/githubtest"
)

func TestEnsureClassroomTeam_WritesDescription(t *testing.T) {
	var gotDescription string
	var gotPrivacy string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/orgs/o/teams" && r.Method == http.MethodPost:
			var body struct {
				Name        string `json:"name"`
				Privacy     string `json:"privacy"`
				Description string `json:"description"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			gotDescription = body.Description
			gotPrivacy = body.Privacy
			_ = json.NewEncoder(w).Encode(map[string]any{"id": 1, "slug": body.Name})
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	desc, err := MarshalTeamDescription("Intro CS", "Fall 2026", "a1b2c3d4", true)
	if err != nil {
		t.Fatalf("MarshalTeamDescription: %v", err)
	}
	ref, err := EnsureClassroomTeam(client, "o", "cs101", desc)
	if err != nil {
		t.Fatalf("EnsureClassroomTeam: %v", err)
	}
	if ref.Slug != "classroom50-cs101" {
		t.Errorf("slug = %q, want classroom50-cs101", ref.Slug)
	}
	if gotPrivacy != "secret" {
		t.Errorf("privacy = %q, want secret (the secret MUST only live on a secret team)", gotPrivacy)
	}
	if gotDescription != desc {
		t.Errorf("description = %q, want %q", gotDescription, desc)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(gotDescription), &decoded); err != nil {
		t.Fatalf("description is not valid JSON: %v", err)
	}
	if decoded["secret"] != "a1b2c3d4" {
		t.Errorf("description secret = %v, want a1b2c3d4", decoded["secret"])
	}
}

// TestEnsureClassroomTeam_AdoptReconcilesDescription: a 422 name-collision
// adopts the existing team and PATCHes the description (and privacy) so a
// rotated secret / renamed classroom propagates to the student-facing record.
func TestEnsureClassroomTeam_AdoptReconcilesDescription(t *testing.T) {
	var patched map[string]any
	newDesc, err := MarshalTeamDescription("Intro CS", "Fall 2026", "newsecret", true)
	if err != nil {
		t.Fatalf("MarshalTeamDescription: %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/orgs/o/teams" && r.Method == http.MethodPost:
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"message":"name already taken"}`))
		case r.URL.Path == "/orgs/o/teams/classroom50-cs101" && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": 7, "slug": "classroom50-cs101", "privacy": "secret",
				"description": `{"schema":"classroom50/team/v1","name":"Intro CS","secret":"oldsecret"}`,
			})
		case r.URL.Path == "/orgs/o/teams/classroom50-cs101" && r.Method == http.MethodPatch:
			_ = json.NewDecoder(r.Body).Decode(&patched)
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	ref, err := EnsureClassroomTeam(client, "o", "cs101", newDesc)
	if err != nil {
		t.Fatalf("EnsureClassroomTeam adopt: %v", err)
	}
	if ref.ID != 7 || ref.Slug != "classroom50-cs101" {
		t.Errorf("adopted ref = %+v, want id 7 / classroom50-cs101", ref)
	}
	if patched == nil {
		t.Fatal("expected a PATCH reconciling the drifted description")
	}
	if patched["description"] != newDesc {
		t.Errorf("PATCH description = %v, want %q", patched["description"], newDesc)
	}
}

// TestEnsureClassroomTeam_AdoptSkipsPatchWhenDescriptionMatches: an adopted
// secret team whose description already equals the desired record issues no
// PATCH (idempotent reconcile).
func TestEnsureClassroomTeam_AdoptSkipsPatchWhenDescriptionMatches(t *testing.T) {
	desc, err := MarshalTeamDescription("Intro CS", "", "", true)
	if err != nil {
		t.Fatalf("MarshalTeamDescription: %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/orgs/o/teams" && r.Method == http.MethodPost:
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"message":"name already taken"}`))
		case r.URL.Path == "/orgs/o/teams/classroom50-cs101" && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": 7, "slug": "classroom50-cs101", "privacy": "secret", "description": desc,
			})
		case r.Method == http.MethodPatch:
			t.Errorf("must not PATCH when privacy and description already match")
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	if _, err := EnsureClassroomTeam(client, "o", "cs101", desc); err != nil {
		t.Fatalf("EnsureClassroomTeam adopt: %v", err)
	}
}

func TestStaffTeamName(t *testing.T) {
	cases := []struct {
		short string
		role  StaffRole
		want  string
	}{
		{"cs-principles", RoleTeacher, "classroom50-cs-principles-teacher"},
		{"cs-principles", RoleInstructor, "classroom50-cs-principles-instructor"},
		{"cs-principles", RoleTA, "classroom50-cs-principles-ta"},
		{"cs50", RoleTeacher, "classroom50-cs50-teacher"},
	}
	for _, tc := range cases {
		if got := staffTeamName(tc.short, tc.role); got != tc.want {
			t.Errorf("staffTeamName(%q, %q) = %q, want %q", tc.short, tc.role, got, tc.want)
		}
	}
}

// TestStaffTeamRepoPermissions pins the collect-time grant map: the TA team
// gets read (pull), and the teacher role is intentionally absent (its access
// is granted at classroom setup, not by the collector). This map is the source
// of truth the collector's STAFF_TEAM_PERMISSIONS mirror must match in lockstep.
func TestStaffTeamRepoPermissions(t *testing.T) {
	if got := StaffTeamRepoPermissions[RoleTA]; got != "pull" {
		t.Errorf("StaffTeamRepoPermissions[ta] = %q, want %q", got, "pull")
	}
	if _, ok := StaffTeamRepoPermissions[RoleTeacher]; ok {
		t.Error("teacher must NOT be in StaffTeamRepoPermissions — the collector grants it nothing")
	}
	if _, ok := StaffTeamRepoPermissions[RoleInstructor]; ok {
		t.Error("instructor must NOT be in StaffTeamRepoPermissions — the collector grants it nothing")
	}
	valid := map[string]bool{"pull": true, "triage": true, "push": true, "maintain": true, "admin": true}
	for role, perm := range StaffTeamRepoPermissions {
		if !valid[perm] {
			t.Errorf("StaffTeamRepoPermissions[%q] = %q is not a valid GitHub team repo permission", role, perm)
		}
	}
}

// TestEnsureStaffTeams verifies both staff teams are created and each is
// granted push (write) on the config repo, and that the returned refs
// carry the created ids/slugs.
func TestEnsureStaffTeams(t *testing.T) {
	var createdNames []string
	grantPerms := map[string]string{} // slug -> permission

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/orgs/o/teams" && r.Method == http.MethodPost:
			var body struct {
				Name    string `json:"name"`
				Privacy string `json:"privacy"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.Privacy != "secret" {
				t.Errorf("team %q created with privacy %q, want secret", body.Name, body.Privacy)
			}
			createdNames = append(createdNames, body.Name)
			// slug == name (canonical short-name).
			_ = json.NewEncoder(w).Encode(map[string]any{"id": int64(len(createdNames)), "slug": body.Name})
		case strings.HasPrefix(r.URL.Path, "/orgs/o/teams/") && strings.Contains(r.URL.Path, "/repos/") && r.Method == http.MethodGet:
			// No access yet.
			w.WriteHeader(http.StatusNotFound)
		case strings.HasPrefix(r.URL.Path, "/orgs/o/teams/") && strings.Contains(r.URL.Path, "/repos/") && r.Method == http.MethodPut:
			var body struct {
				Permission string `json:"permission"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			// slug is the segment between /teams/ and /repos/.
			slug := strings.TrimPrefix(r.URL.Path, "/orgs/o/teams/")
			slug = strings.SplitN(slug, "/repos/", 2)[0]
			grantPerms[slug] = body.Permission
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	refs, err := EnsureStaffTeams(client, "o", "cs-principles")
	if err != nil {
		t.Fatalf("EnsureStaffTeams: %v", err)
	}
	if refs.Teacher == nil || refs.Teacher.Slug != "classroom50-cs-principles-teacher" {
		t.Errorf("teacher ref = %+v, want slug classroom50-cs-principles-teacher", refs.Teacher)
	}
	if refs.TA == nil || refs.TA.Slug != "classroom50-cs-principles-ta" {
		t.Errorf("ta ref = %+v, want slug classroom50-cs-principles-ta", refs.TA)
	}
	if len(createdNames) != 2 {
		t.Fatalf("created %d teams, want 2: %v", len(createdNames), createdNames)
	}
	for _, slug := range []string{"classroom50-cs-principles-teacher", "classroom50-cs-principles-ta"} {
		if grantPerms[slug] != "push" {
			t.Errorf("staff team %q granted %q on config repo, want push", slug, grantPerms[slug])
		}
	}
}

// TestGrantTeamRepoWrite requests push, and is idempotent when the team
// already has access.
func TestGrantTeamRepoWrite(t *testing.T) {
	t.Run("grants push when no access", func(t *testing.T) {
		var gotPerm string
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodGet:
				w.WriteHeader(http.StatusNotFound)
			case http.MethodPut:
				var body struct {
					Permission string `json:"permission"`
				}
				_ = json.NewDecoder(r.Body).Decode(&body)
				gotPerm = body.Permission
				w.WriteHeader(http.StatusNoContent)
			}
		}))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		granted, err := GrantTeamRepoWrite(client, "o", "classroom50-x-instructor", "o", "classroom50")
		if err != nil {
			t.Fatalf("GrantTeamRepoWrite: %v", err)
		}
		if !granted {
			t.Errorf("granted = false, want true on a fresh grant")
		}
		if gotPerm != "push" {
			t.Errorf("permission = %q, want push", gotPerm)
		}
	})

	t.Run("no-op when team already has access", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodGet {
				w.WriteHeader(http.StatusNoContent) // already has access
				return
			}
			t.Errorf("unexpected %s (should skip the PUT)", r.Method)
		}))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		granted, err := GrantTeamRepoWrite(client, "o", "classroom50-x-instructor", "o", "classroom50")
		if err != nil {
			t.Fatalf("GrantTeamRepoWrite: %v", err)
		}
		if granted {
			t.Errorf("granted = true, want false when access already present")
		}
	})
}

// TestDeleteClassroomTeam_NamespaceGuard refuses to delete a team whose
// slug isn't classroom50-namespaced, without issuing any request.
func TestDeleteClassroomTeam_NamespaceGuard(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("must not issue any request for a non-namespaced slug: %s %s", r.Method, r.URL.Path)
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	err := DeleteClassroomTeam(client, "o", TeamRef{ID: 5, Slug: "some-unrelated-team"})
	if err == nil || !strings.Contains(err.Error(), "refusing to delete") {
		t.Fatalf("err = %v, want a namespace-guard refusal", err)
	}
}

// TestDeleteClassroomTeam_RefusesZeroID is the load-bearing fail-closed
// guard: a classroom50--prefixed ref with a non-positive id (a
// hand-edited or pre-id classroom.json) must NOT be deleted blind, and
// must issue no DELETE — mirroring the web's positive-id requirement.
func TestDeleteClassroomTeam_RefusesZeroID(t *testing.T) {
	for _, id := range []int64{0, -1} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t.Errorf("must not issue any request for an id<=0 ref: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}))
		client := githubtest.NewTestClient(t, server)
		err := DeleteClassroomTeam(client, "o", TeamRef{ID: id, Slug: "classroom50-other-instructor"})
		server.Close()
		if err == nil || !strings.Contains(err.Error(), "no recorded id") {
			t.Errorf("id=%d: err = %v, want a fail-closed 'no recorded id' refusal", id, err)
		}
	}
}

// TestIsDeletableClassroomTeamRef pins the shared predicate: deletable
// only when classroom50--prefixed AND id>0 (mirrors the web).
func TestIsDeletableClassroomTeamRef(t *testing.T) {
	cases := []struct {
		team TeamRef
		want bool
	}{
		{TeamRef{ID: 1, Slug: "classroom50-cs-instructor"}, true},
		{TeamRef{ID: 0, Slug: "classroom50-cs-instructor"}, false},
		{TeamRef{ID: -1, Slug: "classroom50-cs-instructor"}, false},
		{TeamRef{ID: 1, Slug: "other-team"}, false},
		{TeamRef{ID: 1, Slug: ""}, false},
	}
	for _, tc := range cases {
		if got := IsDeletableClassroomTeamRef(tc.team); got != tc.want {
			t.Errorf("IsDeletableClassroomTeamRef(%+v) = %v, want %v", tc.team, got, tc.want)
		}
	}
}

// TestEnsureClassroomStaffTeam_AdoptsExisting422 covers the adopt path:
// a 422 name-collision reads the existing team and reconciles a non-secret
// privacy to secret.
func TestEnsureClassroomStaffTeam_AdoptsExisting422(t *testing.T) {
	var patched bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/orgs/o/teams" && r.Method == http.MethodPost:
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"message":"name already taken"}`))
		case r.URL.Path == "/orgs/o/teams/classroom50-cs-instructor" && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{"id": 7, "slug": "classroom50-cs-instructor", "privacy": "closed"})
		case r.URL.Path == "/orgs/o/teams/classroom50-cs-instructor" && r.Method == http.MethodPatch:
			patched = true
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	ref, err := EnsureClassroomStaffTeam(client, "o", "cs", RoleInstructor)
	if err != nil {
		t.Fatalf("EnsureClassroomStaffTeam adopt: %v", err)
	}
	if ref.ID != 7 || ref.Slug != "classroom50-cs-instructor" {
		t.Errorf("adopted ref = %+v, want id 7 / classroom50-cs-instructor", ref)
	}
	if !patched {
		t.Errorf("expected a PATCH reconciling privacy to secret on the closed team")
	}
}

// TestListTeamMembers walks pagination (via the short-page fallback) and
// returns every member login.
func TestListTeamMembers(t *testing.T) {
	page1 := make([]map[string]any, 100)
	for i := range page1 {
		page1[i] = map[string]any{"login": fmt.Sprintf("u%d", i), "id": i + 1}
	}
	page2 := []map[string]any{
		{"login": "alice", "id": 500},
		{"login": "bob", "id": 501},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/orgs/o/teams/classroom50-cs/members" {
			t.Errorf("unexpected path %q", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		// No Link header: a full page (==per_page) continues to a synthesized
		// page 2; the short page 2 (<per_page) ends the walk.
		if r.URL.Query().Get("page") == "2" {
			_ = json.NewEncoder(w).Encode(page2)
			return
		}
		_ = json.NewEncoder(w).Encode(page1)
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	logins, err := ListTeamMembers(client, "o", "classroom50-cs")
	if err != nil {
		t.Fatalf("ListTeamMembers: %v", err)
	}
	if len(logins) != 102 {
		t.Fatalf("got %d logins, want 102", len(logins))
	}
	if logins[100] != "alice" || logins[101] != "bob" {
		t.Errorf("second page not appended: got tail %v", logins[100:])
	}
}

// TestListTeamMembers_404IsEmpty: a classroom whose team doesn't exist yet
// reads as "no members", not an error.
func TestListTeamMembers_404IsEmpty(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	logins, err := ListTeamMembers(client, "o", "classroom50-missing")
	if err != nil {
		t.Fatalf("ListTeamMembers 404: unexpected err %v", err)
	}
	if len(logins) != 0 {
		t.Errorf("got %v, want empty", logins)
	}
}

// TestResolveClassroomTeamSlug_FallbackWhenNoTeamBlock: a classroom.json with
// no team block falls back to the derived classroom50-<short> slug.
func TestResolveClassroomTeamSlug_FallbackWhenNoTeamBlock(t *testing.T) {
	doc, _ := json.Marshal(map[string]any{"schema": "classroom50/v1", "short_name": "cs"})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"content":  base64.StdEncoding.EncodeToString(doc),
			"encoding": "base64",
		})
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	slug, err := ResolveClassroomTeamSlug(client, "o", "cs", "main")
	if err != nil {
		t.Fatalf("ResolveClassroomTeamSlug: %v", err)
	}
	if slug != "classroom50-cs" {
		t.Errorf("slug = %q, want classroom50-cs", slug)
	}
}
