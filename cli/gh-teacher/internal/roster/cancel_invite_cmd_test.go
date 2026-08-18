package roster

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubtest"
)

const cancelTestInvitationID = 42

// cancelMock is the roster-write mock plus the two endpoints `roster
// cancel-invite` touches: the pending-invitation list and the invitation
// DELETE, with the invite team's DELETE recorded so a test can assert the
// recomputed slug.
type cancelMock struct {
	*rosterWriteMock
	// pending is served as GET /orgs/o/invitations; nil means no pending invite.
	pending []map[string]any
	// cancelStatus is the invitation DELETE status (0 → 204); 404 drives the
	// already-gone path.
	cancelStatus int
	// teamDeleteStatus is the invite-team DELETE status (0 → 204).
	teamDeleteStatus int
	// inviteTeamStatus is the invite-team GET status (0 → 200); 404 means this
	// classroom never sent the invitation the address matched.
	inviteTeamStatus int
	// inviteTeamDescription is the description that GET serves.
	inviteTeamDescription string
	// invitationTeams is served as GET /orgs/o/invitations/{id}/teams — the teams
	// the invitation itself carries, i.e. which classroom actually sent it.
	invitationTeams []map[string]any
	// invitationTeamsStatus is that read's status (0 → 200).
	invitationTeamsStatus int

	calls           []inviteCall
	deletedTeamSlug string
}

func (m *cancelMock) handler(t *testing.T) http.Handler {
	t.Helper()
	base := m.rosterWriteMock.handler(t).(*http.ServeMux)
	inviteTeamSlug := configrepo.InviteTeamName(inviteTestClassroom, inviteTestEmail)

	base.HandleFunc("/orgs/o/invitations", func(w http.ResponseWriter, r *http.Request) {
		pending := m.pending
		if pending == nil {
			pending = []map[string]any{}
		}
		_ = json.NewEncoder(w).Encode(pending)
	})
	base.HandleFunc(fmt.Sprintf("/orgs/o/invitations/%d/teams", cancelTestInvitationID), func(w http.ResponseWriter, r *http.Request) {
		if status := m.invitationTeamsStatus; status != 0 && status != http.StatusOK {
			http.Error(w, "boom", status)
			return
		}
		teams := m.invitationTeams
		if teams == nil {
			teams = []map[string]any{}
		}
		_ = json.NewEncoder(w).Encode(teams)
	})
	base.HandleFunc("/orgs/o/invitations/", func(w http.ResponseWriter, r *http.Request) {
		status := m.cancelStatus
		if status == 0 {
			status = http.StatusNoContent
		}
		w.WriteHeader(status)
	})
	base.HandleFunc("/orgs/o/teams/"+inviteTeamSlug, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			if status := m.inviteTeamStatus; status != 0 && status != http.StatusOK {
				w.WriteHeader(status)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": 7, "slug": inviteTeamSlug, "description": m.inviteTeamDescription,
			})
			return
		}
		status := m.teamDeleteStatus
		if status == 0 {
			status = http.StatusNoContent
		}
		if status == http.StatusNoContent {
			m.deletedTeamSlug = inviteTeamSlug
		}
		w.WriteHeader(status)
	})

	return recordCalls(&m.calls, base)
}

// newCancelMock has one pending EMAIL invitation for inviteTestEmail, the
// classroom's invite team backing it (attached to the invitation, as every send
// attaches it), and a roster holding its pending row.
func newCancelMock(rosterCSV string) *cancelMock {
	record, _ := configrepo.MarshalInviteDescription(inviteTestClassroom, inviteTestEmail)
	return &cancelMock{
		rosterWriteMock: &rosterWriteMock{files: map[string]string{
			inviteTestClassroom + "/roster.csv": rosterCSV,
		}},
		pending: []map[string]any{
			{"id": cancelTestInvitationID, "email": inviteTestEmail, "role": "direct_member"},
		},
		inviteTeamDescription: record,
		invitationTeams: []map[string]any{
			{"id": 7, "slug": configrepo.InviteTeamName(inviteTestClassroom, inviteTestEmail)},
		},
	}
}

func runCancelInvite(t *testing.T, mock *cancelMock) (string, string, error) {
	t.Helper()
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	err := runRosterCancelInvite(client, &out, &errOut,
		inviteTestOrg, inviteTestClassroom, inviteTestEmail)
	return out.String(), errOut.String(), err
}

// The happy path tears down all three artifacts: the invitation, the metadata
// team holding the address, and the pending roster row.
func TestRunRosterCancelInvite_HappyPath(t *testing.T) {
	mock := newCancelMock(storedRosterHeader +
		",,," + inviteTestEmail + ",,,student\n" +
		",,,other@uni.edu,,,student\n")

	out, _, err := runCancelInvite(t, mock)
	if err != nil {
		t.Fatalf("runRosterCancelInvite: %v", err)
	}

	if n := countCalls(mock.calls, http.MethodDelete, "/orgs/o/invitations/42"); n != 1 {
		t.Errorf("DELETEs of invitation 42 = %d, want 1; calls = %#v", n, mock.calls)
	}
	wantSlug := configrepo.InviteTeamName(inviteTestClassroom, inviteTestEmail)
	// The ownership read must precede the DELETE, so a refusal (or a degraded
	// read) leaves the invitation intact.
	ownerIdx := indexOfCall(mock.calls, http.MethodGet, "/orgs/o/teams/"+wantSlug)
	cancelIdx := indexOfCall(mock.calls, http.MethodDelete, "/orgs/o/invitations/42")
	if ownerIdx < 0 || ownerIdx > cancelIdx {
		t.Errorf("invite-team read at %d must come before the invitation DELETE at %d; calls = %#v",
			ownerIdx, cancelIdx, mock.calls)
	}
	if mock.deletedTeamSlug != wantSlug {
		t.Errorf("deleted team = %q, want the recomputed slug %q", mock.deletedTeamSlug, wantSlug)
	}
	if len(mock.blobs) != 1 {
		t.Fatalf("got %d blobs POSTed, want 1: %#v", len(mock.blobs), mock.blobs)
	}
	rows, err := configrepo.ParseRoster([]byte(mock.blobs[0]))
	if err != nil {
		t.Fatalf("parse committed roster: %v\n%s", err, mock.blobs[0])
	}
	if len(rows) != 1 || rows[0].Email != "other@uni.edu" {
		t.Fatalf("committed rows = %#v, want only other@uni.edu", rows)
	}
	if !strings.Contains(out, inviteTestEmail) {
		t.Errorf("stdout should name the cancelled address:\n%s", out)
	}
}

// Org invitations are ORG-scoped, so matching on the address alone would let
// classroom B's cancel revoke the live invitation classroom A sent — then tear
// down B's nonexistent artifacts and report success, stranding A's student with
// a row nothing backs. The invite team for (classroom, email) is the proof of
// ownership; without it, refuse before the DELETE.
func TestRunRosterCancelInvite_RefusesAnotherClassroomsInvitation(t *testing.T) {
	mock := newCancelMock(storedRosterHeader)
	mock.inviteTeamStatus = http.StatusNotFound

	_, _, err := runCancelInvite(t, mock)
	if err == nil {
		t.Fatal("err = nil, want a refusal naming the classroom mismatch")
	}
	if !strings.Contains(err.Error(), inviteTestClassroom) {
		t.Errorf("error should name the classroom that does not own the invitation: %v", err)
	}
	// `roster sync` cannot revoke anything, so a teacher whose metadata team is
	// already gone must be pointed somewhere that can (see #17).
	if !strings.Contains(err.Error(), "pending_invitations") {
		t.Errorf("error should point at GitHub's pending invitations page: %v", err)
	}
	if n := countCalls(mock.calls, http.MethodDelete, "/orgs/o/invitations/42"); n != 0 {
		t.Errorf("DELETEd another classroom's invitation %d time(s); calls = %#v", n, mock.calls)
	}
	if mock.deletedTeamSlug != "" {
		t.Errorf("deleted team %q for an invitation this classroom does not own", mock.deletedTeamSlug)
	}
	if len(mock.blobs) != 0 {
		t.Errorf("committed %d blob(s) on a refused cancel", len(mock.blobs))
	}
}

// A team whose description holds no parseable record proves nothing: an
// interrupted send leaves exactly that (the record is written last), and a
// blanked description would otherwise authorize the cancel.
func TestRunRosterCancelInvite_RefusesInviteTeamWithNoRecord(t *testing.T) {
	mock := newCancelMock(storedRosterHeader + ",,," + inviteTestEmail + ",,,student\n")
	mock.inviteTeamDescription = "classroom50: preparing invite"

	_, _, err := runCancelInvite(t, mock)
	if err == nil {
		t.Fatal("err = nil, want a refusal: a record-less team cannot prove ownership")
	}
	if !strings.Contains(err.Error(), "no invite record") {
		t.Errorf("error should name the missing record, distinctly from a foreign classroom: %v", err)
	}
	if writes := writeCalls(mock.calls); len(writes) != 0 {
		t.Errorf("a record-less team drove %d write(s): %#v", len(writes), writes)
	}
	if len(mock.blobs) != 0 {
		t.Errorf("committed %d blob(s) on a refused cancel", len(mock.blobs))
	}
}

// The metadata team only proves this classroom invited the ADDRESS. When two
// classrooms invited it, both have a team, and the org-wide lookup can still
// return the sibling's live invitation — so the invitation's own team list is
// what must bind the id being DELETEd to this classroom.
func TestRunRosterCancelInvite_RefusesInvitationCarryingAnotherClassroomsTeams(t *testing.T) {
	mock := newCancelMock(storedRosterHeader + ",,," + inviteTestEmail + ",,,student\n")
	mock.invitationTeams = []map[string]any{
		{"id": 9, "slug": configrepo.InviteTeamName("other-classroom", inviteTestEmail)},
		{"id": 10, "slug": "classroom50-other-classroom"},
	}

	_, _, err := runCancelInvite(t, mock)
	if err == nil {
		t.Fatal("err = nil, want a refusal: the invitation carries none of this classroom's teams")
	}
	for _, want := range []string{inviteTestClassroom, "42"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error should name the mismatch (%q): %v", want, err)
		}
	}
	if n := countCalls(mock.calls, http.MethodDelete, "/orgs/o/invitations/42"); n != 0 {
		t.Errorf("revoked a sibling classroom's live invitation %d time(s); calls = %#v", n, mock.calls)
	}
	if mock.deletedTeamSlug != "" {
		t.Errorf("deleted team %q for an invitation bound to another classroom", mock.deletedTeamSlug)
	}
	if len(mock.blobs) != 0 {
		t.Errorf("committed %d blob(s) on a refused cancel", len(mock.blobs))
	}
}

// The invitation-teams read runs BEFORE the DELETE, and the classroom team is an
// equally classroom-scoped binding — an invitation carrying it is this
// classroom's even if the invite team was never attached.
func TestRunRosterCancelInvite_ClassroomTeamBindsTheInvitation(t *testing.T) {
	mock := newCancelMock(storedRosterHeader + ",,," + inviteTestEmail + ",,,student\n")
	mock.invitationTeams = []map[string]any{
		{"id": 5, "slug": "classroom50-" + inviteTestClassroom},
	}

	_, _, err := runCancelInvite(t, mock)
	if err != nil {
		t.Fatalf("the classroom team binds the invitation to this classroom: %v", err)
	}
	teamsIdx := indexOfCall(mock.calls, http.MethodGet, "/orgs/o/invitations/42/teams")
	cancelIdx := indexOfCall(mock.calls, http.MethodDelete, "/orgs/o/invitations/42")
	if teamsIdx < 0 || teamsIdx > cancelIdx {
		t.Errorf("invitation-teams read at %d must precede the DELETE at %d; calls = %#v",
			teamsIdx, cancelIdx, mock.calls)
	}
}

// A degraded ownership read must never authorize the DELETE: a non-404 failure
// propagates rather than reading as "no team", so the invitation stays intact.
func TestRunRosterCancelInvite_DegradedReadsRefuseAndTouchNothing(t *testing.T) {
	cases := []struct {
		name  string
		apply func(*cancelMock)
	}{
		{"invite team read fails", func(m *cancelMock) { m.inviteTeamStatus = http.StatusInternalServerError }},
		{"invitation teams read fails", func(m *cancelMock) { m.invitationTeamsStatus = http.StatusInternalServerError }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mock := newCancelMock(storedRosterHeader + ",,," + inviteTestEmail + ",,,student\n")
			tc.apply(mock)

			_, _, err := runCancelInvite(t, mock)
			if err == nil {
				t.Fatal("err = nil, want the degraded read to propagate")
			}
			if writes := writeCalls(mock.calls); len(writes) != 0 {
				t.Errorf("a degraded read drove %d write(s): %#v", len(writes), writes)
			}
			if len(mock.blobs) != 0 {
				t.Errorf("committed %d blob(s) after a degraded read", len(mock.blobs))
			}
		})
	}
}

// A record naming a DIFFERENT classroom is the same ownership failure as a
// missing team: an adopted-then-rewritten team must not authorize this cancel.
func TestRunRosterCancelInvite_RefusesInviteTeamRecordForAnotherClassroom(t *testing.T) {
	mock := newCancelMock(storedRosterHeader)
	record, err := configrepo.MarshalInviteDescription("other-classroom", inviteTestEmail)
	if err != nil {
		t.Fatalf("MarshalInviteDescription: %v", err)
	}
	mock.inviteTeamDescription = record

	_, _, err = runCancelInvite(t, mock)
	if err == nil {
		t.Fatal("err = nil, want a refusal naming the recorded classroom")
	}
	if !strings.Contains(err.Error(), "other-classroom") {
		t.Errorf("error should name the classroom the record belongs to: %v", err)
	}
	if n := countCalls(mock.calls, http.MethodDelete, "/orgs/o/invitations/42"); n != 0 {
		t.Errorf("DELETEd an invitation recorded against another classroom %d time(s)", n)
	}
	if len(mock.blobs) != 0 {
		t.Errorf("committed %d blob(s) on a refused cancel", len(mock.blobs))
	}
}

// GitHub keys an invitation by login OR email, never both, so a login-keyed
// invitation for the same person carries no address this command can cancel.
func TestRunRosterCancelInvite_IgnoresLoginKeyedInvitation(t *testing.T) {
	mock := newCancelMock(storedRosterHeader + ",,," + inviteTestEmail + ",,,student\n")
	mock.pending = []map[string]any{
		{"id": cancelTestInvitationID, "login": "ada", "email": inviteTestEmail, "role": "direct_member"},
	}

	out, errOut, err := runCancelInvite(t, mock)
	if err != nil {
		t.Fatalf("a login-keyed invitation must read as nothing pending: %v", err)
	}
	if writes := writeCalls(mock.calls); len(writes) != 0 {
		t.Errorf("a login-keyed invitation drove %d write(s): %#v", len(writes), writes)
	}
	if !strings.Contains(out+errOut, "no pending invitation") {
		t.Errorf("output should report nothing pending:\n%s%s", out, errOut)
	}
}

// No pending invitation is report-only: an accepted-but-unsynced invitation
// reads identically, and the invite team holds the only email→account mapping,
// so deleting either artifact here could lose the address for good.
func TestRunRosterCancelInvite_NoPendingInvitationIsReportOnly(t *testing.T) {
	mock := newCancelMock(storedRosterHeader + ",,," + inviteTestEmail + ",,,student\n")
	mock.pending = nil

	out, errOut, err := runCancelInvite(t, mock)
	if err != nil {
		t.Fatalf("a missing invitation must not be an error: %v", err)
	}
	if writes := writeCalls(mock.calls); len(writes) != 0 {
		t.Errorf("report-only path issued %d write(s): %#v", len(writes), writes)
	}
	if len(mock.blobs) != 0 {
		t.Errorf("committed %d blob(s) with nothing cancelled", len(mock.blobs))
	}
	if !strings.Contains(out+errOut, "roster sync") {
		t.Errorf("output must point at `roster sync`:\n%s%s", out, errOut)
	}
}

// A 404 on the DELETE means the id was stale: a live invitation for the same
// address may still exist (a resend recreates before cancelling), so retiring
// its artifacts would strip someone who can still accept.
func TestRunRosterCancelInvite_AlreadyGoneRetiresNothing(t *testing.T) {
	mock := newCancelMock(storedRosterHeader + ",,," + inviteTestEmail + ",,,student\n")
	mock.cancelStatus = http.StatusNotFound

	out, errOut, err := runCancelInvite(t, mock)
	if err != nil {
		t.Fatalf("an already-gone invitation must not be an error: %v", err)
	}
	if mock.deletedTeamSlug != "" {
		t.Errorf("deleted team %q on a stale invitation id", mock.deletedTeamSlug)
	}
	if len(mock.blobs) != 0 {
		t.Errorf("committed %d blob(s) on a stale invitation id", len(mock.blobs))
	}
	if !strings.Contains(out+errOut, "roster sync") {
		t.Errorf("output must point at `roster sync`:\n%s%s", out, errOut)
	}
}

// A student who accepted (or a classmate sharing a contact address) keeps their
// row: with no identity-less row for this address, nothing is rewritten — but
// the invitation and its metadata team are still torn down.
func TestRunRosterCancelInvite_KeepsRowsThatIdentifySomeone(t *testing.T) {
	mock := newCancelMock(storedRosterHeader +
		"ada,Ada,Lovelace," + inviteTestEmail + ",section-1,99,student\n" +
		",,,other@uni.edu,,,student\n")

	out, _, err := runCancelInvite(t, mock)
	if err != nil {
		t.Fatalf("runRosterCancelInvite: %v", err)
	}
	if len(mock.blobs) != 0 {
		t.Errorf("rewrote the roster with no pending row to drop: %#v", mock.blobs)
	}
	if n := countCalls(mock.calls, http.MethodDelete, "/orgs/o/invitations/42"); n != 1 {
		t.Errorf("DELETEs of invitation 42 = %d, want 1 (the cancel is independent of the row)", n)
	}
	if !strings.Contains(out, "roster unchanged") {
		t.Errorf("stdout should report the roster was left alone:\n%s", out)
	}
}

// The cancellation is the source of truth once it lands, so a failed team
// delete is a warning: the row removal still commits and the GC reaps the team.
func TestRunRosterCancelInvite_TeamDeleteFailureStillCommitsRowRemoval(t *testing.T) {
	mock := newCancelMock(storedRosterHeader + ",,," + inviteTestEmail + ",,,student\n")
	mock.teamDeleteStatus = http.StatusInternalServerError

	_, errOut, err := runCancelInvite(t, mock)
	if err != nil {
		t.Fatalf("a failed team delete must not fail the cancel: %v", err)
	}
	if !strings.Contains(errOut, "Warning") {
		t.Errorf("stderr should warn about the stranded team:\n%s", errOut)
	}
	if len(mock.blobs) != 1 {
		t.Fatalf("got %d blobs POSTed, want the row removal committed anyway", len(mock.blobs))
	}
	rows, err := configrepo.ParseRoster([]byte(mock.blobs[0]))
	if err != nil {
		t.Fatalf("parse committed roster: %v", err)
	}
	if len(rows) != 0 {
		t.Errorf("committed rows = %#v, want the pending row dropped", rows)
	}
}

func TestRosterCancelInviteCmd(t *testing.T) {
	run := func(t *testing.T, args ...string) error {
		t.Helper()
		return runRosterSubcommand(t, rosterCancelInviteCmd(), args...)
	}

	t.Run("blank email is rejected before any auth/network", func(t *testing.T) {
		err := run(t, "o", "cs-principles", "   ")
		if err == nil || !strings.Contains(err.Error(), "non-empty") {
			t.Fatalf("err = %v, want a non-empty email error", err)
		}
	})

	t.Run("invalid email is rejected before any auth/network", func(t *testing.T) {
		err := run(t, "o", "cs-principles", "Ada <ada@uni.edu>")
		if err == nil || !strings.Contains(err.Error(), "invalid email") {
			t.Fatalf("err = %v, want 'invalid email'", err)
		}
	})

	// A bracketed address is accepted, and must be CANONICALIZED: cancel-invite
	// recomputes the invite-team hash from this value, so keeping the raw
	// `<ada@uni.edu>` would hash to a team that does not exist and silently
	// tear down nothing.
	t.Run("bracketed address canonicalizes to the bare address", func(t *testing.T) {
		_, _, email, err := parseEmailArgs([]string{"o", "cs-principles", "<" + inviteTestEmail + ">"})
		if err != nil {
			t.Fatalf("parseEmailArgs: %v", err)
		}
		if email != inviteTestEmail {
			t.Fatalf("email = %q, want the bare %q", email, inviteTestEmail)
		}
		if got := configrepo.InviteTeamName(inviteTestClassroom, email); got != configrepo.InviteTeamName(inviteTestClassroom, inviteTestEmail) {
			t.Errorf("invite-team slug %q does not match the address's own team", got)
		}
	})

	// No --force: forcing teardown without a pending invitation would delete the
	// only record of the address (see runRosterCancelInvite).
	t.Run("has no --force flag", func(t *testing.T) {
		if rosterCancelInviteCmd().Flags().Lookup("force") != nil {
			t.Error("--force must not exist on `roster cancel-invite`")
		}
	})
}
