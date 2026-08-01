import { GitHubAPIError } from "@/github-core/errors"
import {
  describeLocalizedMessage,
  type LocalizedMessage,
} from "@/types/localizedMessage"

// An accept-time failure that needs teacher action (not a retry the student can
// do). Covers a template that can't be copied and a destination org that refuses
// the create — the class name predates the second case. `localized` names the
// full remedy the accept page renders; `localizedStep` is a one-sentence form for
// the progress checklist row, which sits beside six other rows and can't absorb a
// paragraph. `Error.message` stays populated with a diagnostic (never-rendered)
// form so logs and githubHealthStore keep working.
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

// In-org template that is a FORK of a repo in a DIFFERENT org. Generate copies
// the fork's own objects fine, so the 403 isn't the classroom org or a missing
// team grant — it's the PARENT org's OAuth-App-access restriction gating our
// token (issue #468). "Re-run setup" (the inOrg remedy) can never fix this, so
// name the parent org and its approval as the actual remedy. `localizedStep`
// keeps the checklist row to one sentence (no detail clause) since only the
// full `localized` remedy renders the GitHub detail.
export function forkParentRestrictedError(
  parentOwner: string,
  templateOwner: string,
  templateRepo: string,
  status: number,
  githubMessage?: string,
): TemplateAccessError {
  return new TemplateAccessError(
    {
      key: "accept.templateErrors.forkParentRestricted",
      params: {
        parentOwner,
        owner: templateOwner,
        repo: templateRepo,
        status,
        detail: githubSaid(githubMessage),
      },
    },
    {
      key: "accept.templateErrors.forkParentRestrictedStep",
      params: { parentOwner, status },
    },
  )
}

// The one 403 message GitHub was observed to return when the *destination* org
// refuses the create (issue #413). Matched as a substring, case-insensitively.
const ORG_REPO_CREATION_DENIED_SIGNATURE = "admin access to the organization"

// A 403 that is the destination org refusing to let a member create the repo.
//
// There is no structured signal for this refusal — unlike the SSO gate and the
// scope gap, which are header-derived — so the message text is the only
// discriminator available. Deliberately matches the single observed string: a
// speculative variant like "repository creation is disabled" most plausibly
// denotes an enterprise or ruleset block, which this error's remedy cannot fix,
// so matching it would be confidently wrong.
//
// The three exclusions matter as much as the match: each is also a 403 with its
// own, different remedy, and `isSsoRequired`/`isScopeGap` are header-derived and
// therefore definitive. Without them, an SSO-gated 403 that happened to carry
// this phrase would send a teacher to widen member privileges while the real gate
// stayed in place.
export function isOrgRepoCreationDenied(err: GitHubAPIError): boolean {
  if (!err.isForbidden) return false
  if (err.isRateLimited || err.isSsoRequired || err.isScopeGap) return false
  return err.message.toLowerCase().includes(ORG_REPO_CREATION_DENIED_SIGNATURE)
}

// The destination-org refusal (#413). `org` is the classroom org the repo was
// being created in, never the template owner, which is the misattribution the
// issue reports.
//
// `localized` is deliberately a diagnosis, not a how-to: a student can't change
// an org setting, so the remedy's detail (private-not-public, the enterprise
// override, the settings path) lives where a teacher can act on it, in
// OrgRepoCreationNotice and the Troubleshooting wiki. Short student copy also
// means a teacher reading a screenshot gets the cause immediately.
//
// GitHub's own words are the one thing NOT relayed to the student here (unlike
// the two template errors): "You need admin access to the organization" reads as
// "you, the student, lack admin", contradicting the diagnosis above. It still
// reaches `Error.message` through `describeLocalizedMessage`, so logs and the
// activity trail keep it for triage.
export function orgRepoCreationDeniedError(
  org: string,
  status: number,
  githubMessage?: string,
): TemplateAccessError {
  return new TemplateAccessError(
    {
      key: "accept.templateErrors.orgRepoCreationDenied",
      params: { org, status, detail: githubSaid(githubMessage) },
    },
    // The step key interpolates only org and status, so it must not carry the
    // detail clause: nothing would render it and the two keys' params would be
    // coupled.
    {
      key: "accept.templateErrors.orgRepoCreationDeniedStep",
      params: { org, status },
    },
  )
}
