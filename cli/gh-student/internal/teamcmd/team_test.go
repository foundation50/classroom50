package teamcmd

import (
	"strings"
	"testing"
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
