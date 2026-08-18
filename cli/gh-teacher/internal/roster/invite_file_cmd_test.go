package roster

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubtest"
)

// bulkInviteMock serves the endpoints runRosterInviteFile touches for ANY
// invite-<hash> slug (the single inviteMock is pinned to one email's slug). It
// records the sequence of calls and the invited emails so a test can assert
// send-before-commit ordering, which addresses were invited, and any teardown.
type bulkInviteMock struct {
	*rosterWriteMock
	// rateLimitAfter: once this many invitations have been POSTed, the next one
	// (and it alone) returns a secondary rate limit; 0 disables.
	rateLimitAfter int
	// status422 holds emails GitHub should 422 (already member/invited).
	status422 map[string]bool
	// teamCreate500 holds emails whose invite-team create should hard-fail,
	// exercising the per-address team-prep failure path.
	teamCreate500 map[string]bool
	// teamCreateRateLimitAfter: once this many team creates have succeeded, every
	// later one returns a secondary rate limit; 0 disables.
	teamCreateRateLimitAfter int
	// commitFails fails the tree POST after sends succeed.
	commitFails bool
	// onAfterInvitation runs after each invitation POST is served — strictly
	// before the commit's rebase read — so a test can make the roster the
	// closure re-reads differ from the pre-send snapshot.
	onAfterInvitation func()

	calls          []inviteCall
	invitedEmails  []string
	deletedTeams   []string
	teamRecords    map[string]string
	invitationsPos int
	teamCreatePos  int
	slept          time.Duration
}

func (m *bulkInviteMock) handler(t *testing.T) http.Handler {
	t.Helper()
	base := m.rosterWriteMock.handler(t).(*http.ServeMux)

	base.HandleFunc("/user", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"login": inviteTestActor, "id": 1})
	})

	// Team create: every invite team shares this endpoint. The 422/adopt path is
	// keyed by matching the request name against teamCreate500's emails.
	base.HandleFunc("/orgs/o/teams", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name string `json:"name"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if m.emailForSlug(body.Name, m.teamCreate500) {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"message":"boom"}`))
			return
		}
		m.teamCreatePos++
		if m.teamCreateRateLimitAfter > 0 && m.teamCreatePos > m.teamCreateRateLimitAfter {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"message":"You have exceeded a secondary rate limit"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": inviteTestInviteTeamID, "slug": body.Name, "privacy": "secret",
		})
	})

	// All per-team subpaths (PATCH record, DELETE team, membership drop, members
	// read-back) route through one prefix handler keyed on the slug.
	base.HandleFunc("/orgs/o/teams/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/orgs/o/teams/")
		slug, sub, _ := strings.Cut(rest, "/")
		switch {
		case sub == "" && r.Method == http.MethodDelete:
			m.deletedTeams = append(m.deletedTeams, slug)
			w.WriteHeader(http.StatusNoContent)
		case sub == "":
			var body struct {
				Description string `json:"description"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if m.teamRecords == nil {
				m.teamRecords = map[string]string{}
			}
			m.teamRecords[slug] = body.Description
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": inviteTestInviteTeamID, "slug": slug,
				"privacy": "secret", "description": body.Description,
			})
		case strings.HasPrefix(sub, "memberships/"):
			w.WriteHeader(http.StatusNoContent)
		case sub == "members":
			_ = json.NewEncoder(w).Encode([]map[string]any{})
		default:
			http.NotFound(w, r)
		}
	})

	base.HandleFunc("/orgs/o/invitations", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Email string `json:"email"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		m.invitationsPos++
		if m.rateLimitAfter > 0 && m.invitationsPos > m.rateLimitAfter {
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"message":"You have exceeded a secondary rate limit"}`))
			return
		}
		if m.status422[body.Email] {
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"message":"already a member"}`))
			return
		}
		m.invitedEmails = append(m.invitedEmails, body.Email)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": 1})
		if m.onAfterInvitation != nil {
			m.onAfterInvitation()
		}
	})

	failing := http.Handler(base)
	if m.commitFails {
		failing = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost && r.URL.Path == "/repos/o/classroom50/git/trees" {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			base.ServeHTTP(w, r)
		})
	}
	return recordCalls(&m.calls, failing)
}

// emailForSlug reports whether the given team name (== slug) corresponds to any
// email in the set, by recomputing each email's deterministic slug.
func (m *bulkInviteMock) emailForSlug(slug string, set map[string]bool) bool {
	for email := range set {
		if configrepo.InviteTeamName(inviteTestClassroom, email) == slug {
			return true
		}
	}
	return false
}

func newBulkMock(t *testing.T, rosterCSV string) *bulkInviteMock {
	t.Helper()
	return &bulkInviteMock{
		rosterWriteMock: &rosterWriteMock{files: map[string]string{
			inviteTestClassroom + "/roster.csv":     rosterCSV,
			inviteTestClassroom + "/classroom.json": inviteTestClassroomJSON(t),
		}},
		status422:     map[string]bool{},
		teamCreate500: map[string]bool{},
	}
}

func runInviteFile(t *testing.T, mock *bulkInviteMock, data []byte) (string, string, error) {
	t.Helper()
	// Never sleep through the mock's Retry-After; the wait itself is asserted
	// separately via slept.
	prev := inviteFileSleep
	slept := time.Duration(0)
	inviteFileSleep = func(d time.Duration) { slept += d }
	t.Cleanup(func() { inviteFileSleep = prev })

	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	err := runRosterInviteFile(client, &out, &errOut, inviteTestOrg, inviteTestClassroom, data)
	mock.slept = slept
	return out.String(), errOut.String(), err
}

func countInvitationPOSTs(calls []inviteCall) int {
	n := 0
	for _, c := range calls {
		if c.Method == http.MethodPost && c.Path == "/orgs/o/invitations" {
			n++
		}
	}
	return n
}

// Five fresh addresses -> five invitations, one commit, five rows, and the
// commit must follow every send.
func TestRunRosterInviteFile_HappyPath(t *testing.T) {
	mock := newBulkMock(t, storedRosterHeader)
	list := "ada@uni.edu\nbea@uni.edu\ncam@uni.edu\ndan@uni.edu\neve@uni.edu\n"
	addrs := []string{"ada@uni.edu", "bea@uni.edu", "cam@uni.edu", "dan@uni.edu", "eve@uni.edu"}
	out, _, err := runInviteFile(t, mock, []byte(list))
	if err != nil {
		t.Fatalf("runRosterInviteFile: %v", err)
	}
	if got := countInvitationPOSTs(mock.calls); got != 5 {
		t.Errorf("invitation POSTs = %d, want 5", got)
	}
	if len(mock.blobs) != 1 {
		t.Fatalf("want exactly one roster commit, got %d blobs", len(mock.blobs))
	}

	// Byte-exact: parse the committed roster and assert each row's shape rather
	// than substring-matching the address.
	rows, err := configrepo.ParseRoster([]byte(mock.blobs[0]))
	if err != nil {
		t.Fatalf("parse committed roster: %v", err)
	}
	if len(rows) != 5 {
		t.Fatalf("committed %d rows, want 5: %#v", len(rows), rows)
	}
	got := map[string]bool{}
	for _, r := range rows {
		if r.Username != "" || r.GitHubID != 0 {
			t.Errorf("row %+v should be identity-less (pending email invite)", r)
		}
		if r.Role != rosterRoleStudent {
			t.Errorf("row %+v should carry role %q", r, rosterRoleStudent)
		}
		got[r.Email] = true
	}
	for _, a := range addrs {
		if !got[a] {
			t.Errorf("committed roster missing %s", a)
		}
	}

	// Per-address invite-team identity: each address's record must be its own.
	for _, a := range addrs {
		slug := configrepo.InviteTeamName(inviteTestClassroom, a)
		want, err := configrepo.MarshalInviteDescription(inviteTestClassroom, a)
		if err != nil {
			t.Fatalf("MarshalInviteDescription: %v", err)
		}
		if mock.teamRecords[slug] != want {
			t.Errorf("team %s record = %q, want %q", slug, mock.teamRecords[slug], want)
		}
	}

	// The commit must follow the LAST send: rows are retained only for
	// invitations that actually exist.
	treeIdx := indexOfCall(mock.calls, http.MethodPost, "/repos/o/classroom50/git/trees")
	lastInvite := -1
	for i, c := range mock.calls {
		if c.Method == http.MethodPost && c.Path == "/orgs/o/invitations" {
			lastInvite = i
		}
	}
	if treeIdx < 0 || lastInvite < 0 || treeIdx < lastInvite {
		t.Errorf("roster commit (call %d) must follow the last invitation (call %d)", treeIdx, lastInvite)
	}
	if !strings.Contains(out, "5 invited") || !strings.Contains(out, "5 appended as pending rows") {
		t.Errorf("summary should report 5 invited and 5 appended:\n%s", out)
	}
}

// A pending-blocked address costs no API call; a fresh one beside it still goes.
func TestRunRosterInviteFile_PendingSkippedSecondInvited(t *testing.T) {
	mock := newBulkMock(t, storedRosterHeader+",,,ada@uni.edu,,,student\n")
	out, errOut, err := runInviteFile(t, mock, []byte("ada@uni.edu\nbea@uni.edu\n"))
	if err != nil {
		t.Fatalf("runRosterInviteFile: %v", err)
	}
	if got := countInvitationPOSTs(mock.calls); got != 1 {
		t.Errorf("invitation POSTs = %d, want 1 (ada is already pending)", got)
	}
	if len(mock.invitedEmails) != 1 || mock.invitedEmails[0] != "bea@uni.edu" {
		t.Errorf("invited = %v, want only bea", mock.invitedEmails)
	}
	if !strings.Contains(out, "1 invited") || !strings.Contains(out, "1 already on the roster") {
		t.Errorf("summary should report 1 invited, 1 already on roster:\n%s", out)
	}
	// The skipped address and its file line must both be named.
	if !strings.Contains(errOut, "ada@uni.edu (line 1)") {
		t.Errorf("stderr should name the skipped address and its line:\n%s", errOut)
	}
	if !strings.Contains(errOut, "roster sync") {
		t.Errorf("the skip notice should point at `roster sync`:\n%s", errOut)
	}
}

func TestRunRosterInviteFile_422SkippedTeamDeletedBatchContinues(t *testing.T) {
	mock := newBulkMock(t, storedRosterHeader)
	mock.status422["bea@uni.edu"] = true
	out, errOut, err := runInviteFile(t, mock, []byte("ada@uni.edu\nbea@uni.edu\ncam@uni.edu\n"))
	if err != nil {
		t.Fatalf("a 422 skip must not fail the run: %v", err)
	}
	if len(mock.invitedEmails) != 2 {
		t.Errorf("invited = %v, want ada and cam", mock.invitedEmails)
	}
	beaSlug := configrepo.InviteTeamName(inviteTestClassroom, "bea@uni.edu")
	if len(mock.deletedTeams) != 1 || mock.deletedTeams[0] != beaSlug {
		t.Errorf("deleted = %v, want exactly bea's freshly-created team (%s)", mock.deletedTeams, beaSlug)
	}
	if !strings.Contains(out, "2 invited") || !strings.Contains(out, "1 already member/invited") {
		t.Errorf("summary wrong:\n%s", out)
	}
	// R10: the skipped address must be named, not just counted.
	if !strings.Contains(errOut, "bea@uni.edu (line 2)") {
		t.Errorf("stderr should name the 422-skipped address and line:\n%s", errOut)
	}
}

func TestRunRosterInviteFile_TeamPrepFailureIsPerAddress(t *testing.T) {
	mock := newBulkMock(t, storedRosterHeader)
	mock.teamCreate500["bea@uni.edu"] = true
	out, errOut, err := runInviteFile(t, mock, []byte("ada@uni.edu\nbea@uni.edu\ncam@uni.edu\n"))
	if err == nil {
		t.Fatal("a per-address failure must make the run exit non-zero")
	}
	if cliutil.ExitCodeFor(err) != 1 {
		t.Errorf("exit code = %d, want 1 for a hard failure", cliutil.ExitCodeFor(err))
	}
	if len(mock.invitedEmails) != 2 {
		t.Errorf("invited = %v, want ada and cam (bea's team prep failed)", mock.invitedEmails)
	}
	for _, e := range mock.invitedEmails {
		if e == "bea@uni.edu" {
			t.Errorf("bea was invited despite a team-prep failure")
		}
	}
	if !strings.Contains(out, "1 failed") {
		t.Errorf("summary should report 1 failed:\n%s", out)
	}
	if !strings.Contains(errOut, "bea@uni.edu") || !strings.Contains(errOut, "line 2") {
		t.Errorf("stderr should name the failed address and its line:\n%s", errOut)
	}
}

func TestRunRosterInviteFile_RateLimitDefersRest(t *testing.T) {
	mock := newBulkMock(t, storedRosterHeader)
	mock.rateLimitAfter = 1 // first send ok, second rate-limited, rest deferred
	_, errOut, err := runInviteFile(t, mock, []byte("ada@uni.edu\nbea@uni.edu\ncam@uni.edu\ndan@uni.edu\n"))
	if cliutil.ExitCodeFor(err) != 2 {
		t.Fatalf("exit code = %d (err %v), want 2 for a deferred tail", cliutil.ExitCodeFor(err), err)
	}
	// ada sent (1) + bea attempted then rate-limited (1) = 2 POSTs; cam & dan
	// never attempted.
	if got := countInvitationPOSTs(mock.calls); got != 2 {
		t.Errorf("invitation POSTs = %d, want 2 (no sends after the rate limit)", got)
	}
	if len(mock.invitedEmails) != 1 || mock.invitedEmails[0] != "ada@uni.edu" {
		t.Errorf("invited = %v, want only ada", mock.invitedEmails)
	}
	// Every uninvited address, including the one that tripped the limit.
	for _, addr := range []string{"bea@uni.edu", "cam@uni.edu", "dan@uni.edu"} {
		if !strings.Contains(errOut, addr) {
			t.Errorf("deferred report should name %s:\n%s", addr, errOut)
		}
	}
}

func TestRunRosterInviteFile_NoInvitesNoCommit(t *testing.T) {
	mock := newBulkMock(t, storedRosterHeader)
	mock.status422["ada@uni.edu"] = true
	mock.status422["bea@uni.edu"] = true
	_, _, err := runInviteFile(t, mock, []byte("ada@uni.edu\nbea@uni.edu\n"))
	if err != nil {
		t.Fatalf("all-skipped is a clean run: %v", err)
	}
	if len(mock.blobs) != 0 {
		t.Errorf("no invited addresses means no commit, got %d blobs", len(mock.blobs))
	}
}

// The rebase re-check is the only thing stopping a duplicate row when a
// concurrent writer (the web app, or a sync) takes an address between the
// pre-send read and the commit. onAfterInvitation injects exactly that race.
func TestRunRosterInviteFile_ConcurrentWriterAvoidsDoubleRow(t *testing.T) {
	mock := newBulkMock(t, storedRosterHeader)
	key := inviteTestClassroom + "/roster.csv"
	mock.onAfterInvitation = func() {
		// A concurrent writer claims bea after her invitation was sent, so the
		// rebase read sees a row the pre-send read did not.
		mock.files[key] = storedRosterHeader + ",,,bea@uni.edu,,,student\n"
	}

	out, errOut, err := runInviteFile(t, mock, []byte("bea@uni.edu\n"))
	if err != nil {
		t.Fatalf("runRosterInviteFile: %v", err)
	}
	if len(mock.invitedEmails) != 1 {
		t.Fatalf("invited = %v, want bea invited once", mock.invitedEmails)
	}
	// Nothing to append (the concurrent row already carries her), so no commit.
	if len(mock.blobs) != 0 {
		t.Errorf("appended a duplicate row despite the rebase re-check: %#v", mock.blobs)
	}
	if !strings.Contains(out, "1 invited, 0 appended as pending rows") {
		t.Errorf("summary should show invited-but-not-appended:\n%s", out)
	}
	if !strings.Contains(errOut, "already carries that address") {
		t.Errorf("the dropped address should be named:\n%s", errOut)
	}
}

// The batch-abort guard is the change's most important fail-closed behavior: a
// classroom with no usable team must not produce a batch of invitations that
// enroll nobody.
func TestRunRosterInviteFile_ClassroomTeamMissingAbortsBatch(t *testing.T) {
	mock := newBulkMock(t, storedRosterHeader)
	delete(mock.files, inviteTestClassroom+"/classroom.json")

	_, _, err := runInviteFile(t, mock, []byte("ada@uni.edu\nbea@uni.edu\ncam@uni.edu\n"))
	if err == nil {
		t.Fatal("err = nil, want a refusal naming `classroom add`")
	}
	if !strings.Contains(err.Error(), "classroom add") {
		t.Errorf("error should point at `classroom add`: %v", err)
	}
	if indexOfCall(mock.calls, http.MethodPost, "/orgs/o/teams") >= 0 {
		t.Error("created an invite team despite the abort")
	}
	if countInvitationPOSTs(mock.calls) != 0 {
		t.Error("sent an invitation despite the abort")
	}
	if len(mock.blobs) != 0 {
		t.Errorf("committed a roster despite the abort: %#v", mock.blobs)
	}
}

// A rate limit raised by the invite-team prep (not the invitation) must defer
// the remainder too — otherwise the batch keeps hammering a throttled endpoint.
func TestRunRosterInviteFile_TeamPrepRateLimitDefersRest(t *testing.T) {
	mock := newBulkMock(t, storedRosterHeader)
	mock.teamCreateRateLimitAfter = 1

	_, errOut, err := runInviteFile(t, mock, []byte("ada@uni.edu\nbea@uni.edu\ncam@uni.edu\n"))
	if cliutil.ExitCodeFor(err) != 2 {
		t.Fatalf("exit code = %d (err %v), want 2 for a deferred tail", cliutil.ExitCodeFor(err), err)
	}
	if len(mock.invitedEmails) != 1 || mock.invitedEmails[0] != "ada@uni.edu" {
		t.Errorf("invited = %v, want only ada", mock.invitedEmails)
	}
	// bea tripped the limit during team prep; cam must never be attempted.
	teamPOSTs := 0
	for _, c := range mock.calls {
		if c.Method == http.MethodPost && c.Path == "/orgs/o/teams" {
			teamPOSTs++
		}
	}
	if teamPOSTs != 2 {
		t.Errorf("team POSTs = %d, want 2 (no team prep after the limit)", teamPOSTs)
	}
	for _, addr := range []string{"bea@uni.edu", "cam@uni.edu"} {
		if !strings.Contains(errOut, addr) {
			t.Errorf("deferred report should name %s:\n%s", addr, errOut)
		}
	}
}

// The roster commit is several more requests; firing them inside the throttle
// window is what turns a partial success into "sent but unrecorded".
func TestRunRosterInviteFile_WaitsOutRateLimitBeforeCommit(t *testing.T) {
	mock := newBulkMock(t, storedRosterHeader)
	mock.rateLimitAfter = 1

	_, _, err := runInviteFile(t, mock, []byte("ada@uni.edu\nbea@uni.edu\n"))
	if cliutil.ExitCodeFor(err) != 2 {
		t.Fatalf("exit code = %d, want 2", cliutil.ExitCodeFor(err))
	}
	if mock.slept <= 0 {
		t.Error("want a Retry-After wait before the batch commit, slept 0")
	}
	if len(mock.blobs) != 1 {
		t.Fatalf("ada's row should still be committed, got %d blobs", len(mock.blobs))
	}
}

func TestRunRosterInviteFile_CommitFailureWarnsRepair(t *testing.T) {
	mock := newBulkMock(t, storedRosterHeader)
	mock.commitFails = true
	_, errOut, err := runInviteFile(t, mock, []byte("ada@uni.edu\n"))
	if err == nil {
		t.Fatal("a failed roster commit after sends must exit non-zero")
	}
	// The repair must be one that actually works: re-running records the row,
	// and a sync heals it once the student accepts.
	if !strings.Contains(errOut, "re-run this command") {
		t.Errorf("commit-failure warning must name re-running as the repair:\n%s", errOut)
	}
	if len(mock.invitedEmails) != 1 {
		t.Errorf("the invitation itself should have been sent, invited = %v", mock.invitedEmails)
	}
}

func TestRunRosterInviteFile_AllInvalidSendsNothing(t *testing.T) {
	mock := newBulkMock(t, storedRosterHeader)
	_, _, err := runInviteFile(t, mock, []byte("not-an-email\nalso bad\n"))
	if err == nil {
		t.Fatal("invalid lines must refuse the whole run")
	}
	if countInvitationPOSTs(mock.calls) != 0 {
		t.Errorf("nothing should be sent when the file has invalid lines")
	}
	if len(mock.blobs) != 0 {
		t.Errorf("no commit on a refused run")
	}
}

func TestRunRosterInviteFile_EmptyFile(t *testing.T) {
	mock := newBulkMock(t, storedRosterHeader)
	_, _, err := runInviteFile(t, mock, []byte("# only comments\n\n"))
	if err == nil || !strings.Contains(err.Error(), "no email addresses") {
		t.Fatalf("an empty list should report no addresses, got %v", err)
	}
}
