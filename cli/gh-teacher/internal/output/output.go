// Package output holds CLI-wide presentation helpers that aren't domain logic —
// currently the shared JSON encoder for every `--json` view and every
// config-repo file gh-teacher writes. Stdlib-only.
package output

import (
	"bytes"
	"encoding/json"
)

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
