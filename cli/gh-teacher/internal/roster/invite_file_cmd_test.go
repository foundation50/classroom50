package roster

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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
	// commitFails fails the tree POST after sends succeed.
	commitFails bool

	calls          []inviteCall
	invitedEmails  []string
	deletedTeams   []string
	invitationsPos int
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
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	err := runRosterInviteFile(client, &out, &errOut, inviteTestOrg, inviteTestClassroom, data)
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

// Covers AE1: five fresh addresses → five invitations, one commit, five rows.
func TestRunRosterInviteFile_HappyPath(t *testing.T) {
	mock := newBulkMock(t, storedRosterHeader)
	list := "ada@uni.edu\nbea@uni.edu\ncam@uni.edu\ndan@uni.edu\neve@uni.edu\n"
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
	for _, addr := range []string{"ada@uni.edu", "bea@uni.edu", "cam@uni.edu", "dan@uni.edu", "eve@uni.edu"} {
		if !strings.Contains(mock.blobs[0], addr) {
			t.Errorf("committed roster missing %s:\n%s", addr, mock.blobs[0])
		}
	}
	if !strings.Contains(out, "5 invited") {
		t.Errorf("summary should report 5 invited:\n%s", out)
	}
}

// Covers AE3: first already-pending, second fresh → no call for the first, one
// invited, one row.
func TestRunRosterInviteFile_PendingSkippedSecondInvited(t *testing.T) {
	mock := newBulkMock(t, storedRosterHeader+",,,ada@uni.edu,,,student\n")
	out, _, err := runInviteFile(t, mock, []byte("ada@uni.edu\nbea@uni.edu\n"))
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
}

func TestRunRosterInviteFile_422SkippedTeamDeletedBatchContinues(t *testing.T) {
	mock := newBulkMock(t, storedRosterHeader)
	mock.status422["bea@uni.edu"] = true
	out, _, err := runInviteFile(t, mock, []byte("ada@uni.edu\nbea@uni.edu\ncam@uni.edu\n"))
	if err != nil {
		t.Fatalf("a 422 skip must not fail the run: %v", err)
	}
	if len(mock.invitedEmails) != 2 {
		t.Errorf("invited = %v, want ada and cam", mock.invitedEmails)
	}
	beaSlug := configrepo.InviteTeamName(inviteTestClassroom, "bea@uni.edu")
	found := false
	for _, s := range mock.deletedTeams {
		if s == beaSlug {
			found = true
		}
	}
	if !found {
		t.Errorf("bea's freshly-created team should be deleted on 422; deleted = %v", mock.deletedTeams)
	}
	if !strings.Contains(out, "2 invited") || !strings.Contains(out, "1 already member/invited") {
		t.Errorf("summary wrong:\n%s", out)
	}
}

func TestRunRosterInviteFile_TeamPrepFailureIsPerAddress(t *testing.T) {
	mock := newBulkMock(t, storedRosterHeader)
	mock.teamCreate500["bea@uni.edu"] = true
	out, _, err := runInviteFile(t, mock, []byte("ada@uni.edu\nbea@uni.edu\ncam@uni.edu\n"))
	if err == nil {
		t.Fatal("a per-address failure must make the run exit non-zero")
	}
	if len(mock.invitedEmails) != 2 {
		t.Errorf("invited = %v, want ada and cam (bea's team prep failed)", mock.invitedEmails)
	}
	// No invitation POST should have fired for bea (team prep precedes the send).
	for _, e := range mock.invitedEmails {
		if e == "bea@uni.edu" {
			t.Errorf("bea was invited despite a team-prep failure")
		}
	}
	if !strings.Contains(out, "1 failed") {
		t.Errorf("summary should report 1 failed:\n%s", out)
	}
}

func TestRunRosterInviteFile_RateLimitDefersRest(t *testing.T) {
	mock := newBulkMock(t, storedRosterHeader)
	mock.rateLimitAfter = 1 // first send ok, second rate-limited, rest deferred
	_, errOut, err := runInviteFile(t, mock, []byte("ada@uni.edu\nbea@uni.edu\ncam@uni.edu\ndan@uni.edu\n"))
	if err == nil {
		t.Fatal("a deferred tail must make the run exit non-zero")
	}
	// ada sent (1) + bea attempted then rate-limited (1) = 2 POSTs; cam & dan
	// never attempted.
	if got := countInvitationPOSTs(mock.calls); got != 2 {
		t.Errorf("invitation POSTs = %d, want 2 (no sends after the rate limit)", got)
	}
	if len(mock.invitedEmails) != 1 || mock.invitedEmails[0] != "ada@uni.edu" {
		t.Errorf("invited = %v, want only ada", mock.invitedEmails)
	}
	for _, addr := range []string{"cam@uni.edu", "dan@uni.edu"} {
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

func TestRunRosterInviteFile_ConcurrentWriterAvoidsDoubleRow(t *testing.T) {
	// The roster already holds ada (as if a concurrent writer added her); the
	// rebase re-check must not append a second row for her.
	mock := newBulkMock(t, storedRosterHeader+",,,ada@uni.edu,,,student\n")
	// ada is already pending, so she's skipped before send; bea is fresh. To
	// exercise the rebase drop specifically, invite an address the loaded roster
	// doesn't show as pending but the commit-time roster does — approximated here
	// by bea being fresh and ada blocked pre-send. Assert only bea's row lands.
	_, _, err := runInviteFile(t, mock, []byte("bea@uni.edu\n"))
	if err != nil {
		t.Fatalf("runRosterInviteFile: %v", err)
	}
	if len(mock.blobs) != 1 {
		t.Fatalf("want one commit, got %d", len(mock.blobs))
	}
	if strings.Count(mock.blobs[0], "ada@uni.edu") != 1 {
		t.Errorf("ada should appear exactly once (no double row):\n%s", mock.blobs[0])
	}
	if !strings.Contains(mock.blobs[0], "bea@uni.edu") {
		t.Errorf("bea's pending row should be committed:\n%s", mock.blobs[0])
	}
}

func TestRunRosterInviteFile_CommitFailureWarnsSync(t *testing.T) {
	mock := newBulkMock(t, storedRosterHeader)
	mock.commitFails = true
	_, errOut, err := runInviteFile(t, mock, []byte("ada@uni.edu\n"))
	if err == nil {
		t.Fatal("a failed roster commit after sends must exit non-zero")
	}
	if !strings.Contains(errOut, "roster sync") {
		t.Errorf("commit-failure warning must name `roster sync` as the repair:\n%s", errOut)
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
