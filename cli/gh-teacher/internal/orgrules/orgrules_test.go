package orgrules

import (
	"bytes"
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

const org = "cs50-fall-2026"

func TestBodies_FeedbackBaseIsAHardLockWithExemptStaff(t *testing.T) {
	bodies := bodies([]int64{30, 10, 20, 10, 0, -1})
	byName := map[string]rulesetBody{}
	for _, b := range bodies {
		byName[b.Name] = b
		if b.Target != "branch" || b.Enforcement != "active" {
			t.Errorf("%s: target/enforcement = %q/%q", b.Name, b.Target, b.Enforcement)
		}
		if got := b.Conditions.RepositoryName.Include; len(got) != 1 || got[0] != "~ALL" {
			t.Errorf("%s: repo condition = %v, want ~ALL", b.Name, got)
		}
	}

	main := byName[NameSubmissionHistory]
	if got := ruleTypes(main.Rules); !equalStringSet(got, []string{"non_fast_forward", "deletion"}) {
		t.Errorf("submission-history rules = %v, want non_fast_forward+deletion", got)
	}
	if main.Conditions.RefName.Include[0] != "~DEFAULT_BRANCH" {
		t.Errorf("submission-history ref = %v, want ~DEFAULT_BRANCH", main.Conditions.RefName.Include)
	}
	// Rewriting a student's history stays a deliberate, audited bypass.
	wantMain := []bypassActor{{ActorID: 1, ActorType: "OrganizationAdmin", BypassMode: "always"}}
	if !equalActors(main.BypassActors, wantMain) {
		t.Errorf("submission-history bypass = %+v, want %+v", main.BypassActors, wantMain)
	}

	fb := byName[NameFeedbackBase]
	// `update` (not a review rule) is what keeps a student from ever moving
	// the frozen base; creation is left allowed for accept and the runner.
	if got := ruleTypes(fb.Rules); !equalStringSet(got, []string{"update", "deletion"}) {
		t.Errorf("feedback-base rules = %v, want update+deletion", got)
	}
	if fb.Conditions.RefName.Include[0] != "refs/heads/feedback" {
		t.Errorf("feedback-base ref = %v, want refs/heads/feedback", fb.Conditions.RefName.Include)
	}
	// Owners and staff teams are exempt (rules not evaluated → plain Merge
	// button); team IDs deduped, sorted, non-positive dropped.
	wantFB := []bypassActor{
		{ActorID: 1, ActorType: "OrganizationAdmin", BypassMode: "exempt"},
		{ActorID: 10, ActorType: "Team", BypassMode: "exempt"},
		{ActorID: 20, ActorType: "Team", BypassMode: "exempt"},
		{ActorID: 30, ActorType: "Team", BypassMode: "exempt"},
	}
	if !equalActors(fb.BypassActors, wantFB) {
		t.Errorf("feedback-base bypass = %+v, want %+v", fb.BypassActors, wantFB)
	}
}

func TestBodies_NoStaffTeamsStillExemptsOwners(t *testing.T) {
	for _, b := range bodies(nil) {
		if b.Name == NameFeedbackBase {
			want := []bypassActor{{ActorID: 1, ActorType: "OrganizationAdmin", BypassMode: "exempt"}}
			if !equalActors(b.BypassActors, want) {
				t.Errorf("bypass = %+v, want owners only", b.BypassActors)
			}
		}
	}
}

func TestEnsure_CreatesBoth(t *testing.T) {
	// No existing rulesets → one POST per ruleset carrying the staff teams.
	var (
		mu       sync.Mutex
		posted   []rulesetBody
		listHits int
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Path != "/orgs/"+org+"/rulesets" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		switch r.Method {
		case http.MethodGet:
			listHits++
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`[]`))
		case http.MethodPost:
			var body rulesetBody
			raw, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Errorf("bad POST body: %v", err)
			}
			posted = append(posted, body)
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id": 1}`))
		default:
			t.Errorf("unexpected method: %s", r.Method)
		}
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	ready, err := Ensure(client, &out, &errOut, org, []int64{7, 8})
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if !ready {
		t.Errorf("ready = false, want true when both rulesets are created")
	}
	mu.Lock()
	defer mu.Unlock()
	if listHits != 1 {
		t.Errorf("list calls = %d, want 1", listHits)
	}
	if len(posted) != 2 {
		t.Fatalf("POSTs = %d, want 2: %#v", len(posted), posted)
	}
	for _, rs := range posted {
		if rs.Name != NameFeedbackBase {
			continue
		}
		if got := actorTeamIDs(rs.BypassActors); !equalInt64s(got, []int64{7, 8}) {
			t.Errorf("POSTed feedback-base team actors = %v, want [7 8]", got)
		}
	}
	if errOut.Len() != 0 {
		t.Errorf("happy path should leave stderr empty, got: %q", errOut.String())
	}
}

func TestEnsure_UpdatesExistingAndRebuildsBypassList(t *testing.T) {
	// Both rulesets present → PUT per ruleset by id, no POST. The PUT body is
	// the full current definition, so a stale bypass list (team 99 from a
	// deleted classroom) is replaced by the supplied set.
	var (
		mu        sync.Mutex
		posts     int
		putPaths  []string
		putBodies []rulesetBody
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.Method {
		case http.MethodGet:
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`[{"id":11,"name":"` + NameSubmissionHistory + `"},{"id":22,"name":"` + NameFeedbackBase + `"}]`))
		case http.MethodPut:
			putPaths = append(putPaths, r.URL.Path)
			var body rulesetBody
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &body)
			putBodies = append(putBodies, body)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{}`))
		case http.MethodPost:
			posts++
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{}`))
		default:
			t.Errorf("unexpected method: %s", r.Method)
		}
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	ready, err := Ensure(client, &out, &errOut, org, []int64{5})
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if !ready {
		t.Errorf("ready = false, want true when rulesets reconcile cleanly")
	}
	mu.Lock()
	defer mu.Unlock()
	if posts != 0 {
		t.Errorf("POSTs = %d, want 0 (both already present)", posts)
	}
	wantPaths := map[string]bool{"/orgs/" + org + "/rulesets/11": true, "/orgs/" + org + "/rulesets/22": true}
	if len(putPaths) != 2 {
		t.Fatalf("PUTs = %v, want 2 (one per ruleset, by id)", putPaths)
	}
	for _, p := range putPaths {
		if !wantPaths[p] {
			t.Errorf("unexpected PUT path %q", p)
		}
	}
	if !strings.Contains(out.String(), "updated to current definition") {
		t.Errorf("stdout should note the rulesets were updated: %q", out.String())
	}
	for _, b := range putBodies {
		if b.Name == NameFeedbackBase {
			if got := actorTeamIDs(b.BypassActors); !equalInt64s(got, []int64{5}) {
				t.Errorf("PUT feedback-base team actors = %v, want [5]", got)
			}
			if b.Conditions.RefName.Include[0] != "refs/heads/feedback" {
				t.Errorf("PUT feedback-base ref = %v", b.Conditions.RefName.Include)
			}
		}
	}
}

func TestEnsure_CreateRejectedWarnsPerRuleset(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`[]`))
			return
		}
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"Upgrade your plan"}`))
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	ready, err := Ensure(client, &out, &errOut, org, nil)
	if err != nil {
		t.Fatalf("should not error on 403: %v", err)
	}
	if ready {
		t.Errorf("ready = true, want false when ruleset creation is rejected")
	}
	if got := strings.Count(errOut.String(), "Warning:"); got != 2 {
		t.Errorf("warnings = %d, want 2 (one per ruleset):\n%s", got, errOut.String())
	}
	if !strings.Contains(errOut.String(), "settings/rules") {
		t.Errorf("warning should point at the org rules settings page: %q", errOut.String())
	}
}

func TestEnsure_ListFailsWarnsButSucceeds(t *testing.T) {
	var (
		mu    sync.Mutex
		posts int
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		if r.Method == http.MethodPost {
			posts++
		}
		mu.Unlock()
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"Not Found"}`))
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	ready, err := Ensure(client, &out, &errOut, org, nil)
	if err != nil {
		t.Fatalf("should not error when listing fails: %v", err)
	}
	if ready {
		t.Errorf("ready = true, want false when listing rulesets fails")
	}
	mu.Lock()
	defer mu.Unlock()
	if posts != 0 {
		t.Errorf("POSTs = %d, want 0 when list fails", posts)
	}
	if !strings.Contains(errOut.String(), "could not list org rulesets") {
		t.Errorf("warning should explain the list failure: %q", errOut.String())
	}
}

// bypassServer fakes an org with the feedback-base ruleset installed carrying
// `teams` on its bypass list and records the PUT body.
func bypassServer(t *testing.T, teams []int64, installed bool) (*httptest.Server, func() *rulesetBody) {
	t.Helper()
	var (
		mu  sync.Mutex
		put *rulesetBody
	)
	actors := feedbackBaseBypassActors(teams)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/orgs/"+org+"/rulesets":
			w.WriteHeader(http.StatusOK)
			if installed {
				_, _ = w.Write([]byte(`[{"id":22,"name":"` + NameFeedbackBase + `"}]`))
			} else {
				_, _ = w.Write([]byte(`[]`))
			}
		case r.Method == http.MethodGet && r.URL.Path == "/orgs/"+org+"/rulesets/22":
			payload, _ := json.Marshal(map[string]any{"id": 22, "name": NameFeedbackBase, "bypass_actors": actors})
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(payload)
		case r.Method == http.MethodPut && r.URL.Path == "/orgs/"+org+"/rulesets/22":
			var body rulesetBody
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &body)
			put = &body
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{}`))
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	t.Cleanup(server.Close)
	return server, func() *rulesetBody {
		mu.Lock()
		defer mu.Unlock()
		return put
	}
}

func TestUpdateFeedbackBaseBypassTeams_MergesAddAndRemove(t *testing.T) {
	// Existing [10 20]; add 30, drop 10 → PUT [20 30] plus the owner entry,
	// full definition (rules and conditions intact).
	server, put := bypassServer(t, []int64{10, 20}, true)
	client := githubtest.NewTestClient(t, server)

	ok, err := updateFeedbackBaseBypassTeams(client, org, teamChange{add: []int64{30}, remove: []int64{10}})
	if err != nil {
		t.Fatalf("UpdateFeedbackBaseBypassTeams: %v", err)
	}
	if !ok {
		t.Fatal("ok = false, want true when the ruleset is installed")
	}
	body := put()
	if body == nil {
		t.Fatal("no PUT recorded")
	}
	if got := actorTeamIDs(body.BypassActors); !equalInt64s(got, []int64{20, 30}) {
		t.Errorf("team actors = %v, want [20 30]", got)
	}
	if body.BypassActors[0].ActorType != "OrganizationAdmin" || body.BypassActors[0].BypassMode != "exempt" {
		t.Errorf("owner entry = %+v, want exempt OrganizationAdmin first", body.BypassActors[0])
	}
	if got := ruleTypes(body.Rules); !equalStringSet(got, []string{"update", "deletion"}) {
		t.Errorf("PUT must carry the full definition; rules = %v", got)
	}
}

func TestUpdateFeedbackBaseBypassTeams_AlreadyExemptSkipsThePut(t *testing.T) {
	// Every classroom visit re-asserts its staff teams; when they're all
	// already exempt nothing is written, so the pass stays cheap.
	server, put := bypassServer(t, []int64{10, 20}, true)
	client := githubtest.NewTestClient(t, server)

	ok, err := updateFeedbackBaseBypassTeams(client, org, teamChange{add: []int64{20, 10}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ok {
		t.Error("ok = false, want true (ruleset installed and already complete)")
	}
	if put() != nil {
		t.Error("no PUT expected when every team is already exempt")
	}
}

func TestUpdateFeedbackBaseBypassTeams_NotInstalledIsANoop(t *testing.T) {
	server, put := bypassServer(t, nil, false)
	client := githubtest.NewTestClient(t, server)

	ok, err := updateFeedbackBaseBypassTeams(client, org, teamChange{add: []int64{30}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Error("ok = true, want false when init has not installed the ruleset")
	}
	if put() != nil {
		t.Error("no PUT expected when the ruleset is missing")
	}
}

func TestExistingFeedbackBaseTeamIDs(t *testing.T) {
	server, _ := bypassServer(t, []int64{4, 2}, true)
	client := githubtest.NewTestClient(t, server)
	got, err := ExistingFeedbackBaseTeamIDs(client, org)
	if err != nil {
		t.Fatalf("ExistingFeedbackBaseTeamIDs: %v", err)
	}
	if !equalInt64s(got, []int64{2, 4}) {
		t.Errorf("ids = %v, want [2 4]", got)
	}
}

func TestCanonicalStaffTeamRefs(t *testing.T) {
	if got := CanonicalStaffTeamRefs("cs", nil); got != nil {
		t.Errorf("nil teams → %v, want nil", got)
	}
	refs := &configrepo.StaffTeamsRef{
		Teacher: &configrepo.TeamRef{ID: 1, Slug: "classroom50-cs-teacher"},
		// Zero id: never a valid actor.
		HeadTA: &configrepo.TeamRef{ID: 0, Slug: "classroom50-cs-hta"},
		// A head TA pointing `teams.ta` at the student team must not turn
		// the student team into a bypass actor.
		TA: &configrepo.TeamRef{ID: 3, Slug: "classroom50-cs"},
	}
	got := CanonicalStaffTeamRefs("cs", refs)
	if len(got) != 1 || got[0].ID != 1 {
		t.Errorf("refs = %+v, want only the canonical teacher team", got)
	}
}

func ruleTypes(rules []rule) []string {
	out := make([]string, len(rules))
	for i, r := range rules {
		out[i] = r.Type
	}
	return out
}

func actorTeamIDs(actors []bypassActor) []int64 {
	var out []int64
	for _, a := range actors {
		if a.ActorType == "Team" {
			out = append(out, a.ActorID)
		}
	}
	return out
}

func equalActors(a, b []bypassActor) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func equalInt64s(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func equalStringSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	seen := map[string]int{}
	for _, s := range a {
		seen[s]++
	}
	for _, s := range b {
		seen[s]--
	}
	for _, n := range seen {
		if n != 0 {
			return false
		}
	}
	return true
}

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
