package configrepo

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/gh-teacher/internal/githubtest"
)

const (
	testInviteOrg       = "acme"
	testInviteClassroom = "cs101"
	testInviteEmail     = "alice@example.com"
	testInviteActor     = "ms-frizzle"
)

// recordedCall is one API request the invite-team server saw, in order. Order is
// the contract under test: the email record must be the LAST write.
type recordedCall struct {
	Method      string
	Path        string
	Description string
}

// inviteTeamScript drives the scripted invite-team server: the privacy the
// create, the adopt read, and each PATCH report, plus the membership the
// read-back sees.
type inviteTeamScript struct {
	createPrivacy string // "" = respond 422 (name taken), driving the adopt path
	adoptPrivacy  string
	patchPrivacy  string
	members       []map[string]any
}

// inviteTeamServer replays a scripted invite-team flow, recording every call.
func inviteTeamServer(t *testing.T, script inviteTeamScript) (*httptest.Server, *[]recordedCall) {
	t.Helper()
	slug := InviteTeamName(testInviteClassroom, testInviteEmail)
	teamPath := "/orgs/" + testInviteOrg + "/teams/" + slug
	calls := &[]recordedCall{}
	record := func(r *http.Request) string {
		var body struct {
			Description string `json:"description"`
		}
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		*calls = append(*calls, recordedCall{Method: r.Method, Path: r.URL.Path, Description: body.Description})
		return body.Description
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/orgs/"+testInviteOrg+"/teams" && r.Method == http.MethodPost:
			record(r)
			if script.createPrivacy == "" {
				w.WriteHeader(http.StatusUnprocessableEntity)
				_, _ = w.Write([]byte(`{"message":"Name must be unique for this org"}`))
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": 7, "slug": slug, "privacy": script.createPrivacy,
			})
		case r.URL.Path == teamPath && r.Method == http.MethodGet:
			record(r)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": 7, "slug": slug, "privacy": script.adoptPrivacy,
				"description": "a stale description from an earlier run",
			})
		case r.URL.Path == teamPath && r.Method == http.MethodPatch:
			desc := record(r)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": 7, "slug": slug, "privacy": script.patchPrivacy, "description": desc,
			})
		case r.URL.Path == teamPath+"/memberships/"+testInviteActor && r.Method == http.MethodDelete:
			record(r)
			w.WriteHeader(http.StatusNoContent)
		case r.URL.Path == teamPath+"/members" && r.Method == http.MethodGet:
			record(r)
			members := script.members
			if members == nil {
				members = []map[string]any{}
			}
			_ = json.NewEncoder(w).Encode(members)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server, calls
}

func methodsOf(calls []recordedCall) []string {
	out := make([]string, 0, len(calls))
	for _, c := range calls {
		out = append(out, c.Method)
	}
	return out
}

func assertMethods(t *testing.T, calls []recordedCall, want ...string) {
	t.Helper()
	got := methodsOf(calls)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("request order = %v, want %v", got, want)
	}
}

// wantRecord is the exact description bytes the flow must end with.
func wantRecord(t *testing.T) string {
	t.Helper()
	record, err := MarshalInviteDescription(testInviteClassroom, testInviteEmail)
	if err != nil {
		t.Fatalf("MarshalInviteDescription: %v", err)
	}
	return record
}

// The fresh-create path: the team is created carrying NO email (only the
// provisional description), the acting teacher is dropped, the team is PROVEN
// empty, and only then does the email land.
func TestEnsureInviteTeam_FreshCreateWritesEmailLast(t *testing.T) {
	server, calls := inviteTeamServer(t, inviteTeamScript{
		createPrivacy: "secret", patchPrivacy: "secret",
	})
	client := githubtest.NewTestClient(t, server)

	ref, created, err := EnsureInviteTeam(client, testInviteOrg, testInviteClassroom, testInviteEmail, testInviteActor)
	if err != nil {
		t.Fatalf("EnsureInviteTeam: %v", err)
	}
	if !created {
		t.Error("created = false, want true on a fresh create (drives delete-on-failure cleanup)")
	}
	slug := InviteTeamName(testInviteClassroom, testInviteEmail)
	if ref.ID != 7 || ref.Slug != slug {
		t.Errorf("ref = %+v, want id 7 / %s", ref, slug)
	}
	assertMethods(t, *calls, "POST", "DELETE", "GET", "PATCH")
	if got := (*calls)[0].Description; got != inviteProvisionalDescription {
		t.Errorf("create description = %q, want the provisional %q", got, inviteProvisionalDescription)
	}
	if strings.Contains((*calls)[0].Description, testInviteEmail) {
		t.Error("the create carried the invited email; an interrupted run would strand it on a team holding a teacher")
	}
	if got, want := (*calls)[3].Description, wantRecord(t); got != want {
		t.Errorf("record PATCH description = %q, want %q", got, want)
	}
}

// The 422 adopt path: a same-named team from a resend/retry is adopted, its
// privacy forced to secret on its OWN patch, and the email still lands last.
func TestEnsureInviteTeam_AdoptForcesSecretBeforeEmail(t *testing.T) {
	server, calls := inviteTeamServer(t, inviteTeamScript{
		adoptPrivacy: "closed", patchPrivacy: "secret",
	})
	client := githubtest.NewTestClient(t, server)

	ref, created, err := EnsureInviteTeam(client, testInviteOrg, testInviteClassroom, testInviteEmail, testInviteActor)
	if err != nil {
		t.Fatalf("EnsureInviteTeam adopt: %v", err)
	}
	if created {
		t.Error("created = true for an adopted team; a caller's cleanup would delete a team it didn't create")
	}
	if ref.ID != 7 {
		t.Errorf("ref = %+v, want the adopted id 7", ref)
	}
	assertMethods(t, *calls, "POST", "GET", "PATCH", "DELETE", "GET", "PATCH")
	// The privacy fix rides its own PATCH — the email only ever rides the last.
	if got := (*calls)[2].Description; got != "" {
		t.Errorf("privacy PATCH carried a description %q, want none", got)
	}
	if got, want := (*calls)[5].Description, wantRecord(t); got != want {
		t.Errorf("record PATCH description = %q, want %q", got, want)
	}
}

// An adopted team GitHub reports as still non-secret after the PATCH must fail
// closed BEFORE any membership call: the description holds a plaintext email
// that every org member could otherwise read.
func TestEnsureInviteTeam_NonSecretFailsClosed(t *testing.T) {
	server, calls := inviteTeamServer(t, inviteTeamScript{
		adoptPrivacy: "closed", patchPrivacy: "closed",
	})
	client := githubtest.NewTestClient(t, server)

	_, _, err := EnsureInviteTeam(client, testInviteOrg, testInviteClassroom, testInviteEmail, testInviteActor)
	if !errors.Is(err, ErrInviteTeamNotSecret) {
		t.Fatalf("err = %v, want ErrInviteTeamNotSecret", err)
	}
	for _, c := range *calls {
		if c.Method == http.MethodDelete {
			t.Errorf("touched membership (%s %s) before settling the secret invariant", c.Method, c.Path)
		}
		if strings.Contains(c.Description, testInviteEmail) {
			t.Errorf("wrote the invited email onto a non-secret team: %s %s", c.Method, c.Path)
		}
	}
}

// A member surviving the actor drop is a teacher stranded by an earlier run —
// exactly what the reconcile would misread as the accepted invitee. Fail closed
// while the team still holds no email.
func TestEnsureInviteTeam_NonEmptyFailsClosed(t *testing.T) {
	server, calls := inviteTeamServer(t, inviteTeamScript{
		createPrivacy: "secret", patchPrivacy: "secret",
		members: []map[string]any{{"login": "other-teacher", "id": 99}},
	})
	client := githubtest.NewTestClient(t, server)

	_, created, err := EnsureInviteTeam(client, testInviteOrg, testInviteClassroom, testInviteEmail, testInviteActor)
	if !errors.Is(err, ErrInviteTeamNotEmpty) {
		t.Fatalf("err = %v, want ErrInviteTeamNotEmpty", err)
	}
	if !created {
		t.Error("created = false, want true so the caller can delete the team this run created")
	}
	assertMethods(t, *calls, "POST", "DELETE", "GET")
	for _, c := range *calls {
		if strings.Contains(c.Description, testInviteEmail) {
			t.Errorf("wrote the invited email onto a team that still had a member: %s %s", c.Method, c.Path)
		}
	}
}

// A degraded membership read must not read as "empty" — that is the whole point
// of proving the team teacher-free rather than assuming it.
func TestEnsureInviteTeam_DegradedMemberReadFails(t *testing.T) {
	slug := InviteTeamName(testInviteClassroom, testInviteEmail)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/orgs/"+testInviteOrg+"/teams" && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]any{"id": 7, "slug": slug, "privacy": "secret"})
		case strings.HasSuffix(r.URL.Path, "/members"):
			w.WriteHeader(http.StatusInternalServerError)
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPatch:
			t.Error("must not write the email record after a degraded membership read")
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	_, _, err := EnsureInviteTeam(githubtest.NewTestClient(t, server), testInviteOrg, testInviteClassroom, testInviteEmail, testInviteActor)
	if err == nil {
		t.Fatal("err = nil, want the degraded membership read to propagate")
	}
}

// ReadInviteTeam is the reconcile's per-team read: the parsed record plus the
// created_at the 24h GC age gate needs.
func TestReadInviteTeam(t *testing.T) {
	slug := InviteTeamName(testInviteClassroom, testInviteEmail)
	record := wantRecord(t)

	t.Run("returns the parsed record and created_at", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": 7, "slug": slug, "privacy": "secret",
				"description": record, "created_at": "2026-08-01T10:00:00Z",
			})
		}))
		t.Cleanup(server.Close)

		state, ok, err := ReadInviteTeam(githubtest.NewTestClient(t, server), testInviteOrg, slug)
		if err != nil || !ok {
			t.Fatalf("ReadInviteTeam: ok=%v err=%v", ok, err)
		}
		if state.Record == nil || state.Record.Email != testInviteEmail {
			t.Errorf("record = %+v, want the invited email", state.Record)
		}
		if state.CreatedAt.IsZero() {
			t.Error("created_at unset; the GC age gate would never fire")
		}
	})

	t.Run("a hand-edited description yields no record, not an error", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": 7, "slug": slug, "description": "ask the TA",
			})
		}))
		t.Cleanup(server.Close)

		state, ok, err := ReadInviteTeam(githubtest.NewTestClient(t, server), testInviteOrg, slug)
		if err != nil || !ok {
			t.Fatalf("ReadInviteTeam: ok=%v err=%v", ok, err)
		}
		if state.Record != nil {
			t.Errorf("record = %+v, want nil so the caller skips the team", state.Record)
		}
	})

	t.Run("404 reads as gone, other failures propagate", func(t *testing.T) {
		gone := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.NotFound(w, nil)
		}))
		t.Cleanup(gone.Close)
		if _, ok, err := ReadInviteTeam(githubtest.NewTestClient(t, gone), testInviteOrg, slug); ok || err != nil {
			t.Errorf("404: ok=%v err=%v, want (false, nil)", ok, err)
		}

		broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))
		t.Cleanup(broken.Close)
		if _, _, err := ReadInviteTeam(githubtest.NewTestClient(t, broken), testInviteOrg, slug); err == nil {
			t.Error("err = nil for a 500; a degraded read must never look like an absent team")
		}
	})
}

// ListTeamMembersWithIDs carries the numeric id the roster's github_id column
// needs, and lists EVERY role — an org owner GitHub auto-promotes to maintainer
// is still the accepted invitee.
func TestListTeamMembersWithIDs(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("role") != "" {
			t.Errorf("must not filter by role: %s", r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"login": "ada", "id": 42},
			{"login": "", "id": 43},
			{"login": "grace", "id": 44},
		})
	}))
	t.Cleanup(server.Close)

	members, err := ListTeamMembersWithIDs(githubtest.NewTestClient(t, server), testInviteOrg, "invite-0123456789abcdef")
	if err != nil {
		t.Fatalf("ListTeamMembersWithIDs: %v", err)
	}
	if len(members) != 2 {
		t.Fatalf("members = %+v, want the two login-bearing entries", members)
	}
	if members[0].Login != "ada" || members[0].ID != 42 {
		t.Errorf("members[0] = %+v, want ada/42", members[0])
	}
}

// A vanished team reads as "no members" (the invite simply looks pending), but a
// degraded read must propagate — treating it as empty would let the GC reap a
// team whose invitee had actually accepted.
func TestListTeamMembersWithIDs_404IsEmptyAndErrorsPropagate(t *testing.T) {
	gone := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.NotFound(w, nil)
	}))
	t.Cleanup(gone.Close)
	members, err := ListTeamMembersWithIDs(githubtest.NewTestClient(t, gone), testInviteOrg, "invite-0123456789abcdef")
	if err != nil || len(members) != 0 {
		t.Errorf("404: members=%+v err=%v, want (empty, nil)", members, err)
	}

	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	t.Cleanup(broken.Close)
	if _, err := ListTeamMembersWithIDs(githubtest.NewTestClient(t, broken), testInviteOrg, "invite-0123456789abcdef"); err == nil {
		t.Error("err = nil for a 403; a degraded membership read must not look empty")
	}
}

// A team GitHub reports as non-secret despite the create asking for secret must
// still come back created=true: the caller's cleanup is the only thing that will
// delete it, and it deletes only what this run created.
func TestEnsureInviteTeam_FreshCreateNonSecretStillReportsCreated(t *testing.T) {
	server, calls := inviteTeamServer(t, inviteTeamScript{
		createPrivacy: "closed", patchPrivacy: "closed",
	})
	client := githubtest.NewTestClient(t, server)

	_, created, err := EnsureInviteTeam(client, testInviteOrg, testInviteClassroom, testInviteEmail, testInviteActor)
	if !errors.Is(err, ErrInviteTeamNotSecret) {
		t.Fatalf("err = %v, want ErrInviteTeamNotSecret", err)
	}
	if !created {
		t.Error("created = false; the caller would leave the team it just created standing")
	}
	assertMethods(t, *calls, "POST", "PATCH")
}

// A 422 that ISN'T a name collision (the adopt read 404s) must surface the
// original create error, which says what GitHub actually rejected — not a
// misleading "couldn't adopt".
func TestEnsureInviteTeam_422WithoutCollisionSurfacesCreateError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"message":"Validation Failed: parent team not found"}`))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)

	_, created, err := EnsureInviteTeam(githubtest.NewTestClient(t, server), testInviteOrg, testInviteClassroom, testInviteEmail, testInviteActor)
	if err == nil || !strings.Contains(err.Error(), "POST orgs/"+testInviteOrg+"/teams") {
		t.Fatalf("err = %v, want the original create failure", err)
	}
	if created {
		t.Error("created = true after a failed create; cleanup would delete a team that doesn't exist")
	}
}
