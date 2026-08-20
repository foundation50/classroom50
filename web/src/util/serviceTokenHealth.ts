import type { ServiceTokenExpiry } from "@/github-core/queries"

// A single org's derived service-token health verdict, ordered by urgency. The
// UI turns this into a status chip and folds the set into an
// "N of M orgs need attention" summary.
//
// - `expired` / `missing`: collection is (or will be) failing now.
// - `expiringSoon`: rotate before the window closes.
// - `expiryUntracked`: the token is set but no expiry was recorded (rotated via
//   the CLI, provisioned before we tracked expiry, or a swallowed variable
//   write). We can't warn before it lapses, so nudge the teacher to re-save and
//   record one — a quiet but visible "you're flying blind" signal rather than a
//   false "all healthy".
// - `unknown`: owner-only reads were blocked (not an owner, or a transient
//   read failure) — we can't judge, so don't claim a problem.
// - `ok`: token set, expiry recorded and not near.
export type OrgServiceTokenHealth =
  "ok" | "expiringSoon" | "expired" | "missing" | "expiryUntracked" | "unknown"

// Whether a health verdict should count toward "needs attention". `unknown`
// (owner-only read blocked) is excluded — we genuinely can't judge it — but
// `expiryUntracked` counts: the token IS ours and IS set, we just can't see its
// expiry, which is exactly the blind spot this feature exists to close.
export function needsAttention(health: OrgServiceTokenHealth): boolean {
  return health !== "ok" && health !== "unknown"
}

// The pure reducer: combine the token's presence and its expiry classification
// into one verdict. An expired token outranks a soon expiry, which outranks an
// untracked expiry.
export function deriveOrgServiceTokenHealth(input: {
  tokenStatus: "present" | "missing" | "unknown"
  expiry: ServiceTokenExpiry
}): OrgServiceTokenHealth {
  if (input.tokenStatus === "missing") return "missing"
  if (input.tokenStatus === "unknown") return "unknown"

  if (input.expiry === "expired") return "expired"
  if (input.expiry === "expiringSoon") return "expiringSoon"
  // A set token with no recorded expiry can't be certified healthy — surface
  // the blind spot rather than a false "ok".
  if (input.expiry === "unknown") return "expiryUntracked"
  return "ok"
}
