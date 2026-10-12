package groupcmd

import (
	"bytes"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubtest"
)

// sharedCasesPath is the cross-language oracle for the export: the web suite
// (groupMembershipCsv.test.ts) asserts the same file, so a one-sided change to
// the join, dedupe, ordering, escaping, or default name fails on the other
// language's copy.
const sharedCasesPath = "../../../shared/testdata/group_membership_cases.json"

type sharedCases struct {
	Columns        []string `json:"columns"`
	NoteUnreadable string   `json:"note_unreadable"`
	DefaultName    []struct {
		Recorded string `json:"recorded"`
		Counter  int    `json:"counter"`
		Name     string `json:"name"`
	} `json:"default_name"`
	Cases []struct {
		Name   string `json:"name"`
		Roster []struct {
			Username  string `json:"username"`
			FirstName string `json:"first_name"`
			LastName  string `json:"last_name"`
			Email     string `json:"email"`
			Section   string `json:"section"`
			GitHubID  string `json:"github_id"`
			Role      string `json:"role"`
		} `json:"roster"`
		Groups []struct {
			Group    string `json:"group"`
			Name     string `json:"name"`
			TeamSlug string `json:"team_slug"`
			Repo     string `json:"repo"`
			Members  *[]struct {
				Login    string `json:"login"`
				ID       int64  `json:"id"`
				Fallback bool   `json:"fallback"`
			} `json:"members"`
		} `json:"groups"`
		Rows [][]string `json:"rows"`
	} `json:"cases"`
}

func TestBuildRows_SharedCases(t *testing.T) {
	data, err := os.ReadFile(sharedCasesPath)
	if err != nil {
		t.Fatal(err)
	}
	var doc sharedCases
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	if got, want := strings.Join(doc.Columns, ","), strings.Join(contract.GroupMembershipCSVColumns, ","); got != want {
		t.Fatalf("fixture columns = %q, want %q", got, want)
	}
	if doc.NoteUnreadable != contract.GroupMembershipNoteUnreadable {
		t.Fatalf("fixture note = %q, want %q", doc.NoteUnreadable, contract.GroupMembershipNoteUnreadable)
	}
	for _, d := range doc.DefaultName {
		if got := contract.GroupExportName(d.Recorded, d.Counter); got != d.Name {
			t.Errorf("GroupExportName(%q, %d) = %q, want %q", d.Recorded, d.Counter, got, d.Name)
		}
	}
	for _, c := range doc.Cases {
		t.Run(c.Name, func(t *testing.T) {
			// The fixture carries raw roster.csv cells; run them through the
			// production reader the command uses, so the oracle also pins how a
			// padded, zero-padded, or unparsable cell reaches the builder.
			var rosterCSV bytes.Buffer
			w := csv.NewWriter(&rosterCSV)
			_ = w.Write(configrepo.RosterColumns)
			for _, r := range c.Roster {
				_ = w.Write([]string{r.Username, r.FirstName, r.LastName, r.Email, r.Section, r.GitHubID, r.Role})
			}
			w.Flush()
			roster, err := configrepo.ParseRosterLenient(rosterCSV.Bytes())
			if err != nil {
				t.Fatalf("ParseRosterLenient: %v", err)
			}
			groups := make([]groupSource, 0, len(c.Groups))
			for _, g := range c.Groups {
				src := groupSource{Group: g.Group, Name: g.Name, TeamSlug: g.TeamSlug, Repo: g.Repo}
				if g.Members != nil {
					src.Members = make([]member, 0, len(*g.Members))
					for _, m := range *g.Members {
						src.Members = append(src.Members, member{Login: m.Login, ID: m.ID, Fallback: m.Fallback})
					}
				}
				groups = append(groups, src)
			}
			rows := buildRows(groups, roster)
			got := make([]string, 0, len(rows))
			for _, r := range rows {
				// The web escapes inside its builder; the CLI escapes when it
				// writes CSV, so compare the written cells.
				got = append(got, strings.Join(defangCells(r.cells()), "|"))
			}
			want := make([]string, 0, len(c.Rows))
			for _, r := range c.Rows {
				want = append(want, strings.Join(r, "|"))
			}
			if len(got) != len(want) {
				t.Fatalf("got %d rows, want %d:\n%s", len(got), len(want), strings.Join(got, "\n"))
			}
			for i := range want {
				if got[i] != want[i] {
					t.Errorf("row %d:\n got %q\nwant %q", i, got[i], want[i])
				}
			}
		})
	}
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
	// Teams whose member read answers the given status.
	memberFailures map[string]int
	// Teams whose member read answers 403 with the primary-quota header.
	memberThrottled map[string]bool
}

const (
	testOrg        = "acme"
	testClassroom  = "cs101"
	testAssignment = "project"
)

// accountID is the fake GitHub account id for a login: the roster's id for the
// two rostered fixtures (alice 1, bob 2), a distinct id otherwise, so the
// id-first join is exercised rather than masked by colliding ids.
func accountID(login string) int {
	switch strings.ToLower(login) {
	case "alice":
		return 1
	case "bob":
		return 2
	}
	id := 1000
	for _, c := range login {
		id = id*31 + int(c)
	}
	return id
}

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
				"bob,Bob,Babbage,bob@x.edu,B,2,student\n" +
				// A hand-edited github_id: the lenient read keeps the row.
				"carol,Carol,Cantor,,,=99,student\n")))
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
			if s.memberThrottled[slug] {
				w.Header().Set("X-RateLimit-Remaining", "0")
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"message":"API rate limit exceeded"}`))
				return
			}
			if status, ok := s.memberFailures[slug]; ok {
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"message":"nope"}`))
				return
			}
			members := make([]map[string]any, 0)
			for _, login := range s.membersBySlug[slug] {
				members = append(members, map[string]any{"login": login, "id": accountID(login)})
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
			for _, login := range logins {
				out = append(out, map[string]any{"login": login, "id": accountID(login)})
			}
			_ = json.NewEncoder(w).Encode(out)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	})
}

func run(t *testing.T, state *groupServer, format outputFormat) (string, string, error) {
	t.Helper()
	server := httptest.NewServer(state.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)
	var out, errOut bytes.Buffer
	err := runGroupList(client, &out, &errOut, scope{Org: testOrg, Classroom: testClassroom, Assignment: testAssignment}, format)
	return out.String(), errOut.String(), err
}

func TestRunGroupList_TeamMode_CSV(t *testing.T) {
	slug1 := contract.GroupTeamName(testClassroom, testAssignment, 1)
	slug2 := contract.GroupTeamName(testClassroom, testAssignment, 2)
	slug3 := contract.GroupTeamName(testClassroom, testAssignment, 3)
	named, _ := configrepo.MarshalGroupDescription(testClassroom, testAssignment, "The Sharks")
	unnamed, _ := configrepo.MarshalGroupDescription(testClassroom, testAssignment, "")
	state := &groupServer{
		mode: "team",
		// Team 2 has no repo yet; the bonus repo belongs to a sibling slug.
		orgRepos: []string{contract.GroupRepoName(testClassroom, testAssignment, 1), "cs101-project-bonus-alice", "unrelated"},
		orgTeams: []map[string]any{
			{"id": 501, "slug": slug1, "description": named},
			{"id": 502, "slug": slug2, "description": unnamed},
			// A hand-edited description fails verification: the web still shows
			// the team, so the export keeps it too, unnamed.
			{"id": 503, "slug": slug3, "description": "edited by a student"},
		},
		membersBySlug: map[string][]string{slug1: {"bob", "alice", "eve"}, slug2: {}, slug3: {"carol"}},
	}
	out, errOut, err := run(t, state, formatCSV)
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
		// carol's roster github_id is "=99": kept, unresolved, written blank.
		{"group-3", "Group 3", slug3, "", "carol", "Carol", "Cantor", "", "", "", "student", "yes", ""},
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

// One team's member read failing must not hide the other teams: the team is
// kept as an unreadable row, like a legacy repo whose collaborator read failed
// and like the web export.
func TestRunGroupList_TeamMode_UnreadableTeamKeepsRow(t *testing.T) {
	slug1 := contract.GroupTeamName(testClassroom, testAssignment, 1)
	slug2 := contract.GroupTeamName(testClassroom, testAssignment, 2)
	named, _ := configrepo.MarshalGroupDescription(testClassroom, testAssignment, "The Sharks")
	unnamed, _ := configrepo.MarshalGroupDescription(testClassroom, testAssignment, "")
	state := &groupServer{
		mode:     "team",
		orgRepos: []string{contract.GroupRepoName(testClassroom, testAssignment, 2)},
		orgTeams: []map[string]any{
			{"id": 501, "slug": slug1, "description": named},
			{"id": 502, "slug": slug2, "description": unnamed},
		},
		membersBySlug:  map[string][]string{slug2: {"alice"}},
		memberFailures: map[string]int{slug1: http.StatusForbidden},
	}
	out, errOut, err := run(t, state, formatCSV)
	if err != nil {
		t.Fatalf("runGroupList: %v", err)
	}
	if !strings.Contains(errOut, "warning: "+slug1) {
		t.Errorf("stderr should warn about the unreadable team, got %q", errOut)
	}
	records, err := csv.NewReader(strings.NewReader(out)).ReadAll()
	if err != nil {
		t.Fatalf("parse csv: %v\n%s", err, out)
	}
	want := [][]string{
		{"group-1", "The Sharks", slug1, "", "", "", "", "", "", "", "", "", contract.GroupMembershipNoteUnreadable},
		{"group-2", "Group 2", slug2, "cs101-project-group-2", "alice", "Alice", "Ada", "alice@x.edu", "A", "1", "student", "yes", ""},
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

// A throttled team-member read aborts like a throttled collaborator read: the
// lenient listing keeps only non-throttle failures as unreadable teams.
func TestRunGroupList_TeamMode_RateLimitAborts(t *testing.T) {
	slug1 := contract.GroupTeamName(testClassroom, testAssignment, 1)
	slug2 := contract.GroupTeamName(testClassroom, testAssignment, 2)
	named, _ := configrepo.MarshalGroupDescription(testClassroom, testAssignment, "The Sharks")
	state := &groupServer{
		mode: "team",
		orgTeams: []map[string]any{
			{"id": 501, "slug": slug1, "description": named},
			{"id": 502, "slug": slug2, "description": named},
		},
		membersBySlug:   map[string][]string{slug2: {"alice"}},
		memberThrottled: map[string]bool{slug1: true},
	}
	out, _, err := run(t, state, formatCSV)
	if err == nil || !strings.Contains(err.Error(), slug1) {
		t.Fatalf("err = %v, want a rate-limit failure naming the team", err)
	}
	if out != "" {
		t.Errorf("no CSV should be written on a rate limit, got:\n%s", out)
	}
}

func TestRunGroupList_LegacyMode_TableAndJSON(t *testing.T) {
	state := &groupServer{
		mode: "group",
		orgRepos: []string{
			"cs101-project-alice", "cs101-project-zed",
			"cs101-project-bonus-alice", // sibling slug: excluded
			"cs101-project",             // bare prefix: excluded (no trailing dash)
			"cs101-project-",            // empty founder segment: excluded
		},
		collaborators:  map[string][]string{"cs101-project-alice": {"alice", "bob", "carol", "=Evil"}},
		collabFailures: map[string]int{"cs101-project-zed": http.StatusForbidden},
	}
	out, errOut, err := run(t, state, formatTable)
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
	if !strings.Contains(errOut, "warning: cs101-project-zed") || !strings.Contains(errOut, "2 group(s), 4 member(s), 1 not on the roster") {
		t.Errorf("stderr = %q", errOut)
	}

	jsonOut, _, err := run(t, state, formatJSON)
	if err != nil {
		t.Fatalf("runGroupList --json: %v", err)
	}
	var rows []memberRow
	if err := json.Unmarshal([]byte(jsonOut), &rows); err != nil {
		t.Fatalf("json: %v\n%s", err, jsonOut)
	}
	if len(rows) != 5 || rows[0].Group != "alice" || rows[0].TeamSlug != "" || rows[4].Note != contract.GroupMembershipNoteUnreadable {
		t.Fatalf("rows = %+v", rows)
	}
	// Only the two real group repos are groups: the sibling slug, the bare
	// prefix, and the empty founder segment are all excluded.
	for _, r := range rows {
		if r.Group != "alice" && r.Group != "zed" {
			t.Errorf("unexpected group %q in rows", r.Group)
		}
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
	csvOut, _, err := run(t, state, formatCSV)
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
	out, _, err := run(t, state, formatCSV)
	if err == nil || !strings.Contains(err.Error(), "cs101-project-alice") {
		t.Fatalf("err = %v, want a rate-limit failure naming the repo", err)
	}
	if out != "" {
		t.Errorf("no CSV should be written on a rate limit, got:\n%s", out)
	}
}

func TestResolveFormat(t *testing.T) {
	cases := []struct {
		json, csv bool
		want      outputFormat
	}{
		{false, false, formatTable}, {true, false, formatJSON}, {false, true, formatCSV}, {true, true, formatJSON},
	}
	for _, c := range cases {
		if got := resolveFormat(c.json, c.csv); got != c.want {
			t.Errorf("resolveFormat(%v, %v) = %v, want %v", c.json, c.csv, got, c.want)
		}
	}
}

// The table is the one surface where a student-chosen name is printed to a
// terminal: control characters must not forge a row or recolor the output.
func TestRunGroupList_TeamMode_TableSanitizesCells(t *testing.T) {
	slug1 := contract.GroupTeamName(testClassroom, testAssignment, 1)
	slug2 := contract.GroupTeamName(testClassroom, testAssignment, 2)
	hostile, _ := configrepo.MarshalGroupDescription(testClassroom, testAssignment, "Sharks\x1b[31m\nstranger\tyes")
	unnamed, _ := configrepo.MarshalGroupDescription(testClassroom, testAssignment, "")
	state := &groupServer{
		mode: "team",
		orgTeams: []map[string]any{
			{"id": 501, "slug": slug1, "description": hostile},
			{"id": 502, "slug": slug2, "description": unnamed},
		},
		membersBySlug: map[string][]string{slug1: {"alice"}, slug2: {}},
	}
	out, _, err := run(t, state, formatTable)
	if err != nil {
		t.Fatalf("runGroupList: %v", err)
	}
	if strings.Contains(out, "\x1b") || strings.Contains(out, "\nstranger") {
		t.Errorf("control characters reached the table:\n%q", out)
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("want header + 2 rows, got %d lines:\n%s", len(lines), out)
	}
	if !strings.Contains(lines[2], "(no members)") {
		t.Errorf("empty team row = %q", lines[2])
	}
	// The CSV keeps the recorded name byte-exact; only the terminal is guarded.
	csvOut, _, _ := run(t, state, formatCSV)
	if !strings.Contains(csvOut, "\x1b[31m") {
		t.Errorf("csv should carry the raw name:\n%q", csvOut)
	}
}

// A legacy assignment with no group repos prints a hint instead of an empty
// table, and --json still emits a valid (empty) array.
func TestRunGroupList_LegacyMode_NoGroups(t *testing.T) {
	state := &groupServer{mode: "group", orgRepos: []string{"unrelated"}}
	out, errOut, err := run(t, state, formatTable)
	if err != nil {
		t.Fatalf("runGroupList: %v", err)
	}
	if out != "cs101/project: no groups yet\n" || errOut != "" {
		t.Errorf("table = %q, stderr = %q", out, errOut)
	}
	jsonOut, _, err := run(t, state, formatJSON)
	if err != nil {
		t.Fatalf("runGroupList --json: %v", err)
	}
	if strings.TrimSpace(jsonOut) != "[]" {
		t.Errorf("json = %q, want []", jsonOut)
	}
}

func TestRunGroupList_IndividualModeRefuses(t *testing.T) {
	_, _, err := run(t, &groupServer{mode: "individual"}, formatTable)
	if err == nil || !strings.Contains(err.Error(), "individual assignment") {
		t.Fatalf("err = %v, want an individual-mode refusal", err)
	}
}
