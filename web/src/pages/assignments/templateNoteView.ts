import type { TemplateAccessVerification } from "@/domain/assignments"

// Pure view-model for the private-fork template verdict (the i18n key), so the
// message decision is one testable source of truth (mirrors classifyMembershipError).

// Private fork used as a template. Copying works if Classroom 50 is approved on
// the fork's parent org (verified: generate copies the fork's own objects, no
// parent access needed); the only failure is the parent org's OAuth-App
// restriction, surfaced at accept. So the note is always advisory (an amber
// warning) — in-org or cross-org — never a red "will fail" error, which is why
// this returns only the message key and the caller fixes the warning tone.
export function templateForkNoteView(
  verification: Extract<TemplateAccessVerification, { kind: "private-fork" }>,
): { messageKey: string } {
  const messageKey = verification.parent
    ? verification.parentInOrg
      ? "assignments.template.privateForkInOrg"
      : "assignments.template.privateForkCrossOrg"
    : "assignments.template.privateForkNoParent"
  return { messageKey }
}
