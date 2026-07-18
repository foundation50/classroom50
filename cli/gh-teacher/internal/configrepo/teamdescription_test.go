package configrepo

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/contract"
)

// TestMarshalTeamDescription pins the classroom50/team/v1 encoding: schema
// always present, empty fields omitted, active omitted when true, secret only
// when valid.
func TestMarshalTeamDescription(t *testing.T) {
	t.Run("unlisted active classroom includes secret, omits active", func(t *testing.T) {
		got, err := MarshalTeamDescription("Intro CS", "Fall 2026", "a1b2c3d4", true)
		if err != nil {
			t.Fatalf("MarshalTeamDescription: %v", err)
		}
		var decoded map[string]any
		if err := json.Unmarshal([]byte(got), &decoded); err != nil {
			t.Fatalf("result is not valid JSON: %v (%q)", err, got)
		}
		if decoded["schema"] != contract.TeamSchemaV1 {
			t.Errorf("schema = %v, want %q", decoded["schema"], contract.TeamSchemaV1)
		}
		if decoded["name"] != "Intro CS" {
			t.Errorf("name = %v, want %q", decoded["name"], "Intro CS")
		}
		if decoded["term"] != "Fall 2026" {
			t.Errorf("term = %v, want %q", decoded["term"], "Fall 2026")
		}
		if decoded["secret"] != "a1b2c3d4" {
			t.Errorf("secret = %v, want %q", decoded["secret"], "a1b2c3d4")
		}
		if _, present := decoded["active"]; present {
			t.Errorf("active must be omitted when true, got %v", decoded["active"])
		}
	})

	t.Run("listed classroom omits secret", func(t *testing.T) {
		got, err := MarshalTeamDescription("Intro CS", "", "", true)
		if err != nil {
			t.Fatalf("MarshalTeamDescription: %v", err)
		}
		var decoded map[string]any
		if err := json.Unmarshal([]byte(got), &decoded); err != nil {
			t.Fatalf("invalid JSON: %v", err)
		}
		if _, present := decoded["secret"]; present {
			t.Errorf("secret must be omitted for a listed classroom, got %v", decoded["secret"])
		}
		if _, present := decoded["term"]; present {
			t.Errorf("empty term must be omitted, got %v", decoded["term"])
		}
	})

	t.Run("archived classroom writes active=false", func(t *testing.T) {
		got, err := MarshalTeamDescription("Intro CS", "", "", false)
		if err != nil {
			t.Fatalf("MarshalTeamDescription: %v", err)
		}
		var decoded map[string]any
		if err := json.Unmarshal([]byte(got), &decoded); err != nil {
			t.Fatalf("invalid JSON: %v", err)
		}
		active, ok := decoded["active"].(bool)
		if !ok || active {
			t.Errorf("active = %v, want false present", decoded["active"])
		}
	})

	t.Run("malformed secret is rejected, not persisted", func(t *testing.T) {
		if _, err := MarshalTeamDescription("Intro CS", "", "BAD-secret!", true); err == nil {
			t.Error("expected an error for a malformed secret, got nil")
		}
	})

	t.Run("stays under the size budget", func(t *testing.T) {
		// A realistic worst case: long name + term + secret. Must stay well
		// under ~250 chars so the description never risks GitHub's field limit.
		got, err := MarshalTeamDescription(
			"Introduction to Computer Science and Programming",
			"Fall Semester 2026",
			"a1b2c3d4e5f6g7h8",
			true,
		)
		if err != nil {
			t.Fatalf("MarshalTeamDescription: %v", err)
		}
		if len(got) > 250 {
			t.Errorf("encoded description is %d chars, want <= 250: %q", len(got), got)
		}
	})
}

// sharedTeamDescriptionCasesPath locates the cross-language golden fixture, also
// consumed by the TS mirror (web/src/util/teamDescription.test.ts).
const sharedTeamDescriptionCasesPath = "../../../shared/testdata/team_description_cases.json"

// TestMarshalTeamDescription_SharedFixtureParity pins the Go encoding to the
// shared golden bytes so the Go writer and the TS marshalTeamDescription can't
// drift: a one-sided edit (e.g. HTML-escaping) fails on the other language's
// copy of these same cases. Byte-identity matters because the web reconcile
// compares the current description to the desired string for exact equality —
// any divergence makes the CLI and web perpetually overwrite each other.
func TestMarshalTeamDescription_SharedFixtureParity(t *testing.T) {
	raw, err := os.ReadFile(filepath.Clean(sharedTeamDescriptionCasesPath))
	if err != nil {
		t.Fatalf("read shared fixture: %v", err)
	}
	var doc struct {
		Cases []struct {
			Input struct {
				Name   string `json:"name"`
				Term   string `json:"term"`
				Secret string `json:"secret"`
				Active bool   `json:"active"`
			} `json:"input"`
			Encoded string `json:"encoded"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse shared fixture: %v", err)
	}
	if len(doc.Cases) == 0 {
		t.Fatal("shared fixture has no cases")
	}
	for _, c := range doc.Cases {
		got, err := MarshalTeamDescription(c.Input.Name, c.Input.Term, c.Input.Secret, c.Input.Active)
		if err != nil {
			t.Fatalf("MarshalTeamDescription(%+v): %v", c.Input, err)
		}
		if got != c.Encoded {
			t.Errorf("MarshalTeamDescription(%+v) = %q, want %q (cross-language drift — update every copy in lockstep)", c.Input, got, c.Encoded)
		}
	}
}
