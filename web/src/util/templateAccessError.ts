import i18n from "@/i18n"

// A template-generate failure at accept time, with a plain-text message the
// accept page renders as-is. Messages point students at their teacher (they
// can't approve an OAuth app or grant team read themselves).
export class TemplateAccessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TemplateAccessError"
  }
}

// Out-of-org template: the owning org likely restricts third-party apps, but a
// 403 has other causes (per-user OAuth grant, SSO, scope), so GitHub's message
// is appended rather than asserting one cause.
export function outOfOrgTemplateError(
  templateOwner: string,
  templateRepo: string,
  status: number,
  githubMessage?: string,
): TemplateAccessError {
  const detail = githubMessage
    ? i18n.t("accept.templateErrors.githubSaid", { message: githubMessage })
    : ""
  return new TemplateAccessError(
    i18n.t("accept.templateErrors.outOfOrg", {
      owner: templateOwner,
      repo: templateRepo,
      status,
      detail,
    }),
  )
}

// In-org template: the classroom team likely lacks read on a private template.
export function inOrgTemplateError(
  templateOwner: string,
  templateRepo: string,
  status: number,
  githubMessage?: string,
): TemplateAccessError {
  const detail = githubMessage
    ? i18n.t("accept.templateErrors.githubSaid", { message: githubMessage })
    : ""
  return new TemplateAccessError(
    i18n.t("accept.templateErrors.inOrg", {
      owner: templateOwner,
      repo: templateRepo,
      status,
      detail,
    }),
  )
}
