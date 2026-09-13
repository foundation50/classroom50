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

	"github.com/foundation50/gh-teacher/internal/githubtest"
)

// classroomServer fakes a config repo with the given classroom.json bodies
// (short-name -> JSON; a nil body means the dir exists without the file) and
// the org's team listing (slug -> id/privacy).
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
		case path == "/orgs/"+org+"/teams" && r.Method == http.MethodGet:
			if teams == nil {
				w.WriteHeader(http.StatusInternalServerError)
				_, _ = w.Write([]byte(`{"message":"boom"}`))
				return
			}
			list := make([]map[string]any, 0, len(teams))
			if r.URL.Query().Get("page") == "1" {
				for slug, tm := range teams {
					list = append(list, map[string]any{"id": tm.id, "slug": slug, "privacy": tm.privacy})
				}
			}
			_ = json.NewEncoder(w).Encode(list)
		case strings.HasPrefix(path, "/orgs/"+org+"/teams/") && r.Method == http.MethodPatch:
			slug := strings.TrimPrefix(path, "/orgs/"+org+"/teams/")
			if slug == "classroom50-stuck-teacher" {
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"message":"nope"}`))
				return
			}
			if slug == "classroom50-throttled-teacher" {
				w.Header().Set("Retry-After", "60")
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"message":"You have exceeded a secondary rate limit"}`))
				return
			}
			patched = append(patched, slug)
			_, _ = w.Write([]byte(`{}`))
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

// A classroom whose head TA pointed the ta ref at the student team: the slug
// walk ignores the teams block entirely, so the tampering has no effect.
const csClassroom = `{"schema":"classroom50/classroom/v1","short_name":"cs","org":"cs50-fall-2026",
 "team":{"id":100,"slug":"classroom50-cs"},
 "teams":{"teacher":{"id":11,"slug":"classroom50-cs-teacher"},"hta":{"id":12,"slug":"classroom50-cs-hta"},
          "ta":{"id":100,"slug":"classroom50-cs"}}}`

func TestCollectStaffTeamSlugs(t *testing.T) {
	t.Run("fresh org without a config repo yields nothing, no error", func(t *testing.T) {
		server, _ := classroomServer(t, nil, nil, true)
		slugs, err := CollectStaffTeamSlugs(githubtest.NewTestClient(t, server), org)
		if err != nil || slugs != nil {
			t.Errorf("slugs=%v err=%v, want nil/nil", slugs, err)
		}
	})

	t.Run("derives every role's slug per classroom; skips dirs without classroom.json", func(t *testing.T) {
		server, _ := classroomServer(t, map[string]*string{"cs": str(csClassroom), "empty": nil}, nil, false)
		slugs, err := CollectStaffTeamSlugs(githubtest.NewTestClient(t, server), org)
		if err != nil {
			t.Fatalf("CollectStaffTeamSlugs: %v", err)
		}
		want := []string{"classroom50-cs-teacher", "classroom50-cs-hta", "classroom50-cs-ta"}
		if strings.Join(slugs, ",") != strings.Join(want, ",") {
			t.Errorf("slugs = %v, want %v", slugs, want)
		}
	})

	t.Run("a classroom.json read failure is an error, not a shorter list", func(t *testing.T) {
		server, _ := classroomServer(t, map[string]*string{"cs": str(csClassroom), "bad": str("BOOM")}, nil, false)
		_, err := CollectStaffTeamSlugs(githubtest.NewTestClient(t, server), org)
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
		"classroom50-cs-teacher":    {11, "secret"},
		"classroom50-cs-hta":        {120, "closed"},
		"classroom50-stuck-teacher": {31, "secret"}, // PATCH is refused
	}, false)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	ids, err := PrepareStaffTeams(client, &out, &errOut, org, []string{
		"classroom50-cs-teacher",
		"classroom50-cs-hta",
		"classroom50-cs-ta", // role never staffed: no team
		"classroom50-stuck-teacher",
	})
	if err != nil {
		t.Fatalf("PrepareStaffTeams: %v", err)
	}
	// The secret team is made visible and counted; the live id is what goes on
	// the ruleset; a missing team is simply absent; a team that stays secret
	// is left off (GitHub would 422 the PUT) with a warning.
	if !equalInt64s(ids, []int64{11, 120}) {
		t.Errorf("ids = %v, want [11 120]", ids)
	}
	if p := patched(); len(p) != 1 || p[0] != "classroom50-cs-teacher" {
		t.Errorf("patched = %v, want only the secret team", p)
	}
	if !strings.Contains(out.String(), "classroom50-cs-teacher is now visible") {
		t.Errorf("stdout should report the visibility change: %q", out.String())
	}
	if !strings.Contains(errOut.String(), `could not make staff team "classroom50-stuck-teacher" visible`) {
		t.Errorf("missing PATCH-failure warning: %q", errOut.String())
	}

	t.Run("a rate-limited PATCH is an error, not a shorter list", func(t *testing.T) {
		// Mirrors the web: a throttled PATCH says nothing about the team, so
		// Reconcile must fall back to the current list rather than drop it.
		server, _ := classroomServer(t, nil, map[string]struct {
			id      int64
			privacy string
		}{"classroom50-throttled-teacher": {41, "secret"}}, false)
		_, err := PrepareStaffTeams(githubtest.NewTestClient(t, server), &out, &errOut, org, []string{"classroom50-throttled-teacher"})
		if err == nil || !strings.Contains(err.Error(), "classroom50-throttled-teacher") {
			t.Errorf("err = %v, want a propagated rate-limit error naming the team", err)
		}
	})

	t.Run("a listing failure is an error, not an empty list", func(t *testing.T) {
		server, _ := classroomServer(t, nil, nil, false)
		if _, err := PrepareStaffTeams(githubtest.NewTestClient(t, server), &out, &errOut, org, []string{"classroom50-cs-teacher"}); err == nil {
			t.Error("expected an error when the org team listing fails")
		}
	})
}

// reconcileServer stitches a config repo, the org team listing and the two
// rulesets together for Reconcile. classroomsBroken makes every classroom.json
// read fail; rulesetsBroken makes the ruleset listing fail. It records the
// bodies PUT per ruleset name.
func reconcileServer(t *testing.T, classroomsBroken, rulesetBodyBroken bool) (*httptest.Server, func() map[string]rulesetBody) {
	t.Helper()
	var (
		mu   sync.Mutex
		puts = map[string]rulesetBody{}
	)
	cs := csClassroom
	if classroomsBroken {
		cs = "BOOM"
	}
	configAndTeams, _ := classroomServer(t, map[string]*string{"cs": str(cs)}, map[string]struct {
		id      int64
		privacy string
	}{
		"classroom50-cs-teacher": {11, "secret"},
		"classroom50-cs-hta":     {12, "closed"},
	}, false)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case r.Method == http.MethodGet && path == "/orgs/"+org+"/rulesets":
			_, _ = w.Write([]byte(`[{"id":21,"name":"` + NameSubmissionHistory + `"},{"id":22,"name":"` + NameFeedbackBase + `"}]`))
		case r.Method == http.MethodGet && path == "/orgs/"+org+"/rulesets/22":
			if rulesetBodyBroken {
				w.WriteHeader(http.StatusInternalServerError)
				_, _ = w.Write([]byte(`{"message":"boom"}`))
				return
			}
			_, _ = w.Write([]byte(`{"id":22,"bypass_actors":[{"actor_id":1,"actor_type":"OrganizationAdmin","bypass_mode":"exempt"},{"actor_id":99,"actor_type":"Team","bypass_mode":"exempt"}]}`))
		case r.Method == http.MethodPut && strings.HasPrefix(path, "/orgs/"+org+"/rulesets/"):
			var b rulesetBody
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &b)
			mu.Lock()
			puts[b.Name] = b
			mu.Unlock()
			_, _ = w.Write([]byte(`{}`))
		default:
			// Config repo and team traffic: forward to the classroom fake.
			r2, _ := http.NewRequest(r.Method, configAndTeams.URL+r.URL.RequestURI(), r.Body)
			resp, err := http.DefaultClient.Do(r2)
			if err != nil {
				t.Errorf("forward %s %s: %v", r.Method, path, err)
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			defer func() { _ = resp.Body.Close() }()
			w.WriteHeader(resp.StatusCode)
			_, _ = io.Copy(w, resp.Body)
		}
	}))
	t.Cleanup(server.Close)
	return server, func() map[string]rulesetBody {
		mu.Lock()
		defer mu.Unlock()
		out := make(map[string]rulesetBody, len(puts))
		for k, v := range puts {
			out[k] = v
		}
		return out
	}
}

func TestReconcile(t *testing.T) {
	t.Run("rebuilds the bypass list from the live staff teams", func(t *testing.T) {
		server, puts := reconcileServer(t, false, false)
		var out, errOut bytes.Buffer
		ready, kept, err := Reconcile(githubtest.NewTestClient(t, server), &out, &errOut, org)
		if err != nil || !ready || kept {
			t.Fatalf("ready=%v kept=%v err=%v, want true/false/nil", ready, kept, err)
		}
		// Stale team 99 is dropped; the two live teams (one just made
		// visible) are exempted. The ta role has no team and is simply absent.
		if got := actorTeamIDs(puts()[NameFeedbackBase].BypassActors); !equalInt64s(got, []int64{11, 12}) {
			t.Errorf("feedback-base team actors = %v, want [11 12]", got)
		}
		if _, ok := puts()[NameSubmissionHistory]; !ok {
			t.Error("submission-history should be reconciled too")
		}
	})

	t.Run("unreadable classrooms keep the current bypass list", func(t *testing.T) {
		server, puts := reconcileServer(t, true, false)
		var out, errOut bytes.Buffer
		ready, kept, err := Reconcile(githubtest.NewTestClient(t, server), &out, &errOut, org)
		if err != nil || !ready || kept {
			t.Fatalf("ready=%v kept=%v err=%v, want true/false/nil", ready, kept, err)
		}
		if got := actorTeamIDs(puts()[NameFeedbackBase].BypassActors); !equalInt64s(got, []int64{99}) {
			t.Errorf("feedback-base team actors = %v, want the existing [99]", got)
		}
		if !strings.Contains(errOut.String(), "keeps its current teams") {
			t.Errorf("expected the fallback warning, got %q", errOut.String())
		}
	})

	t.Run("neither source readable leaves the feedback-base ruleset untouched", func(t *testing.T) {
		server, puts := reconcileServer(t, true, true)
		var out, errOut bytes.Buffer
		ready, kept, err := Reconcile(githubtest.NewTestClient(t, server), &out, &errOut, org)
		if err != nil || !ready || !kept {
			t.Fatalf("ready=%v kept=%v err=%v, want true/true/nil", ready, kept, err)
		}
		if _, ok := puts()[NameFeedbackBase]; ok {
			t.Error("feedback-base must not be PUT when its bypass list would be wiped")
		}
		if _, ok := puts()[NameSubmissionHistory]; !ok {
			t.Error("submission-history should still be reconciled")
		}
		if !strings.Contains(errOut.String(), "left unchanged") {
			t.Errorf("expected the left-unchanged warning, got %q", errOut.String())
		}
	})
}
