package staff

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/gh-teacher/internal/githubtest"
)

// migrationMock serves the surface MigrateInstructorTeamToTeacher touches:
// config-repo branch, classroom.json read, team create/adopt + grant, member
// list, membership PUTs, the team-delete verify+DELETE, and the git-data commit
// sequence for the RMW record.
type migrationMock struct {
	classroomJSON    string
	instructorMember []string // logins on the legacy instructor team
	teamsCreated     []string
	membershipPUT    []string
	teamDeleted      []string
	committed        map[string]string
}

func (m *migrationMock) handler(t *testing.T) http.Handler {
	t.Helper()
	if m.committed == nil {
		m.committed = map[string]string{}
	}
	blobs := map[string]string{}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case path == "/repos/o/classroom50" && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{"default_branch": "main"})
		case strings.HasPrefix(path, "/repos/o/classroom50/contents/") && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]string{
				"content":  base64.StdEncoding.EncodeToString([]byte(m.classroomJSON)),
				"encoding": "base64",
			})
		case path == "/orgs/o/teams" && r.Method == http.MethodPost:
			var body struct {
				Name string `json:"name"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			m.teamsCreated = append(m.teamsCreated, body.Name)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": int64(len(m.teamsCreated) + 200), "slug": body.Name})
		case strings.HasPrefix(path, "/orgs/o/teams/") && strings.Contains(path, "/repos/") && r.Method == http.MethodGet:
			w.WriteHeader(http.StatusNotFound) // no repo access yet
		case strings.HasPrefix(path, "/orgs/o/teams/") && strings.Contains(path, "/repos/") && r.Method == http.MethodPut:
			w.WriteHeader(http.StatusNoContent)
		case strings.HasSuffix(path, "/members") && r.Method == http.MethodGet:
			members := make([]map[string]any, 0, len(m.instructorMember))
			for i, login := range m.instructorMember {
				members = append(members, map[string]any{"login": login, "id": i + 1})
			}
			_ = json.NewEncoder(w).Encode(members)
		case strings.Contains(path, "/memberships/") && r.Method == http.MethodPut:
			m.membershipPUT = append(m.membershipPUT, path)
			_ = json.NewEncoder(w).Encode(map[string]any{"state": "active"})
		// team-delete verify + DELETE
		case r.Method == http.MethodGet && strings.HasPrefix(path, "/orgs/o/teams/") && strings.HasSuffix(path, "-instructor"):
			_ = json.NewEncoder(w).Encode(map[string]any{"id": 2})
		case r.Method == http.MethodDelete && strings.HasPrefix(path, "/orgs/o/teams/"):
			m.teamDeleted = append(m.teamDeleted, strings.TrimPrefix(path, "/orgs/o/teams/"))
			w.WriteHeader(http.StatusNoContent)
		// git-data commit sequence
		case strings.Contains(path, "/git/refs/heads/"):
			if r.Method == http.MethodPatch {
				w.WriteHeader(http.StatusOK)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "parent-sha"}})
		case strings.Contains(path, "/git/commits/parent-sha") && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{"tree": map[string]string{"sha": "parent-tree"}})
		case strings.HasSuffix(path, "/git/blobs") && r.Method == http.MethodPost:
			var body struct{ Content, Encoding string }
			_ = json.NewDecoder(r.Body).Decode(&body)
			decoded, _ := base64.StdEncoding.DecodeString(body.Content)
			sha := "blob-" + string(rune('a'+len(blobs)))
			blobs[sha] = string(decoded)
			_ = json.NewEncoder(w).Encode(map[string]string{"sha": sha})
		case strings.HasSuffix(path, "/git/trees") && r.Method == http.MethodPost:
			var body struct {
				Tree []struct {
					Path string `json:"path"`
					SHA  string `json:"sha"`
				} `json:"tree"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			for _, e := range body.Tree {
				if content, ok := blobs[e.SHA]; ok {
					m.committed[e.Path] = content
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-tree"})
		case strings.HasSuffix(path, "/git/commits") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-commit"})
		default:
			t.Errorf("unexpected request: %s %s", r.Method, path)
			http.NotFound(w, r)
		}
	})
}

const legacyInstructorClassroom = `{
  "schema": "classroom50/classroom/v1",
  "short_name": "cs",
  "org": "o",
  "teams": {
    "instructor": {"id": 2, "slug": "classroom50-cs-instructor"},
    "ta": {"id": 3, "slug": "classroom50-cs-ta"}
  }
}`

// TestMigrate_PhaseCreate: a legacy classroom (instructor ref, no teacher ref)
// gets the teacher team created, instructor members copied, and teams.teacher
// recorded — WITHOUT deleting the instructor team (two-phase safety).
func TestMigrate_PhaseCreate(t *testing.T) {
	mock := &migrationMock{
		classroomJSON:    legacyInstructorClassroom,
		instructorMember: []string{"alice", "bob"},
	}
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out bytes.Buffer
	if err := MigrateInstructorTeamToTeacher(client, &out, "o", "cs", "main"); err != nil {
		t.Fatalf("MigrateInstructorTeamToTeacher phase-create: %v", err)
	}
	if len(mock.teamsCreated) != 1 || mock.teamsCreated[0] != "classroom50-cs-teacher" {
		t.Errorf("teamsCreated = %v, want [classroom50-cs-teacher]", mock.teamsCreated)
	}
	for _, login := range []string{"alice", "bob"} {
		found := false
		for _, put := range mock.membershipPUT {
			if strings.Contains(put, "classroom50-cs-teacher/memberships/"+login) {
				found = true
			}
		}
		if !found {
			t.Errorf("expected %s copied to teacher team; PUTs = %v", login, mock.membershipPUT)
		}
	}
	if len(mock.teamDeleted) != 0 {
		t.Errorf("phase-create must NOT delete the instructor team, deleted = %v", mock.teamDeleted)
	}
	committed, ok := mock.committed["cs/classroom.json"]
	if !ok || !strings.Contains(committed, "classroom50-cs-teacher") {
		t.Errorf("committed classroom.json should record the teacher team, got %q", committed)
	}
}

const migratedBothTeamsClassroom = `{
  "schema": "classroom50/classroom/v1",
  "short_name": "cs",
  "org": "o",
  "teams": {
    "teacher": {"id": 9, "slug": "classroom50-cs-teacher"},
    "instructor": {"id": 2, "slug": "classroom50-cs-instructor"},
    "ta": {"id": 3, "slug": "classroom50-cs-ta"}
  }
}`

// TestMigrate_PhaseDelete: once teacher is recorded and the legacy instructor
// team still exists (a later touch), the instructor team is deleted and its ref
// dropped from classroom.json.
func TestMigrate_PhaseDelete(t *testing.T) {
	mock := &migrationMock{classroomJSON: migratedBothTeamsClassroom}
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out bytes.Buffer
	if err := MigrateInstructorTeamToTeacher(client, &out, "o", "cs", "main"); err != nil {
		t.Fatalf("MigrateInstructorTeamToTeacher phase-delete: %v", err)
	}
	if len(mock.teamDeleted) != 1 || mock.teamDeleted[0] != "classroom50-cs-instructor" {
		t.Errorf("teamDeleted = %v, want [classroom50-cs-instructor]", mock.teamDeleted)
	}
	if len(mock.teamsCreated) != 0 {
		t.Errorf("phase-delete must not create teams, got %v", mock.teamsCreated)
	}
	committed, ok := mock.committed["cs/classroom.json"]
	if !ok || strings.Contains(committed, "classroom50-cs-instructor") {
		t.Errorf("committed classroom.json should drop the instructor ref, got %q", committed)
	}
}

// adoptedSameSlugClassroom: the teacher ref adopted the SAME team as the
// instructor ref (shared slug) — e.g. a prior partial migration recorded both
// pointing at the one team.
const adoptedSameSlugClassroom = `{
  "schema": "classroom50/classroom/v1",
  "short_name": "cs",
  "org": "o",
  "teams": {
    "teacher": {"id": 2, "slug": "classroom50-cs-instructor"},
    "instructor": {"id": 2, "slug": "classroom50-cs-instructor"},
    "ta": {"id": 3, "slug": "classroom50-cs-ta"}
  }
}`

// TestMigrate_PhaseDelete_AdoptedSameSlug: when teacher.Slug == instructor.Slug
// the phase-delete MUST skip the team DELETE (deleting would remove the live
// teacher team) and only drop the duplicate instructor ref. Guards the fail-safe
// branch a regression could silently drop.
func TestMigrate_PhaseDelete_AdoptedSameSlug(t *testing.T) {
	mock := &migrationMock{classroomJSON: adoptedSameSlugClassroom}
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out bytes.Buffer
	if err := MigrateInstructorTeamToTeacher(client, &out, "o", "cs", "main"); err != nil {
		t.Fatalf("MigrateInstructorTeamToTeacher adopted-same-slug: %v", err)
	}
	if len(mock.teamDeleted) != 0 {
		t.Errorf("shared-slug phase-delete must NOT delete the (live teacher) team, deleted = %v", mock.teamDeleted)
	}
	if len(mock.teamsCreated) != 0 {
		t.Errorf("phase-delete must not create teams, got %v", mock.teamsCreated)
	}
	committed, ok := mock.committed["cs/classroom.json"]
	if !ok || strings.Contains(committed, `"instructor"`) {
		t.Errorf("committed classroom.json should drop the duplicate instructor ref, got %q", committed)
	}
	if !strings.Contains(committed, "classroom50-cs-instructor") {
		t.Errorf("the adopted team slug must remain as teams.teacher, got %q", committed)
	}
}

// TestMigrate_NoTeamsBlock: a classroom with no teams block is a clean no-op.
func TestMigrate_NoTeamsBlock(t *testing.T) {
	mock := &migrationMock{classroomJSON: `{"schema":"classroom50/classroom/v1","short_name":"cs","org":"o"}`}
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out bytes.Buffer
	if err := MigrateInstructorTeamToTeacher(client, &out, "o", "cs", "main"); err != nil {
		t.Fatalf("no-op migrate: %v", err)
	}
	if len(mock.teamsCreated) != 0 || len(mock.teamDeleted) != 0 {
		t.Errorf("no-op expected, got created=%v deleted=%v", mock.teamsCreated, mock.teamDeleted)
	}
}
