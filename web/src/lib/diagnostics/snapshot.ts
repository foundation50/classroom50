// Assembles the allow-listed "Copy diagnostics" text a user pastes into a
// support thread. Every line is an explicit, non-sensitive fact — build
// identity, browser, granted scopes, org + plan, and the recent-error summary
// from the session Activity store. It NEVER includes the raw response body or
// the raw X-GitHub-SSO header (the store already excludes them; see
// lib/activity/activityStore.ts).

import { appVersion, formatAppVersion } from "@/version"
import { classifyPlan } from "@/lib/orgPlan"
import { missingScopes } from "@/auth/scopes"
import { readActivity, type ActivityEntry } from "@/lib/activity/activityStore"
import { readObservedContext } from "./observed"

export type SnapshotInput = {
  // The org currently in view, if any (threaded from the route). Absent renders
  // an explicit "(none)" org line.
  org?: string | null
  // The org's plan.name from GET /orgs/{org}, when the user can see it (owners
  // only). Undefined/absent renders an explicit "unknown" line, never "free".
  planName?: string
}

export function buildDiagnostics(input: SnapshotInput = {}): string {
  const ctx = readObservedContext()
  const org = input.org ?? null
  const lines: string[] = []

  lines.push(`Classroom 50 diagnostics`)
  if (import.meta.env.DEV) {
    // A dev-server build stamps package.json's version, HEAD at server start,
    // and the launch time — real-looking but NOT a deployed release. Say so
    // plainly so a local run is never mistaken for what shipped.
    lines.push(`Build: LOCAL DEV SERVER (not a deployed release)`)
  }
  lines.push(`Version: ${formatAppVersion()}`)
  lines.push(`Built: ${appVersion.buildDate}`)
  lines.push(`Generated: ${new Date().toISOString()}`)

  if (typeof navigator !== "undefined") {
    lines.push(`User agent: ${navigator.userAgent}`)
    lines.push(`Language: ${navigator.language}`)
  }

  lines.push(scopesLine(ctx.scopes))
  lines.push(orgPlanLine(org, input.planName))

  // Only error-kind activity is relevant to a bug report's "recent errors".
  const errors = readActivity().filter((e) => e.kind === "error")
  lines.push("")
  lines.push(`Recent errors: ${errors.length === 0 ? "none" : ""}`.trimEnd())
  for (const e of errors) {
    lines.push(`  ${errorLine(e)}`)
  }

  return lines.join("\n")
}

function scopesLine(scopes: string | null): string {
  if (scopes === null) {
    return `OAuth scopes: unknown (no X-OAuth-Scopes header — e.g. a fine-grained PAT)`
  }
  const missing = missingScopes(scopes)
  const gap = missing.length > 0 ? ` (missing: ${missing.join(", ")})` : ""
  return `OAuth scopes: ${scopes || "(none)"}${gap}`
}

function orgPlanLine(org: string | null, planName?: string): string {
  const orgPart = org ? org : "(none)"
  const category = classifyPlan(planName)
  if (category === "unknown") {
    // GitHub only returns plan to org owners, so unknown is expected for
    // members — say so rather than leave the maintainer guessing.
    return `Org: ${orgPart} — plan: unknown (plan not visible — not an org owner?)`
  }
  return `Org: ${orgPart} — plan: ${planName} (${category})`
}

function errorLine(e: ActivityEntry): string {
  const parts = [new Date(e.at).toISOString()]
  if (e.status !== undefined) parts.push(`HTTP ${e.status}`)
  if (e.endpoint) parts.push(e.endpoint)
  if (e.requestId) parts.push(`req=${e.requestId}`)
  if (e.ssoRequired) parts.push("ssoRequired")
  if (e.scopeGap) parts.push("scopeGap")
  if (e.source) parts.push(`at ${e.source}`)
  // Keep the label (message) last so it can't be confused with the fielded
  // metadata. It's allow-listed (GitHub's own error string, or a thrown Error's
  // message), never the raw response body.
  if (e.label) parts.push(e.label)
  return parts.join(" | ")
}
