package roster

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
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
	classroomJSON string
	teams         []syncTeam
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

	calls        []inviteCall
	deletedTeams []string
	committed    bool
}

func (m *syncMock) handler(t *testing.T) http.Handler {
	t.Helper()
	base := m.rosterWriteMock.handler(t).(*http.ServeMux)

	base.HandleFunc("/repos/o/classroom50/contents/"+inviteTestClassroom+"/classroom.json",
		func(w http.ResponseWriter, r *http.Request) {
			if m.classroomJSON == "" {
				http.NotFound(w, r)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]string{
				"content":  base64.StdEncoding.EncodeToString([]byte(m.classroomJSON)),
				"encoding": "base64",
			})
		})

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

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.calls = append(m.calls, inviteCall{Method: r.Method, Path: r.URL.Path})
		base.ServeHTTP(w, r)
		if r.Method == http.MethodPost && r.URL.Path == "/repos/o/classroom50/git/trees" {
			m.committed = true
		}
	})
}

func (m *syncMock) findTeam(slug string) *syncTeam {
	for i := range m.teams {
		if m.teams[i].slug == slug {
			return &m.teams[i]
		}
	}
	return nil
}

// writeCalls returns every state-mutating request, so a dry run can be asserted
// to have made none.
func (m *syncMock) writeCalls() []inviteCall {
	var out []inviteCall
	for _, c := range m.calls {
		switch c.Method {
		case http.MethodPost, http.MethodPatch, http.MethodPut, http.MethodDelete:
			out = append(out, c)
		}
	}
	return out
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
			inviteTestClassroom + "/roster.csv": rosterCSV,
		}},
		classroomJSON: inviteTestClassroomJSON(t),
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
	if writes := dry.writeCalls(); len(writes) != 0 {
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
		if writes := dry.writeCalls(); len(writes) != 0 {
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
	if n := countSyncCalls(mock, http.MethodGet, "/users/outsider"); n != 0 {
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
		cmd := rosterSyncCmd()
		cmd.SilenceErrors = true
		cmd.SilenceUsage = true
		cmd.SetArgs(args)
		cmd.SetOut(io.Discard)
		cmd.SetErr(io.Discard)
		return cmd.Execute()
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

func TestRosterCmdRegistersSync(t *testing.T) {
	var found bool
	for _, sub := range NewCmd().Commands() {
		if sub.Name() == "sync" {
			found = true
		}
	}
	if !found {
		t.Error("`roster sync` is not registered on the roster command")
	}
	if !strings.Contains(NewCmd().Long, "sync") {
		t.Error("the roster subcommand summary should list sync")
	}
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

func countSyncCalls(mock *syncMock, method, path string) int {
	n := 0
	for _, c := range mock.calls {
		if c.Method == method && c.Path == path {
			n++
		}
	}
	return n
}
