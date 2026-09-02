package teamcmd

import (
	"strings"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/assignment"
)

// resolveTeamArg maps a bare counter or a full slug to the assignment's team
// slug, and rejects everything else (other assignments' slugs included).
func TestResolveTeamArg(t *testing.T) {
	const classroom, slug = "cs101", "project"
	team2 := contract.GroupTeamName(classroom, slug, 2)

	got, err := resolveTeamArg(classroom, slug, "2")
	if err != nil || got != team2 {
		t.Errorf("resolveTeamArg(2) = (%q, %v), want (%q, nil)", got, err, team2)
	}
	got, err = resolveTeamArg(classroom, slug, team2)
	if err != nil || got != team2 {
		t.Errorf("resolveTeamArg(full slug) = (%q, %v), want (%q, nil)", got, err, team2)
	}

	for _, bad := range []string{
		"",
		"0",
		"-1",
		"the-sharks",
		contract.GroupTeamName(classroom, "other", 2), // another assignment's team
		"classroom50-group-theory",
	} {
		if _, err := resolveTeamArg(classroom, slug, bad); err == nil {
			t.Errorf("resolveTeamArg(%q) = nil error, want rejection", bad)
		}
	}
}

// requireTeamMode gates every subcommand with the exact mode-naming error.
func TestRequireTeamMode(t *testing.T) {
	if err := requireTeamMode(assignment.AssignmentEntry{Slug: "project", Mode: assignment.ModeTeam}); err != nil {
		t.Errorf("team mode rejected: %v", err)
	}
	err := requireTeamMode(assignment.AssignmentEntry{Slug: "hello", Mode: assignment.ModeIndividual})
	if err == nil || err.Error() != `assignment "hello" is not a team assignment (mode individual)` {
		t.Errorf("err = %v, want the exact not-a-team-assignment message", err)
	}
	if err := requireTeamMode(assignment.AssignmentEntry{Slug: "legacy", Mode: assignment.ModeGroup}); err == nil || !strings.Contains(err.Error(), "(mode group)") {
		t.Errorf("group mode: err = %v, want the mode named", err)
	}
}

// splitRostered is the roster gate: case-insensitive matching, dedup, and the
// unknowns reported for the warn-and-skip path.
func TestSplitRostered(t *testing.T) {
	roster := map[string]bool{"alice": true, "bob": true}
	rostered, unknown := splitRostered([]string{"Alice", "alice", "bob", "mallory", " "}, roster)
	if len(rostered) != 2 || rostered[0] != "Alice" || rostered[1] != "bob" {
		t.Errorf("rostered = %v, want [Alice bob] (first casing kept, deduped)", rostered)
	}
	if len(unknown) != 1 || unknown[0] != "mallory" {
		t.Errorf("unknown = %v, want [mallory]", unknown)
	}
}

// describeDrift renders the live-vs-snapshot member delta.
func TestDescribeDrift(t *testing.T) {
	cases := []struct {
		name      string
		live      []string
		recorded  []string
		hasRecord bool
		want      string
	}{
		{"no snapshot row", []string{"alice"}, nil, false, "not in teams.json"},
		{"in sync", []string{"Alice", "bob"}, []string{"alice", "bob"}, true, "in sync"},
		{"live extra", []string{"alice", "eve"}, []string{"alice"}, true, "+eve"},
		{"recorded missing", []string{"alice"}, []string{"alice", "bob"}, true, "-bob"},
		{"both", []string{"eve"}, []string{"bob"}, true, "+eve -bob"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := describeDrift(tc.live, tc.recorded, tc.hasRecord); got != tc.want {
				t.Errorf("describeDrift = %q, want %q", got, tc.want)
			}
		})
	}
}

// appendMember / dropMember are the snapshot member edits.
func TestMemberEdits(t *testing.T) {
	if got := appendMember([]string{"alice"}, "ALICE"); len(got) != 1 {
		t.Errorf("appendMember must be case-insensitively idempotent, got %v", got)
	}
	if got := appendMember([]string{"alice"}, "bob"); len(got) != 2 || got[1] != "bob" {
		t.Errorf("appendMember = %v, want [alice bob]", got)
	}
	if got := dropMember([]string{"alice", "bob"}, "ALICE"); len(got) != 1 || got[0] != "bob" {
		t.Errorf("dropMember = %v, want [bob]", got)
	}
}
