// Match Go's json.Marshal, which HTML-escapes <, >, & AND the U+2028/U+2029
// line/paragraph separators by default (no SetEscapeHTML(false) on the CLI
// writers). JSON.stringify escapes none of these, so a TS writer that skips
// this would produce different bytes than a Go writer for the same record and
// perpetually overwrite it (description reconciles compare strings for exact
// equality). One source for every description marshaller.
export function escapeForGoJsonParity(json: string): string {
  return json
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")
}
