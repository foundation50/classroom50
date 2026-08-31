package configrepo

import (
	"strings"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/contract"
)

func teamsTestSlug(t *testing.T, assignment string, n int) string {
	t.Helper()
	return contract.GroupTeamName("cs101", assignment, n)
}

// Round-trip: unknown fields at EVERY level (file, bucket, record) must
// survive a read-modify-write — the file may be written by newer releases.
func TestTeamsFile_UnknownFieldPreservation(t *testing.T) {
	slug := teamsTestSlug(t, "project", 1)
	original := `{
  "schema": "classroom50/teams/v1",
  "future_root": {"keep": true},
  "assignments": {
    "project": {
      "future_bucket": 7,
      "teams": [
        {
          "slug": "` + slug + `",
          "id": 42,
          "name": "The Sharks",
          "members": ["alice", "bob"],
          "formation": "teacher",
          "future_team": "yes"
        }
      ]
    }
  }
}`
	file, err := ParseTeamsFile([]byte(original))
	if err != nil {
		t.Fatalf("ParseTeamsFile: %v", err)
	}

	// Modify an unrelated assignment, then re-encode.
	UpsertTeam(&file, "other", TeamRecord{
		Slug:    teamsTestSlug(t, "other", 1),
		ID:      43,
		Members: []string{"Carol"},
	})
	data, err := EncodeTeamsFile(file, "cs101")
	if err != nil {
		t.Fatalf("EncodeTeamsFile: %v", err)
	}
	out := string(data)
	for _, want := range []string{
		`"future_root"`, `"future_bucket"`, `"future_team"`,
		`"formation": "teacher"`, `"name": "The Sharks"`,
		`"carol"`, // members normalize to lowercase
	} {
		if !strings.Contains(out, want) {
			t.Errorf("re-encoded teams.json missing %s:\n%s", want, out)
		}
	}

	// And the re-encoded bytes still parse to the same records.
	reparsed, err := ParseTeamsFile(data)
	if err != nil {
		t.Fatalf("re-parse: %v", err)
	}
	team := reparsed.Assignments["project"].Teams[0]
	if team.Slug != slug || team.ID != 42 || team.Name != "The Sharks" || team.Formation != "teacher" {
		t.Errorf("round-tripped record = %+v", team)
	}
	if len(team.Members) != 2 || team.Members[0] != "alice" {
		t.Errorf("round-tripped members = %v", team.Members)
	}
	if string(team.Extra["future_team"]) != `"yes"` {
		t.Errorf("record Extra = %v, want future_team preserved", team.Extra)
	}
}

// A missing/empty scaffold and the schema sentinel gate.
func TestParseTeamsFile_SchemaGate(t *testing.T) {
	if _, err := ParseTeamsFile([]byte(``)); err == nil {
		t.Error("empty teams.json must error")
	}
	if _, err := ParseTeamsFile([]byte(`{"schema":"classroom50/teams/v2","assignments":{}}`)); err == nil || !strings.Contains(err.Error(), "only v1") {
		t.Errorf("v2 sentinel: err = %v, want the only-v1 message", err)
	}
	file, err := ParseTeamsFile([]byte(`{"schema":"classroom50/teams/v1","assignments":{}}`))
	if err != nil {
		t.Fatalf("minimal v1: %v", err)
	}
	if file.Assignments == nil {
		t.Error("Assignments must normalize to an empty map")
	}
}

// UpsertTeam replaces by slug in place (preserving the prior row's unknown
// fields) and appends new slugs; RemoveTeam drops by slug and keeps the
// bucket.
func TestUpsertAndRemoveTeam(t *testing.T) {
	file := NewTeamsFile()
	slug1 := teamsTestSlug(t, "project", 1)
	slug2 := teamsTestSlug(t, "project", 2)

	if replaced := UpsertTeam(&file, "project", TeamRecord{Slug: slug1, ID: 1, Members: []string{"Alice", "alice", "bob"}}); replaced {
		t.Error("first upsert reported replaced")
	}
	if got := file.Assignments["project"].Teams[0].Members; len(got) != 2 || got[0] != "alice" || got[1] != "bob" {
		t.Errorf("members = %v, want lowercased dedup [alice bob]", got)
	}

	UpsertTeam(&file, "project", TeamRecord{Slug: slug2, ID: 2, Members: []string{"carol"}})
	if replaced := UpsertTeam(&file, "project", TeamRecord{Slug: slug1, ID: 1, Name: "Renamed", Members: []string{"alice"}}); !replaced {
		t.Error("same-slug upsert must report replaced")
	}
	teams := file.Assignments["project"].Teams
	if len(teams) != 2 || teams[0].Name != "Renamed" || len(teams[0].Members) != 1 {
		t.Errorf("teams after replace = %+v", teams)
	}

	if removed := RemoveTeam(&file, "project", slug2); !removed {
		t.Error("RemoveTeam(existing) = false")
	}
	if removed := RemoveTeam(&file, "project", slug2); removed {
		t.Error("RemoveTeam(gone) = true, want idempotent false")
	}
	if _, ok := file.Assignments["project"]; !ok {
		t.Error("the bucket must survive its last team's removal")
	}
}

// The write-path validator: slug-to-assignment hash coupling, duplicate
// slugs, disjoint members, and formation values.
func TestValidateTeamsFile(t *testing.T) {
	good := NewTeamsFile()
	UpsertTeam(&good, "project", TeamRecord{Slug: teamsTestSlug(t, "project", 1), Members: []string{"alice"}, Formation: "teacher"})
	UpsertTeam(&good, "project", TeamRecord{Slug: teamsTestSlug(t, "project", 2), Members: []string{"bob"}, Formation: "student"})
	if err := ValidateTeamsFile(good, "cs101"); err != nil {
		t.Fatalf("valid file rejected: %v", err)
	}

	wrongAssignment := NewTeamsFile()
	UpsertTeam(&wrongAssignment, "project", TeamRecord{Slug: teamsTestSlug(t, "other", 1), Members: nil})
	if err := ValidateTeamsFile(wrongAssignment, "cs101"); err == nil || !strings.Contains(err.Error(), "does not belong") {
		t.Errorf("cross-assignment slug: err = %v, want the hash refusal", err)
	}

	overlapping := NewTeamsFile()
	UpsertTeam(&overlapping, "project", TeamRecord{Slug: teamsTestSlug(t, "project", 1), Members: []string{"alice"}})
	UpsertTeam(&overlapping, "project", TeamRecord{Slug: teamsTestSlug(t, "project", 2), Members: []string{"ALICE"}})
	if err := ValidateTeamsFile(overlapping, "cs101"); err == nil || !strings.Contains(err.Error(), "one student, one team") {
		t.Errorf("overlapping members: err = %v, want the disjointness refusal", err)
	}

	badFormation := NewTeamsFile()
	UpsertTeam(&badFormation, "project", TeamRecord{Slug: teamsTestSlug(t, "project", 1), Members: nil, Formation: "committee"})
	if err := ValidateTeamsFile(badFormation, "cs101"); err == nil || !strings.Contains(err.Error(), "formation") {
		t.Errorf("bad formation: err = %v, want the formation refusal", err)
	}
}

// EncodeTeamsFile emits `teams`/`members` as [] (never null) so the file
// always satisfies the schema's required fields.
func TestEncodeTeamsFile_NeverNull(t *testing.T) {
	file := NewTeamsFile()
	file.Assignments["project"] = AssignmentTeams{}
	data, err := EncodeTeamsFile(file, "cs101")
	if err != nil {
		t.Fatalf("EncodeTeamsFile: %v", err)
	}
	if !strings.Contains(string(data), `"teams": []`) {
		t.Errorf("empty bucket must encode teams as []:\n%s", data)
	}

	withTeam := NewTeamsFile()
	UpsertTeam(&withTeam, "project", TeamRecord{Slug: teamsTestSlug(t, "project", 1)})
	data, err = EncodeTeamsFile(withTeam, "cs101")
	if err != nil {
		t.Fatalf("EncodeTeamsFile: %v", err)
	}
	if !strings.Contains(string(data), `"members": []`) {
		t.Errorf("member-less record must encode members as []:\n%s", data)
	}
}
