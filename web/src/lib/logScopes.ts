// Shared logger scope names for modules that log under the same scope from more
// than one file, so a rename stays single-source. Leaf module (no imports) to
// stay clear of the logger/errors init cycle. Single-file scopes stay inline.
export const LOG_SCOPE_GITHUB_CLIENT = "github:client"
