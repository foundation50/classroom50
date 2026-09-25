package groupcmd

import (
	"bytes"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubtest"
)

func TestBuildRows_JoinsRosterAndOrders(t *testing.T) {
	roster := []configrepo.RosterRow{
		{Username: "alice", FirstName: "Alice", LastName: "Ada", Email: "alice@x.edu", Section: "A", GitHubID: 1, Role: "student"},
		{Username: "bob", FirstName: "Bob", LastName: "Babbage", Email: "bob@x.edu", Section: "B", GitHubID: 2, Role: "student"},
		{Username: "Cat", FirstName: "Cat", LastName: "Curry", Role: "ta"},
	}
	rows := buildRows([]groupSource{
		{Group: "group-10", Name: "Tens", TeamSlug: "slug-10", Repo: "cs-hw1-group-10", Members: logins("bob")},
		// Founder repeats as a collaborator; case differs. Alice renamed her
		// account, so her live login no longer matches roster.csv but her id does.
		{Group: "group-2", Name: "Twos", TeamSlug: "slug-2", Repo: "cs-hw1-group-2", Members: []member{
			{Login: "bob"}, {Login: "alice"}, {Login: "ada-lovelace", ID: 1}, {Login: "cat"}, {Login: "stranger", ID: 99},
		}},
		{Group: "group-3", Name: "Empty", TeamSlug: "slug-3", Members: []member{}},
		{Group: "group-1", Name: "Broken", TeamSlug: "slug-1", Repo: "cs-hw1-group-1", Members: nil},
	}, roster)

	got := make([]string, 0, len(rows))
	for _, r := range rows {
		got = append(got, strings.Join(r.cells(), "|"))
	}
	want := []string{
		"group-1|Broken|slug-1|cs-hw1-group-1||||||||" + "|" + contract.GroupMembershipNoteUnreadable,
		"group-2|Twos|slug-2|cs-hw1-group-2|alice|Alice|Ada|alice@x.edu|A|1|student|yes|",
		"group-2|Twos|slug-2|cs-hw1-group-2|bob|Bob|Babbage|bob@x.edu|B|2|student|yes|",
		"group-2|Twos|slug-2|cs-hw1-group-2|Cat|Cat|Curry|||" + "|ta|yes|",
		"group-2|Twos|slug-2|cs-hw1-group-2|stranger|||||||no|",
		"group-3|Empty|slug-3||||||||||",
		"group-10|Tens|slug-10|cs-hw1-group-10|bob|Bob|Babbage|bob@x.edu|B|2|student|yes|",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d rows, want %d:\n%s", len(got), len(want), strings.Join(got, "\n"))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("row %d:\n got %q\nwant %q", i, got[i], want[i])
		}
	}
}

func TestBuildRows_LegacyGroupLeavesTeamBlockBlank(t *testing.T) {
	rows := buildRows([]groupSource{
		{Group: "alice", Repo: "cs-hw1-alice", Members: logins("alice", "bob")},
	}, []configrepo.RosterRow{{Username: "alice"}, {Username: "bob"}})
	if len(rows) != 2 || rows[0].GroupName != "" || rows[0].TeamSlug != "" || rows[0].Repo != "cs-hw1-alice" {
		t.Fatalf("rows = %+v", rows)
	}
}

// logins builds id-less members, as a legacy founder arrives.
func logins(names ...string) []member {
	out := make([]member, 0, len(names))
	for _, n := range names {
		out = append(out, member{Login: n})
	}
	return out
}

func TestNaturalLess(t *testing.T) {
	cases := [][2]string{{"group-2", "group-10"}, {"alice", "bob"}, {"group-1", "group-1a"}, {"a9", "a10"}}
	for _, c := range cases {
		if !naturalLess(c[0], c[1]) || naturalLess(c[1], c[0]) {
			t.Errorf("want %q < %q", c[0], c[1])
		}
	}
}

func TestSiblingPrefixes(t *testing.T) {
	entries := []assignment.AssignmentEntry{
		{Slug: "hw1"}, {Slug: "hw1-bonus"}, {Slug: "hw2"}, {Slug: "h"},
	}
	got := siblingPrefixes(entries, scope{Classroom: "cs", Assignment: "hw1"})
	// Only a sibling whose prefix EXTENDS ours can over-match; hw2 and h can't.
	if len(got) != 1 || got[0] != "cs-hw1-bonus-" {
		t.Fatalf("siblingPrefixes = %v, want [cs-hw1-bonus-]", got)
	}
	if !hasAnyPrefix("cs-hw1-bonus-alice", got) || hasAnyPrefix("cs-hw1-alice", got) {
		t.Error("hw1-bonus repo must be excluded and hw1's own repo kept")
	}
}

// The column order lives in three places (the contract slice, the struct's
// JSON tags, cells()); pin that they agree.
func TestMemberRow_ColumnOrderMatchesContract(t *testing.T) {
	row := memberRow{
		Group: "group", GroupName: "group_name", TeamSlug: "team_slug", Repo: "repo",
		Username: "username", FirstName: "first_name", LastName: "last_name", Email: "email",
		Section: "section", GitHubID: "github_id", Role: "role", InRoster: "in_roster", Note: "note",
	}
	if got, want := strings.Join(row.cells(), ","), strings.Join(contract.GroupMembershipCSVColumns, ","); got != want {
		t.Fatalf("cells() = %q, want %q", got, want)
	}
	data, err := json.Marshal(row)
	if err != nil {
		t.Fatal(err)
	}
	var keyed map[string]string
	if err := json.Unmarshal(data, &keyed); err != nil {
		t.Fatal(err)
	}
	for _, col := range contract.GroupMembershipCSVColumns {
		if keyed[col] != col {
			t.Errorf("json key %q missing or mis-tagged (got %q)", col, keyed[col])
		}
	}
}

// groupServer is an in-memory GitHub for both modes: the config repo
// (assignments.json + roster.csv), org repos, org teams + members, and per-repo
// collaborators (nil entry = 404).
type groupServer struct {
	mode           string
	orgRepos       []string
	orgTeams       []map[string]any
	membersBySlug  map[string][]string
	collaborators  map[string][]string
	collabFailures map[string]int
	// Repos whose collaborator read answers 403 with the primary-quota header.
	collabThrottled map[string]bool
}

const (
	testOrg        = "acme"
	testClassroom  = "cs101"
	testAssignment = "project"
)

func contents(data string) string {
	return `{"content":"` + base64.StdEncoding.EncodeToString([]byte(data)) + `","encoding":"base64"}`
}

func (s *groupServer) handler(t *testing.T) http.Handler {
	t.Helper()
	repoBase := "/repos/" + testOrg + "/classroom50"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		page := r.URL.Query().Get("page")
		switch {
		case path == repoBase && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"default_branch":"main"}`))
		case path == repoBase+"/contents/"+testClassroom+"/assignments.json":
			_, _ = w.Write([]byte(contents(`{"schema":"` + contract.AssignmentsSchemaV1 + `","assignments":[` +
				`{"slug":"` + testAssignment + `","name":"Project","mode":"` + s.mode + `","autograder":"default"` +
				map[string]string{
					"team":       `,"max_group_size":3,"team_formation":"teacher"`,
					"group":      `,"max_group_size":3`,
					"individual": ``,
				}[s.mode] + `},` +
				`{"slug":"project-bonus","name":"Bonus","mode":"individual","autograder":"default"}]}`)))
		case path == repoBase+"/contents/"+testClassroom+"/roster.csv":
			_, _ = w.Write([]byte(contents(configrepo.FullRosterHeader + "\n" +
				"alice,Alice,Ada,alice@x.edu,A,1,student\n" +
				"bob,Bob,Babbage,bob@x.edu,B,2,student\n")))
		case path == "/orgs/"+testOrg+"/repos":
			if page != "1" {
				_, _ = w.Write([]byte(`[]`))
				return
			}
			repos := make([]map[string]any, 0, len(s.orgRepos))
			for _, name := range s.orgRepos {
				repos = append(repos, map[string]any{"name": name})
			}
			_ = json.NewEncoder(w).Encode(repos)
		case path == "/orgs/"+testOrg+"/teams":
			if page != "1" {
				_, _ = w.Write([]byte(`[]`))
				return
			}
			_ = json.NewEncoder(w).Encode(s.orgTeams)
		case strings.HasPrefix(path, "/orgs/"+testOrg+"/teams/") && strings.HasSuffix(path, "/members"):
			slug := strings.TrimSuffix(strings.TrimPrefix(path, "/orgs/"+testOrg+"/teams/"), "/members")
			members := make([]map[string]any, 0)
			for i, login := range s.membersBySlug[slug] {
				members = append(members, map[string]any{"login": login, "id": i + 1})
			}
			_ = json.NewEncoder(w).Encode(members)
		case strings.HasPrefix(path, "/repos/"+testOrg+"/") && strings.HasSuffix(path, "/collaborators"):
			repo := strings.TrimSuffix(strings.TrimPrefix(path, "/repos/"+testOrg+"/"), "/collaborators")
			if s.collabThrottled[repo] {
				w.Header().Set("X-RateLimit-Remaining", "0")
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"message":"API rate limit exceeded"}`))
				return
			}
			if status, ok := s.collabFailures[repo]; ok {
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"message":"nope"}`))
				return
			}
			if page != "1" {
				_, _ = w.Write([]byte(`[]`))
				return
			}
			logins := s.collaborators[repo]
			out := make([]map[string]any, 0, len(logins))
			for i, login := range logins {
				out = append(out, map[string]any{"login": login, "id": i + 1})
			}
			_ = json.NewEncoder(w).Encode(out)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	})
}

func run(t *testing.T, state *groupServer, asJSON, asCSV bool) (string, string, error) {
	t.Helper()
	server := httptest.NewServer(state.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)
	var out, errOut bytes.Buffer
	err := runGroupList(client, &out, &errOut, scope{Org: testOrg, Classroom: testClassroom, Assignment: testAssignment}, asJSON, asCSV)
	return out.String(), errOut.String(), err
}

func TestRunGroupList_TeamMode_CSV(t *testing.T) {
	slug1 := contract.GroupTeamName(testClassroom, testAssignment, 1)
	slug2 := contract.GroupTeamName(testClassroom, testAssignment, 2)
	named, _ := configrepo.MarshalGroupDescription(testClassroom, testAssignment, "The Sharks")
	unnamed, _ := configrepo.MarshalGroupDescription(testClassroom, testAssignment, "")
	state := &groupServer{
		mode: "team",
		// Team 2 has no repo yet; the bonus repo belongs to a sibling slug.
		orgRepos: []string{contract.GroupRepoName(testClassroom, testAssignment, 1), "cs101-project-bonus-alice", "unrelated"},
		orgTeams: []map[string]any{
			{"id": 501, "slug": slug1, "description": named},
			{"id": 502, "slug": slug2, "description": unnamed},
		},
		membersBySlug: map[string][]string{slug1: {"bob", "alice", "eve"}, slug2: {}},
	}
	out, errOut, err := run(t, state, false, true)
	if err != nil {
		t.Fatalf("runGroupList: %v", err)
	}
	if errOut != "" {
		t.Errorf("unexpected stderr: %q", errOut)
	}
	records, err := csv.NewReader(strings.NewReader(out)).ReadAll()
	if err != nil {
		t.Fatalf("parse csv: %v\n%s", err, out)
	}
	if got := strings.Join(records[0], ","); got != strings.Join(contract.GroupMembershipCSVColumns, ",") {
		t.Fatalf("header = %q", got)
	}
	want := [][]string{
		{"group-1", "The Sharks", slug1, "cs101-project-group-1", "alice", "Alice", "Ada", "alice@x.edu", "A", "1", "student", "yes", ""},
		{"group-1", "The Sharks", slug1, "cs101-project-group-1", "bob", "Bob", "Babbage", "bob@x.edu", "B", "2", "student", "yes", ""},
		{"group-1", "The Sharks", slug1, "cs101-project-group-1", "eve", "", "", "", "", "", "", "no", ""},
		{"group-2", "Group 2", slug2, "", "", "", "", "", "", "", "", "", ""},
	}
	if len(records)-1 != len(want) {
		t.Fatalf("got %d rows, want %d:\n%s", len(records)-1, len(want), out)
	}
	for i, w := range want {
		if strings.Join(records[i+1], "|") != strings.Join(w, "|") {
			t.Errorf("row %d:\n got %q\nwant %q", i, records[i+1], w)
		}
	}
}

func TestRunGroupList_LegacyMode_TableAndJSON(t *testing.T) {
	state := &groupServer{
		mode: "group",
		orgRepos: []string{
			"cs101-project-alice", "cs101-project-zed",
			"cs101-project-bonus-alice", // sibling slug: excluded
			"cs101-project",             // bare prefix: excluded
		},
		collaborators:  map[string][]string{"cs101-project-alice": {"alice", "bob", "=Evil"}},
		collabFailures: map[string]int{"cs101-project-zed": http.StatusForbidden},
	}
	out, errOut, err := run(t, state, false, false)
	if err != nil {
		t.Fatalf("runGroupList: %v", err)
	}
	for _, want := range []string{"GROUP", "alice", "bob", "(" + contract.GroupMembershipNoteUnreadable + ")"} {
		if !strings.Contains(out, want) {
			t.Errorf("table missing %q:\n%s", want, out)
		}
	}
	// The unrostered collaborator is lowercased like the web's collaborator read.
	if !strings.Contains(out, "=evil") || strings.Contains(out, "=Evil") {
		t.Errorf("table should lowercase the collaborator login:\n%s", out)
	}
	if strings.Contains(out, "bonus") || strings.Contains(out, "\ncs101-project\t") {
		t.Errorf("sibling or bare-prefix repo leaked into the table:\n%s", out)
	}
	if !strings.Contains(errOut, "warning: cs101-project-zed") || !strings.Contains(errOut, "2 group(s), 3 member(s), 1 not on the roster") {
		t.Errorf("stderr = %q", errOut)
	}

	jsonOut, _, err := run(t, state, true, false)
	if err != nil {
		t.Fatalf("runGroupList --json: %v", err)
	}
	var rows []memberRow
	if err := json.Unmarshal([]byte(jsonOut), &rows); err != nil {
		t.Fatalf("json: %v\n%s", err, jsonOut)
	}
	if len(rows) != 4 || rows[0].Group != "alice" || rows[0].TeamSlug != "" || rows[3].Note != contract.GroupMembershipNoteUnreadable {
		t.Fatalf("rows = %+v", rows)
	}
	var unrostered *memberRow
	for i := range rows {
		if rows[i].InRoster == "no" {
			unrostered = &rows[i]
		}
	}
	if unrostered == nil || unrostered.Username != "=evil" {
		t.Errorf("rows = %+v, want one unrostered row with the lowercased login", rows)
	}

	// CSV defangs the formula-shaped login the table shows verbatim.
	csvOut, _, err := run(t, state, false, true)
	if err != nil {
		t.Fatalf("runGroupList --csv: %v", err)
	}
	if !strings.Contains(csvOut, ",'=evil,") {
		t.Errorf("csv should defang =evil:\n%s", csvOut)
	}
}

// A throttled collaborator read would fail for every remaining repo too, so the
// command stops rather than exporting a file where each group looks unreadable.
func TestRunGroupList_LegacyMode_RateLimitAborts(t *testing.T) {
	state := &groupServer{
		mode:            "group",
		orgRepos:        []string{"cs101-project-alice", "cs101-project-zed"},
		collaborators:   map[string][]string{"cs101-project-zed": {"zed"}},
		collabThrottled: map[string]bool{"cs101-project-alice": true},
	}
	out, _, err := run(t, state, false, true)
	if err == nil || !strings.Contains(err.Error(), "cs101-project-alice") {
		t.Fatalf("err = %v, want a rate-limit failure naming the repo", err)
	}
	if out != "" {
		t.Errorf("no CSV should be written on a rate limit, got:\n%s", out)
	}
}

func TestRunGroupList_IndividualModeRefuses(t *testing.T) {
	_, _, err := run(t, &groupServer{mode: "individual"}, false, false)
	if err == nil || !strings.Contains(err.Error(), "individual assignment") {
		t.Fatalf("err = %v, want an individual-mode refusal", err)
	}
}
