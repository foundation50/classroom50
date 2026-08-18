package configrepo

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/contract"
)

// sharedInviteVectorsPath locates the cross-language golden vectors for the
// invite team name and its description record, also consumed by the web writer's
// parity test (web/src/util/inviteTeam.test.ts).
const sharedInviteVectorsPath = "../../../shared/testdata/invite_vectors.json"

type inviteVectorDoc struct {
	Prefix     string `json:"prefix"`
	HashHexLen int    `json:"hash_hex_len"`
	Schema     string `json:"schema"`
	Cases      []struct {
		Why       string `json:"why"`
		Classroom string `json:"classroom"`
		Email     string `json:"email"`
		Slug      string `json:"slug"`
		Record    string `json:"record"`
	} `json:"cases"`
}

func loadInviteVectors(t *testing.T) inviteVectorDoc {
	t.Helper()
	raw, err := os.ReadFile(filepath.Clean(sharedInviteVectorsPath))
	if err != nil {
		t.Fatalf("read shared fixture: %v", err)
	}
	var doc inviteVectorDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse shared fixture: %v", err)
	}
	if len(doc.Cases) == 0 {
		t.Fatal("shared fixture has no cases")
	}
	return doc
}

// TestInviteVectors_SharedParity is the load-bearing cross-writer pin: the CLI
// and the web both create these teams and both read each other's, so a one-sided
// change to the hash input or the record bytes would make every already-created
// invite team unlocatable (and make the two writers overwrite each other's
// description forever). The web suite asserts the same vectors.
func TestInviteVectors_SharedParity(t *testing.T) {
	doc := loadInviteVectors(t)
	if doc.Prefix != contract.InviteTeamPrefix {
		t.Errorf("fixture prefix = %q, want %q", doc.Prefix, contract.InviteTeamPrefix)
	}
	if doc.HashHexLen != contract.InviteHashHexLen {
		t.Errorf("fixture hash_hex_len = %d, want %d", doc.HashHexLen, contract.InviteHashHexLen)
	}
	if doc.Schema != contract.InviteSchemaV1 {
		t.Errorf("fixture schema = %q, want %q", doc.Schema, contract.InviteSchemaV1)
	}

	for _, c := range doc.Cases {
		t.Run(c.Why, func(t *testing.T) {
			if got := InviteTeamName(c.Classroom, c.Email); got != c.Slug {
				t.Errorf("InviteTeamName(%q, %q) = %q, want %q", c.Classroom, c.Email, got, c.Slug)
			}
			// The name doubles as the slug, so the teardown/GC fence must accept
			// every name this writer produces.
			if !IsInviteTeamSlug(c.Slug) {
				t.Errorf("IsInviteTeamSlug(%q) = false; the writer produced a slug the sweep can't match", c.Slug)
			}
			record, err := MarshalInviteDescription(c.Classroom, c.Email)
			if err != nil {
				t.Fatalf("MarshalInviteDescription: %v", err)
			}
			if record != c.Record {
				t.Errorf("MarshalInviteDescription(%q, %q) = %q, want %q (exact bytes: a reconcile compares descriptions for string equality)",
					c.Classroom, c.Email, record, c.Record)
			}
			parsed, ok := ParseInviteDescription(c.Record)
			if !ok {
				t.Fatalf("ParseInviteDescription(%q) = not ok", c.Record)
			}
			if parsed.Email != NormalizeInviteEmail(c.Email) {
				t.Errorf("parsed email = %q, want %q", parsed.Email, NormalizeInviteEmail(c.Email))
			}
			if parsed.Classroom != c.Classroom {
				t.Errorf("parsed classroom = %q, want %q", parsed.Classroom, c.Classroom)
			}
			// The reconcile's trust boundary: the recorded email must hash back
			// to the team it was read from.
			if got := InviteTeamName(parsed.Classroom, parsed.Email); got != c.Slug {
				t.Errorf("record does not re-hash to its team: %q, want %q", got, c.Slug)
			}
		})
	}
}

// TestMarshalInviteDescription_ControlCharParity is the other half of the byte
// contract the shared vectors pin: Go's json.Marshal agrees with JSON.stringify
// on EVERY C0 control and DEL, so the web's Go-parity escaper
// (web/src/util/goJsonEscape.ts) must escape ONLY <, >, &, U+2028 and U+2029.
// Exhaustive over U+0000–U+001F rather than a sample, because the escaper's
// claim is about the whole range: a toolchain that started emitting \u0008 for
// \b — or a long escape for any other control — would silently un-align the two
// writers, and a range checked in part is a claim pinned in part.
func TestMarshalInviteDescription_ControlCharParity(t *testing.T) {
	// The five controls JSON.stringify gives a short escape; every other C0
	// control takes the lowercase \u00xx form, and DEL stays raw.
	shortEscapes := map[rune]string{'\b': `\b`, '\t': `\t`, '\n': `\n`, '\f': `\f`, '\r': `\r`}
	for cp := rune(0); cp <= 0x1F; cp++ {
		out, err := MarshalInviteDescription(fmt.Sprintf("cs%cx", cp), "a@b")
		if err != nil {
			t.Fatalf("MarshalInviteDescription(U+%04X): %v", cp, err)
		}
		want, long := shortEscapes[cp], fmt.Sprintf(`\u%04x`, cp)
		if want == "" {
			want = long
		} else if strings.Contains(out, long) {
			t.Errorf("U+%04X: record %q uses the long escape %q; JSON.stringify emits %q", cp, out, long, want)
		}
		if !strings.Contains(out, want) {
			t.Errorf("U+%04X: record %q is missing %q", cp, out, want)
		}
		// An uppercase-hex escape would be a byte difference on its own.
		if upper := strings.ToUpper(long); upper != long && strings.Contains(out, upper) {
			t.Errorf("U+%04X: record %q uses uppercase hex; JSON.stringify emits lowercase", cp, out)
		}
	}
	out, err := MarshalInviteDescription("cs\u007fx", "a@b")
	if err != nil {
		t.Fatalf("MarshalInviteDescription(DEL): %v", err)
	}
	if !strings.Contains(out, "\u007f") {
		t.Errorf("record %q should carry DEL raw; neither encoder escapes it", out)
	}
}

// A single normalizer feeds both the hash and the stored email, so they can't
// disagree about which address a team belongs to.
func TestNormalizeInviteEmail(t *testing.T) {
	cases := []struct{ in, want string }{
		{"  Alice@Example.COM ", "alice@example.com"},
		{"alice@example.com", "alice@example.com"},
		{"\tA@B\n", "a@b"},
		{"", ""},
	}
	for _, tc := range cases {
		if got := NormalizeInviteEmail(tc.in); got != tc.want {
			t.Errorf("NormalizeInviteEmail(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// TestInviteTeamName_Shape pins the slug-safety the whole addressing scheme
// rests on: GitHub derives a team's slug from its name, so an `invite-<16 hex>`
// name must come back unchanged for name == slug to hold.
func TestInviteTeamName_Shape(t *testing.T) {
	name := InviteTeamName("cs101", "alice@example.com")
	if want := len(contract.InviteTeamPrefix) + contract.InviteHashHexLen; len(name) != want {
		t.Errorf("len(%q) = %d, want %d", name, len(name), want)
	}
	if name != strings.ToLower(name) {
		t.Errorf("name %q is not lowercase; GitHub would rewrite the slug", name)
	}
	if again := InviteTeamName("cs101", "alice@example.com"); again != name {
		t.Errorf("not deterministic: %q then %q", name, again)
	}
}

// ParseInviteDescription is the reader half, applied to a description the
// accepted invitee can hand-edit: it must never bind a record it can't trust,
// but must tolerate a field a newer writer added.
func TestParseInviteDescription(t *testing.T) {
	valid := `{"schema":"classroom50/invite/v1","email":"a@b","classroom":"cs"}`

	t.Run("tolerates unknown fields", func(t *testing.T) {
		// A legacy release wrote first_name/last_name/section; additive
		// evolution means a newer field must not invalidate the record.
		desc := `{"schema":"classroom50/invite/v1","email":"a@b","classroom":"cs","first_name":"Alice","futureField":42}`
		got, ok := ParseInviteDescription(desc)
		if !ok {
			t.Fatal("ok = false, want a tolerated parse")
		}
		if got.Email != "a@b" || got.Classroom != "cs" {
			t.Errorf("parsed = %+v", got)
		}
	})

	t.Run("round-trips a marshaled record", func(t *testing.T) {
		out, err := MarshalInviteDescription("cs", "  A@B ")
		if err != nil {
			t.Fatalf("MarshalInviteDescription: %v", err)
		}
		got, ok := ParseInviteDescription(out)
		if !ok {
			t.Fatalf("ok = false for %q", out)
		}
		if got.Schema != contract.InviteSchemaV1 || got.Email != "a@b" || got.Classroom != "cs" {
			t.Errorf("parsed = %+v", got)
		}
	})

	for _, tc := range []struct {
		why  string
		desc string
	}{
		{"wrong schema sentinel", `{"schema":"classroom50/invite/v2","email":"a@b","classroom":"cs"}`},
		{"missing schema", `{"email":"a@b","classroom":"cs"}`},
		{"missing email", `{"schema":"classroom50/invite/v1","classroom":"cs"}`},
		{"missing classroom", `{"schema":"classroom50/invite/v1","email":"a@b"}`},
		{"a human-written team description", "Invite only, ask the TA"},
		{"truncated JSON", `{"schema":"classroom50/invite/v1"`},
		{"a JSON array", `["classroom50/invite/v1"]`},
		{"an email present but blank", `{"schema":"classroom50/invite/v1","email":"","classroom":"cs"}`},
		{"empty", ""},
	} {
		t.Run("rejects "+tc.why, func(t *testing.T) {
			if got, ok := ParseInviteDescription(tc.desc); ok {
				t.Errorf("ParseInviteDescription(%q) = %+v, ok; want rejected", tc.desc, got)
			}
		})
	}

	// Sanity: the shared valid form the negative cases are derived from parses.
	if _, ok := ParseInviteDescription(valid); !ok {
		t.Errorf("ParseInviteDescription(%q) = not ok", valid)
	}
}

// The record carries the only PII in this feature and GitHub caps a team
// description at ~250 chars, so an RFC-length address must still fit — there is
// no drop-fields fallback (nothing optional is left to drop).
func TestMarshalInviteDescription_FitsDescriptionCap(t *testing.T) {
	long := strings.Repeat("x", 64) + "@" + strings.Repeat("y", 60) + ".example.com"
	out, err := MarshalInviteDescription("a-fairly-long-classroom-name", long)
	if err != nil {
		t.Fatalf("MarshalInviteDescription: %v", err)
	}
	if len(out) > 240 {
		t.Errorf("record is %d chars, want <= 240 (GitHub's team-description cap is ~250)", len(out))
	}
}
