import {
  describeLocalizedMessage,
  type LocalizedMessage,
} from "@/types/localizedMessage"

// An accept-time failure that needs teacher action (not a retry the student can
// do). `localized` names the full remedy the accept page renders; `localizedStep`
// is a one-sentence form for the progress checklist row, which sits beside six
// other rows and can't absorb a paragraph. `Error.message` stays populated with a
// diagnostic (never-rendered) form so logs and githubHealthStore keep working.
export class TemplateAccessError extends Error {
  localized: LocalizedMessage
  localizedStep: LocalizedMessage

  constructor(localized: LocalizedMessage, localizedStep?: LocalizedMessage) {
    super(describeLocalizedMessage(localized))
    this.name = "TemplateAccessError"
    this.localized = localized
    this.localizedStep = localizedStep ?? localized
  }
}

// GitHub's own words, quoted into a remedy. Not translatable (it's GitHub's
// English), so it nests as a param rather than being assembled here.
function githubSaid(githubMessage?: string): LocalizedMessage | string {
  return githubMessage
    ? {
        key: "accept.templateErrors.githubSaid",
        params: { message: githubMessage },
      }
    : ""
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
  return new TemplateAccessError({
    key: "accept.templateErrors.outOfOrg",
    params: {
      owner: templateOwner,
      repo: templateRepo,
      status,
      detail: githubSaid(githubMessage),
    },
  })
}

// In-org template: the classroom team likely lacks read on a private template.
export function inOrgTemplateError(
  templateOwner: string,
  templateRepo: string,
  status: number,
  githubMessage?: string,
): TemplateAccessError {
  return new TemplateAccessError({
    key: "accept.templateErrors.inOrg",
    params: {
      owner: templateOwner,
      repo: templateRepo,
      status,
      detail: githubSaid(githubMessage),
    },
  })
}
