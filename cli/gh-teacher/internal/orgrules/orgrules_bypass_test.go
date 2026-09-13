package orgrules

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubtest"
)

func TestUpdateFeedbackBaseBypassTeams_UpgradesAlwaysEntry(t *testing.T) {
	// Team 10 is listed but `always`, the owner is `always` too: both are
	// rebuilt as exempt even though 10 is "already on the list".
	var (
		mu  sync.Mutex
		put *rulesetBody
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/orgs/"+org+"/rulesets":
			_, _ = w.Write([]byte(`[{"id":22,"name":"` + NameFeedbackBase + `"}]`))
		case r.Method == http.MethodGet && r.URL.Path == "/orgs/"+org+"/rulesets/22":
			_, _ = w.Write([]byte(`{"id":22,"bypass_actors":[{"actor_id":1,"actor_type":"OrganizationAdmin","bypass_mode":"always"},{"actor_id":10,"actor_type":"Team","bypass_mode":"always"}]}`))
		case r.Method == http.MethodPut && r.URL.Path == "/orgs/"+org+"/rulesets/22":
			var b rulesetBody
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &b)
			put = &b
			_, _ = w.Write([]byte(`{}`))
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	ok, err := updateFeedbackBaseBypassTeams(client, org, teamChange{add: []int64{10}})
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v, want true/nil", ok, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if put == nil {
		t.Fatal("expected a PUT: the listed team is not exempt")
	}
	want := []bypassActor{
		{ActorID: 1, ActorType: "OrganizationAdmin", BypassMode: "exempt"},
		{ActorID: 10, ActorType: "Team", BypassMode: "exempt"},
	}
	if !equalActors(put.BypassActors, want) {
		t.Errorf("PUT actors = %+v, want %+v", put.BypassActors, want)
	}
}

func TestUpdateFeedbackBaseBypassTeams_RemoveAbsentIsANoop(t *testing.T) {
	server, put := bypassServer(t, []int64{10}, true)
	client := githubtest.NewTestClient(t, server)
	ok, err := updateFeedbackBaseBypassTeams(client, org, teamChange{remove: []int64{99}})
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v, want true/nil", ok, err)
	}
	if put() != nil {
		t.Error("no PUT expected when the team to drop was never listed")
	}
}

func TestExemptAndRevokeStaffTeams_Warnings(t *testing.T) {
	teams := []configrepo.TeamRef{{ID: 5, Slug: "classroom50-cs-ta"}}

	// Not installed: a warning pointing at init, no PUT.
	server, put := bypassServer(t, nil, false)
	client := githubtest.NewTestClient(t, server)
	var errOut bytes.Buffer
	ExemptStaffTeams(client, &errOut, org, teams)
	if !strings.Contains(errOut.String(), "not installed") || put() != nil {
		t.Errorf("not-installed: errOut=%q put=%v", errOut.String(), put() != nil)
	}

	// Listing fails: a warning carrying the error, never a panic or exit.
	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"message":"boom"}`))
	}))
	t.Cleanup(failing.Close)
	client = githubtest.NewTestClient(t, failing)
	errOut.Reset()
	ExemptStaffTeams(client, &errOut, org, teams)
	if !strings.Contains(errOut.String(), "could not add") {
		t.Errorf("exempt failure warning missing: %q", errOut.String())
	}
	errOut.Reset()
	RevokeStaffTeams(client, &errOut, org, teams)
	if !strings.Contains(errOut.String(), "could not drop") {
		t.Errorf("revoke failure warning missing: %q", errOut.String())
	}

	// Empty input never touches the network.
	client = githubtest.NewTestClient(t, httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
	})))
	ExemptStaffTeams(client, &errOut, org, nil)
	RevokeStaffTeams(client, &errOut, org, []configrepo.TeamRef{{ID: 0, Slug: "x"}})
}

// classroomServer fakes a config repo with the given classroom.json bodies
// (short-name -> JSON; a nil body means the dir exists without the file) and
// the given team GETs (slug -> privacy; absent -> 404).
func classroomServer(t *testing.T, classrooms map[string]*string, teams map[string]struct {
	id      int64
	privacy string
}, repoMissing bool) (*httptest.Server, func() []string) {
	t.Helper()
	var (
		mu      sync.Mutex
		patched []string
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		path := r.URL.Path
		switch {
		case path == "/repos/"+org+"/classroom50" && r.Method == http.MethodGet:
			if repoMissing {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"message":"Not Found"}`))
				return
			}
			_, _ = w.Write([]byte(`{"default_branch":"main"}`))
		case path == "/repos/"+org+"/classroom50/contents" && r.Method == http.MethodGet:
			var sb strings.Builder
			sb.WriteByte('[')
			i := 0
			for name := range classrooms {
				if i > 0 {
					sb.WriteByte(',')
				}
				sb.WriteString(`{"name":"` + name + `","type":"dir"}`)
				i++
			}
			sb.WriteString(`,{"name":"README.md","type":"file"}]`)
			_, _ = w.Write([]byte(sb.String()))
		case strings.HasPrefix(path, "/repos/"+org+"/classroom50/contents/") && r.Method == http.MethodGet:
			short := strings.TrimSuffix(strings.TrimPrefix(path, "/repos/"+org+"/classroom50/contents/"), "/classroom.json")
			b, ok := classrooms[short]
			if !ok || b == nil {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"message":"Not Found"}`))
				return
			}
			if *b == "BOOM" {
				w.WriteHeader(http.StatusInternalServerError)
				_, _ = w.Write([]byte(`{"message":"boom"}`))
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]string{
				"content": base64.StdEncoding.EncodeToString([]byte(*b)), "encoding": "base64",
			})
		case strings.HasPrefix(path, "/orgs/"+org+"/teams/"):
			slug := strings.TrimPrefix(path, "/orgs/"+org+"/teams/")
			tm, ok := teams[slug]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"message":"Not Found"}`))
				return
			}
			if r.Method == http.MethodPatch {
				patched = append(patched, slug)
				_, _ = w.Write([]byte(`{}`))
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": tm.id, "slug": slug, "privacy": tm.privacy})
		default:
			t.Errorf("unexpected request: %s %s", r.Method, path)
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	t.Cleanup(server.Close)
	return server, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), patched...)
	}
}

func str(s string) *string { return &s }

const csClassroom = `{"schema":"classroom50/classroom/v1","short_name":"cs","org":"cs50-fall-2026",
 "team":{"id":100,"slug":"classroom50-cs"},
 "teams":{"teacher":{"id":11,"slug":"classroom50-cs-teacher"},"hta":{"id":12,"slug":"classroom50-cs-hta"},
          "ta":{"id":100,"slug":"classroom50-cs"}}}`

func TestCollectStaffTeams(t *testing.T) {
	t.Run("fresh org without a config repo yields nothing, no error", func(t *testing.T) {
		server, _ := classroomServer(t, nil, nil, true)
		var errOut bytes.Buffer
		refs, err := CollectStaffTeams(githubtest.NewTestClient(t, server), &errOut, org)
		if err != nil || refs != nil || errOut.Len() != 0 {
			t.Errorf("refs=%v err=%v errOut=%q, want nil/nil/empty", refs, err, errOut.String())
		}
	})

	t.Run("drops a non-canonical ref with a warning; skips dirs without classroom.json", func(t *testing.T) {
		server, _ := classroomServer(t, map[string]*string{"cs": str(csClassroom), "empty": nil}, nil, false)
		var errOut bytes.Buffer
		refs, err := CollectStaffTeams(githubtest.NewTestClient(t, server), &errOut, org)
		if err != nil {
			t.Fatalf("CollectStaffTeams: %v", err)
		}
		if got := teamIDs(refs); !equalInt64s(got, []int64{11, 12}) {
			t.Errorf("ids = %v, want [11 12] (student team named as ta refused)", got)
		}
		if !strings.Contains(errOut.String(), `"classroom50-cs" as the ta staff team`) {
			t.Errorf("expected a warning naming the refused ref, got %q", errOut.String())
		}
	})

	t.Run("a classroom.json read failure is an error, not a shorter list", func(t *testing.T) {
		server, _ := classroomServer(t, map[string]*string{"cs": str(csClassroom), "bad": str("BOOM")}, nil, false)
		var errOut bytes.Buffer
		_, err := CollectStaffTeams(githubtest.NewTestClient(t, server), &errOut, org)
		if err == nil || !strings.Contains(err.Error(), "bad/classroom.json") {
			t.Errorf("err = %v, want a read error naming the classroom", err)
		}
	})
}

func TestPrepareStaffTeams(t *testing.T) {
	server, patched := classroomServer(t, nil, map[string]struct {
		id      int64
		privacy string
	}{
		"classroom50-cs-teacher": {11, "secret"},
		"classroom50-cs-hta":     {120, "closed"}, // re-created: live id != recorded 12
	}, false)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	ids := PrepareStaffTeams(client, &out, &errOut, org, []configrepo.TeamRef{
		{ID: 11, Slug: "classroom50-cs-teacher"},
		{ID: 12, Slug: "classroom50-cs-hta"},
		{ID: 13, Slug: "classroom50-cs-ta"}, // deleted on GitHub
	})
	// The secret team is made visible; the drifted team contributes its LIVE
	// id; the deleted team is left off so the PUT can't 422 on it.
	if !equalInt64s(ids, []int64{11, 120}) {
		t.Errorf("ids = %v, want [11 120]", ids)
	}
	if p := patched(); len(p) != 1 || p[0] != "classroom50-cs-teacher" {
		t.Errorf("patched = %v, want only the secret team", p)
	}
	if !strings.Contains(out.String(), "classroom50-cs-teacher is now visible") {
		t.Errorf("stdout should report the visibility change: %q", out.String())
	}
	if !strings.Contains(errOut.String(), `"classroom50-cs-ta" is recorded in classroom.json but no longer exists`) {
		t.Errorf("missing deleted-team warning: %q", errOut.String())
	}
	if !strings.Contains(errOut.String(), "has id 120 on GitHub but classroom.json records 12") {
		t.Errorf("missing drift warning: %q", errOut.String())
	}
}
