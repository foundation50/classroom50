// Package output holds CLI-wide presentation helpers that aren't domain logic:
// the shared JSON encoder for every `--json` view and every config-repo file
// gh-teacher writes, the terminal cell guard, and the blank-cell table
// placeholder. Stdlib-only.
package output

import (
	"bytes"
	"encoding/json"
	"strings"
	"unicode"
)

// Printable replaces control characters (newline, tab, escape, C1 controls)
// with a space so a user-controlled string (a student-chosen team name, a
// login) cannot forge a table row or emit a terminal escape sequence when
// printed. For terminal tables only; CSV and JSON stay byte-exact.
func Printable(s string) string {
	if !strings.ContainsFunc(s, unicode.IsControl) {
		return s
	}
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
}

// DashIfEmpty is the table placeholder for a blank cell, so an aligned column
// never shows a hole the eye reads as "cell missing".
func DashIfEmpty(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// JSONPretty marshals v with 2-space indent, trailing newline, and EscapeHTML
// off (keeps `<`/`>` literal in URLs). The single encoder behind both `--json`
// output and the config-repo files, so its byte shape is a contract: changing
// indent, HTML-escaping, or the trailing newline is breaking.
func JSONPretty(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
