import type { ServiceTokenExpiry } from "@/github-core/queries"

// A single org's derived service-token health verdict, ordered by urgency. The
// UI turns this into a status chip and folds the set into an
// "N of M orgs need attention" summary.
//
// - `expired` / `missing`: the nightly collect is (or will be) failing now.
// - `collectFailing`: the token looks set, but the most recent collect run
//   concluded in failure — surface it even if expiry still looks fine.
// - `expiringSoon`: rotate before the window closes.
// - `unknown`: owner-only reads were blocked (not an owner, or a transient
//   read failure) — we can't judge, so don't claim a problem.
// - `ok`: token set, no recorded/near expiry, last collect not failing.
export type OrgServiceTokenHealth =
  "ok" | "expiringSoon" | "expired" | "missing" | "collectFailing" | "unknown"

// Whether a health verdict should count toward "needs attention".
export function needsAttention(health: OrgServiceTokenHealth): boolean {
  return (
    health === "expired" ||
    health === "missing" ||
    health === "expiringSoon" ||
    health === "collectFailing"
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
// expiry.
export function deriveOrgServiceTokenHealth(input: {
  tokenStatus: "present" | "missing" | "unknown"
  expiry: ServiceTokenExpiry
  lastCollectFailing: boolean
}): OrgServiceTokenHealth {
  if (input.tokenStatus === "missing") return "missing"
  if (input.tokenStatus === "unknown") return "unknown"

  // present
  if (input.expiry === "expired") return "expired"
  if (input.lastCollectFailing) return "collectFailing"
  if (input.expiry === "expiringSoon") return "expiringSoon"
  return "ok"
}
