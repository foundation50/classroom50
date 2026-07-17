import type { TemplateAccessVerification } from "@/domain/assignments"

// Pure view-model for the two data-branched template verdicts (tone + i18n key),
// so the decision is one testable source of truth (mirrors classifyMembershipError).

export type NoteTone = "warning" | "error"

// Private fork used as a template. In-org parent is usually reachable (advisory
// amber); cross-org or unknown parent likely fails at generate (error red). Each
// messageKey is one full <Trans> sentence carrying {{owner}}/{{repo}}/{{branch}}
// (and {{parent}} when known) with the branch wrapped in a <branch> tag.
export function templateForkNoteView(
  verification: Extract<TemplateAccessVerification, { kind: "private-fork" }>,
): { tone: NoteTone; messageKey: string } {
  const messageKey = verification.parent
    ? verification.parentInOrg
      ? "assignments.template.privateForkInOrg"
      : "assignments.template.privateForkCrossOrg"
    : "assignments.template.privateForkNoParent"
  return {
    tone: verification.parentInOrg ? "warning" : "error",
    messageKey,
  }
}

// A 403 read denial. A real token scope gap points at re-authorizing
// (restrictedScope); any other 403 uses the org-restriction copy (restricted).
// GitHub's own message + status is surfaced alongside via githubSaid.
export function templateRestrictedNoteView(
  verification: Extract<TemplateAccessVerification, { kind: "restricted" }>,
): { messageKey: string } {
  return {
    messageKey: verification.scopeGap
      ? "assignments.template.restrictedScope"
      : "assignments.template.restricted",
  }
}
