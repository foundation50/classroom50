// Context-relevant github.com deep-links for an org login, built here rather
// than inline so the heading/subtitle links stay consistent across pages.
import { CONFIG_REPO, DEFAULT_BRANCH } from "@/util/configRepo"

export const githubOrgUrl = (org: string): string =>
  `https://github.com/orgs/${org}/repositories`

export const githubOrgPeopleUrl = (org: string): string =>
  `https://github.com/orgs/${org}/people`

export const githubOrgSettingsUrl = (org: string): string =>
  `https://github.com/organizations/${org}/settings/profile`

export const githubOrgActionsSettingsUrl = (org: string): string =>
  `https://github.com/organizations/${org}/settings/actions`

// The private config repo's directory for a classroom slug.
export const classroomConfigTreeUrl = (org: string, slug: string): string =>
  `https://github.com/${org}/${CONFIG_REPO}/tree/${DEFAULT_BRANCH}/${slug}`

// An assignment's starter-code (template) repo. Built from `template.owner`, not
// the classroom org — a template can live under a different owner. Deep-links to
// the stored branch when one is set.
export const githubTemplateRepoUrl = (
  owner: string,
  repo: string,
  branch?: string,
): string =>
  `https://github.com/${owner}/${repo}${branch ? `/tree/${branch}` : ""}`
