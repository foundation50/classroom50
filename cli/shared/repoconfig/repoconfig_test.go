package repoconfig

import (
	"reflect"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// TestRender_ByteShape pins the exact document both CLIs write: quoted string
// scalars (a slug like "2026" must not auto-type), unquoted numeric ids, null
// for an unresolved id, and the CLI field order the web GUI mirrors.
func TestRender_ByteShape(t *testing.T) {
	ownerID := int64(12345)
	srcOwnerID := int64(99)
	out, err := Render(Config{
		Schema:     SchemaV1,
		Classroom:  "2026",
		Assignment: "hello",
		Secret:     "abcd1234",
		Owner:      &Identity{Username: "alice", ID: &ownerID, AcceptedAt: "2026-06-01T14:33:11Z"},
		Source:     &Source{Owner: "cs50", OwnerID: &srcOwnerID, Repo: "hello-template", Branch: "main"},
	})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	want := `schema: "classroom50/repo-config/v1"
classroom: "2026"
assignment: "hello"
secret: "abcd1234"
owner:
  username: "alice"
  id: 12345
  accepted_at: "2026-06-01T14:33:11Z"
source:
  owner: "cs50"
  owner_id: 99
  repo: "hello-template"
  branch: "main"
`
	if string(out) != want {
		t.Errorf("Render mismatch\n got:\n%s\nwant:\n%s", out, want)
	}

	var round Config
	if err := yaml.Unmarshal(out, &round); err != nil {
		t.Fatalf("round-trip parse: %v", err)
	}
	if !reflect.DeepEqual(round, Config{
		Schema:     SchemaV1,
		Classroom:  "2026",
		Assignment: "hello",
		Secret:     "abcd1234",
		Owner:      &Identity{Username: "alice", ID: &ownerID, AcceptedAt: "2026-06-01T14:33:11Z"},
		Source:     &Source{Owner: "cs50", OwnerID: &srcOwnerID, Repo: "hello-template", Branch: "main"},
	}) {
		t.Errorf("round-trip mismatch:\n got: %#v", round)
	}
}

func TestRender_TemplateLessOmitsSource(t *testing.T) {
	out, err := Render(Config{Classroom: "cs", Assignment: "solo"})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if strings.Contains(string(out), "source:") {
		t.Errorf("template-less config must omit the source block, got:\n%s", out)
	}
}

func TestRender_OmitsOptionalBlocksAndNullsUnresolvedID(t *testing.T) {
	cfg := Config{
		Schema:     SchemaV1,
		Classroom:  "cs",
		Assignment: "hw1",
		Owner:      &Identity{Username: "alice"},
	}
	out, err := Render(cfg)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	want := `schema: "classroom50/repo-config/v1"
classroom: "cs"
assignment: "hw1"
owner:
  username: "alice"
  id: null
`
	if string(out) != want {
		t.Errorf("Render mismatch\n got:\n%s\nwant:\n%s", out, want)
	}

	var round Config
	if err := yaml.Unmarshal(out, &round); err != nil {
		t.Fatalf("round-trip parse: %v", err)
	}
	if !reflect.DeepEqual(round, cfg) {
		t.Errorf("round-trip mismatch:\n got: %#v\nwant: %#v", round, cfg)
	}
}
