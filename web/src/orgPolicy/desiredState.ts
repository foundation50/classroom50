// Web mirror of the CLI's org-policy desired-state seam
// (classroom50-cli/cli/gh-teacher/internal/orgpolicy/orgpolicy.go).
//
// Single source of truth for the org member-default lockdown the GUI enforces
// and audits. Must stay a 1:1 mirror of the CLI's
// allMemberDefaultSettings()/MemberDefaultSettings()/ClassifyDefaults() — a
// divergence here is a parity bug.

export type MemberDefaultValue = boolean | string

export type MemberDefaultSetting = {
  field: string
  value: MemberDefaultValue
  desc: string
  manualFix: string
  critical: boolean
  enterpriseOnly: boolean
}

// The 16 member-default fields, in the CLI's order. Criticality and
// enterprise-only flags mirror the CLI: critical marks lockdown fields whose
// absence re-opens the org-wide repo-admin danger; enterprise-only fields have
// no member-privileges toggle on Team/Free, so init skips them there.
const ALL_MEMBER_DEFAULT_SETTINGS: readonly MemberDefaultSetting[] = [
  {
    field: "default_repository_permission",
    value: "none",
    desc: 'base repository permission "none"',
    manualFix: 'set "Base permissions" to "No permission"',
    critical: true,
    enterpriseOnly: false,
  },
  {
    // Master repo-creation switch. On Team/Free the granular public/private
    // booleans are slaved to it (true => both on, false => both off), so it
    // must be true for the student flow to create private repos.
    field: "members_can_create_repositories",
    value: true,
    desc: "member repo creation enabled",
    manualFix:
      'under "Repository creation", allow members to create repositories',
    critical: true,
    enterpriseOnly: false,
  },
  {
    field: "members_can_create_private_repositories",
    value: true,
    desc: "private repo creation enabled",
    manualFix:
      'under "Repository creation", check "Private" — without it, gh student accept can\'t create student repos',
    critical: false,
    enterpriseOnly: false,
  },
  {
    field: "members_can_create_public_repositories",
    value: false,
    desc: "public repo creation disabled",
    manualFix:
      'under "Repository creation", restrict members to private repositories only (GitHub Enterprise Cloud only)',
    critical: true,
    enterpriseOnly: true,
  },
  {
    field: "members_can_create_internal_repositories",
    value: false,
    desc: "internal repo creation disabled",
    manualFix:
      'under "Repository creation", uncheck "Internal" if your plan offers it',
    critical: true,
    enterpriseOnly: true,
  },
  {
    // Enforced TRUE: the classroom50 config repo publishes a public Pages site.
    field: "members_can_create_pages",
    value: true,
    desc: "Pages creation enabled (required for the public config-repo site)",
    manualFix: 'check "Allow members to publish Pages sites"',
    critical: false,
    enterpriseOnly: false,
  },
  {
    // Enforced TRUE for the same reason: the config-repo Pages site must be able
    // to publish publicly.
    field: "members_can_create_public_pages",
    value: true,
    desc: "public Pages creation enabled (required for the public config-repo site)",
    manualFix: 'under "Pages creation", select "Public"',
    critical: false,
    enterpriseOnly: false,
  },
  {
    field: "members_can_create_private_pages",
    value: false,
    desc: "private Pages creation disabled",
    manualFix: 'under "Pages creation", deselect "Private"',
    critical: true,
    enterpriseOnly: false,
  },
  {
    field: "members_can_delete_repositories",
    value: false,
    desc: "member repo deletion/transfer disabled",
    manualFix:
      'uncheck "Allow members to delete or transfer repositories for this organization"',
    critical: true,
    enterpriseOnly: false,
  },
  {
    field: "members_can_change_repo_visibility",
    value: false,
    desc: "member repo visibility change disabled",
    manualFix:
      'uncheck "Allow members to change repository visibilities for this organization"',
    critical: true,
    enterpriseOnly: false,
  },
  {
    field: "members_can_delete_issues",
    value: false,
    desc: "member issue deletion disabled",
    manualFix: 'uncheck "Allow members to delete issues for this organization"',
    critical: true,
    enterpriseOnly: false,
  },
  {
    field: "readers_can_create_discussions",
    value: false,
    desc: "discussion creation by read-access members disabled",
    manualFix: 'uncheck "Allow users with read access to create discussions"',
    critical: true,
    enterpriseOnly: false,
  },
  {
    field: "members_can_create_teams",
    value: false,
    desc: "member team creation disabled",
    manualFix: 'uncheck "Allow members to create teams"',
    critical: true,
    enterpriseOnly: false,
  },
  {
    field: "members_can_view_dependency_insights",
    value: false,
    desc: "member dependency-insights viewing disabled",
    manualFix: 'uncheck "Allow members to view dependency insights"',
    critical: true,
    enterpriseOnly: true,
  },
  {
    field: "members_can_fork_private_repositories",
    value: false,
    desc: "forking of private repos disabled",
    manualFix: 'uncheck "Allow forking of private repositories"',
    critical: true,
    enterpriseOnly: false,
  },
  {
    field: "members_can_invite_outside_collaborators",
    value: false,
    desc: "member-invited outside collaborators disabled",
    manualFix:
      'uncheck "Allow members to invite outside collaborators to repositories for this organization"',
    critical: true,
    enterpriseOnly: true,
  },
]

// memberDefaultSettings returns the in-scope settings for a plan. Only
// "enterprise" gets all 16; every other plan (team/free/unknown) is treated as
// non-enterprise and the 4 enterprise-only fields are filtered out, leaving 12.
export function memberDefaultSettings(
  plan: string | undefined,
): MemberDefaultSetting[] {
  if (plan === "enterprise") {
    return [...ALL_MEMBER_DEFAULT_SETTINGS]
  }
  return ALL_MEMBER_DEFAULT_SETTINGS.filter((s) => !s.enterpriseOnly)
}

export type DefaultVerdict = {
  setting: MemberDefaultSetting
  enforced: boolean
}

export type ClassifyResult = {
  verdicts: DefaultVerdict[]
  criticalMissed: boolean
}

// classifyDefaults compares each in-scope (plan-filtered) setting against the
// live GET /orgs/{org} values, reporting per-setting whether it's enforced and
// whether any critical setting is unenforced. Single source of truth for
// interpreting an org response — shared by the settings page and the audit.
export function classifyDefaults(
  live: Record<string, unknown>,
  plan: string | undefined,
): ClassifyResult {
  const settings = memberDefaultSettings(plan)
  const verdicts: DefaultVerdict[] = []
  let criticalMissed = false
  for (const setting of settings) {
    const enforced = live[setting.field] === setting.value
    verdicts.push({ setting, enforced })
    if (!enforced && setting.critical) {
      criticalMissed = true
    }
  }
  return { verdicts, criticalMissed }
}

export type ManualStep = {
  setting: string
  url: string
}

// The org member-privileges settings page — where a teacher inspects/sets the
// member-default lockdown by hand. Shared so desired state, audit, and deep
// links can't drift on the path.
export function memberPrivilegesUrl(org: string): string {
  return `https://github.com/organizations/${org}/settings/member_privileges`
}

// manualHardeningSteps is the canonical list of the four member-privilege
// settings with no REST API — applied by hand, all on the org
// member-privileges settings page.
export function manualHardeningSteps(org: string): ManualStep[] {
  const url = memberPrivilegesUrl(org)
  return [
    {
      setting:
        'Set "App access requests" to "Members only" (or "Disable app access requests")',
      url,
    },
    {
      setting:
        'Uncheck "Allow repository admins to install GitHub Apps for their repositories" (under "GitHub Apps")',
      url,
    },
    { setting: 'Set "Projects base permissions" to "No access"', url },
    {
      setting:
        'Uncheck "Allow repository administrators to rename branches protected by organization rules" (under "Branch renames")',
      url,
    },
  ]
}
