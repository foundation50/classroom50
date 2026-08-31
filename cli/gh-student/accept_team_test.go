package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-student/internal/assignments"
	"github.com/foundation50/gh-student/internal/groupteam"
	"github.com/foundation50/gh-student/internal/ui"
)

const (
	teamTestOrg        = "cs50"
	teamTestClassroom  = "cs-principles"
	teamTestAssignment = "project"
)

func teamEntry() assignments.Entry {
	return assignments.Entry{
		Slug:          teamTestAssignment,
		Mode:          contract.ModeTeam,
		MaxGroupSize:  3,
		TeamFormation: contract.TeamFormationStudent,
	}
}

// userTeamsHandler serves GET /user/teams with the given team slugs (all in
// teamTestOrg unless the slug carries a "@otherorg" suffix).
func userTeamsHandler(slugs ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			_, _ = w.Write([]byte(`[]`))
			return
		}
		teams := make([]map[string]any, 0, len(slugs))
		for _, slug := range slugs {
			org := teamTestOrg
			if name, other, found := strings.Cut(slug, "@"); found {
				slug, org = name, other
			}
			teams = append(teams, map[string]any{
				"slug":         slug,
				"organization": map[string]any{"login": org},
			})
		}
		_ = json.NewEncoder(w).Encode(teams)
	}
}

// A student already on one of the assignment's teams resolves to it —
// unrelated teams, other orgs' teams (same hash!), and other assignments'
// teams are all ignored — and --new-team is ignored with a warning rather
// than forking a second team.
func TestResolveTeamMembership_AlreadyOnTeam(t *testing.T) {
	mine := contract.GroupTeamName(teamTestClassroom, teamTestAssignment, 2)
	mux := http.NewServeMux()
	mux.HandleFunc("/user/teams", userTeamsHandler(
		"classroom50-"+teamTestClassroom,                      // the classroom student team
		contract.GroupTeamName(teamTestClassroom, "other", 1), // another assignment
		mine+"@other-org",                                     // same slug, different org
		mine,
	))
	// Any POST (team create) here is the bug --new-team-idempotence exists to
	// prevent.
	mux.HandleFunc("/orgs/", func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected org request: %s %s", r.Method, r.URL.Path)
		http.NotFound(w, r)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	var errOut bytes.Buffer
	membership, err := resolveTeamMembership(newTestRESTClient(t, server), ui.NewForced(&errOut, false), teamTestOrg, teamTestClassroom, teamTestAssignment, teamEntry(), true, "")
	if err != nil {
		t.Fatalf("resolveTeamMembership: %v", err)
	}
	if membership.Slug != mine || membership.Counter != 2 {
		t.Errorf("membership = %+v, want counter 2 (%s)", membership, mine)
	}
	if !strings.Contains(errOut.String(), "ignoring --new-team") {
		t.Errorf("expected the ignoring --new-team warning:\n%s", errOut.String())
	}
}

// Teacher formation + not on a team: the student is told the teacher assigns
// groups — never offered team creation.
func TestResolveTeamMembership_TeacherFormationNotOnTeam(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/user/teams", userTeamsHandler())
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	entry := teamEntry()
	entry.TeamFormation = contract.TeamFormationTeacher
	var errOut bytes.Buffer
	_, err := resolveTeamMembership(newTestRESTClient(t, server), ui.NewForced(&errOut, false), teamTestOrg, teamTestClassroom, teamTestAssignment, entry, true, "")
	if err == nil || !strings.Contains(err.Error(), "teacher assigns the groups") {
		t.Fatalf("err = %v, want the teacher-assigns-groups message", err)
	}
}

// Student formation + not on a team without --new-team: the error names both
// remedies (found one, or get added by a teammate).
func TestResolveTeamMembership_StudentFormationNeedsNewTeam(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/user/teams", userTeamsHandler())
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	var errOut bytes.Buffer
	_, err := resolveTeamMembership(newTestRESTClient(t, server), ui.NewForced(&errOut, false), teamTestOrg, teamTestClassroom, teamTestAssignment, teamEntry(), false, "")
	if err == nil || !strings.Contains(err.Error(), "--new-team") {
		t.Fatalf("err = %v, want the --new-team hint", err)
	}
}

// The --new-team flow founds a team: 422 collisions (counters won by teams
// this student can't see) retry the next counter, the create is SECRET and
// carries the v1 record with the display name.
func TestResolveTeamMembership_NewTeamCreatesWith422Retry(t *testing.T) {
	var createBodies []map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/user/teams", userTeamsHandler())
	mux.HandleFunc("/orgs/"+teamTestOrg+"/teams", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		createBodies = append(createBodies, body)
		if len(createBodies) == 1 {
			// Counter 1 is taken by an invisible secret team.
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"message":"Name must be unique for this org"}`))
			return
		}
		name, _ := body["name"].(string)
		_ = json.NewEncoder(w).Encode(map[string]any{"slug": name})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	var errOut bytes.Buffer
	membership, err := resolveTeamMembership(newTestRESTClient(t, server), ui.NewForced(&errOut, false), teamTestOrg, teamTestClassroom, teamTestAssignment, teamEntry(), true, "The Sharks")
	if err != nil {
		t.Fatalf("resolveTeamMembership(--new-team): %v", err)
	}
	if membership.Counter != 2 || membership.Slug != contract.GroupTeamName(teamTestClassroom, teamTestAssignment, 2) {
		t.Errorf("membership = %+v, want counter 2 after the 422 retry", membership)
	}
	if len(createBodies) != 2 {
		t.Fatalf("creates = %d, want 2 (counter 1 collided)", len(createBodies))
	}
	first := createBodies[0]
	if first["name"] != contract.GroupTeamName(teamTestClassroom, teamTestAssignment, 1) {
		t.Errorf("first attempt name = %v, want counter 1", first["name"])
	}
	if first["privacy"] != "secret" || first["notification_setting"] != "notifications_disabled" {
		t.Errorf("create body = %v, want a secret notifications-disabled team", first)
	}
	wantRecord, _ := groupteam.MarshalDescription(teamTestClassroom, teamTestAssignment, "The Sharks")
	if first["description"] != wantRecord {
		t.Errorf("description = %v, want %s", first["description"], wantRecord)
	}
	if !strings.Contains(errOut.String(), "gh student team add") {
		t.Errorf("expected the add-teammates hint after founding:\n%s", errOut.String())
	}
}

// MarshalDescription byte-parity with the teacher writer: schema, classroom,
// assignment order, name omitted when empty.
func TestGroupTeamMarshalDescription(t *testing.T) {
	got, err := groupteam.MarshalDescription("cs50", "project", "")
	if err != nil {
		t.Fatal(err)
	}
	want := `{"schema":"classroom50/group/v1","classroom":"cs50","assignment":"project"}`
	if got != want {
		t.Errorf("record = %s, want %s", got, want)
	}
}

// The team-mode accept tail: a fresh create attaches the group team to the
// repo with push, and an already-accepted repo (marker present) re-attaches
// best-effort without any file re-provision — the "already on team + repo
// exists" no-create path.
func TestAcceptIntoRepo_TeamMode(t *testing.T) {
	const repoName = teamTestClassroom + "-" + teamTestAssignment + "-group-2"
	teamSlug := contract.GroupTeamName(teamTestClassroom, teamTestAssignment, 2)
	markerPath := "/repos/" + teamTestOrg + "/" + repoName + "/contents/.classroom50.yaml"
	attachPath := "/orgs/" + teamTestOrg + "/teams/" + teamSlug + "/repos/" + teamTestOrg + "/" + repoName

	origBackoff := verifyProvisionBackoff
	verifyProvisionBackoff = time.Millisecond
	t.Cleanup(func() { verifyProvisionBackoff = origBackoff })

	teamParams := func(alreadyExisted bool) acceptRepoParams {
		var errBuf bytes.Buffer
		ownerID := int64(4242)
		return acceptRepoParams{
			org:            teamTestOrg,
			classroom:      teamTestClassroom,
			assignment:     teamTestAssignment,
			mode:           contract.ModeTeam,
			maxGroupSize:   3,
			teamFormation:  contract.TeamFormationStudent,
			teamSlug:       teamSlug,
			username:       "alice",
			ownerID:        &ownerID,
			acceptedAt:     "2026-06-01T14:33:11Z",
			repoName:       repoName,
			branch:         "main",
			shim:           "shim-content",
			autograderName: "default",
			fullName:       teamTestOrg + "/" + repoName,
			htmlURL:        "https://github.com/" + teamTestOrg + "/" + repoName,
			alreadyExisted: alreadyExisted,
			createSp:       ui.NewForced(&errBuf, false).Spinner("Creating"),
			createMsg:      "Creating",
		}
	}

	t.Run("fresh create attaches the team with push and grants push (no admin clamp)", func(t *testing.T) {
		var (
			attachPut        bool
			attachBody       map[string]any
			collaboratorPerm string
			refPatched       bool
		)
		mux := http.NewServeMux()
		mux.HandleFunc(markerPath, func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"type": "file"})
		})
		mux.HandleFunc(attachPath, func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPut {
				attachPut = true
				_ = json.NewDecoder(r.Body).Decode(&attachBody)
			}
			w.WriteHeader(http.StatusNoContent)
		})
		mux.HandleFunc("/repos/"+teamTestOrg+"/"+repoName+"/collaborators/alice", func(w http.ResponseWriter, r *http.Request) {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			collaboratorPerm, _ = body["permission"].(string)
			w.WriteHeader(http.StatusNoContent)
		})
		mux.HandleFunc("/repos/"+teamTestOrg+"/"+repoName+"/branches/main", func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"commit": map[string]any{"sha": "stable"}})
		})
		mux.HandleFunc("/repos/"+teamTestOrg+"/"+repoName+"/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodGet:
				_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "parent"}})
			case http.MethodPatch:
				refPatched = true
				w.WriteHeader(http.StatusOK)
			}
		})
		mux.HandleFunc("/repos/"+teamTestOrg+"/"+repoName+"/git/commits/parent", func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"tree": map[string]string{"sha": "parent-tree"}})
		})
		mux.HandleFunc("/repos/"+teamTestOrg+"/"+repoName+"/git/blobs", func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]string{"sha": "blob"})
		})
		mux.HandleFunc("/repos/"+teamTestOrg+"/"+repoName+"/git/trees", func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]string{"sha": "tree"})
		})
		mux.HandleFunc("/repos/"+teamTestOrg+"/"+repoName+"/git/commits", func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]string{"sha": "commit"})
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)

		var out bytes.Buffer
		if err := acceptIntoRepo(newTestRESTClient(t, server), ui.NewForced(&out, false), false, &out, teamParams(false)); err != nil {
			t.Fatalf("acceptIntoRepo (team fresh): %v", err)
		}
		if !attachPut {
			t.Error("the team was never attached to the repo (missing PUT teams/.../repos/...)")
		}
		if attachBody["permission"] != "push" {
			t.Errorf("attach permission = %v, want push", attachBody["permission"])
		}
		if collaboratorPerm != "push" {
			t.Errorf("founder permission = %q, want push (team mode never clamps to admin)", collaboratorPerm)
		}
		if !refPatched {
			t.Error("provisioning never landed the control files")
		}
		if !strings.Contains(out.String(), "Assignment accepted:") {
			t.Errorf("expected the accepted report:\n%s", out.String())
		}
	})

	t.Run("already on team + repo exists (marker present): no create, best-effort re-attach", func(t *testing.T) {
		var attachPut, treeWrite bool
		mux := http.NewServeMux()
		mux.HandleFunc(markerPath, func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"type": "file"})
		})
		mux.HandleFunc(attachPath, func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPut {
				attachPut = true
			}
			w.WriteHeader(http.StatusNoContent)
		})
		mux.HandleFunc("/repos/"+teamTestOrg+"/"+repoName+"/collaborators/alice", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		})
		// Any file re-provision here is a bug — the repo is done.
		mux.HandleFunc("/repos/"+teamTestOrg+"/"+repoName+"/git/trees", func(w http.ResponseWriter, _ *http.Request) {
			treeWrite = true
			_ = json.NewEncoder(w).Encode(map[string]string{"sha": "t"})
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)

		var out bytes.Buffer
		if err := acceptIntoRepo(newTestRESTClient(t, server), ui.NewForced(&out, false), false, &out, teamParams(true)); err != nil {
			t.Fatalf("acceptIntoRepo (team already accepted): %v", err)
		}
		if !attachPut {
			t.Error("an already-accepted team repo should still re-issue the idempotent attach")
		}
		if treeWrite {
			t.Error("an already-provisioned team repo must not re-provision files")
		}
		if !strings.Contains(out.String(), "already accepted") {
			t.Errorf("expected the already-accepted report:\n%s", out.String())
		}
	})
}
