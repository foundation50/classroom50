// Context-relevant github.com deep-links for an org login, built here rather
// than inline so the heading/subtitle links stay consistent across pages.
export const githubOrgUrl = (org: string): string =>
  `https://github.com/orgs/${org}/repositories`

export const githubOrgPeopleUrl = (org: string): string =>
  `https://github.com/orgs/${org}/people`

export const githubOrgSettingsUrl = (org: string): string =>
  `https://github.com/organizations/${org}/settings/profile`
