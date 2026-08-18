// Match Go's json.Marshal, which HTML-escapes <, >, & AND the U+2028/U+2029
// line/paragraph separators by default (no SetEscapeHTML(false) on the CLI
// writers). JSON.stringify escapes none of these, so a TS writer that skips
// this would produce different bytes than a Go writer for the same record and
// perpetually overwrite it (description reconciles compare strings for exact
// equality). One source for every description marshaller.
//
// These five are the ONLY divergences, verified against Go 1.26 (the toolchain
// both cli go.mod files require) across every C0 code point: Go emits the same
// short \b \f \n \r \t escapes JSON.stringify does, the same lowercase \u00xx for
// every other C0 control, and leaves DEL and well-formed non-ASCII raw. So do
// NOT "also escape" a control character here — that would CREATE the byte
// difference this guards against. Pinned exhaustively by the control-character
// case in cli/shared/testdata/invite_vectors.json and both writers' suites.
export function escapeForGoJsonParity(json: string): string {
  return json
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")
}
