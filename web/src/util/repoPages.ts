// GitHub Pages helpers for STUDENT repos (the org config repo's own Pages site
// is handled by github-core/queries/pagesReads.ts). Pure: the URL derivation
// needs no API call, and the create-body mapper is the one place the
// assignments.json `pages` block turns into GitHub's POST /pages body.
import type { AssignmentPages } from "@/types/classroom"

// The POST /repos/{owner}/{repo}/pages body. GitHub's two deploy models:
// `workflow` (a GitHub Actions workflow publishes; `source` is not sent) and
// `legacy` (GitHub publishes `source.branch` at `source.path`, which must be
// "/" or "/docs").
// https://docs.github.com/en/rest/pages/pages#create-a-github-pages-site
export type PagesCreateBody =
  | { build_type: "workflow" }
  | { build_type: "legacy"; source: { branch: string; path: "/" | "/docs" } }

// `defaultBranch` is the student repo's settled default branch, used when the
// assignment names none (the common case). Returns null for a source this
// release does not know (a newer writer's value): the caller skips the POST
// rather than guess a deploy model, so the two accept clients never configure
// different sites for the same entry (the Go mapper fails closed the same way).
export function pagesCreateBody(
  pages: AssignmentPages,
  defaultBranch: string,
): PagesCreateBody | null {
  switch (pages.source) {
    case "workflow":
      return { build_type: "workflow" }
    case "branch":
      return {
        build_type: "legacy",
        source: {
          branch: pages.branch || defaultBranch,
          path: pages.path ?? "/",
        },
      }
    default:
      return null
  }
}

// The github.io project-site URL GitHub assigns every repo. Always valid to
// show: on an org with a custom Pages domain github.io redirects to it.
export function defaultRepoPagesUrl(org: string, repo: string): string {
  return `https://${org.toLowerCase()}.github.io/${repo.toLowerCase()}/`
}
