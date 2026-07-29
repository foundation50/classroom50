import type { ServiceTokenExpiry } from "@/github-core/queries"

// A single org's derived service-token health verdict, ordered by urgency. The
// UI turns this into a status chip and folds the set into an
// "N of M orgs need attention" summary.
//
// - `expired` / `missing`: the nightly collect is (or will be) failing now.
// - `collectFailing`: the token looks set, but the most recent collect run
//   concluded in failure — surface it even if expiry still looks fine.
// - `expiringSoon`: rotate before the window closes.
// - `expiryUntracked`: the token is set but no expiry was recorded (rotated via
//   the CLI, provisioned before we tracked expiry, or a swallowed variable
//   write). We can't warn before it lapses, so nudge the teacher to re-save and
//   record one — a quiet but visible "you're flying blind" signal rather than a
//   false "all healthy".
// - `unknown`: owner-only reads were blocked (not an owner, or a transient
//   read failure) — we can't judge, so don't claim a problem.
// - `ok`: token set, expiry recorded and not near, last collect not failing.
export type OrgServiceTokenHealth =
  | "ok"
  | "expiringSoon"
  | "expired"
  | "missing"
  | "collectFailing"
  | "expiryUntracked"
  | "unknown"

// Whether a health verdict should count toward "needs attention". `unknown`
// (owner-only read blocked) is excluded — we genuinely can't judge it — but
// `expiryUntracked` counts: the token IS ours and IS set, we just can't see its
// expiry, which is exactly the blind spot this feature exists to close.
export function needsAttention(health: OrgServiceTokenHealth): boolean {
  return (
    health === "expired" ||
    health === "missing" ||
    health === "expiringSoon" ||
    health === "collectFailing" ||
    health === "expiryUntracked"
  )
}

// A completed workflow run's conclusion is "failing" for our purposes when it
// hard-failed or timed out. Cancelled/skipped/neutral runs are not treated as a
// token problem.
export function isCollectRunFailing(conclusion: string | null): boolean {
  return conclusion === "failure" || conclusion === "timed_out"
}

// The pure reducer: combine the token's presence, its expiry classification,
// and the last collect run's conclusion into one verdict. Expiry outranks a
// failing collect (an expired token IS the cause), which outranks a soon
// expiry, which outranks an untracked expiry.
//
// `lastCollectFailing` is `true`/`false` for a resolved run read, or `"unknown"`
// when that read errored — an errored read must NOT be read as a clean "not
// failing", so it never lets us assert `ok` (it degrades to `expiryUntracked`
// at worst, never a false all-clear).
export function deriveOrgServiceTokenHealth(input: {
  tokenStatus: "present" | "missing" | "unknown"
  expiry: ServiceTokenExpiry
  lastCollectFailing: boolean | "unknown"
}): OrgServiceTokenHealth {
  if (input.tokenStatus === "missing") return "missing"
  if (input.tokenStatus === "unknown") return "unknown"

  // present
  if (input.expiry === "expired") return "expired"
  if (input.lastCollectFailing === true) return "collectFailing"
  if (input.expiry === "expiringSoon") return "expiringSoon"
  // A set token with no recorded expiry (or an inconclusive collect read) can't
  // be certified healthy — surface the blind spot rather than a false "ok".
  if (input.expiry === "unknown" || input.lastCollectFailing === "unknown") {
    return "expiryUntracked"
  }
  return "ok"
}
