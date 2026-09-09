// GitHub Pages helpers for STUDENT repos; the org config repo's own site lives
// in github-core/queries/pagesReads.ts. The body mapper is the one place the
// assignments.json `pages` block becomes GitHub's POST /pages body.
import type { AssignmentPages } from "@/types/classroom"

// The POST /repos/{owner}/{repo}/pages body: `workflow` (a GitHub Actions
// workflow publishes; no `source`) or `legacy` (GitHub publishes
// `source.branch` at `source.path`, "/" or "/docs").
// https://docs.github.com/en/rest/pages/pages#create-a-github-pages-site
export type PagesCreateBody =
  | { build_type: "workflow" }
  | { build_type: "legacy"; source: { branch: string; path: "/" | "/docs" } }

// `defaultBranch` fills an unnamed branch. Returns null for a source this
// release does not know (a newer writer's value) so the caller skips the POST
// instead of guessing a deploy model; the Go mapper fails closed the same way,
// so both accept clients agree.
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

// The github.io project-site URL every repo gets. Safe to show even on an org
// with a custom Pages domain: github.io redirects there.
export function defaultRepoPagesUrl(org: string, repo: string): string {
  return `https://${org.toLowerCase()}.github.io/${repo.toLowerCase()}/`
}
