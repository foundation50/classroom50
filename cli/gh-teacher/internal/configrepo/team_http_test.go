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

	desc, err := MarshalTeamDescription("Intro CS", "Fall 2026", "a1b2c3d4", "", true)
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
	newDesc, err := MarshalTeamDescription("Intro CS", "Fall 2026", "newsecret", "", true)
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
	desc, err := MarshalTeamDescription("Intro CS", "", "", "", true)
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
				"notification_setting": "notifications_disabled", "description": desc,
			})
		case r.Method == http.MethodPatch:
			t.Errorf("must not PATCH when privacy, notification setting, and description already match")
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

// TestEnsureClassroomStaffTeam_AdoptSkipsPatchWhenNotificationOmitted: GitHub
// returns notification_setting only to org members, so it can be absent from
// the adopt GET. An absent value must read as "unknown, not read" — not as
// drift — so an already-secret team issues no PATCH (#335 guard).
func TestEnsureClassroomStaffTeam_AdoptSkipsPatchWhenNotificationOmitted(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/orgs/o/teams" && r.Method == http.MethodPost:
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"message":"name already taken"}`))
		case r.URL.Path == "/orgs/o/teams/classroom50-cs101-teacher" && r.Method == http.MethodGet:
			// notification_setting omitted (not visible to this token).
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": 7, "slug": "classroom50-cs101-teacher", "privacy": "secret",
			})
		case r.Method == http.MethodPatch:
			t.Errorf("must not PATCH when notification_setting is absent from the GET (unknown, not drifted)")
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	if _, err := EnsureClassroomStaffTeam(client, "o", "cs101", RoleTeacher); err != nil {
		t.Fatalf("EnsureClassroomStaffTeam adopt: %v", err)
	}
}

// TestEnsureClassroomStaffTeam_AdoptReconcilesNotification: when the adopt GET
// returns a concrete notification_setting that differs from the desired one,
// the reconcile PATCHes it (a staff team left disabled gets enabled — #335).
func TestEnsureClassroomStaffTeam_AdoptReconcilesNotification(t *testing.T) {
	var patched map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/orgs/o/teams" && r.Method == http.MethodPost:
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"message":"name already taken"}`))
		case r.URL.Path == "/orgs/o/teams/classroom50-cs101-teacher" && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": 7, "slug": "classroom50-cs101-teacher", "privacy": "secret",
				"notification_setting": "notifications_disabled",
			})
		case r.URL.Path == "/orgs/o/teams/classroom50-cs101-teacher" && r.Method == http.MethodPatch:
			_ = json.NewDecoder(r.Body).Decode(&patched)
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	if _, err := EnsureClassroomStaffTeam(client, "o", "cs101", RoleTeacher); err != nil {
		t.Fatalf("EnsureClassroomStaffTeam adopt: %v", err)
	}
	if patched == nil {
		t.Fatal("expected a PATCH reconciling the drifted notification_setting")
	}
	if patched["notification_setting"] != "notifications_enabled" {
		t.Errorf("PATCH notification_setting = %v, want notifications_enabled", patched["notification_setting"])
	}
}

func TestStaffTeamName(t *testing.T) {
	cases := []struct {
		short string
		role  StaffRole
		want  string
	}{
		{"cs-principles", RoleTeacher, "classroom50-cs-principles-teacher"},
		{"cs-principles", RoleHeadTA, "classroom50-cs-principles-hta"},
		{"cs-principles", RoleTA, "classroom50-cs-principles-ta"},
		{"cs50", RoleTeacher, "classroom50-cs50-teacher"},
	}
	for _, tc := range cases {
		if got := staffTeamName(tc.short, tc.role); got != tc.want {
			t.Errorf("staffTeamName(%q, %q) = %q, want %q", tc.short, tc.role, got, tc.want)
		}
	}
}

// TestStaffTeamRepoPermissions pins the collect-time grant map: the non-owner
// staff teams (head-TA and TA) get read (pull), and the teacher role is
// intentionally absent (owners get repo access via ownership, not the
// collector). This map is the source of truth the collector's
// STAFF_TEAM_PERMISSIONS mirror must match in lockstep.
func TestStaffTeamRepoPermissions(t *testing.T) {
	if got := StaffTeamRepoPermissions[RoleHeadTA]; got != "pull" {
		t.Errorf("StaffTeamRepoPermissions[hta] = %q, want %q", got, "pull")
	}
	if got := StaffTeamRepoPermissions[RoleTA]; got != "pull" {
		t.Errorf("StaffTeamRepoPermissions[ta] = %q, want %q", got, "pull")
	}
	if _, ok := StaffTeamRepoPermissions[RoleTeacher]; ok {
		t.Error("teacher must NOT be in StaffTeamRepoPermissions — owners get repo access via ownership")
	}
	valid := map[string]bool{"pull": true, "triage": true, "push": true, "maintain": true, "admin": true}
	for role, perm := range StaffTeamRepoPermissions {
		if !valid[perm] {
			t.Errorf("StaffTeamRepoPermissions[%q] = %q is not a valid GitHub team repo permission", role, perm)
		}
	}
}

// TestEnsureStaffTeams verifies all three staff teams are created as `secret`
// with notifications_enabled (#335), the returned refs carry the created
// ids/slugs, and NO config-repo grant is issued — the grant is now a separate
// step (GrantStaffTeamsConfigRepoAccess) callers run AFTER the creator drop so
// the drop stays silent.
func TestEnsureStaffTeams(t *testing.T) {
	var createdNames []string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/orgs/o/teams" && r.Method == http.MethodPost:
			var body struct {
				Name                string `json:"name"`
				Privacy             string `json:"privacy"`
				NotificationSetting string `json:"notification_setting"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.Privacy != "secret" {
				t.Errorf("team %q created with privacy %q, want secret", body.Name, body.Privacy)
			}
			if body.NotificationSetting != "notifications_enabled" {
				t.Errorf("staff team %q created with notification_setting %q, want notifications_enabled (#335)", body.Name, body.NotificationSetting)
			}
			createdNames = append(createdNames, body.Name)
			// slug == name (canonical short-name).
			_ = json.NewEncoder(w).Encode(map[string]any{"id": int64(len(createdNames)), "slug": body.Name})
		case strings.Contains(r.URL.Path, "/repos/"):
			t.Errorf("EnsureStaffTeams must not grant config-repo access (that moved to GrantStaffTeamsConfigRepoAccess): %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
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
	if refs.HeadTA == nil || refs.HeadTA.Slug != "classroom50-cs-principles-hta" {
		t.Errorf("hta ref = %+v, want slug classroom50-cs-principles-hta", refs.HeadTA)
	}
	if len(createdNames) != 3 {
		t.Fatalf("created %d teams, want 3: %v", len(createdNames), createdNames)
	}
}

// TestGrantStaffTeamsConfigRepoAccess pins that each recorded staff team is
// granted its role's config-repo permission (teacher/hta push, ta pull) — the
// grant split out of EnsureStaffTeams so callers run it AFTER the silent
// creator drop. A nil ref/empty slug is skipped.
func TestGrantStaffTeamsConfigRepoAccess(t *testing.T) {
	grantPerms := map[string]string{} // slug -> permission
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/repos/") && r.Method == http.MethodGet:
			// No access yet, so each role issues its PUT.
			w.WriteHeader(http.StatusNotFound)
		case strings.Contains(r.URL.Path, "/repos/") && r.Method == http.MethodPut:
			var body struct {
				Permission string `json:"permission"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
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

	refs := &StaffTeamsRef{
		Teacher: &TeamRef{ID: 1, Slug: "classroom50-cs-principles-teacher"},
		HeadTA:  &TeamRef{ID: 2, Slug: "classroom50-cs-principles-hta"},
		TA:      &TeamRef{ID: 3, Slug: "classroom50-cs-principles-ta"},
	}
	if err := GrantStaffTeamsConfigRepoAccess(client, "o", refs); err != nil {
		t.Fatalf("GrantStaffTeamsConfigRepoAccess: %v", err)
	}
	// Teacher and head-TA get config-repo write; a plain TA gets read-only.
	for _, slug := range []string{"classroom50-cs-principles-teacher", "classroom50-cs-principles-hta"} {
		if grantPerms[slug] != "push" {
			t.Errorf("staff team %q granted %q on config repo, want push", slug, grantPerms[slug])
		}
	}
	if grantPerms["classroom50-cs-principles-ta"] != "pull" {
		t.Errorf("ta team granted %q on config repo, want pull", grantPerms["classroom50-cs-principles-ta"])
	}
}

// TestGrantStaffTeamsConfigRepoAccess_SkipsAbsentAndNil pins the guards: a nil
// refs pointer is a no-op, and a role with no recorded ref is skipped.
func TestGrantStaffTeamsConfigRepoAccess_SkipsAbsentAndNil(t *testing.T) {
	var touchedSlugs []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/repos/") {
			slug := strings.TrimPrefix(r.URL.Path, "/orgs/o/teams/")
			slug = strings.SplitN(slug, "/repos/", 2)[0]
			touchedSlugs = append(touchedSlugs, slug)
		}
		// GET probe returns 404 (no access) so a recorded team would PUT.
		if r.Method == http.MethodGet {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	if err := GrantStaffTeamsConfigRepoAccess(client, "o", nil); err != nil {
		t.Fatalf("nil refs: %v", err)
	}
	if len(touchedSlugs) != 0 {
		t.Errorf("nil refs touched teams: %v", touchedSlugs)
	}

	// Only teacher recorded; hta/ta absent must be skipped.
	if err := GrantStaffTeamsConfigRepoAccess(client, "o", &StaffTeamsRef{
		Teacher: &TeamRef{ID: 1, Slug: "classroom50-cs101-teacher"},
	}); err != nil {
		t.Fatalf("partial refs: %v", err)
	}
	for _, s := range touchedSlugs {
		if s != "classroom50-cs101-teacher" {
			t.Errorf("partial refs touched unexpected team %q, want only classroom50-cs101-teacher", s)
		}
	}
	if len(touchedSlugs) == 0 {
		t.Error("partial refs: expected the teacher team to be granted")
	}
}

// TestGrantTeamConfigRepoAccess covers the permission-aware config-repo grant:
// it grants the role's permission when absent, is a no-op when already correct,
// and DOWNGRADES an existing stronger grant (a TA team holding push drops to
// pull) — the behavior the TA read-only demotion depends on.
func TestGrantTeamConfigRepoAccess(t *testing.T) {
	cases := []struct {
		name       string
		role       StaffRole
		current    string // "" = 404 (no access)
		wantPut    string // "" = no PUT expected
		wantChange bool
	}{
		{"grant push to hta when absent", RoleHeadTA, "", "push", true},
		{"grant pull to ta when absent", RoleTA, "", "pull", true},
		{"downgrade ta push to pull", RoleTA, "push", "pull", true},
		{"no-op when ta already pull", RoleTA, "pull", "", false},
		{"no-op when teacher already push", RoleTeacher, "push", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotPut string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.Method {
				case http.MethodGet:
					if tc.current == "" {
						w.WriteHeader(http.StatusNotFound)
						return
					}
					perms := map[string]bool{tc.current: true}
					_ = json.NewEncoder(w).Encode(map[string]any{"permissions": perms})
				case http.MethodPut:
					var body struct {
						Permission string `json:"permission"`
					}
					_ = json.NewDecoder(r.Body).Decode(&body)
					gotPut = body.Permission
					w.WriteHeader(http.StatusNoContent)
				default:
					t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
				}
			}))
			t.Cleanup(server.Close)
			client := githubtest.NewTestClient(t, server)

			changed, err := GrantTeamConfigRepoAccess(client, "o", "classroom50-x-"+string(tc.role), tc.role)
			if err != nil {
				t.Fatalf("GrantTeamConfigRepoAccess: %v", err)
			}
			if changed != tc.wantChange {
				t.Errorf("changed = %v, want %v", changed, tc.wantChange)
			}
			if gotPut != tc.wantPut {
				t.Errorf("PUT permission = %q, want %q", gotPut, tc.wantPut)
			}
		})
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

		granted, err := GrantTeamRepoWrite(client, "o", "classroom50-x-teacher", "o", "classroom50")
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

		granted, err := GrantTeamRepoWrite(client, "o", "classroom50-x-teacher", "o", "classroom50")
		if err != nil {
			t.Fatalf("GrantTeamRepoWrite: %v", err)
		}
		if granted {
			t.Errorf("granted = true, want false when access already present")
		}
	})
}

// TestRemoveTeamRepo issues a DELETE on the team-repo path and treats a 404
// (never granted) as success so revoking is idempotent.
func TestRemoveTeamRepo(t *testing.T) {
	t.Run("deletes the team repo access", func(t *testing.T) {
		var gotMethod, gotPath string
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotMethod = r.Method
			gotPath = r.URL.Path
			w.WriteHeader(http.StatusNoContent)
		}))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		if err := RemoveTeamRepo(client, "o", "classroom50-x", "o", "hello-template"); err != nil {
			t.Fatalf("RemoveTeamRepo: %v", err)
		}
		if gotMethod != http.MethodDelete {
			t.Errorf("method = %q, want DELETE", gotMethod)
		}
		if want := "/orgs/o/teams/classroom50-x/repos/o/hello-template"; gotPath != want {
			t.Errorf("path = %q, want %q", gotPath, want)
		}
	})

	t.Run("404 is success (idempotent)", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNotFound)
		}))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		if err := RemoveTeamRepo(client, "o", "classroom50-x", "o", "hello-template"); err != nil {
			t.Errorf("RemoveTeamRepo on 404 = %v, want nil (idempotent)", err)
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
		err := DeleteClassroomTeam(client, "o", TeamRef{ID: id, Slug: "classroom50-other-teacher"})
		server.Close()
		if err == nil || !strings.Contains(err.Error(), "no recorded id") {
			t.Errorf("id=%d: err = %v, want a fail-closed 'no recorded id' refusal", id, err)
		}
	}
}

// TestDeleteInviteTeam_NamespaceGuard is the fail-closed fence for the
// web-created invite teams: unlike a classroom team there is no recorded id to
// verify against, so the `invite-` prefix IS the guard. A slug outside that
// namespace must be refused without issuing any request.
func TestDeleteInviteTeam_NamespaceGuard(t *testing.T) {
	// Each of these must be refused: a classroom team, an unrelated team, the
	// bare prefix, a HUMAN team that merely starts with `invite-` ("Invite Only"
	// slugs to `invite-only`), a too-short/too-long hash, and uppercase hex.
	for _, slug := range []string{
		"classroom50-cs-principles",
		"some-unrelated-team",
		"invite",
		"invite-",
		"invite-only",
		"invite-reviewers",
		"invite-0123456789abcde",   // 15 hex
		"invite-0123456789abcdef0", // 17 hex
		"invite-0123456789ABCDEF",  // uppercase
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t.Errorf("must not issue any request for slug %q: %s %s", slug, r.Method, r.URL.Path)
			http.NotFound(w, r)
		}))
		client := githubtest.NewTestClient(t, server)
		err := DeleteInviteTeam(client, "o", slug)
		server.Close()
		if err == nil || !strings.Contains(err.Error(), "refusing to delete") {
			t.Errorf("slug %q: err = %v, want a namespace-guard refusal", slug, err)
		}
	}
}

// IsInviteTeamSlug is the fail-closed predicate the sweep's filter and its
// delete share; pin both directions so a loosened regex fails here.
func TestIsInviteTeamSlug(t *testing.T) {
	cases := []struct {
		slug string
		want bool
	}{
		{"invite-0123456789abcdef", true},
		{"invite-ffffffffffffffff", true},
		{"invite-only", false},
		{"invite-", false},
		{"invite", false},
		{"", false},
		{"classroom50-cs101", false},
		{"invite-0123456789ABCDEF", false},
		{"invite-0123456789abcde", false},
		{"invite-0123456789abcdef0", false},
		{"xinvite-0123456789abcdef", false},
	}
	for _, tc := range cases {
		if got := IsInviteTeamSlug(tc.slug); got != tc.want {
			t.Errorf("IsInviteTeamSlug(%q) = %v, want %v", tc.slug, got, tc.want)
		}
	}
}

// An empty slug is a silent no-op (nothing to delete), and a 404 reads as
// success so a re-run of the sweep is idempotent.
func TestDeleteInviteTeam_EmptySlugAndAlreadyGone(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	if err := DeleteInviteTeam(client, "o", ""); err != nil {
		t.Errorf("empty slug should no-op, got %v", err)
	}
	if err := DeleteInviteTeam(client, "o", "invite-0123456789abcdef"); err != nil {
		t.Errorf("404 should read as already-deleted, got %v", err)
	}
}

// ListInviteTeams keeps only the hashed invite- shape and paginates via the
// shared PaginateAll helper (Link-header driven, page-capped).
func TestListInviteTeams_FiltersAndPaginates(t *testing.T) {
	var pages int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/orgs/o/teams" {
			t.Errorf("unexpected path %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		pages++
		if r.URL.Query().Get("page") == "1" {
			// A full page plus a next link keeps pagination going.
			var sb strings.Builder
			sb.WriteByte('[')
			for i := 0; i < 100; i++ {
				if i > 0 {
					sb.WriteByte(',')
				}
				slug := fmt.Sprintf("classroom50-filler-%d", i)
				if i == 0 {
					slug = "invite-aaaaaaaaaaaaaaaa"
				}
				fmt.Fprintf(&sb, `{"id":%d,"slug":%q}`, i+1, slug)
			}
			sb.WriteByte(']')
			// Absolute next link, as GitHub sends.
			w.Header().Set("Link", `<http://`+r.Host+r.URL.Path+`?per_page=100&page=2>; rel="next"`)
			_, _ = w.Write([]byte(sb.String()))
			return
		}
		// Page 2: one real invite team, one human team that merely starts with
		// the prefix (must be filtered out), one unrelated team.
		_, _ = w.Write([]byte(`[{"id":900,"slug":"invite-bbbbbbbbbbbbbbbb"},{"id":901,"slug":"invite-only"},{"id":902,"slug":"other"}]`))
	}))
	t.Cleanup(server.Close)

	refs, err := ListInviteTeams(githubtest.NewTestClient(t, server), "o")
	if err != nil {
		t.Fatalf("ListInviteTeams: %v", err)
	}
	if pages < 2 {
		t.Errorf("pages read = %d, want at least 2 (pagination)", pages)
	}
	var slugs []string
	for _, r := range refs {
		slugs = append(slugs, r.Slug)
	}
	want := []string{"invite-aaaaaaaaaaaaaaaa", "invite-bbbbbbbbbbbbbbbb"}
	if len(slugs) != len(want) {
		t.Fatalf("slugs = %v, want %v", slugs, want)
	}
	for i := range want {
		if slugs[i] != want[i] {
			t.Errorf("slug %d = %q, want %q", i, slugs[i], want[i])
		}
	}
}

// A failed org-team read must surface as an error, not an empty sweep set —
// silently sweeping nothing would strand invited emails without a warning.
func TestListInviteTeams_ReadFailurePropagates(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(server.Close)
	if _, err := ListInviteTeams(githubtest.NewTestClient(t, server), "o"); err == nil {
		t.Fatal("err = nil, want the read failure to propagate")
	}
}

// TestIsDeletableClassroomTeamRef pins the shared predicate: deletable
// only when classroom50--prefixed AND id>0 (mirrors the web).
func TestIsDeletableClassroomTeamRef(t *testing.T) {
	cases := []struct {
		team TeamRef
		want bool
	}{
		{TeamRef{ID: 1, Slug: "classroom50-cs-teacher"}, true},
		{TeamRef{ID: 0, Slug: "classroom50-cs-teacher"}, false},
		{TeamRef{ID: -1, Slug: "classroom50-cs-teacher"}, false},
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
		case r.URL.Path == "/orgs/o/teams/classroom50-cs-teacher" && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{"id": 7, "slug": "classroom50-cs-teacher", "privacy": "closed"})
		case r.URL.Path == "/orgs/o/teams/classroom50-cs-teacher" && r.Method == http.MethodPatch:
			patched = true
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	ref, err := EnsureClassroomStaffTeam(client, "o", "cs", RoleTeacher)
	if err != nil {
		t.Fatalf("EnsureClassroomStaffTeam adopt: %v", err)
	}
	if ref.ID != 7 || ref.Slug != "classroom50-cs-teacher" {
		t.Errorf("adopted ref = %+v, want id 7 / classroom50-cs-teacher", ref)
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
