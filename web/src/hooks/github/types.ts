export type GitHubOrgMembership = {
  state: "active" | "pending"
  role: "admin" | "member"
  organization: {
    login: string
    id: number
    avatar_url: string
    html_url: string
    description: string
  }
}

// Shared by GET /orgs/{org}/invitations and /failed_invitations. failed_at /
// failed_reason are only set on the failed list. No invitee numeric id, so
// students match on login / email. id is needed to cancel (DELETE) before
// resend.
export type GitHubOrgInvitation = {
  id: number
  login: string | null
  email: string | null
  role: string
  created_at: string
  failed_at: string | null
  failed_reason: string | null
}

export type GitHubBranchRef = {
  ref: string
  node_id: string
  url: string
  object: {
    type: string
    sha: string
    url: string
  }
}

export type GitHubCommitRef = {
  sha: string
  tree: {
    sha: string
  }
}

export type GitHubCreateTree = {
  sha: string
}

// Response from POST /repos/{owner}/{repo}/git/blobs.
export type GitHubBlob = {
  sha: string
  url: string
}

export type GitHubCreateCommit = {
  sha: string
}

export type GitHubMoveBranch = {
  ref: string
  object: {
    sha: string
  }
}

export type GitHubRepo = {
  id: number
  name: string
  full_name: string
  private: boolean
  is_template?: boolean
  // True when the repo is a fork. A fork's `generate` (template copy) can fail
  // when its upstream/parent is private and inaccessible to the OAuth token, so
  // the template pre-flight warns on a private fork.
  fork?: boolean
  // Present on a fork: the immediate parent repo it was forked from. Used to
  // name the inaccessible upstream in the warning.
  parent?: {
    full_name: string
    private: boolean
  }
  default_branch: string
  visibility?: "public" | "private" | "internal"
  archived?: boolean
  // Last push to the repo; used to sort orgs by "last modified" on the home
  // page. GitHub returns both on GET /repos; typed optional as older callers
  // don't rely on them.
  pushed_at?: string
  updated_at?: string
  description?: string | null
  owner?: {
    login: string
    id: number
  }
  permissions?: {
    admin: boolean
    maintain?: boolean
    push: boolean
    triage?: boolean
    pull: boolean
  }
  ssh_url: string
  html_url: string
}

export type GitHubRelease = {
  id: number
  tag_name: string
  name: string | null
  html_url: string
  draft: boolean
  prerelease: boolean
  created_at: string
  published_at: string | null
}

export type GitHubUser = {
  login: string
  id: number
  avatar_url: string
  html_url: string
  name: string | null
  email: string | null
  bio: string | null
  permissions: {
    admin: boolean
    pull: boolean
    maintain: boolean
    push: boolean
  }
}

export type GitHubFileListing = {
  type: string
  name: string
  path: string
}

export type GitHubTeam = {
  id: number
  name: string
  slug: string
  privacy: "secret" | "closed"
  description: string | null
}

export type GitHubOrgDetails = {
  login: string
  id: number
  // `plan` is only returned by GET /orgs/{org} to org owners; a non-owner
  // member gets a response without it, so it's optional and read defensively.
  plan?: {
    name: string
    space: number
    filled_seats: number
    seats: number
  }
}

export type GitHubWorkflowRun = {
  id: number
  // Workflow display name; labels an unattributed run in the banner.
  name?: string
  // Workflow definition file path; maps a run to a workflow without the name.
  path?: string
  status:
    "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending"
  conclusion:
    | "success"
    | "failure"
    | "cancelled"
    | "skipped"
    | "timed_out"
    | "action_required"
    | "neutral"
    | "stale"
    | null
  created_at: string
  // When the run actually started (may lag created_at while queued).
  run_started_at?: string
  // Last-updated time; for a completed run, effectively the finish time (banner
  // elapsed duration).
  updated_at?: string
  // Head commit SHA; the banner matches a publish-pages run to a commit by this.
  head_sha?: string
  html_url: string
  event: string
  // Human title of the run (often the head commit subject). Present on the list
  // endpoint; used to label a run when the workflow file isn't mapped.
  display_title?: string
  // Who triggered the run (a teacher's token, or the Actions bot for cron). Used
  // for actor attribution in the activity timeline.
  triggering_actor?: {
    login: string
    avatar_url?: string
  }
}

// A commit from the REST list-commits endpoint
// (GET /repos/{owner}/{repo}/commits). Distinct from GitHubCommitRef (the
// git-data single-commit tree ref). Used by the org activity timeline to render
// classroom50 config-repo history as an audit log.
export type GitHubCommit = {
  sha: string
  html_url: string
  commit: {
    message: string
    author?: {
      name?: string
      date?: string
    }
  }
  // The GitHub account, when the commit author is a known user (null for a
  // workflow/bot-authored commit that isn't linked to an account).
  author: {
    login: string
    avatar_url?: string
  } | null
}
