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

// GitHub's drag-and-drop upload page for an assignment's bundle folder
// (`<classroom>/autograders/<slug>/`), where teacher-only test scripts and
// fixtures go. The upload page accepts a path that doesn't exist yet and
// creates it on commit, so this works before the folder has any files.
export const assignmentBundleUploadUrl = (
  org: string,
  classroom: string,
  slug: string,
): string =>
  `https://github.com/${encodeURIComponent(org)}/${CONFIG_REPO}/upload/${DEFAULT_BRANCH}/${encodeURIComponent(
    classroom,
  )}/autograders/${encodeURIComponent(slug)}`

// An assignment's starter-code (template) repo. Built from `template.owner`, not
// the classroom org — a template can live under a different owner. Deep-links to
// the stored branch when one is set.
export const githubTemplateRepoUrl = (
  owner: string,
  repo: string,
  branch?: string,
): string =>
  `https://github.com/${owner}/${repo}${branch ? `/tree/${branch}` : ""}`

// Deep-link to a repo's tree at a git ref (tag or commit sha), used by the
// submissions views to open a tag or commit. Each path segment is encoded
// separately so a slash-bearing tag (e.g. `submit/2026-...`) stays a real path
// while other metacharacters are escaped, then guarded through safeHttpUrl.
// Returns undefined when the inputs can't form a safe http(s) URL.
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

// A repo's commit page for a sha. Used to link a detected default-branch commit
// (every-push mode). safeHttpUrl-guarded; undefined on blank
// input.
export const repoCommitUrl = (
  org: string,
  repo: string,
  sha: string,
): string | undefined => {
  if (!org || !repo || !sha) return undefined
  return safeHttpUrl(
    `https://github.com/${encodeURIComponent(org)}/${encodeURIComponent(
      repo,
    )}/commit/${encodeURIComponent(sha)}`,
  )
}
