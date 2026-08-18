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
	base.HandleFunc("/orgs/o/invitations/", func(w http.ResponseWriter, r *http.Request) {
		status := m.cancelStatus
		if status == 0 {
			status = http.StatusNoContent
		}
		w.WriteHeader(status)
	})
	base.HandleFunc("/orgs/o/teams/"+inviteTeamSlug, func(w http.ResponseWriter, r *http.Request) {
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

// newCancelMock has one pending EMAIL invitation for inviteTestEmail and a
// roster holding its pending row.
func newCancelMock(rosterCSV string) *cancelMock {
	return &cancelMock{
		rosterWriteMock: &rosterWriteMock{files: map[string]string{
			inviteTestClassroom + "/roster.csv": rosterCSV,
		}},
		pending: []map[string]any{
			{"id": cancelTestInvitationID, "email": inviteTestEmail, "role": "direct_member"},
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

	// No --force: forcing teardown without a pending invitation would delete the
	// only record of the address (see runRosterCancelInvite).
	t.Run("has no --force flag", func(t *testing.T) {
		if rosterCancelInviteCmd().Flags().Lookup("force") != nil {
			t.Error("--force must not exist on `roster cancel-invite`")
		}
	})
}
