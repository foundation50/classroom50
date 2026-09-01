package teamcmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-student/internal/githubtest"
)

// checkTeamCapacity is the `team add` size gate: an existing member is never
// blocked, a full group refuses, and 0 means no limit.
func TestCheckTeamCapacity(t *testing.T) {
	members := []string{"alice", "bob", "carol"}

	already, err := checkTeamCapacity(members, "ALICE", 3)
	if err != nil || !already {
		t.Errorf("re-adding an existing member: (already=%v, err=%v), want (true, nil)", already, err)
	}

	already, err = checkTeamCapacity(members, "dave", 3)
	if already || err == nil || !strings.Contains(err.Error(), "your group is full") {
		t.Errorf("adding past the cap: (already=%v, err=%v), want the group-full refusal", already, err)
	}

	already, err = checkTeamCapacity(members, "dave", 4)
	if already || err != nil {
		t.Errorf("adding under the cap: (already=%v, err=%v), want (false, nil)", already, err)
	}

	if _, err := checkTeamCapacity(members, "dave", 0); err != nil {
		t.Errorf("no limit (0): unexpected error %v", err)
	}
}

// inAnotherGroup is the one-student-one-group gate for `team add`: a
// classmate on a different visible group team is reported with its counter,
// the founder's own team is skipped, and no membership means free.
func TestInAnotherGroup(t *testing.T) {
	const (
		org        = "acme"
		classroom  = "cs101"
		assignment = "project"
	)
	slug1 := contract.GroupTeamName(classroom, assignment, 1)
	slug2 := contract.GroupTeamName(classroom, assignment, 2)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/orgs/"+org+"/teams":
			if r.URL.Query().Get("page") != "1" {
				_, _ = w.Write([]byte(`[]`))
				return
			}
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"slug": slug1}, {"slug": slug2}, {"slug": "unrelated-team"},
			})
		case r.URL.Path == "/orgs/"+org+"/teams/"+slug2+"/memberships/bob":
			_, _ = w.Write([]byte(`{"state":"active"}`))
		case strings.Contains(r.URL.Path, "/memberships/"):
			http.NotFound(w, r)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	counter, taken, err := inAnotherGroup(client, org, classroom, assignment, "bob", slug1)
	if err != nil || !taken || counter != 2 {
		t.Errorf("bob on group 2: (counter=%d, taken=%v, err=%v), want (2, true, nil)", counter, taken, err)
	}

	// bob's own team is skipped, and he is on no other group.
	counter, taken, err = inAnotherGroup(client, org, classroom, assignment, "bob", slug2)
	if err != nil || taken {
		t.Errorf("bob on his own team only: (counter=%d, taken=%v, err=%v), want (0, false, nil)", counter, taken, err)
	}

	counter, taken, err = inAnotherGroup(client, org, classroom, assignment, "dave", slug1)
	if err != nil || taken {
		t.Errorf("dave on no team: (counter=%d, taken=%v, err=%v), want (0, false, nil)", counter, taken, err)
	}
}
