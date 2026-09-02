package configrepo

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/contract"
)

// TestMarshalGroupDescription_Golden pins the exact record bytes: the web
// writer mirrors Go's json.Marshal escaping, so a byte drift here silently
// diverges the two writers' descriptions.
func TestMarshalGroupDescription_Golden(t *testing.T) {
	got, err := MarshalGroupDescription("cs50", "project", "The Sharks")
	if err != nil {
		t.Fatalf("MarshalGroupDescription: %v", err)
	}
	want := `{"schema":"classroom50/group/v1","classroom":"cs50","assignment":"project","name":"The Sharks"}`
	if got != want {
		t.Errorf("record = %s, want %s", got, want)
	}

	// An empty display name is OMITTED, not written as "".
	got, err = MarshalGroupDescription("cs50", "project", "")
	if err != nil {
		t.Fatalf("MarshalGroupDescription: %v", err)
	}
	want = `{"schema":"classroom50/group/v1","classroom":"cs50","assignment":"project"}`
	if got != want {
		t.Errorf("nameless record = %s, want %s", got, want)
	}
}

// TestGroupDescription_SharedVectorParity runs the shared golden vectors: for
// every fixture case the marshalled record must parse back AND verify against
// the fixture's team-1 slug — tying the description record to the same
// hash derivation every writer pins.
func TestGroupDescription_SharedVectorParity(t *testing.T) {
	raw, err := os.ReadFile("../../../shared/testdata/group_vectors.json")
	if err != nil {
		t.Fatalf("read shared group vectors: %v", err)
	}
	var doc struct {
		Cases []struct {
			Classroom  string `json:"classroom"`
			Assignment string `json:"assignment"`
			Hash       string `json:"hash"`
			Team1      string `json:"team_1"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse shared group vectors: %v", err)
	}
	if len(doc.Cases) == 0 {
		t.Fatal("shared group vectors: no cases")
	}
	for _, c := range doc.Cases {
		desc, err := MarshalGroupDescription(c.Classroom, c.Assignment, "")
		if err != nil {
			t.Fatalf("MarshalGroupDescription(%q,%q): %v", c.Classroom, c.Assignment, err)
		}
		record, ok := ParseGroupDescription(desc)
		if !ok {
			t.Fatalf("ParseGroupDescription(%q) = !ok, want the record back", desc)
		}
		if !VerifyGroupDescription(c.Team1, record) {
			t.Errorf("VerifyGroupDescription(%q, record for %q/%q) = false, want true",
				c.Team1, c.Classroom, c.Assignment)
		}
		if got := contract.GroupTeamHash(c.Classroom, c.Assignment); got != c.Hash {
			t.Errorf("GroupTeamHash(%q,%q) = %q, want fixture %q", c.Classroom, c.Assignment, got, c.Hash)
		}
	}
}

// ParseGroupDescription is a trust boundary: absent/garbage/wrong-schema
// descriptions yield no record; unknown fields are tolerated (additive
// evolution).
func TestParseGroupDescription(t *testing.T) {
	valid := `{"schema":"classroom50/group/v1","classroom":"cs50","assignment":"project","name":"The Sharks"}`
	record, ok := ParseGroupDescription(valid)
	if !ok || record.Classroom != "cs50" || record.Assignment != "project" || record.Name != "The Sharks" {
		t.Errorf("ParseGroupDescription(valid) = (%+v, %t), want the full record", record, ok)
	}

	withUnknown := `{"schema":"classroom50/group/v1","classroom":"cs50","assignment":"project","future":"field"}`
	if _, ok := ParseGroupDescription(withUnknown); !ok {
		t.Error("a record with an unknown field must still parse (additive evolution)")
	}

	for _, bad := range []string{
		"",
		"   ",
		"ask the TA",
		`{"schema":"classroom50/invite/v1","classroom":"cs50","assignment":"project"}`,
		`{"schema":"classroom50/group/v1","classroom":"","assignment":"project"}`,
		`{"schema":"classroom50/group/v1","classroom":"cs50","assignment":""}`,
		`{"schema":"classroom50/group/v1"}`,
	} {
		if _, ok := ParseGroupDescription(bad); ok {
			t.Errorf("ParseGroupDescription(%q) = ok, want rejection", bad)
		}
	}
}

// VerifyGroupDescription must reject a record whose classroom/assignment
// doesn't hash back to the slug — the maintainer-edited-description defense —
// and any slug outside the full group-team shape.
func TestVerifyGroupDescription(t *testing.T) {
	slug := contract.GroupTeamName("cs50", "project", 3)
	good := GroupDescription{Schema: contract.GroupSchemaV1, Classroom: "cs50", Assignment: "project"}
	if !VerifyGroupDescription(slug, good) {
		t.Errorf("VerifyGroupDescription(%q, matching record) = false, want true", slug)
	}

	// A record pointing at a DIFFERENT assignment hashes elsewhere.
	stolen := GroupDescription{Schema: contract.GroupSchemaV1, Classroom: "cs50", Assignment: "other"}
	if VerifyGroupDescription(slug, stolen) {
		t.Error("a record for another assignment must not verify against this slug")
	}

	// Only the FULL slug shape is ever trusted for destructive ops.
	if VerifyGroupDescription("classroom50-group-theory", good) {
		t.Error("a human team in the classroom50-group- namespace must never verify")
	}
	if VerifyGroupDescription("classroom50-cs50", good) {
		t.Error("a classroom student team must never verify")
	}
}
