import type { TemplateAccessVerification } from "@/api/mutations/assignments"

// Pure view-model helpers for the two template-access verdicts whose rendering
// branches on data (tone + which i18n key). Extracted from TemplateField's
// TemplateVerificationNote so the tone/key decision is a single source of truth
// and unit-testable without a DOM (mirrors classifyMembershipError). The JSX
// only interpolates the returned keys and picks the Note tone.

export type NoteTone = "warning" | "error"

// A private fork used as a template. In-org parent is usually reachable
// (advisory amber); a cross-org or unknown parent is likely to fail at generate
// (error red). The no-parent case reuses the cross-org suffix (no dedicated
// privateForkNoParent_2 key) because an unknown upstream is treated as the
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

// A 403 read denial. A real token scope gap points the user at re-authorizing
// (restrictedScope); any other 403 uses the org-restriction copy (restricted).
// GitHub's actual message + status is always surfaced alongside via githubSaid.
export function templateRestrictedNoteView(
  verification: Extract<TemplateAccessVerification, { kind: "restricted" }>,
): { messageKey: string } {
  return {
    messageKey: verification.scopeGap
      ? "assignments.template.restrictedScope"
      : "assignments.template.restricted",
  }
}
