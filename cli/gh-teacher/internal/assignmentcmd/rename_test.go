package assignmentcmd

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// --- rewriteMarkerAssignment (pure) -----------------------------------------

const markerYAML = `# Written by gh student accept — do not edit.
schema: classroom50/repo-config/v1
classroom: cs
assignment: old-slug-with-a-very-long-legacy-name
secret: abcd1234
owner:
  username: alice
  id: 7
`

func TestRewriteMarkerAssignment(t *testing.T) {
	t.Run("rewrites the assignment scalar, preserving comments and siblings", func(t *testing.T) {
		out, changed, foreign, err := rewriteMarkerAssignment([]byte(markerYAML), "old-slug-with-a-very-long-legacy-name", "ps3")
		if err != nil || !changed || foreign != "" {
			t.Fatalf("got changed=%t foreign=%q err=%v, want a clean rewrite", changed, foreign, err)
		}
		text := string(out)
		if !strings.Contains(text, "assignment: ps3") {
			t.Errorf("rewritten marker missing new slug:\n%s", text)
		}
		if strings.Contains(text, "old-slug-with-a-very-long-legacy-name") {
			t.Errorf("rewritten marker still carries the old slug:\n%s", text)
		}
		// The comment header and the sibling keys must survive the round-trip
		// (students' files are hand-inspectable; the runner reads secret/owner).
		for _, keep := range []string{"# Written by gh student accept", "classroom: cs", "secret: abcd1234", "username: alice"} {
			if !strings.Contains(text, keep) {
				t.Errorf("rewritten marker lost %q:\n%s", keep, text)
			}
		}
	})

	t.Run("already-new marker is a no-op", func(t *testing.T) {
		already := strings.Replace(markerYAML, "old-slug-with-a-very-long-legacy-name", "ps3", 1)
		out, changed, foreign, err := rewriteMarkerAssignment([]byte(already), "old-slug-with-a-very-long-legacy-name", "ps3")
		if err != nil || changed || foreign != "" || out != nil {
			t.Errorf("got (%v,%t,%q,%v), want a clean no-op", out, changed, foreign, err)
		}
	})

	t.Run("a foreign slug is reported, never rewritten", func(t *testing.T) {
		sibling := strings.Replace(markerYAML, "old-slug-with-a-very-long-legacy-name", "other-assignment", 1)
		_, changed, foreign, err := rewriteMarkerAssignment([]byte(sibling), "old-slug-with-a-very-long-legacy-name", "ps3")
		if err != nil || changed {
			t.Fatalf("got changed=%t err=%v, want untouched", changed, err)
		}
		if foreign != "other-assignment" {
			t.Errorf("foreign = %q, want other-assignment", foreign)
		}
	})

	t.Run("missing assignment key errors", func(t *testing.T) {
		if _, _, _, err := rewriteMarkerAssignment([]byte("classroom: cs\n"), "a", "b"); err == nil {
			t.Error("want an error for a marker without an assignment key")
		}
	})

	t.Run("non-mapping document errors", func(t *testing.T) {
		if _, _, _, err := rewriteMarkerAssignment([]byte("- just\n- a list\n"), "a", "b"); err == nil {
			t.Error("want an error for a non-mapping marker")
		}
	})
}

// --- rekeyScoresBucket (pure) ------------------------------------------------

const scoresJSON = `{
  "schema": "classroom50/scores/v1",
  "assignments": {
    "old-slug": {"type": "individual", "entries": [{"owner": "alice", "submissions": []}]},
    "hw2": {"type": "group", "entries": []}
  }
}`

func TestRekeyScoresBucket(t *testing.T) {
	t.Run("moves the bucket verbatim and keeps siblings + schema", func(t *testing.T) {
		out, changed, err := rekeyScoresBucket([]byte(scoresJSON), "old-slug", "ps3")
		if err != nil || !changed {
			t.Fatalf("got changed=%t err=%v, want a re-key", changed, err)
		}
		var doc struct {
			Schema      string                     `json:"schema"`
			Assignments map[string]json.RawMessage `json:"assignments"`
		}
		if err := json.Unmarshal(out, &doc); err != nil {
			t.Fatalf("re-keyed scores.json does not parse: %v", err)
		}
		if doc.Schema != "classroom50/scores/v1" {
			t.Errorf("schema = %q, want preserved", doc.Schema)
		}
		if _, old := doc.Assignments["old-slug"]; old {
			t.Error("old bucket still present")
		}
		if !bytes.Contains(doc.Assignments["ps3"], []byte(`"alice"`)) {
			t.Errorf("ps3 bucket = %s, want the old bucket's entries", doc.Assignments["ps3"])
		}
		if _, sibling := doc.Assignments["hw2"]; !sibling {
			t.Error("sibling bucket dropped")
		}
	})

	t.Run("absent old bucket is a clean no-op", func(t *testing.T) {
		out, changed, err := rekeyScoresBucket([]byte(scoresJSON), "never-collected", "ps3")
		if err != nil || changed || out != nil {
			t.Errorf("got (%v,%t,%v), want a no-op", out, changed, err)
		}
	})

	t.Run("existing new bucket is refused", func(t *testing.T) {
		if _, _, err := rekeyScoresBucket([]byte(scoresJSON), "old-slug", "hw2"); err == nil {
			t.Error("want an error when the new bucket already exists")
		}
	})

	t.Run("malformed document errors", func(t *testing.T) {
		if _, _, err := rekeyScoresBucket([]byte("not json"), "a", "b"); err == nil {
			t.Error("want a parse error")
		}
	})
}
