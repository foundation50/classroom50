// GitHub Pages helpers for STUDENT repos (the org config repo's own Pages site
// is handled by github-core/queries/pagesReads.ts). Pure: the URL derivation
// needs no API call, and the create-body mapper is the one place the
// assignments.json `pages` block turns into GitHub's POST /pages body.
import type { AssignmentPages } from "@/types/classroom"
import { CONFIG_REPO } from "./configRepo"

// The POST /repos/{owner}/{repo}/pages body. GitHub's two deploy models:
// `workflow` (a GitHub Actions workflow publishes; `source` is not sent) and
// `legacy` (GitHub publishes `source.branch` at `source.path`, which must be
// "/" or "/docs").
// https://docs.github.com/en/rest/pages/pages#create-a-github-pages-site
export type PagesCreateBody =
  | { build_type: "workflow" }
  | { build_type: "legacy"; source: { branch: string; path: "/" | "/docs" } }

// `defaultBranch` is the student repo's settled default branch, used when the
// assignment names none (the common case).
export function pagesCreateBody(
  pages: AssignmentPages,
  defaultBranch: string,
): PagesCreateBody {
  if (pages.source === "workflow") return { build_type: "workflow" }
  return {
    build_type: "legacy",
    source: { branch: pages.branch || defaultBranch, path: pages.path ?? "/" },
  }
}

// The github.io project-site URL GitHub assigns every repo. Always valid to
// show: on an org with a custom Pages domain github.io redirects to it.
export function defaultRepoPagesUrl(org: string, repo: string): string {
  return `https://${org.toLowerCase()}.github.io/${repo.toLowerCase()}/`
}

// The URL a student repo's site is served at when the org has a custom Pages
// domain, or null when none applies. Project sites inherit an ORG-ROOT custom
// domain (the `https://<host>/classroom50` layout of classroom.pages_base_url:
// the org's user site carries the CNAME, so `<host>/<repo>/` serves every repo);
// a CNAME on the classroom50 repo alone (`https://<host>` layout) covers only
// that repo, so nothing is derived.
export function customRepoPagesUrl(
  pagesBaseUrl: string | undefined,
  repo: string,
): string | null {
  if (!pagesBaseUrl) return null
  let url: URL
  try {
    url = new URL(pagesBaseUrl)
  } catch {
    return null
  }
  if (url.protocol !== "https:" || url.pathname !== `/${CONFIG_REPO}`) {
    return null
  }
  return `https://${url.host}/${repo.toLowerCase()}/`
}

// Both URLs worth showing for a student repo's site: the github.io default
// first, then the custom-domain one when the classroom has an org-root custom
// Pages domain.
export function studentRepoPagesUrls(
  org: string,
  repo: string,
  pagesBaseUrl?: string,
): string[] {
  const urls = [defaultRepoPagesUrl(org, repo)]
  const custom = customRepoPagesUrl(pagesBaseUrl, repo)
  if (custom) urls.push(custom)
  return urls
}
