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
	// pendingAfterWrite replaces pending once the roster tree POST lands, so a
	// test can stage a same-email re-invite in the commit→delete window.
	pendingAfterWrite []map[string]any
	teamListStatus    int
	// staffMembers is each recorded staff team's membership, keyed by slug —
	// the source of an appended row's team-derived role.
	staffMembers map[string][]map[string]any
	// classroomJSONStatus fails the classroom.json read, the degraded case that
	// must make the whole pass read-mostly.
	classroomJSONStatus int

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
		if !team.createdAt.IsZero() {
			payload["created_at"] = team.createdAt.UTC().Format(time.RFC3339)
		}
		_ = json.NewEncoder(w).Encode(payload)
	})

	base.HandleFunc("/orgs/o/invitations", func(w http.ResponseWriter, r *http.Request) {
		if m.pendingStatus != 0 {
			w.WriteHeader(m.pendingStatus)
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

// The invitation read is the liveness signal every removal is confirmed
// against, so losing it must degrade the whole pass: nothing reaped, nothing
// deleted, exit 1.
func TestRunRosterSync_DegradedInvitationReadReapsNothing(t *testing.T) {
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
		if !strings.Contains(errOut, "Warning") {
			t.Errorf("status %d: stderr must warn about the degraded read:\n%s", status, errOut)
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
// goes but no identity is resurrected onto a row.
func TestRunRosterSync_SoleMemberOnNoClassroomTeamDeletesWithoutFolding(t *testing.T) {
	mock := newSyncMock(t, storedRosterHeader+",,,"+inviteTestEmail+",,,student\n")
	mock.teams = []syncTeam{acceptedInviteTeam(t)}
	mock.classroomMembers = []map[string]any{{"login": "someone-else", "id": 999}}

	if _, _, err := runSync(t, mock, true); err != nil {
		t.Fatalf("runRosterSync: %v", err)
	}
	for _, row := range committedRosterRows(t, mock) {
		if row.Username == syncTestAcceptedLogin || row.GitHubID == syncTestAcceptedID {
			t.Errorf("folded an unenrolled account onto a row: %#v", row)
		}
	}
	want := configrepo.InviteTeamName(inviteTestClassroom, inviteTestEmail)
	if len(mock.deletedTeams) != 1 || mock.deletedTeams[0] != want {
		t.Errorf("deleted teams = %v, want just %s", mock.deletedTeams, want)
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
}

// A pending row nothing backs is dead — but only when the pass can prove it.
func TestRunRosterSync_DeadPendingRowReapedOnlyWhenTrusted(t *testing.T) {
	roster := storedRosterHeader +
		",,,gone@uni.edu,,,student\n" +
		"bob,Bob,B,bob@uni.edu,s1,202,student\n"

	mock := newSyncMock(t, roster)
	mock.classroomMembers = []map[string]any{{"login": "bob", "id": 202}}
	if _, _, err := runSync(t, mock, true); err != nil {
		t.Fatalf("runRosterSync: %v", err)
	}
	rows := committedRosterRows(t, mock)
	if len(rows) != 1 || rows[0].Username != "bob" {
		t.Fatalf("committed rows = %#v, want only bob (the dead pending row reaped)", rows)
	}

	degraded := newSyncMock(t, roster)
	degraded.classroomMembers = []map[string]any{{"login": "bob", "id": 202}}
	degraded.pendingStatus = http.StatusForbidden
	if _, _, err := runSync(t, degraded, true); exitCode(err) != 1 {
		t.Fatalf("exit code = %d (err %v), want 1", exitCode(err), err)
	}
	if len(degraded.blobs) != 0 {
		t.Errorf("reaped a pending row on a degraded read: %#v", degraded.blobs)
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

// A failed team enumeration can't prove any row is dead, so the pass degrades
// rather than reaping on a blind guess.
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
// promises — otherwise the pass reaps rows and deletes teams while telling the
// teacher nothing was removed.
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
				t.Errorf("reaped a pending row on a degraded read: %#v", mock.blobs)
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
	_, errOut, err := runSync(t, apply, true)
	if got := exitCode(err); got != 0 {
		t.Fatalf("--write exit code = %d (err %v), want 0", got, err)
	}
	if len(apply.blobs) != 0 {
		t.Errorf("committed %d blob(s) for a backfill nothing can apply: %#v", len(apply.blobs), apply.blobs)
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
	if !strings.Contains(out, "accepted — record as") {
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

// Same rule on the reap side: with no invitation and no metadata team backing
// the address, a row carrying an unusable github_id cell is a dead pending row
// like any other — the web removes it, so this must too.
func TestRunRosterSync_UnresolvedGitHubIDRowIsReaped(t *testing.T) {
	// Above 2^53: readable, but past what the web app can address exactly, so
	// neither reader treats it as identity.
	mock := newSyncMock(t, storedRosterHeader+",,,gone@uni.edu,,9007199254740992,student\n")

	out, _, err := runSync(t, mock, true)
	if got := exitCode(err); got != 0 {
		t.Fatalf("exit code = %d (err %v), want 0", got, err)
	}
	if !strings.Contains(out, "drop the pending row") {
		t.Errorf("the dead row must be reported as dropped:\n%s", out)
	}
	rows := committedRosterRows(t, mock)
	if len(rows) != 0 {
		t.Errorf("committed rows = %#v, want the dead pending row dropped", rows)
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
