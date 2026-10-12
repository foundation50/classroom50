package output

import (
	"strings"
	"testing"
)

// TestJSONPretty_ByteContract pins the three byte-level guarantees other
// code depends on: 2-space indent, no HTML escaping (so `<`/`>` in URLs
// stay literal), and a trailing newline.
func TestJSONPretty_ByteContract(t *testing.T) {
	type payload struct {
		URL  string `json:"url"`
		Name string `json:"name"`
	}
	got, err := JSONPretty(payload{URL: "https://example.com/a?x=1&y=<2>", Name: "alice"})
	if err != nil {
		t.Fatalf("JSONPretty: %v", err)
	}

	want := "{\n" +
		"  \"url\": \"https://example.com/a?x=1&y=<2>\",\n" +
		"  \"name\": \"alice\"\n" +
		"}\n"
	if string(got) != want {
		t.Errorf("JSONPretty output mismatch:\n got: %q\nwant: %q", string(got), want)
	}
}

// TestJSONPretty_LeavesAngleBracketsLiteral guards specifically against a
// regression to the default EscapeHTML=true, which would emit \u003c/\u003e.
func TestJSONPretty_LeavesAngleBracketsLiteral(t *testing.T) {
	got, err := JSONPretty(map[string]string{"k": "<b>&</b>"})
	if err != nil {
		t.Fatalf("JSONPretty: %v", err)
	}
	if want := "<b>&</b>"; !strings.Contains(string(got), want) {
		t.Errorf("expected literal %q in output, got %q", want, string(got))
	}
}

func TestPrintable(t *testing.T) {
	cases := map[string]string{
		"The Sharks":             "The Sharks",
		"Sharks\x1b[31m\nx\tyes": "Sharks [31m x yes",   // the ESC goes, so "[31m" is inert text
		"caf\u00e9 \u0130nan":    "caf\u00e9 \u0130nan", // non-ASCII letters are not controls
		"":                       "",
	}
	for in, want := range cases {
		if got := Printable(in); got != want {
			t.Errorf("Printable(%q) = %q, want %q", in, got, want)
		}
	}
}
