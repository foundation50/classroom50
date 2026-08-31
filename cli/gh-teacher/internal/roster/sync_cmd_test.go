package roster

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubtest"
)

const (
	syncTestClassroomTeamSlug = "classroom50-" + inviteTestClassroom
	// syncTestAcceptedLogin/ID is the account behind inviteTestEmail once the
	// invitation is accepted: the only member of its invite team.
	syncTestAcceptedLogin = "ada"
	syncTestAcceptedID    = 101
)

// syncTeam is one org team the reconcile enumerates: its description (the
// classroom50/invite/v1 record, or something unparseable), the created_at the
// GC age gate reads, and its members.
type syncTeam struct {
	slug      string
	desc      string
	createdAt time.Time
	members   []map[string]any
	// readStatus overrides the team read with an error status (degraded read).
	readStatus int
}

// syncMock is the roster-write mock plus every endpoint `roster sync` reads:
// the org team list, each team's description/members, the pending-invitation
// list, and classroom.json (for the authoritative classroom team slug).
type syncMock struct {
	*rosterWriteMock
	teams []syncTeam
	// classroomMembers is the classroom team's membership — the ONLY source of
	// enrollment and of a backfilled github_id.
	classroomMembers []map[string]any
	// classroomStatus overrides the classroom team's members read.
	classroomStatus int

	pending       []map[string]any
	pendingStatus int
	// pendingFailAfterScan fails the invitation read only AFTER the scan's, so
	// the teardown's delete-time liveness re-check is the read that degrades.
	pendingFailAfterScan bool
	pendingReads         int
	// pendingAfterWrite replaces pending once the roster tree POST lands, so a
	// test can stage a same-email re-invite in the commit→delete window.
	pendingAfterWrite []map[string]any
	teamListStatus    int
	// deleteStatus fails every invite-team DELETE, the case whose exit code must
	// still tell a script the pass did not finish.
	deleteStatus int
	// refConflicts is how many times the ref PATCH answers non-fast-forward,
	// driving the rebase retry. rosterAfterConflict then replaces roster.csv, so
	// the retried closure genuinely re-reads a changed file.
	refConflicts        int
	rosterAfterConflict string
	// staffMembers is each recorded staff team's membership, keyed by slug —
	// the source of an appended row's team-derived role.
	staffMembers map[string][]map[string]any
	// membershipStates answers the decision-time enrollment point reads
	// (GET .../teams/{slug}/memberships/{login}) by login; a login absent here
	// 404s, GitHub's "not on this team". membershipStatus overrides every such
	// read with an error status (a degraded re-check).
	membershipStates map[string]string
	membershipStatus int
	// classroomJSONStatus fails the classroom.json read, the degraded case that
	// must make the whole pass read-mostly.
	classroomJSONStatus int
	// rawCreatedAt overrides a team's created_at with a literal, so a test can
	// serve one GitHub omitted or malformed.
	rawCreatedAt map[string]string

	calls        []inviteCall
	deletedTeams []string
	committed    bool
}

func (m *syncMock) handler(t *testing.T) http.Handler {
	t.Helper()
	base := m.rosterWriteMock.handler(t).(*http.ServeMux)

	base.HandleFunc("/orgs/o/teams", func(w http.ResponseWriter, r *http.Request) {
		if m.teamListStatus != 0 {
			w.WriteHeader(m.teamListStatus)
			return
		}
		listed := []map[string]any{{"id": 5, "slug": syncTestClassroomTeamSlug}}
		for i, team := range m.teams {
			listed = append(listed, map[string]any{"id": 100 + i, "slug": team.slug})
		}
		_ = json.NewEncoder(w).Encode(listed)
	})

	base.HandleFunc("/orgs/o/teams/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/orgs/o/teams/")
		if _, login, ok := strings.Cut(rest, "/memberships/"); ok {
			if m.membershipStatus != 0 {
				if m.membershipStatus == http.StatusTooManyRequests {
					// A real secondary limit carries the header IsRateLimited keys on.
					w.Header().Set("Retry-After", "30")
				}
				w.WriteHeader(m.membershipStatus)
				return
			}
			if state, ok := m.membershipStates[login]; ok {
				_ = json.NewEncoder(w).Encode(map[string]any{"state": state})
				return
			}
			http.NotFound(w, r)
			return
		}
		slug, members := rest, false
		if trimmed, ok := strings.CutSuffix(rest, "/members"); ok {
			slug, members = trimmed, true
		}
		if slug == syncTestClassroomTeamSlug {
			if m.classroomStatus != 0 {
				w.WriteHeader(m.classroomStatus)
				return
			}
			_ = json.NewEncoder(w).Encode(m.classroomMembers)
			return
		}
		if members, ok := m.staffMembers[slug]; ok {
			_ = json.NewEncoder(w).Encode(members)
			return
		}
		team := m.findTeam(slug)
		if team == nil {
			http.NotFound(w, r)
			return
		}
		if r.Method == http.MethodDelete {
			if m.deleteStatus != 0 {
				w.WriteHeader(m.deleteStatus)
				return
			}
			m.deletedTeams = append(m.deletedTeams, slug)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if team.readStatus != 0 {
			w.WriteHeader(team.readStatus)
			return
		}
		if members {
			_ = json.NewEncoder(w).Encode(team.members)
			return
		}
		payload := map[string]any{"id": 100, "slug": slug, "description": team.desc}
		if raw, ok := m.rawCreatedAt[slug]; ok {
			if raw != "" {
				payload["created_at"] = raw
			}
		} else if !team.createdAt.IsZero() {
			payload["created_at"] = team.createdAt.UTC().Format(time.RFC3339)
		}
		_ = json.NewEncoder(w).Encode(payload)
	})

	base.HandleFunc("/orgs/o/invitations", func(w http.ResponseWriter, r *http.Request) {
		m.pendingReads++
		if m.pendingStatus != 0 || (m.pendingFailAfterScan && m.pendingReads > 1) {
			status := m.pendingStatus
			if status == 0 {
				status = http.StatusInternalServerError
			}
			w.WriteHeader(status)
			return
		}
		pending := m.pending
		if m.committed && m.pendingAfterWrite != nil {
			pending = m.pendingAfterWrite
		}
		if pending == nil {
			pending = []map[string]any{}
		}
		_ = json.NewEncoder(w).Encode(pending)
	})

	// committed latches on the roster write so a same-email re-invite can be
	// staged in the commit→delete window.
	tracked := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if m.classroomJSONStatus != 0 && strings.HasSuffix(r.URL.Path, "/classroom.json") {
			w.WriteHeader(m.classroomJSONStatus)
			return
		}
		// A non-fast-forward ref PATCH is how GitHub reports a concurrent writer;
		// the rebase loop then re-runs the whole build closure against the file as
		// it now stands.
		if m.refConflicts > 0 && r.Method == http.MethodPatch && r.URL.Path == "/repos/o/classroom50/git/refs/heads/main" {
			m.refConflicts--
			if m.rosterAfterConflict != "" {
				m.files[inviteTestClassroom+"/roster.csv"] = m.rosterAfterConflict
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"message":"Update is not a fast forward"}`))
			return
		}
		base.ServeHTTP(w, r)
		if r.Method == http.MethodPost && r.URL.Path == "/repos/o/classroom50/git/trees" {
			m.committed = true
		}
	})
	return recordCalls(&m.calls, tracked)
}

func (m *syncMock) findTeam(slug string) *syncTeam {
	for i := range m.teams {
		if m.teams[i].slug == slug {
			return &m.teams[i]
		}
	}
	return nil
}

// syncInviteRecord is the valid v1 record for (classroom, email).
func syncInviteRecord(t *testing.T, email string) string {
	t.Helper()
	record, err := configrepo.MarshalInviteDescription(inviteTestClassroom, email)
	if err != nil {
		t.Fatalf("MarshalInviteDescription: %v", err)
	}
	return record
}

// newSyncMock has a resolvable classroom team, one enrolled member (the
// accepted invitee), and no pending invitations.
func newSyncMock(t *testing.T, rosterCSV string) *syncMock {
	t.Helper()
	return &syncMock{
		rosterWriteMock: &rosterWriteMock{files: map[string]string{
			inviteTestClassroom + "/roster.csv":     rosterCSV,
			inviteTestClassroom + "/classroom.json": inviteTestClassroomJSON(t),
		}},
		classroomMembers: []map[string]any{
			{"login": syncTestAcceptedLogin, "id": syncTestAcceptedID},
		},
	}
}

// acceptedInviteTeam is the invite team for inviteTestEmail with the accepted
// invitee as its sole member.
func acceptedInviteTeam(t *testing.T) syncTeam {
	t.Helper()
	return syncTeam{
		slug:      configrepo.InviteTeamName(inviteTestClassroom, inviteTestEmail),
		desc:      syncInviteRecord(t, inviteTestEmail),
		createdAt: time.Now().Add(-time.Hour),
		members: []map[string]any{
			{"login": syncTestAcceptedLogin, "id": syncTestAcceptedID},
		},
	}
}

func runSync(t *testing.T, mock *syncMock, write bool) (string, string, error) {
	t.Helper()
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	err := runRosterSync(client, &out, &errOut, inviteTestOrg, inviteTestClassroom, write)
	return out.String(), errOut.String(), err
}

// exitCode is the process status main() would derive from a sync run.
func exitCode(err error) int { return cliutil.ExitCodeFor(err) }

// The headline flow (#548): a student accepted, so the dry run reports the
// recovery and exits 2, `--write` fills their identity onto the pending row and
// retires the metadata team, and a second pass is clean.
func TestRunRosterSync_AcceptedInviteRecoveredThenClean(t *testing.T) {
	roster := storedRosterHeader + ",Ada,Lovelace," + inviteTestEmail + ",section-1,,student\n"
	slug := configrepo.InviteTeamName(inviteTestClassroom, inviteTestEmail)

	dry := newSyncMock(t, roster)
	dry.teams = []syncTeam{acceptedInviteTeam(t)}
	out, _, err := runSync(t, dry, false)
	if got := exitCode(err); got != 2 {
		t.Fatalf("dry-run exit code = %d (err %v), want 2 for changes pending", got, err)
	}
	if !strings.Contains(out, inviteTestEmail) || !strings.Contains(out, syncTestAcceptedLogin) {
		t.Errorf("dry run must report the recovery it found:\n%s", out)
	}
	if writes := writeCalls(dry.calls); len(writes) != 0 {
		t.Errorf("dry run issued %d write request(s): %#v", len(writes), writes)
	}

	apply := newSyncMock(t, roster)
	apply.teams = []syncTeam{acceptedInviteTeam(t)}
	if _, _, err := runSync(t, apply, true); err != nil {
		t.Fatalf("--write: %v", err)
	}
	rows := committedRosterRows(t, apply)
	if len(rows) != 1 {
		t.Fatalf("committed %d row(s), want the one folded row: %#v", len(rows), rows)
	}
	row := rows[0]
	if row.Username != syncTestAcceptedLogin || row.GitHubID != syncTestAcceptedID {
		t.Errorf("row did not gain the recovered identity: %#v", row)
	}
	if row.FirstName != "Ada" || row.LastName != "Lovelace" || row.Section != "section-1" || row.Email != inviteTestEmail {
		t.Errorf("fold overwrote teacher-owned metadata: %#v", row)
	}
	if len(apply.deletedTeams) != 1 || apply.deletedTeams[0] != slug {
		t.Errorf("deleted teams = %v, want just the recovered %s", apply.deletedTeams, slug)
	}
	treeIdx, deleteIdx := -1, -1
	for i, c := range apply.calls {
		if treeIdx < 0 && c.Method == http.MethodPost && c.Path == "/repos/o/classroom50/git/trees" {
			treeIdx = i
		}
		if deleteIdx < 0 && c.Method == http.MethodDelete && c.Path == "/orgs/o/teams/"+slug {
			deleteIdx = i
		}
	}
	if treeIdx < 0 || deleteIdx < 0 || deleteIdx < treeIdx {
		t.Errorf("the team delete (call %d) must follow the roster commit (call %d): push-before-delete", deleteIdx, treeIdx)
	}

	// Second pass: the row now carries the identity and the team is gone.
	clean := newSyncMock(t, storedRosterHeader+
		syncTestAcceptedLogin+",Ada,Lovelace,"+inviteTestEmail+",section-1,101,student\n")
	cleanOut, _, err := runSync(t, clean, false)
	if got := exitCode(err); got != 0 {
		t.Fatalf("second dry run exit code = %d (err %v), want 0 clean", got, err)
	}
	if !strings.Contains(cleanOut, "up to date") {
		t.Errorf("a clean pass should say so:\n%s", cleanOut)
	}
}

// The invitation read is the liveness signal every team delete is confirmed
// against, so losing it must degrade the whole pass: nothing deleted, exit 1.
func TestRunRosterSync_DegradedInvitationReadDeletesNothing(t *testing.T) {
	for _, status := range []int{http.StatusForbidden, http.StatusInternalServerError} {
		mock := newSyncMock(t, storedRosterHeader+",,,gone@uni.edu,,,student\n")
		mock.pendingStatus = status
		mock.teams = []syncTeam{{
			slug:      configrepo.InviteTeamName(inviteTestClassroom, "stale@uni.edu"),
			desc:      syncInviteRecord(t, "stale@uni.edu"),
			createdAt: time.Now().Add(-2 * contract.InviteTeamGCMinAge),
		}}

		_, errOut, err := runSync(t, mock, true)
		if got := exitCode(err); got != 1 {
			t.Fatalf("status %d: exit code = %d (err %v), want 1 for a degraded read", status, got, err)
		}
		if len(mock.blobs) != 0 {
			t.Errorf("status %d: committed %d blob(s) on a degraded read", status, len(mock.blobs))
		}
		if len(mock.deletedTeams) != 0 {
			t.Errorf("status %d: deleted %v on a degraded read", status, mock.deletedTeams)
		}
		if !strings.Contains(errOut, "no metadata team will be deleted") {
			t.Errorf("status %d: stderr must promise no team is deleted this pass:\n%s", status, errOut)
		}
		// With no invitation list there is no liveness shortcut: the pass must
		// fall back to reading every team the long way, not skip them all.
		teamReads := countCalls(mock.calls, http.MethodGet, "/orgs/o/teams/"+mock.teams[0].slug)
		if teamReads == 0 {
			t.Errorf("status %d: the team was never read — a failed invitation read must fall back to the full walk", status)
		}
	}
}

// The description is invitee-editable after acceptance, so a record whose email
// no longer hashes to the team name is never bound to a roster row.
func TestRunRosterSync_TamperedRecordIsKeptAndWarned(t *testing.T) {
	// The row for the address the tampered record CLAIMS: if the pass trusted
	// the description, this is the row it would bind an account to.
	mock := newSyncMock(t, storedRosterHeader+",,,victim@uni.edu,,,student\n")
	tampered := acceptedInviteTeam(t)
	// Same team (hashed from inviteTestEmail), a record now naming someone else.
	tampered.desc = syncInviteRecord(t, "victim@uni.edu")
	mock.teams = []syncTeam{tampered}

	_, errOut, err := runSync(t, mock, true)
	if got := exitCode(err); got != 0 {
		t.Fatalf("exit code = %d (err %v), want 0: a tampered team is reported, not a failure", got, err)
	}
	if len(mock.blobs) != 0 {
		t.Errorf("bound a roster row from a tampered record: %#v", mock.blobs)
	}
	if len(mock.deletedTeams) != 0 {
		t.Errorf("deleted %v; a tampered team is kept for the teacher to inspect", mock.deletedTeams)
	}
	if !strings.Contains(errOut, tampered.slug) {
		t.Errorf("stderr must name the skipped team:\n%s", errOut)
	}
}

// Accepted, then removed from the classroom: the lifecycle is over, so the team
// goes but no identity is resurrected onto a row — and the pending row itself
// simply stays (the sync never removes a row), so nothing is committed.
func TestRunRosterSync_SoleMemberOnNoClassroomTeamDeletesWithoutFolding(t *testing.T) {
	mock := newSyncMock(t, storedRosterHeader+",,,"+inviteTestEmail+",,,student\n")
	mock.teams = []syncTeam{acceptedInviteTeam(t)}
	mock.classroomMembers = []map[string]any{{"login": "someone-else", "id": 999}}

	if _, _, err := runSync(t, mock, true); err != nil {
		t.Fatalf("runRosterSync: %v", err)
	}
	if len(mock.blobs) != 0 {
		t.Errorf("committed %d blob(s); an unenrolled account must not be folded and no row removed: %#v", len(mock.blobs), mock.blobs)
	}
	want := configrepo.InviteTeamName(inviteTestClassroom, inviteTestEmail)
	if len(mock.deletedTeams) != 1 || mock.deletedTeams[0] != want {
		t.Errorf("deleted teams = %v, want just %s", mock.deletedTeams, want)
	}
}

// The #756 race: a student accepts WHILE the pass runs, so they sit on their
// invite team while absent from the enrollment snapshot taken earlier. The
// stale snapshot must never authorize the irreversible team delete — the
// decision-time membership re-check proves they enrolled mid-pass, so the pass
// folds them like any other recovery and only RETIRES the team post-commit.
func TestRunRosterSync_MidPassAcceptorIsRecoveredNotDeleted(t *testing.T) {
	mock := newSyncMock(t, storedRosterHeader+",Ada,Lovelace,"+inviteTestEmail+",section-1,,student\n")
	mock.teams = []syncTeam{acceptedInviteTeam(t)}
	// The snapshot predates the acceptance: the invitee is not in the list...
	mock.classroomMembers = []map[string]any{{"login": "someone-else", "id": 999}}
	// ...but the point read shows them on the classroom team NOW.
	mock.membershipStates = map[string]string{syncTestAcceptedLogin: "active"}

	if _, _, err := runSync(t, mock, true); err != nil {
		t.Fatalf("runRosterSync: %v", err)
	}
	rows := committedRosterRows(t, mock)
	if len(rows) != 1 {
		t.Fatalf("committed %d row(s), want the one folded row: %#v", len(rows), rows)
	}
	row := rows[0]
	if row.Username != syncTestAcceptedLogin || row.GitHubID != syncTestAcceptedID {
		t.Errorf("row did not gain the recovered identity: %#v", row)
	}
	if row.FirstName != "Ada" || row.LastName != "Lovelace" || row.Section != "section-1" {
		t.Errorf("fold lost teacher-owned metadata: %#v", row)
	}
	want := configrepo.InviteTeamName(inviteTestClassroom, inviteTestEmail)
	if len(mock.deletedTeams) != 1 || mock.deletedTeams[0] != want {
		t.Errorf("deleted teams = %v, want the retired %s (post-commit), never a stale delete", mock.deletedTeams, want)
	}
}

// A failed enrollment re-check proves nothing about the one team it guards, so
// the pass keeps it, warns, and degrades (exit 1) rather than guessing.
func TestRunRosterSync_EnrollmentRecheckFailureKeepsTeam(t *testing.T) {
	mock := newSyncMock(t, storedRosterHeader+",Ada,Lovelace,"+inviteTestEmail+",,,student\n")
	mock.teams = []syncTeam{acceptedInviteTeam(t)}
	mock.classroomMembers = []map[string]any{{"login": "someone-else", "id": 999}}
	mock.membershipStatus = http.StatusInternalServerError

	_, errOut, err := runSync(t, mock, true)
	if got := exitCode(err); got != 1 {
		t.Fatalf("exit code = %d (err %v), want 1 for a degraded re-check", got, err)
	}
	if len(mock.deletedTeams) != 0 {
		t.Errorf("deleted %v; an unproven unenrollment must keep the team", mock.deletedTeams)
	}
	if len(mock.blobs) != 0 {
		t.Errorf("committed %d blob(s); an unproven identity must not be folded", len(mock.blobs))
	}
	if !strings.Contains(errOut, "Warning") {
		t.Errorf("stderr must warn about the failed re-check:\n%s", errOut)
	}
}

// A PENDING membership record still means the invite lifecycle is not provably
// over: the re-check must recover, not delete. A refactor to `state == "active"`
// fails this test.
func TestRunRosterSync_PendingMembershipRecheckRecovers(t *testing.T) {
	mock := newSyncMock(t, storedRosterHeader+",Ada,Lovelace,"+inviteTestEmail+",,,student\n")
	mock.teams = []syncTeam{acceptedInviteTeam(t)}
	mock.classroomMembers = []map[string]any{{"login": "someone-else", "id": 999}}
	mock.membershipStates = map[string]string{syncTestAcceptedLogin: "pending"}

	if _, _, err := runSync(t, mock, true); err != nil {
		t.Fatalf("runRosterSync: %v", err)
	}
	rows := committedRosterRows(t, mock)
	if len(rows) != 1 || rows[0].Username != syncTestAcceptedLogin {
		t.Fatalf("expected the fold onto the pending row, got %#v", rows)
	}
	want := configrepo.InviteTeamName(inviteTestClassroom, inviteTestEmail)
	if len(mock.deletedTeams) != 1 || mock.deletedTeams[0] != want {
		t.Errorf("deleted teams = %v, want only the post-commit retire of %s", mock.deletedTeams, want)
	}
}

// A rate-limited re-check must stop the whole invite pass early (like every
// other rate-limited read), not burn one doomed request per remaining team.
func TestRunRosterSync_RateLimitedRecheckStopsPassEarly(t *testing.T) {
	second := syncTeam{
		slug:      configrepo.InviteTeamName(inviteTestClassroom, "second@uni.edu"),
		desc:      syncInviteRecord(t, "second@uni.edu"),
		createdAt: time.Now().Add(-time.Hour),
		members:   []map[string]any{{"login": "bea", "id": 202}},
	}
	mock := newSyncMock(t, storedRosterHeader+",Ada,Lovelace,"+inviteTestEmail+",,,student\n")
	mock.teams = []syncTeam{acceptedInviteTeam(t), second}
	mock.classroomMembers = []map[string]any{{"login": "someone-else", "id": 999}}
	mock.membershipStatus = http.StatusTooManyRequests

	_, errOut, err := runSync(t, mock, true)
	if got := exitCode(err); got != 1 {
		t.Fatalf("exit code = %d (err %v), want 1 for a rate-limited pass", got, err)
	}
	if len(mock.deletedTeams) != 0 || len(mock.blobs) != 0 {
		t.Errorf("deleted %v / committed %d blob(s) on a rate-limited pass", mock.deletedTeams, len(mock.blobs))
	}
	if !strings.Contains(errOut, "rate-limited") {
		t.Errorf("stderr must name the rate limit:\n%s", errOut)
	}
	pointReads := 0
	for _, c := range mock.calls {
		if strings.Contains(c.Path, "/memberships/") {
			pointReads++
		}
	}
	if pointReads != 1 {
		t.Errorf("membership point reads = %d, want 1 — the first rate limit must stop the pass", pointReads)
	}
}

// Two members can't identify one invitee, so the team stays live and the pass
// reports the anomaly instead of guessing.
func TestRunRosterSync_MultiMemberTeamIsKeptLive(t *testing.T) {
	mock := newSyncMock(t, storedRosterHeader+",,,"+inviteTestEmail+",,,student\n")
	team := acceptedInviteTeam(t)
	team.members = append(team.members, map[string]any{"login": "bob", "id": 202})
	mock.teams = []syncTeam{team}
	mock.classroomMembers = append(mock.classroomMembers, map[string]any{"login": "bob", "id": 202})

	out, errOut, err := runSync(t, mock, true)
	if got := exitCode(err); got != 0 {
		t.Fatalf("exit code = %d (err %v), want 0", got, err)
	}
	if len(mock.blobs) != 0 {
		t.Errorf("wrote the roster from an ambiguous team: %#v", mock.blobs)
	}
	if len(mock.deletedTeams) != 0 {
		t.Errorf("deleted %v; a multi-member team is an anomaly to keep", mock.deletedTeams)
	}
	if !strings.Contains(out+errOut, team.slug) {
		t.Errorf("the anomaly must be reported:\n%s%s", out, errOut)
	}
}

// committedRosterRows parses the single roster blob a write run POSTed.
func committedRosterRows(t *testing.T, mock *syncMock) []configrepo.RosterRow {
	t.Helper()
	if len(mock.blobs) != 1 {
		t.Fatalf("got %d roster blob(s) POSTed, want exactly 1: %#v", len(mock.blobs), mock.blobs)
	}
	rows, err := configrepo.ParseRoster([]byte(mock.blobs[0]))
	if err != nil {
		t.Fatalf("parse committed roster: %v\n%s", err, mock.blobs[0])
	}
	return rows
}

// The GC guard: a member-less team is only reaped once it is old enough that a
// mid-creation race is impossible AND no pending invitation still maps to it.
func TestRunRosterSync_MemberlessTeamGCGuard(t *testing.T) {
	slug := configrepo.InviteTeamName(inviteTestClassroom, inviteTestEmail)
	memberless := func(age time.Duration) syncTeam {
		return syncTeam{slug: slug, desc: syncInviteRecord(t, inviteTestEmail), createdAt: time.Now().Add(-age)}
	}

	t.Run("younger than the GC age is untouched", func(t *testing.T) {
		mock := newSyncMock(t, storedRosterHeader+",,,"+inviteTestEmail+",,,student\n")
		mock.teams = []syncTeam{memberless(contract.InviteTeamGCMinAge / 2)}

		if _, _, err := runSync(t, mock, true); err != nil {
			t.Fatalf("runRosterSync: %v", err)
		}
		if len(mock.deletedTeams) != 0 || len(mock.blobs) != 0 {
			t.Errorf("reaped a young invite team (deleted %v, blobs %d)", mock.deletedTeams, len(mock.blobs))
		}
	})

	t.Run("old but still pending is untouched", func(t *testing.T) {
		mock := newSyncMock(t, storedRosterHeader+",,,"+inviteTestEmail+",,,student\n")
		mock.teams = []syncTeam{memberless(2 * contract.InviteTeamGCMinAge)}
		mock.pending = []map[string]any{{"id": 7, "email": inviteTestEmail, "role": "direct_member"}}

		if _, _, err := runSync(t, mock, true); err != nil {
			t.Fatalf("runRosterSync: %v", err)
		}
		if len(mock.deletedTeams) != 0 || len(mock.blobs) != 0 {
			t.Errorf("reaped a live invitation (deleted %v, blobs %d)", mock.deletedTeams, len(mock.blobs))
		}
	})

	t.Run("old with no invitation is reaped in write mode only", func(t *testing.T) {
		dry := newSyncMock(t, storedRosterHeader)
		dry.teams = []syncTeam{memberless(2 * contract.InviteTeamGCMinAge)}
		if got := exitCode(mustSyncErr(t, dry, false)); got != 2 {
			t.Fatalf("dry-run exit code = %d, want 2", got)
		}
		if writes := writeCalls(dry.calls); len(writes) != 0 {
			t.Errorf("dry run issued %d write(s): %#v", len(writes), writes)
		}

		apply := newSyncMock(t, storedRosterHeader)
		apply.teams = []syncTeam{memberless(2 * contract.InviteTeamGCMinAge)}
		if _, _, err := runSync(t, apply, true); err != nil {
			t.Fatalf("runRosterSync: %v", err)
		}
		if len(apply.deletedTeams) != 1 || apply.deletedTeams[0] != slug {
			t.Errorf("deleted teams = %v, want just the stale %s", apply.deletedTeams, slug)
		}
	})

	// An age that can't be read is not an age past the gate: a team GitHub
	// reports with no created_at, or one it malforms, must never be reaped —
	// otherwise a single API quirk collects every live invite in the org.
	for name, createdAt := range map[string]string{
		"created_at absent":   "",
		"created_at malforms": "yesterday",
	} {
		t.Run(name+" is never reaped", func(t *testing.T) {
			mock := newSyncMock(t, storedRosterHeader)
			mock.teams = []syncTeam{{slug: slug, desc: syncInviteRecord(t, inviteTestEmail)}}
			mock.rawCreatedAt = map[string]string{slug: createdAt}

			out, _, err := runSync(t, mock, true)
			if len(mock.deletedTeams) != 0 {
				t.Errorf("deleted %v; an unreadable created_at cannot prove the team is past the GC age", mock.deletedTeams)
			}
			if got := exitCode(err); got != 0 {
				t.Errorf("exit code = %d (err %v), want 0: an unaged team is simply left alone", got, err)
			}
			if !strings.Contains(out, "up to date") {
				t.Errorf("nothing is pending, so the pass should say so:\n%s", out)
			}
		})
	}
}

// #800: a still-pending invitation proves nobody accepted, so its team holds
// nothing to recover — the pass must classify it as live from the invitation
// list alone, without the two per-team reads that dominated large classrooms.
func TestRunRosterSync_PendingInviteTeamIsSkippedWithoutReads(t *testing.T) {
	slug := configrepo.InviteTeamName(inviteTestClassroom, inviteTestEmail)

	mock := newSyncMock(t, storedRosterHeader+",,,"+inviteTestEmail+",,,student\n")
	mock.teams = []syncTeam{{
		slug:      slug,
		desc:      syncInviteRecord(t, inviteTestEmail),
		createdAt: time.Now().Add(-2 * contract.InviteTeamGCMinAge),
	}}
	mock.pending = []map[string]any{{"id": 7, "email": inviteTestEmail, "role": "direct_member"}}

	out, _, err := runSync(t, mock, true)
	if got := exitCode(err); got != 0 {
		t.Fatalf("exit code = %d (err %v), want 0: a live invite is nothing to do", got, err)
	}
	if len(mock.blobs) != 0 {
		t.Errorf("wrote the roster for a live invitation: %#v", mock.blobs)
	}
	if len(mock.deletedTeams) != 0 {
		t.Errorf("deleted %v; the invitation is still pending", mock.deletedTeams)
	}
	if !strings.Contains(out, "up to date") {
		t.Errorf("nothing is pending, so the pass should say so:\n%s", out)
	}
	for _, c := range mock.calls {
		if strings.HasPrefix(c.Path, "/orgs/o/teams/"+slug) {
			t.Errorf("read a team the pending invitation already proves live: %s %s", c.Method, c.Path)
		}
	}
}

// The sync NEVER removes a roster row: an email-only row nothing backs stays
// on the roster for the teacher to link or delete by hand (the web renders it
// as "unlinked"). When other work commits, the row must still be in the blob.
func TestRunRosterSync_NeverRemovesRows(t *testing.T) {
	// bob's github_id is backfillable, so the pass has something to commit —
	// proving the row survives an actual write, not just a no-op.
	roster := storedRosterHeader +
		",,,gone@uni.edu,,,student\n" +
		"bob,Bob,B,bob@uni.edu,s1,,student\n"

	mock := newSyncMock(t, roster)
	mock.classroomMembers = []map[string]any{{"login": "bob", "id": 202}}
	if _, _, err := runSync(t, mock, true); err != nil {
		t.Fatalf("runRosterSync: %v", err)
	}
	rows := committedRosterRows(t, mock)
	if len(rows) != 2 {
		t.Fatalf("committed rows = %#v, want gone@ kept alongside bob", rows)
	}
	var keptSeen bool
	for _, row := range rows {
		if configrepo.NormalizeInviteEmail(row.Email) == "gone@uni.edu" {
			keptSeen = true
		}
		if row.Username == "bob" && row.GitHubID != 202 {
			t.Errorf("bob's github_id was not backfilled: %#v", row)
		}
	}
	if !keptSeen {
		t.Error("the email-only row was removed — the sync never removes a row")
	}
}

// A pending row nothing backs is KEPT: with nothing else to change, the pass
// commits nothing at all and reports up to date.
func TestRunRosterSync_DeadPendingRowsAreKept(t *testing.T) {
	roster := storedRosterHeader +
		",,,gone@uni.edu,,,student\n" +
		"bob,Bob,B,bob@uni.edu,s1,202,student\n"

	mock := newSyncMock(t, roster)
	mock.classroomMembers = []map[string]any{{"login": "bob", "id": 202}}
	out, _, err := runSync(t, mock, true)
	if got := exitCode(err); got != 0 {
		t.Fatalf("exit code = %d (err %v), want 0", got, err)
	}
	if len(mock.blobs) != 0 {
		t.Errorf("committed %d blob(s); keeping the row needs no write: %#v", len(mock.blobs), mock.blobs)
	}
	if !strings.Contains(out, "up to date (no invites to record, no ids to fill)") {
		t.Errorf("nothing is pending, so the pass should say so:\n%s", out)
	}
}

// An unresolved github_id is backfilled from the classroom team's own
// membership — never a global user lookup, which a recycled login would poison.
func TestRunRosterSync_BackfillsIDsFromClassroomTeamOnly(t *testing.T) {
	mock := newSyncMock(t, storedRosterHeader+
		syncTestAcceptedLogin+",Ada,L,,s1,,student\n"+
		"outsider,Out,S,,s1,,student\n")

	if _, _, err := runSync(t, mock, true); err != nil {
		t.Fatalf("runRosterSync: %v", err)
	}
	rows := committedRosterRows(t, mock)
	var filled, left configrepo.RosterRow
	for _, row := range rows {
		switch row.Username {
		case syncTestAcceptedLogin:
			filled = row
		case "outsider":
			left = row
		}
	}
	if filled.GitHubID != syncTestAcceptedID {
		t.Errorf("classroom member's id not backfilled: %#v", filled)
	}
	if left.GitHubID != 0 {
		t.Errorf("backfilled %q, who is on no classroom team: %#v", left.Username, left)
	}
	if n := countCalls(mock.calls, http.MethodGet, "/users/outsider"); n != 0 {
		t.Errorf("resolved a login through a global user lookup %d time(s)", n)
	}
}

// The slug is a deterministic hash, so a same-email re-invite between the
// commit and the teardown adopts this very team — deleting it would strip the
// metadata team off a brand-new live invitation.
func TestRunRosterSync_SkipsDeletingATeamAReInviteAdopted(t *testing.T) {
	mock := newSyncMock(t, storedRosterHeader+",,,"+inviteTestEmail+",,,student\n")
	mock.teams = []syncTeam{acceptedInviteTeam(t)}
	mock.pendingAfterWrite = []map[string]any{
		{"id": 9, "email": inviteTestEmail, "role": "direct_member"},
	}

	_, errOut, err := runSync(t, mock, true)
	if err != nil {
		t.Fatalf("runRosterSync: %v", err)
	}
	if len(mock.blobs) != 1 {
		t.Fatalf("the fold should still commit, got %d blob(s)", len(mock.blobs))
	}
	if len(mock.deletedTeams) != 0 {
		t.Errorf("deleted %v; a re-invite now maps to that slug", mock.deletedTeams)
	}
	if !strings.Contains(errOut, "re-invite") {
		t.Errorf("stderr should explain the skipped delete:\n%s", errOut)
	}
}

// Namespace fence: `invite-` is a namespace a human team can land in, so only
// the exact `invite-<16 hex>` shape is ever read or deleted.
func TestRunRosterSync_NeverTouchesAForeignTeam(t *testing.T) {
	mock := newSyncMock(t, storedRosterHeader+",,,"+inviteTestEmail+",,,student\n")
	mock.teams = []syncTeam{{
		slug:      "invite-only",
		desc:      syncInviteRecord(t, inviteTestEmail),
		createdAt: time.Now().Add(-2 * contract.InviteTeamGCMinAge),
	}}

	if _, _, err := runSync(t, mock, true); err != nil {
		t.Fatalf("runRosterSync: %v", err)
	}
	if len(mock.deletedTeams) != 0 {
		t.Errorf("deleted %v; invite-only is not a hashed invite team", mock.deletedTeams)
	}
	for _, c := range mock.calls {
		if strings.HasPrefix(c.Path, "/orgs/o/teams/invite-only") {
			t.Errorf("read a foreign team: %s %s", c.Method, c.Path)
		}
	}
}

// A failed team enumeration proves nothing, so the pass degrades rather than
// deleting on a blind guess.
func TestRunRosterSync_DegradedTeamListingDegradesThePass(t *testing.T) {
	mock := newSyncMock(t, storedRosterHeader+",,,gone@uni.edu,,,student\n")
	mock.teamListStatus = http.StatusInternalServerError

	_, errOut, err := runSync(t, mock, true)
	if got := exitCode(err); got != 1 {
		t.Fatalf("exit code = %d (err %v), want 1", got, err)
	}
	if len(mock.blobs) != 0 {
		t.Errorf("committed %d blob(s) with an unreadable team list", len(mock.blobs))
	}
	if !strings.Contains(errOut, "Warning") {
		t.Errorf("stderr must warn:\n%s", errOut)
	}
}

// #1: a 404 on the classroom team is ABSENCE, not an empty roster. A renamed,
// deleted, or mistyped classroom/staff team would otherwise make every accepted
// invitee look unenrolled, and the unenrolled branch deletes the metadata team
// holding the only record of their invited address.
func TestRunRosterSync_MissingClassroomTeamDeletesNothing(t *testing.T) {
	roster := storedRosterHeader + ",Ada,Lovelace," + inviteTestEmail + ",section-1,,student\n"

	t.Run("the classroom team 404s", func(t *testing.T) {
		// A readable staff team keeps the enrollment set non-empty, so the
		// "no members visible" guard never fires: the invitee is simply absent
		// from a set that was never fully read, and the unenrolled branch would
		// delete the only record of their address.
		const taSlug = syncTestClassroomTeamSlug + "-ta"
		mock := newSyncMock(t, roster)
		mock.files[inviteTestClassroom+"/classroom.json"] = syncClassroomJSON(t, false, map[string]string{"ta": taSlug})
		mock.teams = []syncTeam{acceptedInviteTeam(t)}
		mock.classroomStatus = http.StatusNotFound
		mock.staffMembers = map[string][]map[string]any{
			taSlug: {{"login": "ms-frizzle", "id": 900}},
		}

		out, errOut, err := runSync(t, mock, true)
		if len(mock.deletedTeams) != 0 {
			t.Errorf("deleted %v; a 404 on the classroom team proves nobody was unenrolled", mock.deletedTeams)
		}
		if got := exitCode(err); got != 1 {
			t.Errorf("exit code = %d (err %v), want 1: a missing classroom team is a degraded read", got, err)
		}
		if strings.Contains(out, "delete the leftover metadata team") {
			t.Errorf("reported a delete it must not make:\n%s", out)
		}
		if !strings.Contains(errOut, "Warning") {
			t.Errorf("stderr must warn about the unreadable classroom team:\n%s", errOut)
		}
	})

	t.Run("a recorded staff team 404s", func(t *testing.T) {
		const taSlug = syncTestClassroomTeamSlug + "-ta"
		mock := newSyncMock(t, roster)
		mock.files[inviteTestClassroom+"/classroom.json"] = syncClassroomJSON(t, false, map[string]string{"ta": taSlug})
		mock.teams = []syncTeam{acceptedInviteTeam(t)}
		// staffMembers has no entry for taSlug, so the mock 404s that read.

		_, _, err := runSync(t, mock, true)
		if got := exitCode(err); got != 1 {
			t.Fatalf("exit code = %d (err %v), want 1: a recorded staff team that is gone is degraded", got, err)
		}
		if len(mock.deletedTeams) != 0 {
			t.Errorf("deleted %v with a staff team unread", mock.deletedTeams)
		}
	})
}

// #6/#22: a classmate's row carrying a shared contact address must not decide
// anything about a DIFFERENT student's invite. The teardown gate is per
// recovery, and the appends gate joins on identity — as the web's fold does.
func TestRunRosterSync_ASharedAddressOnAnotherRowDecidesNothing(t *testing.T) {
	slug := configrepo.InviteTeamName(inviteTestClassroom, inviteTestEmail)

	// #6: ada's own row already carries her personal address, so the invited one
	// gets no write (hers stands) — while bob's row holds the invited address as
	// a shared department contact. Nothing records where ADA's account came from,
	// so the team holding that is the only record and must survive.
	t.Run("it does not authorize retiring the team", func(t *testing.T) {
		roster := storedRosterHeader +
			syncTestAcceptedLogin + ",Ada,L,ada@personal.example,s1,101,student\n" +
			"bob,Bob,B," + inviteTestEmail + ",s1,202,student\n"

		mock := newSyncMock(t, roster)
		mock.teams = []syncTeam{acceptedInviteTeam(t)}
		mock.classroomMembers = []map[string]any{
			{"login": syncTestAcceptedLogin, "id": syncTestAcceptedID},
			{"login": "bob", "id": 202},
		}

		_, errOut, err := runSync(t, mock, true)
		if err != nil {
			t.Fatalf("runRosterSync: %v", err)
		}
		if len(mock.deletedTeams) != 0 {
			t.Errorf("deleted %v; only a classmate's row holds %s, so nothing records where %s's account came from",
				mock.deletedTeams, inviteTestEmail, syncTestAcceptedLogin)
		}
		if !strings.Contains(errOut, slug) {
			t.Errorf("stderr must say which team was kept and why:\n%s", errOut)
		}
	})

	// #22: the appends gate joins on identity too, so an accepted invitee whose
	// address happens to sit on a classmate's row still gets a row of their own
	// instead of being left off the roster entirely.
	t.Run("it does not leave the invitee off the roster", func(t *testing.T) {
		roster := storedRosterHeader + "bob,Bob,B," + inviteTestEmail + ",s1,202,student\n"

		mock := newSyncMock(t, roster)
		mock.teams = []syncTeam{acceptedInviteTeam(t)}
		mock.classroomMembers = []map[string]any{
			{"login": syncTestAcceptedLogin, "id": syncTestAcceptedID},
			{"login": "bob", "id": 202},
		}

		if _, _, err := runSync(t, mock, true); err != nil {
			t.Fatalf("runRosterSync: %v", err)
		}
		rows := committedRosterRows(t, mock)
		var appended bool
		for _, row := range rows {
			if row.Username == syncTestAcceptedLogin {
				appended = true
				if row.GitHubID != syncTestAcceptedID || row.Email != inviteTestEmail {
					t.Errorf("appended row lost identity or the recovered address: %#v", row)
				}
			}
		}
		if !appended {
			t.Errorf("the accepted invitee was left off the roster because a classmate shares the address: %#v", rows)
		}
		// Their own row now records it against their account, so the team may go.
		if len(mock.deletedTeams) != 1 || mock.deletedTeams[0] != slug {
			t.Errorf("deleted teams = %v, want the now-redundant %s retired", mock.deletedTeams, slug)
		}
	})
}

// #13: a dry run must not report "up to date" and exit 0 when --write would
// still delete a metadata team. The address is already recorded here, so the
// roster plan is empty — but the team is redundant and --write retires it.
func TestRunRosterSync_DryRunReportsARetirableTeam(t *testing.T) {
	stored := storedRosterHeader +
		syncTestAcceptedLogin + ",Ada,L," + inviteTestEmail + ",s1,101,student\n"
	slug := configrepo.InviteTeamName(inviteTestClassroom, inviteTestEmail)

	dry := newSyncMock(t, stored)
	dry.teams = []syncTeam{acceptedInviteTeam(t)}
	out, _, err := runSync(t, dry, false)
	if got := exitCode(err); got != 2 {
		t.Fatalf("dry-run exit code = %d (err %v), want 2: --write would delete %s", got, err, slug)
	}
	if strings.Contains(out, "up to date") {
		t.Errorf("claimed up to date while a delete is pending:\n%s", out)
	}
	if !strings.Contains(out, slug) {
		t.Errorf("the dry run must name the team it would retire:\n%s", out)
	}
	if writes := writeCalls(dry.calls); len(writes) != 0 {
		t.Errorf("dry run issued %d write request(s): %#v", len(writes), writes)
	}

	apply := newSyncMock(t, stored)
	apply.teams = []syncTeam{acceptedInviteTeam(t)}
	if _, _, err := runSync(t, apply, true); err != nil {
		t.Fatalf("--write: %v", err)
	}
	if len(apply.deletedTeams) != 1 || apply.deletedTeams[0] != slug {
		t.Fatalf("deleted teams = %v, want %s — the dry run promised this", apply.deletedTeams, slug)
	}
	// And the pass converges: with the team gone there is nothing left to do.
	clean := newSyncMock(t, stored)
	if got := exitCode(mustSyncErr(t, clean, false)); got != 0 {
		t.Errorf("second dry run exit code = %d, want 0: the pass must converge", got)
	}
}

// #14: a degraded pass promises nothing was removed, so it must not retire a
// recovered team either — fail closed and keep the message true.
func TestRunRosterSync_DegradedPassRetiresNoRecoveredTeam(t *testing.T) {
	stored := storedRosterHeader +
		syncTestAcceptedLogin + ",Ada,L," + inviteTestEmail + ",s1,101,student\n"
	slug := configrepo.InviteTeamName(inviteTestClassroom, inviteTestEmail)

	// A second, unreadable invite team degrades the pass while leaving the
	// recovery above intact.
	mock := newSyncMock(t, stored)
	mock.teams = []syncTeam{acceptedInviteTeam(t), {
		slug:       configrepo.InviteTeamName(inviteTestClassroom, "other@uni.edu"),
		readStatus: http.StatusInternalServerError,
	}}

	out, errOut, err := runSync(t, mock, true)
	if len(mock.deletedTeams) != 0 {
		t.Errorf("deleted %v on a degraded pass, while the exit-1 message promises nothing was removed", mock.deletedTeams)
	}
	if got := exitCode(err); got != 1 {
		t.Errorf("exit code = %d (err %v), want 1", got, err)
	}
	if strings.Contains(out, slug) {
		t.Errorf("reported a retirement it will not make:\n%s", out)
	}
	if !strings.Contains(errOut, "Warning") {
		t.Errorf("stderr must warn about the unreadable team:\n%s", errOut)
	}
}

// A degraded PER-TEAM read is the same fail-closed rule at team granularity:
// the unreadable team proves nothing, so no other team is swept either.
func TestRunRosterSync_DegradedInviteTeamReadSuppressesRemovals(t *testing.T) {
	roster := storedRosterHeader + ",,,gone@uni.edu,,,student\n"

	mock := newSyncMock(t, roster)
	mock.teams = []syncTeam{
		{slug: configrepo.InviteTeamName(inviteTestClassroom, "other@uni.edu"), readStatus: http.StatusInternalServerError},
		{
			slug:      configrepo.InviteTeamName(inviteTestClassroom, "stale@uni.edu"),
			desc:      syncInviteRecord(t, "stale@uni.edu"),
			createdAt: time.Now().Add(-2 * contract.InviteTeamGCMinAge),
		},
	}

	_, errOut, err := runSync(t, mock, true)
	if got := exitCode(err); got != 1 {
		t.Fatalf("exit code = %d (err %v), want 1 for a degraded per-team read", got, err)
	}
	if len(mock.blobs) != 0 {
		t.Errorf("committed %d blob(s) with a team unread: %#v", len(mock.blobs), mock.blobs)
	}
	if len(mock.deletedTeams) != 0 {
		t.Errorf("deleted %v with a team unread", mock.deletedTeams)
	}
	if !strings.Contains(errOut, "leaving it alone") {
		t.Errorf("stderr must say the unreadable team was left alone:\n%s", errOut)
	}
}

// #20: the accepted invitee owns their own team's description. A record-less
// team is an anomaly like a hash mismatch — reported and left standing, with
// nothing written on its word.
func TestRunRosterSync_UnreadableRecordCannotReapItsOwnRow(t *testing.T) {
	roster := storedRosterHeader + ",,," + inviteTestEmail + ",,,student\n"
	blanked := acceptedInviteTeam(t)
	blanked.desc = ""
	blanked.members = nil

	mock := newSyncMock(t, roster)
	mock.teams = []syncTeam{blanked}

	out, errOut, err := runSync(t, mock, true)
	if len(mock.blobs) != 0 {
		t.Errorf("wrote the roster on the word of a team whose record the invitee blanked: %#v", mock.blobs)
	}
	if len(mock.deletedTeams) != 0 {
		t.Errorf("deleted %v; a record-less team is an anomaly to inspect, not to reap", mock.deletedTeams)
	}
	if got := exitCode(err); got != 1 {
		t.Errorf("exit code = %d (err %v), want 1: the pass could not read the record", got, err)
	}
	if !strings.Contains(out+errOut, blanked.slug) {
		t.Errorf("the anomaly must name the team:\n%s%s", out, errOut)
	}
}

// A team still carrying the PROVISIONAL description is a run of either tool
// still in flight, not a tampered one: it holds no address, so it is skipped
// silently rather than reported as an anomaly.
func TestRunRosterSync_ProvisionalTeamIsSkippedQuietly(t *testing.T) {
	provisional := acceptedInviteTeam(t)
	provisional.desc = contract.InviteProvisionalDescription
	provisional.members = nil

	mock := newSyncMock(t, storedRosterHeader)
	mock.teams = []syncTeam{provisional}

	out, errOut, err := runSync(t, mock, false)
	if got := exitCode(err); got != 0 {
		t.Fatalf("exit code = %d (err %v), want 0: a mid-flight invite is not a finding", got, err)
	}
	if strings.Contains(out+errOut, provisional.slug) {
		t.Errorf("reported a team whose invite is still being created:\n%s%s", out, errOut)
	}
}

// #23: a delete the teardown could not make must reach the exit code, not just
// stderr — a script that reads 0 would believe the classroom is settled.
func TestRunRosterSync_FailedTeamDeleteExitsNonZero(t *testing.T) {
	mock := newSyncMock(t, storedRosterHeader+",Ada,L,"+inviteTestEmail+",s1,,student\n")
	mock.teams = []syncTeam{acceptedInviteTeam(t)}
	mock.deleteStatus = http.StatusInternalServerError

	_, errOut, err := runSync(t, mock, true)
	if got := exitCode(err); got != 1 {
		t.Fatalf("exit code = %d (err %v), want 1: the teardown did not finish", got, err)
	}
	if len(mock.blobs) != 1 {
		t.Errorf("the fold should still have committed, got %d blob(s)", len(mock.blobs))
	}
	if !strings.Contains(errOut, "re-run") {
		t.Errorf("stderr must tell the teacher how to collect the leftover:\n%s", errOut)
	}
}

// #23 (other half): the teardown re-checks the pending invitations right
// before deleting. A failed re-check must fail closed — no team deleted, exit 1
// — while the roster commit that already landed stands.
func TestRunRosterSync_FailedTeardownRecheckKeepsTeamsAndExitsNonZero(t *testing.T) {
	mock := newSyncMock(t, storedRosterHeader+",Ada,L,"+inviteTestEmail+",s1,,student\n")
	mock.teams = []syncTeam{acceptedInviteTeam(t)}
	mock.pendingFailAfterScan = true

	_, errOut, err := runSync(t, mock, true)
	if got := exitCode(err); got != 1 {
		t.Fatalf("exit code = %d (err %v), want 1: the teardown could not prove liveness", got, err)
	}
	if len(mock.blobs) != 1 {
		t.Errorf("the fold should still have committed, got %d blob(s)", len(mock.blobs))
	}
	if len(mock.deletedTeams) != 0 {
		t.Errorf("deleted %v on a failed liveness re-check", mock.deletedTeams)
	}
	if !strings.Contains(errOut, "re-checking the pending invitations") {
		t.Errorf("stderr must name the failed re-check:\n%s", errOut)
	}
}

// A rebase retry re-runs the whole build closure, so the teardown's premise —
// "the roster as COMMITTED records this address" — must be rebuilt from the
// attempt that landed, not the one that lost the race.
func TestRunRosterSync_RebaseRetryRebuildsTheTeardownPremise(t *testing.T) {
	slug := configrepo.InviteTeamName(inviteTestClassroom, inviteTestEmail)

	mock := newSyncMock(t, storedRosterHeader+",Ada,L,"+inviteTestEmail+",s1,,student\n")
	mock.teams = []syncTeam{acceptedInviteTeam(t)}
	mock.refConflicts = 1
	// The concurrent writer already gave ada an identity row carrying HER OWN
	// address, so the retried attempt has nothing to fold and nothing to fill
	// (a teacher-entered address stands) — the invited address is recorded
	// nowhere, and the team holding it must survive.
	mock.rosterAfterConflict = storedRosterHeader +
		syncTestAcceptedLogin + ",Ada,L,ada@personal.example,s1,101,student\n"

	if _, _, err := runSync(t, mock, true); err != nil {
		t.Fatalf("runRosterSync: %v", err)
	}
	if len(mock.deletedTeams) != 0 {
		t.Errorf("deleted %v using the premise of the attempt that lost the rebase; %s is still the only record of %s",
			mock.deletedTeams, slug, inviteTestEmail)
	}
}

func TestRosterSyncCmd(t *testing.T) {
	run := func(t *testing.T, args ...string) error {
		t.Helper()
		return runRosterSubcommand(t, rosterSyncCmd(), args...)
	}

	t.Run("blank classroom is rejected before any auth/network", func(t *testing.T) {
		err := run(t, "o", "   ")
		if err == nil || !strings.Contains(err.Error(), "non-empty") {
			t.Fatalf("err = %v, want a non-empty classroom error", err)
		}
	})

	t.Run("dry run is the default", func(t *testing.T) {
		flag := rosterSyncCmd().Flags().Lookup("write")
		if flag == nil {
			t.Fatal("missing --write")
		}
		if flag.DefValue != "false" {
			t.Errorf("--write default = %q, want false (report-only by default)", flag.DefValue)
		}
	})
}

// A recovery whose invite-time row is gone (an interrupted `roster invite`, or a
// hand-deleted row) still needs one: retiring the team otherwise loses the only
// record of the invited address.
func TestRunRosterSync_RecoveryWithNoRowIsAppended(t *testing.T) {
	mock := newSyncMock(t, storedRosterHeader)
	mock.teams = []syncTeam{acceptedInviteTeam(t)}

	if _, _, err := runSync(t, mock, true); err != nil {
		t.Fatalf("runRosterSync: %v", err)
	}
	rows := committedRosterRows(t, mock)
	if len(rows) != 1 {
		t.Fatalf("committed %d row(s), want the appended one: %#v", len(rows), rows)
	}
	row := rows[0]
	if row.Username != syncTestAcceptedLogin || row.GitHubID != syncTestAcceptedID || row.Email != inviteTestEmail {
		t.Errorf("appended row lost identity or the recovered address: %#v", row)
	}
	if row.FirstName != "" || row.LastName != "" || row.Section != "" {
		t.Errorf("sync fabricated profile metadata: %#v", row)
	}
}

// mustSyncErr runs a sync expecting the caller to inspect only its error.
func mustSyncErr(t *testing.T, mock *syncMock, write bool) error {
	t.Helper()
	_, _, err := runSync(t, mock, write)
	return err
}

// syncClassroomJSON is inviteTestClassroomJSON plus the keys only the reconcile
// reads: the staff teams an appended row's role comes from, and the archive flag.
func syncClassroomJSON(t *testing.T, archived bool, staff map[string]string) string {
	t.Helper()
	payload := map[string]any{
		"name": inviteTestClassroom,
		"team": map[string]any{"id": inviteTestClassroomTeamID, "slug": syncTestClassroomTeamSlug},
	}
	if archived {
		payload["active"] = false
	}
	if len(staff) > 0 {
		teams := map[string]any{}
		for role, slug := range staff {
			teams[role] = map[string]any{"id": 900, "slug": slug}
		}
		payload["teams"] = teams
	}
	b, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal classroom.json: %v", err)
	}
	return string(b)
}

// F5: an archived classroom's roster is frozen (the web's syncRosterFromTeam
// asserts it), so `--write` is refused — but the dry run still runs, so the
// leftovers stay inspectable.
func TestRunRosterSync_ArchivedClassroomRefusesWrite(t *testing.T) {
	roster := storedRosterHeader + ",Ada,Lovelace," + inviteTestEmail + ",section-1,,student\n"

	apply := newSyncMock(t, roster)
	apply.files[inviteTestClassroom+"/classroom.json"] = syncClassroomJSON(t, true, nil)
	apply.teams = []syncTeam{acceptedInviteTeam(t)}
	_, _, err := runSync(t, apply, true)
	if err == nil || !strings.Contains(err.Error(), "archived") {
		t.Fatalf("err = %v, want a refusal naming the archived classroom", err)
	}
	if len(apply.blobs) != 0 || len(apply.deletedTeams) != 0 {
		t.Errorf("wrote the roster (%d blob(s)) or deleted %v for an archived classroom", len(apply.blobs), apply.deletedTeams)
	}
	if writes := writeCalls(apply.calls); len(writes) != 0 {
		t.Errorf("issued %d write request(s) for an archived classroom: %#v", len(writes), writes)
	}

	dry := newSyncMock(t, roster)
	dry.files[inviteTestClassroom+"/classroom.json"] = syncClassroomJSON(t, true, nil)
	dry.teams = []syncTeam{acceptedInviteTeam(t)}
	out, _, dryErr := runSync(t, dry, false)
	if got := exitCode(dryErr); got != 2 {
		t.Fatalf("dry-run exit code = %d (err %v), want 2: a dry run stays allowed", got, dryErr)
	}
	if !strings.Contains(out, inviteTestEmail) {
		t.Errorf("the dry run must still report what it found:\n%s", out)
	}
}

// F9: the appended row records the role of the classroom team the invitee is
// actually on — the web writes the team-derived `role`, so a staff invitee must
// not be filed as a student.
func TestRunRosterSync_AppendedRowRecordsTheSourceTeamRole(t *testing.T) {
	const taSlug = syncTestClassroomTeamSlug + "-ta"

	mock := newSyncMock(t, storedRosterHeader)
	mock.files[inviteTestClassroom+"/classroom.json"] = syncClassroomJSON(t, false, map[string]string{"ta": taSlug})
	mock.classroomMembers = []map[string]any{}
	mock.staffMembers = map[string][]map[string]any{
		taSlug: {{"login": syncTestAcceptedLogin, "id": syncTestAcceptedID}},
	}
	mock.teams = []syncTeam{acceptedInviteTeam(t)}

	if _, _, err := runSync(t, mock, true); err != nil {
		t.Fatalf("runRosterSync: %v", err)
	}
	rows := committedRosterRows(t, mock)
	if len(rows) != 1 {
		t.Fatalf("committed %d row(s), want the appended one: %#v", len(rows), rows)
	}
	if rows[0].Role != "ta" {
		t.Errorf("appended row role = %q, want the source team's ta", rows[0].Role)
	}
}

// A person on both a staff and the student team records the staff role — the
// web's ROLE_RANK — regardless of which team is read first.
func TestRunRosterSync_AppendedRowPrefersTheStaffRole(t *testing.T) {
	const taSlug = syncTestClassroomTeamSlug + "-ta"
	invitee := map[string]any{"login": syncTestAcceptedLogin, "id": syncTestAcceptedID}

	mock := newSyncMock(t, storedRosterHeader)
	mock.files[inviteTestClassroom+"/classroom.json"] = syncClassroomJSON(t, false, map[string]string{"ta": taSlug})
	mock.classroomMembers = []map[string]any{invitee}
	mock.staffMembers = map[string][]map[string]any{taSlug: {invitee}}
	mock.teams = []syncTeam{acceptedInviteTeam(t)}

	if _, _, err := runSync(t, mock, true); err != nil {
		t.Fatalf("runRosterSync: %v", err)
	}
	rows := committedRosterRows(t, mock)
	if len(rows) != 1 || rows[0].Role != "ta" {
		t.Errorf("committed rows = %#v, want the staff role recorded", rows)
	}
}

// F4: a degraded classroom read must clear the trusted flag its own warning
// promises — otherwise the pass deletes teams while telling the teacher
// nothing was removed.
func TestRunRosterSync_DegradedClassroomReadSuppressesRemovals(t *testing.T) {
	roster := storedRosterHeader + ",,,gone@uni.edu,,,student\n"
	staleTeam := syncTeam{
		slug:      configrepo.InviteTeamName(inviteTestClassroom, "stale@uni.edu"),
		desc:      syncInviteRecord(t, "stale@uni.edu"),
		createdAt: time.Now().Add(-2 * contract.InviteTeamGCMinAge),
	}

	for name, degrade := range map[string]func(*syncMock){
		"classroom.json unreadable":    func(m *syncMock) { m.classroomJSONStatus = http.StatusInternalServerError },
		"classroom members unreadable": func(m *syncMock) { m.classroomStatus = http.StatusForbidden },
	} {
		t.Run(name, func(t *testing.T) {
			mock := newSyncMock(t, roster)
			mock.teams = []syncTeam{staleTeam}
			degrade(mock)

			out, errOut, err := runSync(t, mock, true)
			if got := exitCode(err); got != 1 {
				t.Fatalf("exit code = %d (err %v), want 1 for a degraded read", got, err)
			}
			if len(mock.blobs) != 0 {
				t.Errorf("committed %d blob(s) on a degraded read: %#v", len(mock.blobs), mock.blobs)
			}
			if len(mock.deletedTeams) != 0 {
				t.Errorf("deleted %v on a degraded read", mock.deletedTeams)
			}
			if strings.Contains(out, "delete the leftover metadata team") {
				t.Errorf("reported a delete it will not make:\n%s", out)
			}
			if !strings.Contains(errOut, "Warning") {
				t.Errorf("stderr must warn:\n%s", errOut)
			}
		})
	}
}

// F7: two rows sharing a username (one already carrying a resolved id) — the
// backfill helper matches the FIRST such row, so planning against the other
// would apply nothing and leave every dry run on exit 2 forever.
func TestRunRosterSync_DuplicateUsernameBackfillConverges(t *testing.T) {
	roster := storedRosterHeader +
		syncTestAcceptedLogin + ",Ada,Lovelace,,s1,101,student\n" +
		syncTestAcceptedLogin + ",Ada,Duplicate,,s2,,student\n"

	apply := newSyncMock(t, roster)
	out, errOut, err := runSync(t, apply, true)
	if got := exitCode(err); got != 0 {
		t.Fatalf("--write exit code = %d (err %v), want 0", got, err)
	}
	if len(apply.blobs) != 0 {
		t.Errorf("committed %d blob(s) for a backfill nothing can apply: %#v", len(apply.blobs), apply.blobs)
	}
	// A duplicate username is a report-only FINDING, not an applicable step, so
	// the summary and the exit code must agree that nothing is pending.
	if !strings.Contains(out, "up to date") {
		t.Errorf("stdout must agree with the exit-0 verdict:\n%s", out)
	}
	if !strings.Contains(errOut, syncTestAcceptedLogin) {
		t.Errorf("stderr must report the duplicate username:\n%s", errOut)
	}

	again := newSyncMock(t, roster)
	if got := exitCode(mustSyncErr(t, again, false)); got != 0 {
		t.Fatalf("second dry run exit code = %d, want 0: the pass must converge", got)
	}
}

// A pending-looking row whose github_id cell addresses no account is claimable —
// the web's filter reads such a cell as absent (resolveGitHubId returns null),
// so the CLI must fold onto it too rather than strand it as un-foldable and
// un-reapable forever.
func TestRunRosterSync_RowWithAnUnusableGitHubIDFoldsLikeTheWeb(t *testing.T) {
	// github_id 0 reads as "present but addresses no account" (parseGitHubID).
	roster := storedRosterHeader + ",Ada,Lovelace," + inviteTestEmail + ",section-1,0,student\n"
	slug := configrepo.InviteTeamName(inviteTestClassroom, inviteTestEmail)

	dry := newSyncMock(t, roster)
	dry.teams = []syncTeam{acceptedInviteTeam(t)}
	out, _, err := runSync(t, dry, false)
	if got := exitCode(err); got != 2 {
		t.Fatalf("dry-run exit code = %d (err %v), want 2 for a fold pending", got, err)
	}
	if !strings.Contains(out, "accepted: record as") {
		t.Errorf("dry run must report the fold:\n%s", out)
	}
	if writes := writeCalls(dry.calls); len(writes) != 0 {
		t.Errorf("dry run issued %d write request(s): %#v", len(writes), writes)
	}

	apply := newSyncMock(t, roster)
	apply.teams = []syncTeam{acceptedInviteTeam(t)}
	if _, _, err := runSync(t, apply, true); err != nil {
		t.Fatalf("--write: %v", err)
	}
	rows := committedRosterRows(t, apply)
	if len(rows) != 1 || rows[0].Username != syncTestAcceptedLogin || rows[0].GitHubID != syncTestAcceptedID {
		t.Fatalf("committed rows = %#v, want the row folded and its cell repaired", rows)
	}
	if len(apply.deletedTeams) != 1 || apply.deletedTeams[0] != slug {
		t.Errorf("deleted teams = %v, want the recovered %s retired", apply.deletedTeams, slug)
	}

	clean := newSyncMock(t, rosterCSVContent(t, rows...))
	if _, _, err := runSync(t, clean, false); exitCode(err) != 0 {
		t.Fatalf("second dry run exit code = %d (err %v), want 0: the pass must converge", exitCode(err), err)
	}
}

// The keep-rule holds for a row carrying an unusable github_id cell too: it
// reads as a pending email row, and the sync keeps it like any other — nothing
// else changed, so no commit at all.
func TestRunRosterSync_UnresolvedGitHubIDRowIsKept(t *testing.T) {
	// Above 2^53: readable, but past what the web app can address exactly, so
	// neither reader treats it as identity.
	mock := newSyncMock(t, storedRosterHeader+",,,gone@uni.edu,,9007199254740992,student\n")

	out, _, err := runSync(t, mock, true)
	if got := exitCode(err); got != 0 {
		t.Fatalf("exit code = %d (err %v), want 0", got, err)
	}
	if len(mock.blobs) != 0 {
		t.Errorf("committed %d blob(s); keeping the row needs no write: %#v", len(mock.blobs), mock.blobs)
	}
	if !strings.Contains(out, "up to date") {
		t.Errorf("nothing is pending, so the pass should say so:\n%s", out)
	}
}

// F1/F2: a recovery whose account is already named by a row with an EMPTY email
// column must have its address recorded there — otherwise nothing holds the
// invited address and retiring the metadata team would destroy the only record
// of it.
func TestRunRosterSync_RecordsTheRecoveredAddressOnAnIdentityRow(t *testing.T) {
	slug := configrepo.InviteTeamName(inviteTestClassroom, inviteTestEmail)
	for name, roster := range map[string]string{
		"matched by login and id": storedRosterHeader + syncTestAcceptedLogin + ",Ada,Lovelace,,section-1,101,student\n",
		"matched by github_id":    storedRosterHeader + ",Ada,Lovelace,,section-1,101,student\n",
		"matched by login only":   storedRosterHeader + syncTestAcceptedLogin + ",Ada,Lovelace,,section-1,,student\n",
	} {
		t.Run(name, func(t *testing.T) {
			dry := newSyncMock(t, roster)
			dry.teams = []syncTeam{acceptedInviteTeam(t)}
			if got := exitCode(mustSyncErr(t, dry, false)); got != 2 {
				t.Fatalf("dry-run exit code = %d, want 2: the address is not recorded yet", got)
			}

			apply := newSyncMock(t, roster)
			apply.teams = []syncTeam{acceptedInviteTeam(t)}
			if _, _, err := runSync(t, apply, true); err != nil {
				t.Fatalf("--write: %v", err)
			}
			rows := committedRosterRows(t, apply)
			if len(rows) != 1 || rows[0].Email != inviteTestEmail {
				t.Fatalf("committed rows = %#v, want the recovered address recorded", rows)
			}
			if rows[0].FirstName != "Ada" || rows[0].Section != "section-1" {
				t.Errorf("the fill overwrote teacher-owned metadata: %#v", rows[0])
			}
			if len(apply.deletedTeams) != 1 || apply.deletedTeams[0] != slug {
				t.Errorf("deleted teams = %v; the team may retire once its address is recorded", apply.deletedTeams)
			}

			clean := newSyncMock(t, rosterCSVContent(t, rows...))
			if got := exitCode(mustSyncErr(t, clean, false)); got != 0 {
				t.Fatalf("second dry run exit code = %d, want 0: the pass must converge", got)
			}
		})
	}
}

// F1: the teardown is gated on what the commit APPLIED, not on what the scan
// recovered. A row that already names the account but records the teacher's own
// address gets no write (theirs stands), so nothing holds the INVITED address —
// and the team holding it must survive.
//
// This also pins the no-empty-diff rule: a pass with nothing to apply must
// create no commit at all, so a polling caller can tell progress from churn.
func TestRunRosterSync_KeepsTheTeamWhenNoRowRecordedTheAddress(t *testing.T) {
	stored := storedRosterHeader + syncTestAcceptedLogin + ",Ada,Lovelace,ada@personal.example,section-1,101,student\n"
	slug := configrepo.InviteTeamName(inviteTestClassroom, inviteTestEmail)

	mock := newSyncMock(t, stored)
	mock.teams = []syncTeam{acceptedInviteTeam(t)}
	out, errOut, err := runSync(t, mock, true)
	if got := exitCode(err); got != 0 {
		t.Fatalf("exit code = %d (err %v), want 0", got, err)
	}
	if len(mock.blobs) != 0 {
		t.Errorf("committed %d blob(s) with nothing to apply: %#v", len(mock.blobs), mock.blobs)
	}
	if n := countCalls(mock.calls, http.MethodPost, "/repos/o/classroom50/git/commits"); n != 0 {
		t.Errorf("created %d commit(s) with nothing applied", n)
	}
	if len(mock.deletedTeams) != 0 {
		t.Fatalf("deleted %v; that team holds the only record of %s", mock.deletedTeams, inviteTestEmail)
	}
	if !strings.Contains(errOut, slug) || !strings.Contains(errOut, inviteTestEmail) {
		t.Errorf("stderr must say which team was kept and whose address it holds:\n%s", errOut)
	}
	if strings.Contains(out, "deleted metadata team") {
		t.Errorf("reported a delete it did not make:\n%s", out)
	}
}
