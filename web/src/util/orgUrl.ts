// Context-relevant github.com deep-links for an org login, built here rather
// than inline so the heading/subtitle links stay consistent across pages.
import { CONFIG_REPO, DEFAULT_BRANCH } from "@/util/configRepo"
import { safeHttpUrl } from "@/util/url"

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

// Deep-link to a repo's tree at a git ref (a tag or a commit sha) — the code
// state at that ref, used by the submissions views to open a tag or commit.
// The ref is a tag name or sha built from GitHub data or a validated
// submission_tags pattern; each path segment is encoded so a slash-bearing tag
// (e.g. `submit/2026-...`) stays a real path while other metacharacters are
// escaped, and the result is guarded through safeHttpUrl. Returns undefined
// when the inputs can't form a safe http(s) URL, so callers can omit the link.
export const repoTreeAtRefUrl = (
  org: string,
  repo: string,
  ref: string,
): string | undefined => {
  if (!org || !repo || !ref) return undefined
  const encodedRef = ref
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
  return safeHttpUrl(
    `https://github.com/${encodeURIComponent(org)}/${encodeURIComponent(
      repo,
    )}/tree/${encodedRef}`,
  )
}

// The repo's tags listing page. Used as the "no submissions yet" destination
// for a tag-mode assignment (there is no single tag to open, so point at where
// tags will appear). safeHttpUrl-guarded; undefined on blank input.
export const repoTagsUrl = (org: string, repo: string): string | undefined => {
  if (!org || !repo) return undefined
  return safeHttpUrl(
    `https://github.com/${encodeURIComponent(org)}/${encodeURIComponent(
      repo,
    )}/tags`,
  )
}
