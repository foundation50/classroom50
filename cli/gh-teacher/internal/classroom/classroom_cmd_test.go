package classroom

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubtest"
	"github.com/foundation50/gh-teacher/internal/output"
)

// configRepoMock is a minimal in-memory <org>/classroom50 server
// covering the contents API and git-data API surface the classroom
// commands touch. files maps repo-relative path -> content. blobs
// records the decoded content of every blob POSTed, so a test can
// assert what an edit re-encoded.
type configRepoMock struct {
	files            map[string]string
	blobs            []string
	teamDeleted      bool     // set when DELETE /orgs/o/teams/classroom50-cs-principles is received
	staffTeamDeleted []string // staff-team slugs that received a DELETE
}

func (m *configRepoMock) handler(t *testing.T) http.Handler {
	t.Helper()
	mux := http.NewServeMux()

	// Repo metadata → default branch.
	mux.HandleFunc("/repos/o/classroom50", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"default_branch": "main"})
	})

	// Root contents listing (exact path, no trailing slash).
	mux.HandleFunc("/repos/o/classroom50/contents", func(w http.ResponseWriter, r *http.Request) {
		seen := map[string]string{}
		for p := range m.files {
			if seg, _, found := strings.Cut(p, "/"); found {
				seen[seg] = "dir"
			} else {
				seen[seg] = "file"
			}
		}
		var entries []map[string]string
		for name, typ := range seen {
			entries = append(entries, map[string]string{"name": name, "path": name, "type": typ, "sha": "sha-" + name})
		}
		_ = json.NewEncoder(w).Encode(entries)
	})

	// File reads and directory-existence probes.
	mux.HandleFunc("/repos/o/classroom50/contents/", func(w http.ResponseWriter, r *http.Request) {
		repoPath := strings.TrimPrefix(r.URL.Path, "/repos/o/classroom50/contents/")
		if content, ok := m.files[repoPath]; ok {
			_ = json.NewEncoder(w).Encode(map[string]string{
				"content":  base64.StdEncoding.EncodeToString([]byte(content)),
				"encoding": "base64",
			})
			return
		}
		// Directory probe (contentsExists): 200 if any file lives under it.
		for p := range m.files {
			if strings.HasPrefix(p, repoPath+"/") {
				_ = json.NewEncoder(w).Encode([]map[string]string{})
				return
			}
		}
		http.NotFound(w, r)
	})

	// git-data: refs, commits, blobs, trees.
	mux.HandleFunc("/repos/o/classroom50/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "parent-sha"}})
		case http.MethodPatch:
			w.WriteHeader(http.StatusOK)
		}
	})
	mux.HandleFunc("/repos/o/classroom50/git/commits/", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"tree": map[string]string{"sha": "parent-tree"}})
	})
	mux.HandleFunc("/repos/o/classroom50/git/commits", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-commit-sha"})
	})
	mux.HandleFunc("/repos/o/classroom50/git/blobs", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var blob struct {
			Content  string `json:"content"`
			Encoding string `json:"encoding"`
		}
		if err := json.Unmarshal(body, &blob); err == nil {
			if decoded, derr := base64.StdEncoding.DecodeString(blob.Content); derr == nil {
				m.blobs = append(m.blobs, string(decoded))
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "blob-sha"})
	})
	mux.HandleFunc("/repos/o/classroom50/git/trees", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-tree-sha"})
	})
	mux.HandleFunc("/repos/o/classroom50/git/trees/", func(w http.ResponseWriter, r *http.Request) {
		// Recursive tree read → blob entry per file, tree entry per dir prefix.
		dirs := map[string]bool{}
		var entries []map[string]string
		for p := range m.files {
			entries = append(entries, map[string]string{"path": p, "type": "blob"})
			if seg, _, found := strings.Cut(p, "/"); found {
				dirs[seg] = true
			}
		}
		for d := range dirs {
			entries = append(entries, map[string]string{"path": d, "type": "tree"})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"tree": entries, "truncated": false})
	})

	// Classroom team delete (DELETE /orgs/o/teams/{slug}) — records the
	// Classroom team verify+delete (GET then DELETE
	// /orgs/o/teams/{slug}) — records the delete so a test can assert
	// classroom remove tears the team down by its persisted slug, after
	// confirming the live team id matches the recorded one (4242, set by
	// classroomJSONContent).
	mux.HandleFunc("/orgs/o/teams/classroom50-cs-principles", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{"id": 4242, "slug": "classroom50-cs-principles"})
		case http.MethodDelete:
			m.teamDeleted = true
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	})

	// Staff-team verify+delete routes (instructor, ta), keyed by the
	// slug + recorded ids the classroomJSONWithStaffTeams helper sets.
	for _, st := range []struct {
		slug string
		id   int64
	}{
		{"classroom50-cs-principles-instructor", 4243},
		{"classroom50-cs-principles-ta", 4244},
	} {
		st := st
		mux.HandleFunc("/orgs/o/teams/"+st.slug, func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodGet:
				_ = json.NewEncoder(w).Encode(map[string]any{"id": st.id, "slug": st.slug})
			case http.MethodDelete:
				m.staffTeamDeleted = append(m.staffTeamDeleted, st.slug)
				w.WriteHeader(http.StatusNoContent)
			default:
				http.NotFound(w, r)
			}
		})
	}

	return mux
}

// classroomJSONWithStaffTeams builds a classroom.json carrying the
// students team plus both staff teams, so the remove sweep has refs to
// delete.
func classroomJSONWithStaffTeams(t *testing.T, org, shortName string) string {
	t.Helper()
	b, err := output.JSONPretty(configrepo.ClassroomJSON{
		Schema:    classroomSchemaV1,
		ShortName: shortName,
		Org:       org,
		Team:      &configrepo.TeamRef{ID: 4242, Slug: "classroom50-" + shortName},
		Teams: &configrepo.StaffTeamsRef{
			Instructor: &configrepo.TeamRef{ID: 4243, Slug: "classroom50-" + shortName + "-instructor"},
			TA:         &configrepo.TeamRef{ID: 4244, Slug: "classroom50-" + shortName + "-ta"},
		},
	})
	if err != nil {
		t.Fatalf("encode classroom.json: %v", err)
	}
	return string(b)
}

func classroomJSONContent(t *testing.T, org, shortName, name, term string) string {
	t.Helper()
	b, err := output.JSONPretty(configrepo.ClassroomJSON{
		Schema:    classroomSchemaV1,
		Name:      name,
		ShortName: shortName,
		Term:      term,
		Org:       org,
		Team:      &configrepo.TeamRef{ID: 4242, Slug: "classroom50-" + shortName},
	})
	if err != nil {
		t.Fatalf("encode classroom.json: %v", err)
	}
	return string(b)
}

func TestRunClassroomList(t *testing.T) {
	mock := &configRepoMock{files: map[string]string{
		"cs-principles/classroom.json": classroomJSONContent(t, "o", "cs-principles", "CS Principles", "Fall-2026"),
		"intro-java/classroom.json":    classroomJSONContent(t, "o", "intro-java", "Intro to Java", ""),
		// A dir without classroom.json must be skipped.
		".github/workflows/collect.yml": "name: collect\n",
		// A top-level file must be skipped.
		"README.md": "# config repo\n",
	}}
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	t.Run("default lists short-names only", func(t *testing.T) {
		var out, errOut bytes.Buffer
		if err := runClassroomList(client, &out, &errOut, "o", false, false, false); err != nil {
			t.Fatalf("runClassroomList: %v", err)
		}
		got := strings.Fields(out.String())
		want := map[string]bool{"cs-principles": true, "intro-java": true}
		if len(got) != 2 {
			t.Fatalf("stdout = %q, want 2 short-names", out.String())
		}
		for _, g := range got {
			if !want[g] {
				t.Errorf("unexpected line %q (non-classroom dirs/files must be skipped)", g)
			}
		}
		if !strings.Contains(errOut.String(), "2 classrooms") {
			t.Errorf("stderr summary = %q, want '2 classrooms'", errOut.String())
		}
	})

	t.Run("--json emits full objects", func(t *testing.T) {
		var out, errOut bytes.Buffer
		if err := runClassroomList(client, &out, &errOut, "o", true, true, true); err != nil {
			t.Fatalf("runClassroomList: %v", err)
		}
		var got []classroomSummary
		if err := json.Unmarshal(out.Bytes(), &got); err != nil {
			t.Fatalf("unmarshal json output: %v\n%s", err, out.String())
		}
		if len(got) != 2 {
			t.Fatalf("got %d summaries, want 2", len(got))
		}
		byName := map[string]classroomSummary{}
		for _, c := range got {
			byName[c.ShortName] = c
		}
		if byName["cs-principles"].Name != "CS Principles" || byName["cs-principles"].Term != "Fall-2026" {
			t.Errorf("cs-principles summary = %#v", byName["cs-principles"])
		}
		if errOut.Len() != 0 {
			t.Errorf("--quiet should suppress stderr, got %q", errOut.String())
		}
	})
}

func TestEditClassroom(t *testing.T) {
	current := classroomJSONContent(t, "o", "cs-principles", "CS Principles", "Fall-2026")

	t.Run("update changes a field", func(t *testing.T) {
		mock := &configRepoMock{files: map[string]string{"cs-principles/classroom.json": current}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		err := editClassroom(client, &out, &errOut, "o", "cs-principles", true, "Computer Science Principles", false, "")
		if err != nil {
			t.Fatalf("editClassroom: %v", err)
		}
		if !strings.Contains(out.String(), "updated classroom cs-principles") {
			t.Errorf("stdout = %q, want 'updated classroom'", out.String())
		}
	})

	t.Run("no-op when value matches", func(t *testing.T) {
		mock := &configRepoMock{files: map[string]string{"cs-principles/classroom.json": current}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		err := editClassroom(client, &out, &errOut, "o", "cs-principles", true, "CS Principles", false, "")
		if err != nil {
			t.Fatalf("editClassroom: %v", err)
		}
		if !strings.Contains(out.String(), "already up to date") {
			t.Errorf("stdout = %q, want 'already up to date'", out.String())
		}
	})

	t.Run("missing classroom errors", func(t *testing.T) {
		mock := &configRepoMock{files: map[string]string{}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		err := editClassroom(client, &out, &errOut, "o", "ghost", true, "X", false, "")
		if err == nil || !strings.Contains(err.Error(), "not found") {
			t.Fatalf("editClassroom err = %v, want 'not found'", err)
		}
	})

	// An edit must touch only the named field; every other field on
	// classroom.json -- including the optional migrated_from
	// provenance block -- has to round-trip unchanged.
	t.Run("preserves migrated_from and other fields", func(t *testing.T) {
		migrated, err := output.JSONPretty(configrepo.ClassroomJSON{
			Schema:    classroomSchemaV1,
			Name:      "CS Principles",
			ShortName: "cs-principles",
			Term:      "Fall-2026",
			Org:       "o",
			MigratedFrom: &configrepo.MigratedFromRef{
				Source:           "12345",
				ClassroomID:      12345,
				OriginalName:     "Old CS Principles",
				OriginalOrgLogin: "old-org",
				URL:              "https://classroom.github.com/classrooms/12345",
				MigratedAt:       "2026-01-02T03:04:05Z",
			},
		})
		if err != nil {
			t.Fatalf("encode migrated classroom.json: %v", err)
		}

		mock := &configRepoMock{files: map[string]string{"cs-principles/classroom.json": string(migrated)}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		if err := editClassroom(client, &out, &errOut, "o", "cs-principles", true, "Computer Science Principles", false, ""); err != nil {
			t.Fatalf("editClassroom: %v", err)
		}

		if len(mock.blobs) != 1 {
			t.Fatalf("got %d blobs POSTed, want 1: %#v", len(mock.blobs), mock.blobs)
		}
		var got configrepo.ClassroomJSON
		if err := json.Unmarshal([]byte(mock.blobs[0]), &got); err != nil {
			t.Fatalf("unmarshal re-encoded classroom.json: %v\n%s", err, mock.blobs[0])
		}
		if got.Name != "Computer Science Principles" {
			t.Errorf("Name = %q, want the edited value", got.Name)
		}
		if got.ShortName != "cs-principles" || got.Term != "Fall-2026" || got.Org != "o" {
			t.Errorf("unrelated fields changed: %#v", got)
		}
		if got.MigratedFrom == nil {
			t.Fatal("migrated_from was dropped on edit")
		}
		if got.MigratedFrom.ClassroomID != 12345 || got.MigratedFrom.OriginalOrgLogin != "old-org" || got.MigratedFrom.MigratedAt != "2026-01-02T03:04:05Z" {
			t.Errorf("migrated_from not preserved verbatim: %#v", got.MigratedFrom)
		}
	})
}

func TestRemoveClassroom(t *testing.T) {
	t.Run("deletes the subtree with --yes", func(t *testing.T) {
		mock := &configRepoMock{files: map[string]string{
			"cs-principles/classroom.json":                  classroomJSONContent(t, "o", "cs-principles", "CS Principles", ""),
			"cs-principles/assignments.json":                "[]",
			"cs-principles/roster.csv":                      "username\n",
			"cs-principles/scores.json":                     "{}",
			"cs-principles/autograders/hello/autograder.py": "print()\n",
			// Sibling classroom that must survive.
			"intro-java/classroom.json": classroomJSONContent(t, "o", "intro-java", "Intro Java", ""),
		}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		err := removeClassroom(client, strings.NewReader(""), &out, &errOut, "o", "cs-principles", true)
		if err != nil {
			t.Fatalf("removeClassroom: %v", err)
		}
		// 5 files live under cs-principles/.
		if !strings.Contains(out.String(), "removed classroom cs-principles (5 files)") {
			t.Errorf("stdout = %q, want 'removed classroom cs-principles (5 files)'", out.String())
		}
		if !mock.teamDeleted {
			t.Error("classroom remove should delete the classroom team")
		}
		if !strings.Contains(out.String(), "deleted classroom team classroom50-cs-principles") {
			t.Errorf("stdout = %q, want team-delete confirmation", out.String())
		}
	})

	t.Run("sweeps the staff teams recorded in classroom.json", func(t *testing.T) {
		mock := &configRepoMock{files: map[string]string{
			"cs-principles/classroom.json":   classroomJSONWithStaffTeams(t, "o", "cs-principles"),
			"cs-principles/assignments.json": "[]",
		}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		if err := removeClassroom(client, strings.NewReader(""), &out, &errOut, "o", "cs-principles", true); err != nil {
			t.Fatalf("removeClassroom: %v", err)
		}
		if !mock.teamDeleted {
			t.Error("students team should be deleted")
		}
		want := map[string]bool{
			"classroom50-cs-principles-instructor": true,
			"classroom50-cs-principles-ta":         true,
		}
		if len(mock.staffTeamDeleted) != 2 {
			t.Fatalf("staffTeamDeleted = %v, want both staff teams", mock.staffTeamDeleted)
		}
		for _, s := range mock.staffTeamDeleted {
			if !want[s] {
				t.Errorf("unexpected staff-team delete %q", s)
			}
		}
		if !strings.Contains(out.String(), "deleted staff team classroom50-cs-principles-instructor") {
			t.Errorf("stdout = %q, want instructor staff-team delete confirmation", out.String())
		}
	})

	t.Run("missing classroom errors before prompt", func(t *testing.T) {
		mock := &configRepoMock{files: map[string]string{}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		err := removeClassroom(client, strings.NewReader(""), &out, &errOut, "o", "ghost", true)
		if err == nil || !strings.Contains(err.Error(), "not found") {
			t.Fatalf("removeClassroom err = %v, want 'not found'", err)
		}
	})

	t.Run("confirmation mismatch aborts", func(t *testing.T) {
		mock := &configRepoMock{files: map[string]string{
			"cs-principles/classroom.json": classroomJSONContent(t, "o", "cs-principles", "CS Principles", ""),
		}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		err := removeClassroom(client, strings.NewReader("wrong-name\n"), &out, &errOut, "o", "cs-principles", false)
		if err == nil || !strings.Contains(err.Error(), "confirmation did not match") {
			t.Fatalf("removeClassroom err = %v, want confirmation mismatch", err)
		}
	})
}

// TestSeedStaffTeams_MaintainerAddFailureIsBestEffort pins that a
// failure adding the acting teacher as instructor maintainer warns but
// does not fail classroom creation (the teacher can self-add via web).
func TestSeedStaffTeams_MaintainerAddFailureIsBestEffort(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/orgs/o/teams", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name string `json:"name"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": 9, "slug": body.Name})
	})
	// Repo-grant probe/PUT for each staff team.
	mux.HandleFunc("/orgs/o/teams/", func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/repos/") && r.Method == http.MethodGet:
			w.WriteHeader(http.StatusNotFound)
		case strings.Contains(r.URL.Path, "/repos/") && r.Method == http.MethodPut:
			w.WriteHeader(http.StatusNoContent)
		case strings.Contains(r.URL.Path, "/memberships/") && r.Method == http.MethodPut:
			// The maintainer add fails.
			http.Error(w, `{"message":"forbidden"}`, http.StatusForbidden)
		default:
			http.NotFound(w, r)
		}
	})
	mux.HandleFunc("/user", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"login": "teacher", "id": 1})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var errOut bytes.Buffer
	refs, _, err := seedStaffTeams(client, &errOut, "o", "cs-principles")
	if err != nil {
		t.Fatalf("seedStaffTeams must not fail on a best-effort maintainer-add error: %v", err)
	}
	if refs == nil || refs.Instructor == nil || refs.TA == nil {
		t.Fatalf("staff refs = %+v, want both teams", refs)
	}
	if !strings.Contains(errOut.String(), "couldn't add you") {
		t.Errorf("stderr = %q, want a best-effort maintainer-add warning", errOut.String())
	}
}

// TestDropCreatorFromNonInstructorTeams_RemovesStudentsAndTA pins that the
// creator is dropped from the students and TA teams (undoing GitHub's implicit
// creator-as-maintainer grant on team create) but NEVER from the instructor
// team — the owner's only intended role.
func TestDropCreatorFromNonInstructorTeams_RemovesStudentsAndTA(t *testing.T) {
	var deleted []string
	mux := http.NewServeMux()
	mux.HandleFunc("/orgs/o/teams/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/memberships/") {
			deleted = append(deleted, r.URL.Path)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		http.NotFound(w, r)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	staffTeams := &configrepo.StaffTeamsRef{
		Instructor: &configrepo.TeamRef{ID: 1, Slug: "classroom50-cs-principles-instructor"},
		TA:         &configrepo.TeamRef{ID: 2, Slug: "classroom50-cs-principles-ta"},
	}

	var errOut bytes.Buffer
	dropCreatorFromNonInstructorTeams(client, &errOut, "o", "teacher", "classroom50-cs-principles", staffTeams)

	want := []string{
		"/orgs/o/teams/classroom50-cs-principles/memberships/teacher",
		"/orgs/o/teams/classroom50-cs-principles-ta/memberships/teacher",
	}
	if len(deleted) != len(want) {
		t.Fatalf("DELETEs = %v, want %v", deleted, want)
	}
	for _, w := range want {
		found := false
		for _, d := range deleted {
			if d == w {
				found = true
			}
		}
		if !found {
			t.Errorf("missing DELETE %s (got %v)", w, deleted)
		}
	}
	for _, d := range deleted {
		if strings.Contains(d, "-instructor/") {
			t.Errorf("must not drop the creator from the instructor team, got %s", d)
		}
	}
}

// TestDropCreatorFromNonInstructorTeams_BestEffort pins that a removal failure
// warns but does not panic/fail — the owner is left harmlessly on the team.
func TestDropCreatorFromNonInstructorTeams_BestEffort(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/orgs/o/teams/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/memberships/") {
			http.Error(w, `{"message":"forbidden"}`, http.StatusForbidden)
			return
		}
		http.NotFound(w, r)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	staffTeams := &configrepo.StaffTeamsRef{
		Instructor: &configrepo.TeamRef{ID: 1, Slug: "classroom50-cs-principles-instructor"},
		TA:         &configrepo.TeamRef{ID: 2, Slug: "classroom50-cs-principles-ta"},
	}

	var errOut bytes.Buffer
	dropCreatorFromNonInstructorTeams(client, &errOut, "o", "teacher", "classroom50-cs-principles", staffTeams)

	if !strings.Contains(errOut.String(), "couldn't remove you") {
		t.Errorf("stderr = %q, want a best-effort removal warning", errOut.String())
	}
}

// TestDropCreatorFromNonInstructorTeams_NoLogin pins that an unresolved login
// (empty string) is a no-op — nothing to remove, no request.
func TestDropCreatorFromNonInstructorTeams_NoLogin(t *testing.T) {
	var hit bool
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		hit = true
		w.WriteHeader(http.StatusNoContent)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	staffTeams := &configrepo.StaffTeamsRef{
		Instructor: &configrepo.TeamRef{ID: 1, Slug: "classroom50-cs-principles-instructor"},
		TA:         &configrepo.TeamRef{ID: 2, Slug: "classroom50-cs-principles-ta"},
	}

	var errOut bytes.Buffer
	dropCreatorFromNonInstructorTeams(client, &errOut, "o", "", "classroom50-cs-principles", staffTeams)

	if hit {
		t.Errorf("an empty login must make no request, but the server was hit")
	}
}

func TestConfirmClassroomRemove(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		wantErr bool
	}{
		{"exact match proceeds", "cs-principles\n", false},
		{"trailing spaces trimmed", "  cs-principles  \n", false},
		{"mismatch aborts", "nope\n", true},
		{"empty/EOF aborts", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			err := confirmClassroomRemove(strings.NewReader(tc.input), &out, "cs-principles")
			if tc.wantErr && err == nil {
				t.Errorf("want error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Errorf("want nil, got %v", err)
			}
		})
	}
}

// archivedClassroomJSON builds a classroom.json carrying active:false.
func archivedClassroomJSON(t *testing.T, org, shortName, name string) string {
	t.Helper()
	f := false
	b, err := output.JSONPretty(configrepo.ClassroomJSON{
		Schema:    classroomSchemaV1,
		Name:      name,
		ShortName: shortName,
		Org:       org,
		Active:    &f,
	})
	if err != nil {
		t.Fatalf("encode classroom.json: %v", err)
	}
	return string(b)
}

func TestSetClassroomActive_Archive(t *testing.T) {
	current := classroomJSONContent(t, "o", "cs-principles", "CS Principles", "Fall-2026")
	mock := &configRepoMock{files: map[string]string{"cs-principles/classroom.json": current}}
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := setClassroomActive(client, &out, &errOut, "o", "cs-principles", false); err != nil {
		t.Fatalf("setClassroomActive(archive): %v", err)
	}
	if !strings.Contains(out.String(), "archived classroom cs-principles") {
		t.Errorf("stdout = %q, want 'archived classroom'", out.String())
	}
	if len(mock.blobs) != 1 {
		t.Fatalf("expected 1 committed blob, got %d", len(mock.blobs))
	}
	var c configrepo.ClassroomJSON
	if err := json.Unmarshal([]byte(mock.blobs[0]), &c); err != nil {
		t.Fatalf("committed classroom.json: %v", err)
	}
	if !c.IsArchived() {
		t.Errorf("committed classroom should be archived, got Active=%v", c.Active)
	}
}

func TestSetClassroomActive_UnarchiveClearsFlag(t *testing.T) {
	current := archivedClassroomJSON(t, "o", "cs-principles", "CS Principles")
	mock := &configRepoMock{files: map[string]string{"cs-principles/classroom.json": current}}
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := setClassroomActive(client, &out, &errOut, "o", "cs-principles", true); err != nil {
		t.Fatalf("setClassroomActive(unarchive): %v", err)
	}
	if !strings.Contains(out.String(), "unarchived classroom cs-principles") {
		t.Errorf("stdout = %q, want 'unarchived classroom'", out.String())
	}
	if len(mock.blobs) != 1 {
		t.Fatalf("expected 1 committed blob, got %d", len(mock.blobs))
	}
	// Unarchive drops the key (absent = active), so the wire form must
	// not carry "active".
	if strings.Contains(mock.blobs[0], "active") {
		t.Errorf("unarchive should drop the active key, got %s", mock.blobs[0])
	}
}

func TestSetClassroomActive_AlreadyArchivedNoop(t *testing.T) {
	current := archivedClassroomJSON(t, "o", "cs-principles", "CS Principles")
	mock := &configRepoMock{files: map[string]string{"cs-principles/classroom.json": current}}
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := setClassroomActive(client, &out, &errOut, "o", "cs-principles", false); err != nil {
		t.Fatalf("setClassroomActive: %v", err)
	}
	if !strings.Contains(out.String(), "already archived") {
		t.Errorf("stdout = %q, want 'already archived' no-op", out.String())
	}
	if len(mock.blobs) != 0 {
		t.Errorf("no-op should not commit, got %d blobs", len(mock.blobs))
	}
}

func TestRunClassroomList_HidesArchivedByDefault(t *testing.T) {
	mock := &configRepoMock{files: map[string]string{
		"cs-principles/classroom.json": classroomJSONContent(t, "o", "cs-principles", "CS Principles", "Fall-2026"),
		"old-term/classroom.json":      archivedClassroomJSON(t, "o", "old-term", "Old Term"),
	}}
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	t.Run("default hides archived", func(t *testing.T) {
		var out, errOut bytes.Buffer
		if err := runClassroomList(client, &out, &errOut, "o", false, false, false); err != nil {
			t.Fatalf("runClassroomList: %v", err)
		}
		lines := strings.Fields(out.String())
		for _, l := range lines {
			if l == "old-term" {
				t.Errorf("archived classroom should be hidden by default, got %q", out.String())
			}
		}
		if !strings.Contains(out.String(), "cs-principles") {
			t.Errorf("active classroom missing: %q", out.String())
		}
	})

	t.Run("--all shows archived with marker", func(t *testing.T) {
		var out, errOut bytes.Buffer
		if err := runClassroomList(client, &out, &errOut, "o", false, false, true); err != nil {
			t.Fatalf("runClassroomList: %v", err)
		}
		if !strings.Contains(out.String(), "old-term (archived)") {
			t.Errorf("--all should show 'old-term (archived)', got %q", out.String())
		}
	})

	t.Run("--json --all carries active:false", func(t *testing.T) {
		var out, errOut bytes.Buffer
		if err := runClassroomList(client, &out, &errOut, "o", true, true, true); err != nil {
			t.Fatalf("runClassroomList: %v", err)
		}
		var got []classroomSummary
		if err := json.Unmarshal(out.Bytes(), &got); err != nil {
			t.Fatalf("unmarshal json: %v\n%s", err, out.String())
		}
		var foundArchived bool
		for _, c := range got {
			if c.ShortName == "old-term" {
				if c.Active == nil || *c.Active {
					t.Errorf("old-term summary should carry active:false, got %#v", c)
				}
				foundArchived = true
			}
		}
		if !foundArchived {
			t.Errorf("--all --json should include old-term")
		}
	})
}

// TestSetClassroomActive_PreservesUnknownField pins the forward-compat fix:
// archiving a classroom.json that carries an unknown top-level key (one a
// newer binary or the web GUI wrote) must NOT drop that key on the
// read-modify-write — the classroom-side "tolerate AND preserve" guarantee
// matching the assignments path.
func TestSetClassroomActive_PreservesUnknownField(t *testing.T) {
	// A classroom.json with an unknown `lms_link` key this CLI doesn't model.
	current := `{"schema":"classroom50/classroom/v1","name":"CS Principles","short_name":"cs-principles","term":"Fall-2026","org":"o","lms_link":"https://lms.example/c/1"}`
	mock := &configRepoMock{files: map[string]string{"cs-principles/classroom.json": current}}
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := setClassroomActive(client, &out, &errOut, "o", "cs-principles", false); err != nil {
		t.Fatalf("setClassroomActive(archive): %v", err)
	}
	if len(mock.blobs) != 1 {
		t.Fatalf("expected 1 committed blob, got %d", len(mock.blobs))
	}
	committed := mock.blobs[0]
	if !strings.Contains(committed, "lms_link") {
		t.Errorf("archive RMW dropped the unknown lms_link field: %s", committed)
	}
	// The archive still applied, and the unknown key still parses back.
	var c configrepo.ClassroomJSON
	if err := json.Unmarshal([]byte(committed), &c); err != nil {
		t.Fatalf("committed classroom.json: %v", err)
	}
	if !c.IsArchived() {
		t.Errorf("classroom should be archived, got Active=%v", c.Active)
	}
	if _, ok := c.Extra["lms_link"]; !ok {
		t.Errorf("lms_link not preserved into Extra after RMW: %v", c.Extra)
	}
}
