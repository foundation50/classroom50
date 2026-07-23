package member

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/gh-teacher/internal/githubtest"
)

// memberMock serves the org-members / org-invitations / repo-
// collaborators endpoints `member list` reads. Each field is the JSON
// array a given endpoint returns; the handler also honors role=admin
// filtering and page/per_page pagination so the walk logic is covered.
type memberMock struct {
	orgMembers       []map[string]any // GET /orgs/{org}/members (all)
	orgAdmins        []map[string]any // GET /orgs/{org}/members?role=admin
	orgInvitations   []map[string]any // GET /orgs/{org}/invitations
	invitationsErr   int              // if non-zero, /invitations returns this status
	invitationScopes string           // X-OAuth-Scopes header on the /invitations error (drives 403 classification)
	membersErr       int              // if non-zero, /members returns this status
	collaborators    []map[string]any // GET /repos/{o}/{r}/collaborators
	collaboratorErr  int              // if non-zero, /collaborators returns this status
}

func (m *memberMock) handler(t *testing.T) http.Handler {
	t.Helper()
	mux := http.NewServeMux()

	mux.HandleFunc("/orgs/o/members", func(w http.ResponseWriter, r *http.Request) {
		if m.membersErr != 0 {
			http.Error(w, "members error", m.membersErr)
			return
		}
		if r.URL.Query().Get("role") == "admin" {
			writePagedJSON(w, r, m.orgAdmins)
			return
		}
		writePagedJSON(w, r, m.orgMembers)
	})
	mux.HandleFunc("/orgs/o/invitations", func(w http.ResponseWriter, r *http.Request) {
		if m.invitationsErr != 0 {
			if m.invitationScopes != "" {
				w.Header().Set("X-OAuth-Scopes", m.invitationScopes)
			}
			http.Error(w, "forbidden", m.invitationsErr)
			return
		}
		writePagedJSON(w, r, m.orgInvitations)
	})
	mux.HandleFunc("/repos/o/hello/collaborators", func(w http.ResponseWriter, r *http.Request) {
		if m.collaboratorErr != 0 {
			http.Error(w, "collaborators error", m.collaboratorErr)
			return
		}
		writePagedJSON(w, r, m.collaborators)
	})

	return mux
}

// writePagedJSON emulates GitHub page/per_page pagination over `all`:
// it slices the requested page and returns it, so a caller looping
// until a short page terminates correctly.
func writePagedJSON(w http.ResponseWriter, r *http.Request, all []map[string]any) {
	perPage := 100
	if v := r.URL.Query().Get("per_page"); v != "" {
		_, _ = fmt.Sscanf(v, "%d", &perPage)
	}
	page := 1
	if v := r.URL.Query().Get("page"); v != "" {
		_, _ = fmt.Sscanf(v, "%d", &page)
	}
	start := (page - 1) * perPage
	if start >= len(all) {
		_ = json.NewEncoder(w).Encode([]map[string]any{})
		return
	}
	end := start + perPage
	if end > len(all) {
		end = len(all)
	}
	_ = json.NewEncoder(w).Encode(all[start:end])
}

func acct(login string, id int64) map[string]any {
	return map[string]any{"login": login, "id": id}
}

func TestRunMemberListOrg(t *testing.T) {
	mock := &memberMock{
		orgMembers: []map[string]any{acct("alice", 1), acct("bob", 2), acct("carol", 3)},
		orgAdmins:  []map[string]any{acct("alice", 1)},
		orgInvitations: []map[string]any{
			{"login": "dave", "id": 4, "role": "direct_member"},
		},
	}
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	t.Run("default table labels roles and pending invites", func(t *testing.T) {
		var out, errOut bytes.Buffer
		if err := runMemberListOrg(client, &out, &errOut, "o", false, false); err != nil {
			t.Fatalf("runMemberListOrg: %v", err)
		}
		s := out.String()
		if !strings.Contains(s, "LOGIN") || !strings.Contains(s, "KIND") {
			t.Errorf("stdout = %q, want a header", s)
		}
		for _, want := range []string{"alice", "admin", "bob", "member", "dave", "invitation"} {
			if !strings.Contains(s, want) {
				t.Errorf("stdout missing %q\n%s", want, s)
			}
		}
		if !strings.Contains(errOut.String(), "4 member(s) (3 active, 1 pending)") {
			t.Errorf("stderr = %q, want the 4/3/1 summary", errOut.String())
		}
	})

	t.Run("--json emits typed entries", func(t *testing.T) {
		var out, errOut bytes.Buffer
		if err := runMemberListOrg(client, &out, &errOut, "o", true, false); err != nil {
			t.Fatalf("runMemberListOrg --json: %v", err)
		}
		var got []memberListEntry
		if err := json.Unmarshal(out.Bytes(), &got); err != nil {
			t.Fatalf("unmarshal: %v\n%s", err, out.String())
		}
		if len(got) != 4 {
			t.Fatalf("got %d entries, want 4: %#v", len(got), got)
		}
		byLogin := map[string]memberListEntry{}
		for _, e := range got {
			byLogin[e.Login] = e
		}
		if byLogin["alice"].Role != "admin" || byLogin["alice"].Kind != memberKindOrgMember {
			t.Errorf("alice = %#v, want admin/member", byLogin["alice"])
		}
		if byLogin["bob"].Role != "member" {
			t.Errorf("bob role = %q, want member", byLogin["bob"].Role)
		}
		if byLogin["dave"].Kind != memberKindOrgInvitation || byLogin["dave"].Role != "member" {
			t.Errorf("dave = %#v, want invitation/member (direct_member normalized)", byLogin["dave"])
		}
	})

	t.Run("--quiet prints one login per line, no stderr", func(t *testing.T) {
		var out, errOut bytes.Buffer
		if err := runMemberListOrg(client, &out, &errOut, "o", false, true); err != nil {
			t.Fatalf("runMemberListOrg --quiet: %v", err)
		}
		lines := strings.Split(strings.TrimSpace(out.String()), "\n")
		if len(lines) != 4 {
			t.Fatalf("stdout lines = %q, want 4", lines)
		}
		if strings.Contains(out.String(), "LOGIN") {
			t.Errorf("--quiet should not print the header")
		}
		if errOut.Len() != 0 {
			t.Errorf("--quiet should suppress stderr, got %q", errOut.String())
		}
	})
}

func TestRunMemberListOrg_EmptyAndJSONArray(t *testing.T) {
	mock := &memberMock{} // no members, no invites
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	t.Run("--json on empty org emits [] not null", func(t *testing.T) {
		var out, errOut bytes.Buffer
		if err := runMemberListOrg(client, &out, &errOut, "o", true, false); err != nil {
			t.Fatalf("runMemberListOrg: %v", err)
		}
		if got := strings.TrimSpace(out.String()); got != "[]" {
			t.Errorf("stdout = %q, want []", got)
		}
	})

	t.Run("empty org: stderr says none", func(t *testing.T) {
		var out, errOut bytes.Buffer
		if err := runMemberListOrg(client, &out, &errOut, "o", false, false); err != nil {
			t.Fatalf("runMemberListOrg: %v", err)
		}
		if !strings.Contains(errOut.String(), "no members found") {
			t.Errorf("stderr = %q, want 'no members found'", errOut.String())
		}
	})
}

func TestRunMemberListOrg_InvitationsForbidden(t *testing.T) {
	cases := []struct {
		name   string
		scopes string // X-OAuth-Scopes on the 403
		want   string // substring the error must contain
	}{
		// No header (e.g., fine-grained PAT) -> generic: points at the scope + access.
		{"generic (no scopes header)", "", "admin:org"},
		// Has other scopes but not admin:org -> scope-missing sentinel.
		{"scope missing", "repo, read:org", "missing admin:org OAuth scope"},
		// Has admin:org but still 403 -> not an admin of the org.
		{"has scope, not admin", "repo, admin:org", "you may not have admin access"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mock := &memberMock{
				orgMembers:       []map[string]any{acct("alice", 1)},
				invitationsErr:   http.StatusForbidden,
				invitationScopes: tc.scopes,
			}
			server := httptest.NewServer(mock.handler(t))
			t.Cleanup(server.Close)
			client := githubtest.NewTestClient(t, server)

			var out, errOut bytes.Buffer
			err := runMemberListOrg(client, &out, &errOut, "o", false, false)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want substring %q", err, tc.want)
			}
		})
	}
}

func TestRunMemberListOrg_Pagination(t *testing.T) {
	// 150 members forces two pages (per_page=100); admins empty.
	var members []map[string]any
	for i := 1; i <= 150; i++ {
		members = append(members, acct(fmt.Sprintf("user%03d", i), int64(i)))
	}
	mock := &memberMock{orgMembers: members}
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runMemberListOrg(client, &out, &errOut, "o", true, false); err != nil {
		t.Fatalf("runMemberListOrg: %v", err)
	}
	var got []memberListEntry
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got) != 150 {
		t.Errorf("got %d entries, want 150 (pagination across 2 pages)", len(got))
	}
}

func TestRunMemberListRepo(t *testing.T) {
	mock := &memberMock{
		collaborators: []map[string]any{
			{"login": "alice", "id": 1, "role_name": "admin"},
			{"login": "bob", "id": 2, "role_name": "write"},
		},
	}
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	t.Run("default table lists collaborators with permission level", func(t *testing.T) {
		var out, errOut bytes.Buffer
		if err := runMemberListRepo(client, &out, &errOut, "o", "hello", false, false); err != nil {
			t.Fatalf("runMemberListRepo: %v", err)
		}
		s := out.String()
		for _, want := range []string{"alice", "admin", "bob", "write", "collaborator"} {
			if !strings.Contains(s, want) {
				t.Errorf("stdout missing %q\n%s", want, s)
			}
		}
		if !strings.Contains(errOut.String(), "2 collaborator(s)") {
			t.Errorf("stderr = %q, want '2 collaborator(s)'", errOut.String())
		}
	})

	t.Run("--json emits typed collaborator entries", func(t *testing.T) {
		var out, errOut bytes.Buffer
		if err := runMemberListRepo(client, &out, &errOut, "o", "hello", true, true); err != nil {
			t.Fatalf("runMemberListRepo --json: %v", err)
		}
		var got []memberListEntry
		if err := json.Unmarshal(out.Bytes(), &got); err != nil {
			t.Fatalf("unmarshal: %v\n%s", err, out.String())
		}
		if len(got) != 2 {
			t.Fatalf("got %d, want 2", len(got))
		}
		if got[0].Kind != memberKindCollaborator || got[0].Role != "admin" {
			t.Errorf("entry[0] = %#v, want collaborator/admin", got[0])
		}
		if errOut.Len() != 0 {
			t.Errorf("--quiet should suppress stderr, got %q", errOut.String())
		}
	})
}

func TestNormalizeInviteRole(t *testing.T) {
	cases := map[string]string{
		"direct_member":   "member",
		"":                "member",
		"admin":           "admin",
		"billing_manager": "billing_manager",
	}
	for in, want := range cases {
		if got := normalizeInviteRole(in); got != want {
			t.Errorf("normalizeInviteRole(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRunMemberListRepo_EmptyRoleName(t *testing.T) {
	// A collaborator whose role_name GitHub didn't report: the JSON Role
	// must be the raw empty string (no "(unknown)" sentinel leaking into
	// the machine contract); the table renders it as "-".
	mock := &memberMock{collaborators: []map[string]any{
		{"login": "alice", "id": 1, "role_name": ""},
	}}
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	t.Run("--json keeps empty role, not a sentinel", func(t *testing.T) {
		var out, errOut bytes.Buffer
		if err := runMemberListRepo(client, &out, &errOut, "o", "hello", true, true); err != nil {
			t.Fatalf("runMemberListRepo: %v", err)
		}
		var got []memberListEntry
		if err := json.Unmarshal(out.Bytes(), &got); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if len(got) != 1 || got[0].Role != "" {
			t.Errorf("entry = %#v, want role==\"\" (no (unknown) sentinel in JSON)", got)
		}
	})

	t.Run("table renders empty role as -", func(t *testing.T) {
		var out, errOut bytes.Buffer
		if err := runMemberListRepo(client, &out, &errOut, "o", "hello", false, false); err != nil {
			t.Fatalf("runMemberListRepo: %v", err)
		}
		var aliceRow string
		for _, line := range strings.Split(out.String(), "\n") {
			if strings.HasPrefix(line, "alice") {
				aliceRow = line
			}
		}
		if !strings.Contains(aliceRow, "-") {
			t.Errorf("alice row = %q, want '-' for the empty role", aliceRow)
		}
	})
}

func TestRunMemberList_ErrorPaths(t *testing.T) {
	t.Run("500 on org members propagates", func(t *testing.T) {
		mock := &memberMock{membersErr: http.StatusInternalServerError}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		err := runMemberListOrg(client, &out, &errOut, "o", false, false)
		if err == nil {
			t.Fatalf("err = nil, want a non-nil error for a 5xx on /members")
		}
	})

	t.Run("404 on org members maps to a not-found message", func(t *testing.T) {
		mock := &memberMock{membersErr: http.StatusNotFound}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		err := runMemberListOrg(client, &out, &errOut, "o", false, false)
		if err == nil || !strings.Contains(err.Error(), "not found or not accessible") {
			t.Fatalf("err = %v, want a 'not found or not accessible' mapping", err)
		}
	})

	t.Run("404 on repo collaborators maps to a not-found message", func(t *testing.T) {
		mock := &memberMock{collaboratorErr: http.StatusNotFound}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		err := runMemberListRepo(client, &out, &errOut, "o", "hello", false, false)
		if err == nil || !strings.Contains(err.Error(), "not found or not accessible") {
			t.Fatalf("err = %v, want a 'not found or not accessible' mapping", err)
		}
		if !strings.Contains(err.Error(), "o/hello") {
			t.Errorf("err = %v, want the o/hello subject", err)
		}
	})

	t.Run("500 on repo collaborators propagates", func(t *testing.T) {
		mock := &memberMock{collaboratorErr: http.StatusInternalServerError}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		if err := runMemberListRepo(client, &out, &errOut, "o", "hello", false, false); err == nil {
			t.Fatalf("err = nil, want a non-nil error for a 5xx on /collaborators")
		}
	})
}

func TestRunMemberListRepo_EmptyCollaborators(t *testing.T) {
	mock := &memberMock{collaborators: nil}
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runMemberListRepo(client, &out, &errOut, "o", "hello", false, false); err != nil {
		t.Fatalf("runMemberListRepo: %v", err)
	}
	if !strings.Contains(errOut.String(), "no collaborators found") {
		t.Errorf("stderr = %q, want 'no collaborators found' for an empty repo target", errOut.String())
	}
}

func TestRunMemberListRepo_Pagination(t *testing.T) {
	var collabs []map[string]any
	for i := 1; i <= 150; i++ {
		collabs = append(collabs, map[string]any{"login": fmt.Sprintf("c%03d", i), "id": int64(i), "role_name": "write"})
	}
	mock := &memberMock{collaborators: collabs}
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runMemberListRepo(client, &out, &errOut, "o", "hello", true, true); err != nil {
		t.Fatalf("runMemberListRepo: %v", err)
	}
	var got []memberListEntry
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got) != 150 {
		t.Errorf("got %d collaborators, want 150 (pagination across 2 pages)", len(got))
	}
}

func TestRunMemberListOrg_InvitationsPagination(t *testing.T) {
	mock := &memberMock{orgMembers: []map[string]any{acct("alice", 1)}}
	for i := 1; i <= 120; i++ {
		mock.orgInvitations = append(mock.orgInvitations, map[string]any{"login": fmt.Sprintf("inv%03d", i), "id": int64(1000 + i), "role": "direct_member"})
	}
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runMemberListOrg(client, &out, &errOut, "o", true, false); err != nil {
		t.Fatalf("runMemberListOrg: %v", err)
	}
	var got []memberListEntry
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got) != 121 { // 1 member + 120 invitations
		t.Errorf("got %d entries, want 121 (1 member + 120 paginated invitations)", len(got))
	}
}
