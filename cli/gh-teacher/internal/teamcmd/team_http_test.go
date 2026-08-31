package teamcmd

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubtest"
)

const (
	cmdTestOrg        = "acme"
	cmdTestClassroom  = "cs101"
	cmdTestAssignment = "project"
)

// teamCmdServer is a stateful in-memory GitHub for the command-level tests:
// the config repo (assignments.json + roster.csv + a committable teams.json)
// plus the org teams surface.
type teamCmdServer struct {
	mu            sync.Mutex
	teamsJSON     string           // current committed teams.json ("" = absent)
	orgTeams      []map[string]any // GET /orgs/{org}/teams page 1
	createdTeams  []map[string]any // POST bodies
	memberPuts    []string         // "slug/username" PUT order
	memberDeletes []string         // "slug/username" DELETE order
	refPatched    bool
}

func (s *teamCmdServer) assignmentsJSON() string {
	return `{"schema":"` + contract.AssignmentsSchemaV1 + `","assignments":[{` +
		`"slug":"` + cmdTestAssignment + `","name":"Project","mode":"team",` +
		`"autograder":"default","max_group_size":3,"team_formation":"teacher"},` +
		`{"slug":"hello","name":"Hello","mode":"individual","autograder":"default"}]}`
}

func (s *teamCmdServer) rosterCSV() string {
	return configrepo.FullRosterHeader + "\n" +
		"alice,Alice,A,alice@example.com,,1,student\n" +
		"bob,Bob,B,bob@example.com,,2,student\n" +
		"carol,Carol,C,carol@example.com,,3,student\n" +
		"dave,Dave,D,dave@example.com,,4,student\n"
}

func contentsBody(data string) string {
	encoded := base64.StdEncoding.EncodeToString([]byte(data))
	return `{"content":"` + encoded + `","encoding":"base64"}`
}

func (s *teamCmdServer) handler(t *testing.T) http.Handler {
	t.Helper()
	repoBase := "/repos/" + cmdTestOrg + "/classroom50"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		path := r.URL.Path
		switch {
		case path == repoBase && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"default_branch":"main"}`))
		case path == repoBase+"/contents/"+cmdTestClassroom+"/assignments.json" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(contentsBody(s.assignmentsJSON())))
		case path == repoBase+"/contents/"+cmdTestClassroom+"/roster.csv" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(contentsBody(s.rosterCSV())))
		case path == repoBase+"/contents/"+cmdTestClassroom+"/teams.json" && r.Method == http.MethodGet:
			if s.teamsJSON == "" {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write([]byte(contentsBody(s.teamsJSON)))
		case path == "/orgs/"+cmdTestOrg+"/teams" && r.Method == http.MethodGet:
			if r.URL.Query().Get("page") != "1" {
				_, _ = w.Write([]byte(`[]`))
				return
			}
			_ = json.NewEncoder(w).Encode(s.orgTeams)
		case path == "/orgs/"+cmdTestOrg+"/teams" && r.Method == http.MethodPost:
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			s.createdTeams = append(s.createdTeams, body)
			name, _ := body["name"].(string)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": 500 + len(s.createdTeams), "slug": name})
		case path == "/user" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"login":"ms-frizzle","id":9}`))
		case strings.Contains(path, "/memberships/") && r.Method == http.MethodPut:
			s.memberPuts = append(s.memberPuts, strings.TrimPrefix(path, "/orgs/"+cmdTestOrg+"/teams/"))
			_, _ = w.Write([]byte(`{"state":"active"}`))
		case strings.Contains(path, "/memberships/") && r.Method == http.MethodDelete:
			s.memberDeletes = append(s.memberDeletes, strings.TrimPrefix(path, "/orgs/"+cmdTestOrg+"/teams/"))
			w.WriteHeader(http.StatusNoContent)
		case strings.HasSuffix(path, "/members") && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"login": "alice", "id": 1}, {"login": "bob", "id": 2},
			})
		// CommitTree (optimistic tree commit) plumbing:
		case path == repoBase+"/git/refs/heads/main" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"object":{"sha":"parent"}}`))
		case path == repoBase+"/git/commits/parent" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"tree":{"sha":"parent-tree"}}`))
		case path == repoBase+"/git/blobs" && r.Method == http.MethodPost:
			var blob struct {
				Content string `json:"content"`
			}
			_ = json.NewDecoder(r.Body).Decode(&blob)
			decoded, err := base64.StdEncoding.DecodeString(blob.Content)
			if err == nil {
				// The only blob these commands upload is teams.json; capture
				// it as the new committed state.
				s.teamsJSON = string(decoded)
			}
			_, _ = w.Write([]byte(`{"sha":"blob1"}`))
		case path == repoBase+"/git/trees" && r.Method == http.MethodPost:
			_, _ = w.Write([]byte(`{"sha":"tree1"}`))
		case path == repoBase+"/git/commits" && r.Method == http.MethodPost:
			_, _ = w.Write([]byte(`{"sha":"commit1"}`))
		case path == repoBase+"/git/refs/heads/main" && r.Method == http.MethodPatch:
			s.refPatched = true
			_, _ = w.Write([]byte(`{}`))
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	})
}

// The create happy path: team created secret with the record, teacher dropped,
// rostered members added (unknown ones skipped with a warning), and
// teams.json committed with the new record.
func TestRunTeamCreate_HappyPath(t *testing.T) {
	state := &teamCmdServer{}
	server := httptest.NewServer(state.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	scope := teamScope{Org: cmdTestOrg, Classroom: cmdTestClassroom, Assignment: cmdTestAssignment}
	err := runTeamCreate(client, &out, &errOut, scope, "The Sharks", []string{"alice", "bob", "mallory"})
	if err != nil {
		t.Fatalf("runTeamCreate: %v", err)
	}

	slug := contract.GroupTeamName(cmdTestClassroom, cmdTestAssignment, 1)
	if len(state.createdTeams) != 1 {
		t.Fatalf("created %d teams, want 1", len(state.createdTeams))
	}
	created := state.createdTeams[0]
	if created["name"] != slug || created["privacy"] != "secret" {
		t.Errorf("create body = %v, want secret team %q", created, slug)
	}
	wantRecord, _ := configrepo.MarshalGroupDescription(cmdTestClassroom, cmdTestAssignment, "The Sharks")
	if created["description"] != wantRecord {
		t.Errorf("description = %v, want %s", created["description"], wantRecord)
	}
	// The acting teacher (auto-added maintainer) is dropped; rostered members
	// added; mallory (not on the roster) skipped with a warning.
	if len(state.memberDeletes) != 1 || state.memberDeletes[0] != slug+"/memberships/ms-frizzle" {
		t.Errorf("member deletes = %v, want the acting teacher dropped", state.memberDeletes)
	}
	wantPuts := []string{slug + "/memberships/alice", slug + "/memberships/bob"}
	if fmt.Sprint(state.memberPuts) != fmt.Sprint(wantPuts) {
		t.Errorf("member puts = %v, want %v", state.memberPuts, wantPuts)
	}
	if !strings.Contains(errOut.String(), `"mallory" is not on`) {
		t.Errorf("expected a roster skip warning for mallory:\n%s", errOut.String())
	}
	// teams.json committed with the record.
	if !state.refPatched {
		t.Error("teams.json commit never landed (no ref PATCH)")
	}
	file, err := configrepo.ParseTeamsFile([]byte(state.teamsJSON))
	if err != nil {
		t.Fatalf("committed teams.json is invalid: %v\n%s", err, state.teamsJSON)
	}
	teams := file.Assignments[cmdTestAssignment].Teams
	if len(teams) != 1 || teams[0].Slug != slug || teams[0].ID != 501 ||
		teams[0].Name != "The Sharks" || teams[0].Formation != "teacher" {
		t.Errorf("committed record = %+v", teams)
	}
	if fmt.Sprint(teams[0].Members) != fmt.Sprint([]string{"alice", "bob"}) {
		t.Errorf("committed members = %v, want [alice bob]", teams[0].Members)
	}
	if !strings.Contains(out.String(), "created team "+slug) {
		t.Errorf("stdout missing the created-team report:\n%s", out.String())
	}
}

// Creating past max_group_size is refused before any team is created.
func TestRunTeamCreate_EnforcesMaxGroupSize(t *testing.T) {
	state := &teamCmdServer{}
	server := httptest.NewServer(state.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	scope := teamScope{Org: cmdTestOrg, Classroom: cmdTestClassroom, Assignment: cmdTestAssignment}
	err := runTeamCreate(client, &out, &errOut, scope, "", []string{"alice", "bob", "carol", "dave"})
	if err == nil || !strings.Contains(err.Error(), "max_group_size is 3") {
		t.Fatalf("err = %v, want the max_group_size refusal", err)
	}
	if len(state.createdTeams) != 0 {
		t.Errorf("created teams = %v, want none past the cap", state.createdTeams)
	}
}

// The add path enforces the live member count against max_group_size.
func TestRunTeamAdd_SizeCap(t *testing.T) {
	slug := contract.GroupTeamName(cmdTestClassroom, cmdTestAssignment, 1)
	record, _ := configrepo.MarshalGroupDescription(cmdTestClassroom, cmdTestAssignment, "")
	state := &teamCmdServer{
		orgTeams: []map[string]any{{"id": 501, "slug": slug, "description": record}},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The live team already sits at the cap of 3.
		if strings.HasSuffix(r.URL.Path, "/members") && r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"login": "bob", "id": 2}, {"login": "carol", "id": 3}, {"login": "dave", "id": 4},
			})
			return
		}
		state.handler(t).ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out bytes.Buffer
	scope := teamScope{Org: cmdTestOrg, Classroom: cmdTestClassroom, Assignment: cmdTestAssignment}
	err := runTeamAdd(client, &out, scope, "1", "alice")
	if err == nil || !strings.Contains(err.Error(), "is full") {
		t.Fatalf("err = %v, want the team-full refusal", err)
	}
	if len(state.memberPuts) != 0 {
		t.Errorf("member puts = %v, want none past the cap", state.memberPuts)
	}
}

// A non-team assignment is refused with the exact mode-naming error.
func TestRunTeamList_RejectsNonTeamAssignment(t *testing.T) {
	state := &teamCmdServer{}
	server := httptest.NewServer(state.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out bytes.Buffer
	err := runTeamList(client, &out, teamScope{Org: cmdTestOrg, Classroom: cmdTestClassroom, Assignment: "hello"})
	if err == nil || err.Error() != `assignment "hello" is not a team assignment (mode individual)` {
		t.Fatalf("err = %v, want the not-a-team-assignment message", err)
	}
}

// The list happy path renders counters, members, size against the cap, and
// snapshot drift.
func TestRunTeamList_HappyPath(t *testing.T) {
	slug := contract.GroupTeamName(cmdTestClassroom, cmdTestAssignment, 1)
	record, _ := configrepo.MarshalGroupDescription(cmdTestClassroom, cmdTestAssignment, "The Sharks")
	state := &teamCmdServer{
		orgTeams: []map[string]any{{"id": 501, "slug": slug, "description": record}},
		// Snapshot records alice only; the live team has alice+bob -> "+bob".
		teamsJSON: `{"schema":"` + contract.TeamsSchemaV1 + `","assignments":{"` + cmdTestAssignment + `":{"teams":[` +
			`{"slug":"` + slug + `","id":501,"name":"The Sharks","members":["alice"],"formation":"teacher"}]}}}`,
	}
	server := httptest.NewServer(state.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out bytes.Buffer
	scope := teamScope{Org: cmdTestOrg, Classroom: cmdTestClassroom, Assignment: cmdTestAssignment}
	if err := runTeamList(client, &out, scope); err != nil {
		t.Fatalf("runTeamList: %v", err)
	}
	rendered := out.String()
	for _, want := range []string{"GROUP", "The Sharks", "alice, bob", "2/3", "+bob"} {
		if !strings.Contains(rendered, want) {
			t.Errorf("list output missing %q:\n%s", want, rendered)
		}
	}
}
