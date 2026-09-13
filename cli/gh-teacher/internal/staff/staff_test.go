package staff

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubtest"
	"github.com/foundation50/gh-teacher/internal/orgrules"
)

// staffMock serves the minimal <org>/classroom50 surface the staff
// commands touch: config-repo default-branch metadata, a user lookup,
// the classroom.json read, the team-membership PUT/DELETE, and — for the
// self-heal path when a staff team is not yet recorded — team creation,
// the config-repo write grant, and the git-data commit sequence.
type staffMock struct {
	classroomJSON string // contents-API body for <classroom>/classroom.json ("" => 404)
	userNotFound  bool   // GET /users/{name} → 404 when true
	membershipPUT []string
	membershipDEL []string
	teamsCreated  []string          // team names POSTed to /orgs/o/teams
	grantedRepo   map[string]string // team slug -> permission granted on config repo
	committed     map[string]string // committed tree path -> content (self-heal RMW)
	bypassTeamIDs []int64           // Team actors PUT onto the feedback-base ruleset
	// A team already at a staff slug (POST 422s, GET returns this id) with no
	// config-repo grant: only a matching recorded id lets the adopt through.
	existingTeamSlug string
	existingTeamID   int64
}

func (m *staffMock) handler(t *testing.T) http.Handler {
	t.Helper()
	if m.grantedRepo == nil {
		m.grantedRepo = map[string]string{}
	}
	if m.committed == nil {
		m.committed = map[string]string{}
	}
	blobs := map[string]string{}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case path == "/repos/o/classroom50" && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{"default_branch": "main"})
		// --- feedback-base ruleset: the self-healed team gets exempted ---
		case path == "/orgs/o/rulesets" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`[{"id":22,"name":"` + orgrules.NameFeedbackBase + `"}]`))
		case path == "/orgs/o/rulesets/22" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"id":22,"bypass_actors":[{"actor_id":1,"actor_type":"OrganizationAdmin","bypass_mode":"exempt"}]}`))
		case path == "/orgs/o/rulesets/22" && r.Method == http.MethodPut:
			var body struct {
				BypassActors []struct {
					ActorID   int64  `json:"actor_id"`
					ActorType string `json:"actor_type"`
				} `json:"bypass_actors"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			for _, a := range body.BypassActors {
				if a.ActorType == "Team" {
					m.bypassTeamIDs = append(m.bypassTeamIDs, a.ActorID)
				}
			}
			_, _ = w.Write([]byte(`{}`))
		case strings.HasPrefix(path, "/users/") && r.Method == http.MethodGet:
			if m.userNotFound {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			name := strings.TrimPrefix(path, "/users/")
			_ = json.NewEncoder(w).Encode(map[string]any{"login": name, "id": 42})
		case strings.HasPrefix(path, "/repos/o/classroom50/contents/") && r.Method == http.MethodGet:
			// Only the classroom's own file exists; the adopt guard's probe for a
			// sibling `<short>-<role>/classroom.json` 404s.
			if m.classroomJSON == "" || path != "/repos/o/classroom50/contents/cs-principles/classroom.json" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]string{
				"content":  base64.StdEncoding.EncodeToString([]byte(m.classroomJSON)),
				"encoding": "base64",
			})
		case strings.Contains(path, "/memberships/") && r.Method == http.MethodPut:
			m.membershipPUT = append(m.membershipPUT, path)
			_ = json.NewEncoder(w).Encode(map[string]any{"state": "active"})
		case strings.Contains(path, "/memberships/") && r.Method == http.MethodDelete:
			m.membershipDEL = append(m.membershipDEL, path)
			w.WriteHeader(http.StatusNoContent)

		// --- self-heal path: adopt-or-create team, grant, RMW commit ---
		case path == "/orgs/o/teams" && r.Method == http.MethodPost:
			var body struct {
				Name string `json:"name"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.Name == m.existingTeamSlug {
				w.WriteHeader(http.StatusUnprocessableEntity)
				_, _ = w.Write([]byte(`{"message":"name already taken"}`))
				return
			}
			m.teamsCreated = append(m.teamsCreated, body.Name)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": int64(len(m.teamsCreated) + 100), "slug": body.Name})
		case strings.HasPrefix(path, "/orgs/o/teams/") && strings.Contains(path, "/repos/") && r.Method == http.MethodGet:
			w.WriteHeader(http.StatusNotFound) // no access yet
		case path == "/orgs/o/teams/"+m.existingTeamSlug && m.existingTeamSlug != "" && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{"id": m.existingTeamID, "slug": m.existingTeamSlug, "privacy": "closed"})
		case path == "/orgs/o/teams/"+m.existingTeamSlug && m.existingTeamSlug != "" && r.Method == http.MethodPatch:
			w.WriteHeader(http.StatusOK)
		case strings.HasPrefix(path, "/orgs/o/teams/") && strings.Contains(path, "/repos/") && r.Method == http.MethodPut:
			var body struct {
				Permission string `json:"permission"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			slug := strings.SplitN(strings.TrimPrefix(path, "/orgs/o/teams/"), "/repos/", 2)[0]
			m.grantedRepo[slug] = body.Permission
			w.WriteHeader(http.StatusNoContent)
		// git-data commit sequence (mirrors the migrate E2E mock shape)
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

const classroomWithStaffTeams = `{
  "schema": "classroom50/classroom/v1",
  "name": "CS Principles",
  "short_name": "cs-principles",
  "org": "o",
  "team": {"id": 1, "slug": "classroom50-cs-principles"},
  "teams": {
    "teacher": {"id": 2, "slug": "classroom50-cs-principles-teacher"},
    "ta": {"id": 3, "slug": "classroom50-cs-principles-ta"}
  }
}`

func TestRunStaffAdd(t *testing.T) {
	t.Run("adds to the teacher team by default", func(t *testing.T) {
		mock := &staffMock{classroomJSON: classroomWithStaffTeams}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		if err := runStaffAdd(client, &out, &errOut, "o", "cs-principles", "alice", configrepo.RoleTeacher); err != nil {
			t.Fatalf("runStaffAdd: %v", err)
		}
		if len(mock.membershipPUT) != 1 || !strings.Contains(mock.membershipPUT[0], "classroom50-cs-principles-teacher/memberships/alice") {
			t.Errorf("membership PUTs = %v, want one for the teacher team + alice", mock.membershipPUT)
		}
		if !strings.Contains(out.String(), "added alice to teacher team") {
			t.Errorf("stdout = %q, want a teacher add confirmation", out.String())
		}
	})

	t.Run("adds to the ta team with --role ta", func(t *testing.T) {
		mock := &staffMock{classroomJSON: classroomWithStaffTeams}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		if err := runStaffAdd(client, &out, &errOut, "o", "cs-principles", "bob", configrepo.RoleTA); err != nil {
			t.Fatalf("runStaffAdd ta: %v", err)
		}
		if len(mock.membershipPUT) != 1 || !strings.Contains(mock.membershipPUT[0], "classroom50-cs-principles-ta/memberships/bob") {
			t.Errorf("membership PUTs = %v, want one for the ta team + bob", mock.membershipPUT)
		}
	})

	t.Run("re-records a non-canonical staff team ref instead of honoring it", func(t *testing.T) {
		// A head TA can edit classroom.json; a `teams.ta` entry naming another
		// team must not receive the member, and the ref is rewritten to the
		// canonical slug (the step collect_scores.py's warning points at).
		mock := &staffMock{classroomJSON: `{"schema":"classroom50/classroom/v1","short_name":"cs-principles","org":"o",
  "teams": {"ta": {"id": 9, "slug": "classroom50-other-ta"}}}`}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		if err := runStaffAdd(client, &out, &errOut, "o", "cs-principles", "bob", configrepo.RoleTA); err != nil {
			t.Fatalf("runStaffAdd: %v", err)
		}
		if !strings.Contains(errOut.String(), `records "classroom50-other-ta" as the ta staff team`) {
			t.Errorf("stderr = %q, want a warning naming the rejected ref", errOut.String())
		}
		committed, ok := mock.committed["cs-principles/classroom.json"]
		if !ok || !strings.Contains(committed, `"classroom50-cs-principles-ta"`) || strings.Contains(committed, "classroom50-other-ta") {
			t.Errorf("committed classroom.json = %q, want teams.ta rewritten to the canonical slug", committed)
		}
		if len(mock.membershipPUT) != 1 || !strings.Contains(mock.membershipPUT[0], "classroom50-cs-principles-ta/memberships/bob") {
			t.Errorf("membership PUTs = %v, want bob added to the canonical ta team only", mock.membershipPUT)
		}
	})

	t.Run("self-heals a missing staff team: creates, grants, records, then adds", func(t *testing.T) {
		mock := &staffMock{classroomJSON: `{"schema":"classroom50/classroom/v1","short_name":"cs-principles","org":"o"}`}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		if err := runStaffAdd(client, &out, &errOut, "o", "cs-principles", "alice", configrepo.RoleTeacher); err != nil {
			t.Fatalf("runStaffAdd should self-heal, got err = %v", err)
		}
		if len(mock.teamsCreated) != 1 || mock.teamsCreated[0] != "classroom50-cs-principles-teacher" {
			t.Errorf("teamsCreated = %v, want the teacher team", mock.teamsCreated)
		}
		if mock.grantedRepo["classroom50-cs-principles-teacher"] != "push" {
			t.Errorf("grantedRepo = %v, want push on the teacher team", mock.grantedRepo)
		}
		// The minted team (id 101, per the mock) must be exempt from the
		// feedback-base lock or its members can't merge feedback PRs.
		if len(mock.bypassTeamIDs) != 1 || mock.bypassTeamIDs[0] != 101 {
			t.Errorf("feedback-base bypass Team actors = %v, want [101]", mock.bypassTeamIDs)
		}
		if _, ok := mock.committed["cs-principles/classroom.json"]; !ok {
			t.Errorf("committed = %v, want a classroom.json write recording the team ref", mock.committed)
		}
		if len(mock.membershipPUT) != 1 || !strings.Contains(mock.membershipPUT[0], "classroom50-cs-principles-teacher/memberships/alice") {
			t.Errorf("membership PUTs = %v, want alice added to the teacher team", mock.membershipPUT)
		}
	})

	t.Run("re-adopts a recorded team whose config-repo grant was lost", func(t *testing.T) {
		// The recorded ta team (id 55) exists but lost its grant; the id vouches
		// for it: adopt, then re-grant.
		mock := &staffMock{
			classroomJSON:    `{"schema":"classroom50/classroom/v1","short_name":"cs-principles","org":"o","teams":{"ta":{"id":55,"slug":"classroom50-cs-principles-ta"}}}`,
			existingTeamSlug: "classroom50-cs-principles-ta", existingTeamID: 55,
		}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		var out, errOut bytes.Buffer
		if err := runStaffAdd(githubtest.NewTestClient(t, server), &out, &errOut, "o", "cs-principles", "bob", configrepo.RoleTA); err != nil {
			t.Fatalf("runStaffAdd: %v", err)
		}
		if len(mock.teamsCreated) != 0 || mock.grantedRepo["classroom50-cs-principles-ta"] != "pull" {
			t.Errorf("created = %v granted = %v, want the recorded team adopted and re-granted pull", mock.teamsCreated, mock.grantedRepo)
		}
	})

	t.Run("refuses a team at the slug that nothing vouches for", func(t *testing.T) {
		// Recorded id 56, live team 55, no grant: someone else's team.
		mock := &staffMock{
			classroomJSON:    `{"schema":"classroom50/classroom/v1","short_name":"cs-principles","org":"o","teams":{"ta":{"id":56,"slug":"classroom50-cs-principles-ta"}}}`,
			existingTeamSlug: "classroom50-cs-principles-ta", existingTeamID: 55,
		}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		var out, errOut bytes.Buffer
		err := runStaffAdd(githubtest.NewTestClient(t, server), &out, &errOut, "o", "cs-principles", "bob", configrepo.RoleTA)
		var unclaimed *configrepo.UnclaimedTeamError
		if !errors.As(err, &unclaimed) {
			t.Fatalf("err = %v, want *configrepo.UnclaimedTeamError", err)
		}
		if len(mock.grantedRepo) != 0 || len(mock.membershipPUT) != 0 {
			t.Errorf("granted = %v membership = %v, want no writes to a refused team", mock.grantedRepo, mock.membershipPUT)
		}
	})

	t.Run("propagates a GitHub user-not-found error", func(t *testing.T) {
		mock := &staffMock{classroomJSON: classroomWithStaffTeams, userNotFound: true}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		err := runStaffAdd(client, &out, &errOut, "o", "cs-principles", "ghost", configrepo.RoleTeacher)
		if err == nil || !strings.Contains(err.Error(), "not found") {
			t.Fatalf("err = %v, want a user-not-found error", err)
		}
	})
}

func TestRunStaffRemove(t *testing.T) {
	mock := &staffMock{classroomJSON: classroomWithStaffTeams}
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runStaffRemove(client, &out, &errOut, "o", "cs-principles", "alice", configrepo.RoleTA); err != nil {
		t.Fatalf("runStaffRemove: %v", err)
	}
	if len(mock.membershipDEL) != 1 || !strings.Contains(mock.membershipDEL[0], "classroom50-cs-principles-ta/memberships/alice") {
		t.Errorf("membership DELETEs = %v, want one for the ta team + alice", mock.membershipDEL)
	}
	if !strings.Contains(out.String(), "removed alice from ta team") {
		t.Errorf("stdout = %q, want a ta remove confirmation", out.String())
	}
}

func TestRunStaffRemove_NonCanonicalRef(t *testing.T) {
	// The recorded ta ref names another team; the removal must hit the
	// canonical team, never the recorded one.
	mock := &staffMock{classroomJSON: `{"schema":"classroom50/classroom/v1","short_name":"cs-principles","org":"o",
  "teams": {"ta": {"id": 9, "slug": "classroom50-other-ta"}}}`}
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runStaffRemove(client, &out, &errOut, "o", "cs-principles", "alice", configrepo.RoleTA); err != nil {
		t.Fatalf("runStaffRemove: %v", err)
	}
	if !strings.Contains(errOut.String(), `records "classroom50-other-ta" as the ta staff team`) {
		t.Errorf("stderr = %q, want a warning naming the rejected ref", errOut.String())
	}
	if len(mock.membershipDEL) != 1 || !strings.Contains(mock.membershipDEL[0], "classroom50-cs-principles-ta/memberships/alice") {
		t.Errorf("membership DELETEs = %v, want alice removed from the canonical ta team only", mock.membershipDEL)
	}
}

func TestParseRole(t *testing.T) {
	cases := []struct {
		in      string
		want    string // string(StaffRole); "" means expect error
		wantErr bool
	}{
		{"", "teacher", false},
		{"teacher", "teacher", false},
		{"TEACHER", "teacher", false},
		{"ta", "ta", false},
		{"TA", "ta", false},
		{"hta", "hta", false},
		{"HTA", "hta", false},
		{"grader", "", true},
	}
	for _, tc := range cases {
		got, err := parseRole(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Errorf("parseRole(%q) err = nil, want an error", tc.in)
			}
			continue
		}
		if err != nil {
			t.Errorf("parseRole(%q) err = %v, want nil", tc.in, err)
			continue
		}
		if string(got) != tc.want {
			t.Errorf("parseRole(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
