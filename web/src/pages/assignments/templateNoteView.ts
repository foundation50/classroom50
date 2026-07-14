import type { TemplateAccessVerification } from "@/domain/assignments"

// Pure view-model for the two data-branched template verdicts (tone + i18n key),
// so the decision is one testable source of truth (mirrors classifyMembershipError).

export type NoteTone = "warning" | "error"

// Private fork used as a template. In-org parent is usually reachable (advisory
// amber); cross-org or unknown parent likely fails at generate (error red). The
// no-parent case reuses the cross-org suffix, treating unknown upstream as the
// higher-risk cross-org case.
export function templateForkNoteView(
  verification: Extract<TemplateAccessVerification, { kind: "private-fork" }>,
): { tone: NoteTone; labelKey: string; suffixKey: string } {
  const labelKey = verification.parent
    ? verification.parentInOrg
      ? "assignments.template.privateForkInOrg_1"
      : "assignments.template.privateForkCrossOrg_1"
    : "assignments.template.privateForkNoParent_1"
  return verification.parentInOrg
    ? {
        tone: "warning",
        labelKey,
        suffixKey: "assignments.template.privateForkInOrg_2",
      }
    : {
        tone: "error",
        labelKey,
        suffixKey: "assignments.template.privateForkCrossOrg_2",
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
