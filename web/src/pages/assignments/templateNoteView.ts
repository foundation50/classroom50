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

// The verdict kinds whose template gets the classroom-team read grant on save
// (so whose private forks inherit it): an in-org private `ok`, and every
// `private-fork`, which is in-org and private by construction. One source for
// the question so the forks note and the team-access check cannot drift.
export function teamGrantTemplate(
  verification: TemplateAccessVerification | null,
): { owner: string; repo: string; branch: string; forksCount: number } | null {
  if (!verification) return null
  if (verification.kind === "private-fork") {
    const { owner, repo, branch, forksCount } = verification
    return { owner, repo, branch, forksCount }
  }
  if (
    verification.kind === "ok" &&
    verification.inOrg &&
    verification.visibility === "private"
  ) {
    const { owner, repo, branch, forksCount } = verification
    return { owner, repo, branch, forksCount }
  }
  return null
}
