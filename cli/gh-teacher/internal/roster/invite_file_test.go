package roster

import (
	"strings"
	"testing"
)

func TestParseInviteFile(t *testing.T) {
	t.Run("valid lines parse in order", func(t *testing.T) {
		entries, failures := parseInviteFile([]byte("ada@uni.edu\nbea@uni.edu\n"))
		if len(failures) != 0 {
			t.Fatalf("failures = %v, want none", failures)
		}
		if len(entries) != 2 || entries[0].email != "ada@uni.edu" || entries[1].email != "bea@uni.edu" {
			t.Fatalf("entries = %+v, want ada then bea", entries)
		}
	})

	// Covers AE2: an invalid line is reported by line number and raw content.
	t.Run("invalid line reported by line and raw", func(t *testing.T) {
		entries, failures := parseInviteFile([]byte("ada@uni.edu\nnot-an-email\ncam@uni.edu\n"))
		if len(entries) != 2 {
			t.Fatalf("entries = %+v, want the two valid rows", entries)
		}
		if len(failures) != 1 {
			t.Fatalf("failures = %v, want exactly one", failures)
		}
		msg := failures[0].Error()
		if !strings.Contains(msg, "line 2") || !strings.Contains(msg, "not-an-email") {
			t.Errorf("failure = %q, want it to name line 2 and the raw value", msg)
		}
	})

	// Covers AE4: comments, blanks, and a repeat collapse; kept entry keeps the
	// first occurrence's line.
	t.Run("comments blanks and duplicates collapse", func(t *testing.T) {
		data := "# section 1 list\n\nada@uni.edu\n  # trailing note\nada@uni.edu\n"
		entries, failures := parseInviteFile([]byte(data))
		if len(failures) != 0 {
			t.Fatalf("failures = %v, want none", failures)
		}
		if len(entries) != 1 {
			t.Fatalf("entries = %+v, want a single deduped entry", entries)
		}
		if entries[0].email != "ada@uni.edu" || entries[0].line != 3 {
			t.Errorf("entry = %+v, want ada@uni.edu first seen on line 3", entries[0])
		}
	})

	t.Run("CRLF endings parse like LF", func(t *testing.T) {
		entries, failures := parseInviteFile([]byte("ada@uni.edu\r\nbea@uni.edu\r\n"))
		if len(failures) != 0 {
			t.Fatalf("failures = %v, want none", failures)
		}
		if len(entries) != 2 || entries[0].email != "ada@uni.edu" || entries[1].email != "bea@uni.edu" {
			t.Fatalf("entries = %+v, want both addresses", entries)
		}
	})

	t.Run("two invalid lines both reported", func(t *testing.T) {
		_, failures := parseInviteFile([]byte("bad one\nada@uni.edu\nbad two\n"))
		if len(failures) != 2 {
			t.Fatalf("failures = %v, want two", failures)
		}
		if !strings.Contains(failures[0].Error(), "line 1") || !strings.Contains(failures[1].Error(), "line 3") {
			t.Errorf("failures = %v, want lines 1 and 3 named", failures)
		}
	})

	t.Run("only comments and blanks yields nothing", func(t *testing.T) {
		entries, failures := parseInviteFile([]byte("# header\n\n   \n#done\n"))
		if len(entries) != 0 || len(failures) != 0 {
			t.Fatalf("entries=%+v failures=%v, want both empty", entries, failures)
		}
	})

	t.Run("case and whitespace normalize before dedup", func(t *testing.T) {
		entries, failures := parseInviteFile([]byte("Ada@Uni.edu\n  ada@uni.edu \n"))
		if len(failures) != 0 {
			t.Fatalf("failures = %v, want none", failures)
		}
		if len(entries) != 1 || entries[0].email != "ada@uni.edu" {
			t.Fatalf("entries = %+v, want one normalized entry", entries)
		}
	})
}

func TestJoinInviteFileFailures(t *testing.T) {
	if err := joinInviteFileFailures(nil); err != nil {
		t.Fatalf("no failures should join to nil, got %v", err)
	}
	entries, failures := parseInviteFile([]byte("bad one\nbad two\n"))
	if len(entries) != 0 {
		t.Fatalf("entries = %+v, want none", entries)
	}
	err := joinInviteFileFailures(failures)
	if err == nil {
		t.Fatal("want a joined error")
	}
	if !strings.Contains(err.Error(), "2 line(s)") || !strings.Contains(err.Error(), "nothing was sent") {
		t.Errorf("joined = %q, want the count and fail-closed phrasing", err.Error())
	}
}
