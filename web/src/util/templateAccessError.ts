// A template-generate failure at accept time, with a plain-text message the
// accept page renders as-is. Messages point students at their instructor —
// they can't approve an OAuth app or grant team read themselves.
export class TemplateAccessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TemplateAccessError"
  }
}

// Out-of-org template: the owning org likely restricts third-party apps, but a
// 403 has other causes too (per-user OAuth grant, SSO, scope), so GitHub's
// actual message is appended rather than asserting a single cause.
export function outOfOrgTemplateError(
  templateOwner: string,
  templateRepo: string,
  status: number,
  githubMessage?: string,
): TemplateAccessError {
  const detail = githubMessage ? ` GitHub said: "${githubMessage}".` : ""
  return new TemplateAccessError(
    `Couldn't copy the template ${templateOwner}/${templateRepo} (HTTP ${status}).${detail} This is often because the ${templateOwner} organization restricts third-party apps — ask your instructor to approve the Classroom 50 app for ${templateOwner} (or make the template public), then accept again.`,
  )
}

// In-org template: the classroom team likely lacks read on a private template.
export function inOrgTemplateError(
  templateOwner: string,
  templateRepo: string,
  status: number,
  githubMessage?: string,
): TemplateAccessError {
  const detail = githubMessage ? ` GitHub said: "${githubMessage}".` : ""
  return new TemplateAccessError(
    `Couldn't copy the private template ${templateOwner}/${templateRepo} (HTTP ${status}).${detail} Ask your instructor to re-run assignment setup, then accept again.`,
  )
}
