// Shared logger scope names for scopes used from more than one file, so a
// rename stays single-source (this file's own doc rule: cross-file scopes are
// extracted, single-file scopes stay inline at their call site). Leaf module
// (no imports) to stay clear of the logger/errors init cycle.
export const LOG_SCOPE_GITHUB_CLIENT = "github:client"
export const LOG_SCOPE_GITHUB_SETUP = "github:setup"
export const LOG_SCOPE_ROUTER = "router"
export const LOG_SCOPE_AUTH = "auth"
export const LOG_SCOPE_QUERIES = "queries"
