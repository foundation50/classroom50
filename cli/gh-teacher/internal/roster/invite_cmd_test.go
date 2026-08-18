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

const (
	inviteTestOrg       = "o"
	inviteTestClassroom = "cs-principles"
	inviteTestEmail     = "ada@uni.edu"
	inviteTestActor     = "prof"
	// inviteTestClassroomTeamID is the team id classroom.json records; the
	// invitation must carry it alongside the invite team's.
	inviteTestClassroomTeamID = 5
	inviteTestInviteTeamID    = 7
)

// inviteMock is the roster-write mock plus every endpoint `roster invite`
// touches: /user (the acting teacher), the invite team
// create/patch/membership/members/delete, and the org invitation. classroom.json
// is served from rosterWriteMock.files.
type inviteMock struct {
	*rosterWriteMock
	// createStatus is the invite-team create status; 422 drives the adopt path
	// (a pre-existing team a failed run must NOT delete).
	createStatus int
	// invitationStatus is the org-invitation POST status (0 → 201).
	invitationStatus int
	// invitationRateLimited makes the POST fail as a secondary rate limit, which
	// the web deliberately treats differently from a hard failure.
	invitationRateLimited bool
	// commitFails fails the tree POST, simulating a roster write failure after a
	// successful send.
	commitFails bool

	calls           []inviteCall
	invitationBody  map[string]any
	inviteTeamSlug  string
	deletedTeamSlug string
}

func (m *inviteMock) handler(t *testing.T) http.Handler {
	t.Helper()
	base := m.rosterWriteMock.handler(t).(*http.ServeMux)
	m.inviteTeamSlug = configrepo.InviteTeamName(inviteTestClassroom, inviteTestEmail)
	teamPath := "/orgs/" + inviteTestOrg + "/teams/" + m.inviteTeamSlug

	base.HandleFunc("/user", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"login": inviteTestActor, "id": 1})
	})

	base.HandleFunc("/orgs/o/teams", func(w http.ResponseWriter, r *http.Request) {
		if m.createStatus != 0 && m.createStatus != http.StatusCreated {
			w.WriteHeader(m.createStatus)
			_, _ = w.Write([]byte(`{"message":"Name must be unique for this org"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": inviteTestInviteTeamID, "slug": m.inviteTeamSlug, "privacy": "secret",
		})
	})

	base.HandleFunc(teamPath, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			m.deletedTeamSlug = m.inviteTeamSlug
			w.WriteHeader(http.StatusNoContent)
			return
		}
		var body struct {
			Description string `json:"description"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": inviteTestInviteTeamID, "slug": m.inviteTeamSlug,
			"privacy": "secret", "description": body.Description,
		})
	})
	base.HandleFunc(teamPath+"/memberships/"+inviteTestActor, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	base.HandleFunc(teamPath+"/members", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{})
	})

	base.HandleFunc("/orgs/o/invitations", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&m.invitationBody)
		if m.invitationRateLimited {
			w.Header().Set("Retry-After", "60")
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"message":"You have exceeded a secondary rate limit"}`))
			return
		}
		status := m.invitationStatus
		if status == 0 {
			status = http.StatusCreated
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": 1})
	})

	// commitFails intercepts before the mux so the tree POST never reaches it.
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

// inviteTestClassroomJSON records the classroom team the invitation must carry.
func inviteTestClassroomJSON(t *testing.T) string {
	t.Helper()
	b, err := json.Marshal(map[string]any{
		"name": inviteTestClassroom,
		"team": map[string]any{"id": inviteTestClassroomTeamID, "slug": "classroom50-" + inviteTestClassroom},
	})
	if err != nil {
		t.Fatalf("marshal classroom.json: %v", err)
	}
	return string(b)
}

// runInvite drives runRosterInvite against a scripted server.
func runInvite(t *testing.T, mock *inviteMock) (string, string, error) {
	t.Helper()
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	err := runRosterInvite(client, &out, &errOut,
		inviteTestOrg, inviteTestClassroom, inviteTestEmail, "Ada", "Lovelace", "section-1")
	return out.String(), errOut.String(), err
}

// newInviteMock is a mock with a resolvable classroom team and an empty roster.
func newInviteMock(t *testing.T, rosterCSV string) *inviteMock {
	t.Helper()
	return &inviteMock{
		rosterWriteMock: &rosterWriteMock{files: map[string]string{
			inviteTestClassroom + "/roster.csv":     rosterCSV,
			inviteTestClassroom + "/classroom.json": inviteTestClassroomJSON(t),
		}},
	}
}

// TestRunRosterInvite_HappyPath is the AE2 artifact leg: the invite team is
// created secret carrying only the provisional description, the acting teacher
// is dropped, the record lands last, the invitation carries BOTH team ids, and
// only then does the pending roster row get committed.
func TestRunRosterInvite_HappyPath(t *testing.T) {
	mock := newInviteMock(t, storedRosterHeader)
	out, _, err := runInvite(t, mock)
	if err != nil {
		t.Fatalf("runRosterInvite: %v", err)
	}

	slug := mock.inviteTeamSlug
	teamPath := "/orgs/o/teams/" + slug
	createIdx := indexOfCall(mock.calls, http.MethodPost, "/orgs/o/teams")
	dropIdx := indexOfCall(mock.calls, http.MethodDelete, teamPath+"/memberships/"+inviteTestActor)
	membersIdx := indexOfCall(mock.calls, http.MethodGet, teamPath+"/members")
	recordIdx := indexOfCall(mock.calls, http.MethodPatch, teamPath)
	inviteIdx := indexOfCall(mock.calls, http.MethodPost, "/orgs/o/invitations")
	treeIdx := indexOfCall(mock.calls, http.MethodPost, "/repos/o/classroom50/git/trees")
	sequence := []struct {
		name string
		idx  int
	}{
		{"team create", createIdx}, {"actor drop", dropIdx}, {"members read-back", membersIdx},
		{"record PATCH", recordIdx}, {"invitation POST", inviteIdx}, {"roster tree POST", treeIdx},
	}
	for i, step := range sequence {
		if step.idx < 0 {
			t.Fatalf("%s never happened; calls = %#v", step.name, mock.calls)
		}
		if i > 0 && step.idx < sequence[i-1].idx {
			t.Errorf("%s (call %d) came before %s (call %d); the send order is load-bearing",
				step.name, step.idx, sequence[i-1].name, sequence[i-1].idx)
		}
	}

	if got := mock.calls[createIdx].Description; strings.Contains(got, inviteTestEmail) {
		t.Errorf("create carried the invited email (%q); an interrupted run would strand it", got)
	}
	wantRecord, err := configrepo.MarshalInviteDescription(inviteTestClassroom, inviteTestEmail)
	if err != nil {
		t.Fatalf("MarshalInviteDescription: %v", err)
	}
	if got := mock.calls[recordIdx].Description; got != wantRecord {
		t.Errorf("record PATCH description = %q, want %q", got, wantRecord)
	}

	if got := mock.invitationBody["email"]; got != inviteTestEmail {
		t.Errorf("invitation email = %v, want %s", got, inviteTestEmail)
	}
	if got := mock.invitationBody["role"]; got != "direct_member" {
		t.Errorf("invitation role = %v, want direct_member", got)
	}
	teamIDs, _ := mock.invitationBody["team_ids"].([]any)
	if len(teamIDs) != 2 || teamIDs[0] != float64(inviteTestClassroomTeamID) || teamIDs[1] != float64(inviteTestInviteTeamID) {
		t.Errorf("invitation team_ids = %v, want [%d %d]", teamIDs, inviteTestClassroomTeamID, inviteTestInviteTeamID)
	}

	if mock.deletedTeamSlug != "" {
		t.Errorf("deleted team %q on the happy path", mock.deletedTeamSlug)
	}
	if len(mock.blobs) != 1 {
		t.Fatalf("got %d blobs POSTed, want 1: %#v", len(mock.blobs), mock.blobs)
	}
	rows, err := configrepo.ParseRoster([]byte(mock.blobs[0]))
	if err != nil {
		t.Fatalf("parse committed roster: %v\n%s", err, mock.blobs[0])
	}
	if len(rows) != 1 {
		t.Fatalf("committed %d rows, want 1:\n%s", len(rows), mock.blobs[0])
	}
	row := rows[0]
	if row.Username != "" || row.GitHubID != 0 {
		t.Errorf("pending row must carry no identity, got username %q id %d", row.Username, row.GitHubID)
	}
	if row.Email != inviteTestEmail || row.FirstName != "Ada" || row.LastName != "Lovelace" || row.Section != "section-1" {
		t.Errorf("pending row lost its email/metadata: %#v", row)
	}
	if row.Role != "student" {
		t.Errorf("pending row role = %q, want student (byte parity with the web's row)", row.Role)
	}
	if !strings.Contains(out, inviteTestEmail) {
		t.Errorf("stdout should name the invited address:\n%s", out)
	}
}

// An unresolvable classroom team must abort BEFORE anything is created or sent:
// a team-less email invite lands the student in the org attached to nothing.
func TestRunRosterInvite_ClassroomTeamMissing(t *testing.T) {
	mock := newInviteMock(t, storedRosterHeader)
	delete(mock.files, inviteTestClassroom+"/classroom.json") // → ResolveClassroomTeam ok=false

	_, _, err := runInvite(t, mock)
	if err == nil {
		t.Fatal("err = nil, want a hard failure naming the missing classroom team")
	}
	if !strings.Contains(err.Error(), "classroom add") {
		t.Errorf("error should point at `classroom add`: %v", err)
	}
	if n := countCalls(mock.calls, http.MethodPost, "/orgs/o/teams"); n != 0 {
		t.Errorf("created %d invite team(s) with no classroom team to attach", n)
	}
	if n := countCalls(mock.calls, http.MethodPost, "/orgs/o/invitations"); n != 0 {
		t.Errorf("sent %d invitation(s) with no classroom team", n)
	}
	if len(mock.blobs) != 0 {
		t.Errorf("committed %d blob(s) on a blocked send", len(mock.blobs))
	}
}

// GitHub's 422 means the address is already a member or already invited —
// nothing to send, so it's a skip (exit 0), and the team this run created is
// removed rather than left for the GC.
func TestRunRosterInvite_InvitationAlreadyMemberSkips(t *testing.T) {
	mock := newInviteMock(t, storedRosterHeader)
	mock.invitationStatus = http.StatusUnprocessableEntity

	out, _, err := runInvite(t, mock)
	if err != nil {
		t.Fatalf("a 422 must be a skip, not an error: %v", err)
	}
	if !strings.Contains(out, "skipped") {
		t.Errorf("stdout should report the skip:\n%s", out)
	}
	if mock.deletedTeamSlug != mock.inviteTeamSlug {
		t.Errorf("deleted team = %q, want the team this run created (%q)", mock.deletedTeamSlug, mock.inviteTeamSlug)
	}
	if len(mock.blobs) != 0 {
		t.Errorf("a skipped send must write no roster row, got %d blob(s)", len(mock.blobs))
	}
}

// A hard invitation failure deletes only what this run created: a fresh team
// holds nothing anyone can recover, so leaving it would only feed the GC.
func TestRunRosterInvite_InvitationFailureDeletesCreatedTeam(t *testing.T) {
	mock := newInviteMock(t, storedRosterHeader)
	mock.invitationStatus = http.StatusInternalServerError

	_, _, err := runInvite(t, mock)
	if err == nil {
		t.Fatal("err = nil, want the invitation failure to propagate")
	}
	if mock.deletedTeamSlug != mock.inviteTeamSlug {
		t.Errorf("deleted team = %q, want the team this run created", mock.deletedTeamSlug)
	}
	if len(mock.blobs) != 0 {
		t.Errorf("a failed send must write no roster row, got %d blob(s)", len(mock.blobs))
	}
}

// An ADOPTED team may hold an earlier invite's still-unrecovered record, so a
// failure must leave it standing — deleting it would destroy the only
// email→account mapping that invite has.
func TestRunRosterInvite_InvitationFailureKeepsAdoptedTeam(t *testing.T) {
	mock := newInviteMock(t, storedRosterHeader)
	mock.createStatus = http.StatusUnprocessableEntity // name taken → adopt
	mock.invitationStatus = http.StatusInternalServerError

	_, _, err := runInvite(t, mock)
	if err == nil {
		t.Fatal("err = nil, want the invitation failure to propagate")
	}
	if mock.deletedTeamSlug != "" {
		t.Errorf("deleted the adopted team %q; it may hold an earlier unrecovered record", mock.deletedTeamSlug)
	}
}

// A rate-limited send keeps the metadata team so a retry adopts it, matching the
// web's bulkInviteByEmail (`if (!rateLimited && inviteTeam.created)`). Deleting
// it would make every retry re-create the team, feeding the same limit.
func TestRunRosterInvite_RateLimitedSendKeepsCreatedTeam(t *testing.T) {
	mock := newInviteMock(t, storedRosterHeader)
	mock.invitationRateLimited = true

	_, _, err := runInvite(t, mock)
	if err == nil {
		t.Fatal("err = nil, want the rate limit to propagate")
	}
	if mock.deletedTeamSlug != "" {
		t.Errorf("deleted team %q on a rate limit; a retry must be able to adopt it", mock.deletedTeamSlug)
	}
	if len(mock.blobs) != 0 {
		t.Errorf("a rate-limited send must write no roster row, got %d blob(s)", len(mock.blobs))
	}
}

// An address an account row already carries still gets its invitation (the web
// sends too), but NOT a second row: appendEmailInviteRows skips any claimed
// address, so appending one here would leave a duplicate for the reconcile.
func TestRunRosterInvite_AddressOnAnAccountRowWarnsAndSends(t *testing.T) {
	mock := newInviteMock(t, storedRosterHeader+"sibling,Sib,Ling,"+inviteTestEmail+",,101,student\n")

	out, errOut, err := runInvite(t, mock)
	if err != nil {
		t.Fatalf("a shared address must not block the send: %v", err)
	}
	if !strings.Contains(errOut, "sibling") {
		t.Errorf("stderr should name the account already holding the address:\n%s", errOut)
	}
	if indexOfCall(mock.calls, http.MethodPost, "/orgs/o/invitations") < 0 {
		t.Fatalf("the invitation was never sent; calls = %#v", mock.calls)
	}
	if len(mock.blobs) != 0 {
		t.Fatalf("appended a second row for an already-claimed address: %#v", mock.blobs)
	}
	if !strings.Contains(out, "roster unchanged") {
		t.Errorf("stdout should report the row was skipped:\n%s", out)
	}
}

// A pending row already claims this address: re-sending would duplicate the row
// (or resurrect one sync is about to fold), so refuse before any API write.
func TestRunRosterInvite_ExistingPendingRowRefusedUpFront(t *testing.T) {
	mock := newInviteMock(t, storedRosterHeader+",,,"+inviteTestEmail+",,,student\n")

	_, _, err := runInvite(t, mock)
	if err == nil {
		t.Fatal("err = nil, want a refusal naming the existing pending invitation")
	}
	for _, want := range []string{"already invited", "roster sync", "cancel-invite"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error should mention %q: %v", want, err)
		}
	}
	for _, c := range mock.calls {
		switch c.Method {
		case http.MethodPost, http.MethodPatch, http.MethodPut, http.MethodDelete:
			t.Errorf("wrote %s %s before the refusal", c.Method, c.Path)
		}
	}
}

// The invitation is the source of truth once sent, so a failed roster write is
// never rolled back: warn, name `roster sync` as the repair, and still exit
// non-zero so a script sees the partial state.
func TestRunRosterInvite_RosterWriteFailureWarnsAndFails(t *testing.T) {
	mock := newInviteMock(t, storedRosterHeader)
	mock.commitFails = true

	_, errOut, err := runInvite(t, mock)
	if err == nil {
		t.Fatal("err = nil, want a non-zero exit for the partial state")
	}
	if !strings.Contains(errOut, "roster sync") {
		t.Errorf("stderr must name `roster sync` as the repair:\n%s", errOut)
	}
	if indexOfCall(mock.calls, http.MethodPost, "/orgs/o/invitations") < 0 {
		t.Fatal("the invitation should have been sent before the roster write")
	}
	if mock.deletedTeamSlug != "" {
		t.Errorf("deleted team %q after a SENT invitation; the record must outlive the row", mock.deletedTeamSlug)
	}
}

// Arg/flag validation runs inside RunE before any auth or network, so these
// need no server.
func TestRosterInviteCmd(t *testing.T) {
	run := func(t *testing.T, args ...string) error {
		t.Helper()
		return runRosterSubcommand(t, rosterInviteCmd(), args...)
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

	t.Run("carries roster add's metadata flags and no --role", func(t *testing.T) {
		flags := rosterInviteCmd().Flags()
		for _, name := range []string{"first-name", "last-name", "section"} {
			if flags.Lookup(name) == nil {
				t.Errorf("missing --%s", name)
			}
		}
		// CLI email invites are student-role only: the web gates an owner grant
		// behind a confirmation the CLI has no equivalent for.
		if flags.Lookup("role") != nil {
			t.Error("--role must not exist on `roster invite`")
		}
	})

	t.Run("has a --file flag for bulk invites", func(t *testing.T) {
		if rosterInviteCmd().Flags().Lookup("file") == nil {
			t.Error("missing --file")
		}
	})

	// Covers AE2 arg leg / R2: --file with a positional email is rejected before
	// any network call.
	t.Run("both a positional email and --file is an arg error", func(t *testing.T) {
		err := run(t, "o", "cs-principles", "ada@uni.edu", "--file", "list.txt")
		if err == nil || !strings.Contains(err.Error(), "--file") {
			t.Fatalf("err = %v, want an arg error naming --file", err)
		}
	})

	t.Run("--file at a nonexistent path errors before network", func(t *testing.T) {
		err := run(t, "o", "cs-principles", "--file", "/no/such/list-file.txt")
		if err == nil || !strings.Contains(err.Error(), "read") {
			t.Fatalf("err = %v, want a read error", err)
		}
	})
}

// The three email-lifecycle subcommands must be reachable and discoverable: a
// registration miss is invisible without this, since the package compiles fine.
func TestRosterCmdRegistersInviteLifecycleSubcommands(t *testing.T) {
	for _, name := range []string{"invite", "cancel-invite", "sync"} {
		t.Run(name, func(t *testing.T) {
			var found bool
			for _, sub := range NewCmd().Commands() {
				if sub.Name() == name {
					found = true
				}
			}
			if !found {
				t.Errorf("`roster %s` is not registered on the roster command", name)
			}
			if !strings.Contains(NewCmd().Long, name) {
				t.Errorf("the roster subcommand summary should list %s", name)
			}
		})
	}
}
