import type { GitHubRepo } from "@/github-core/types"

// Which repos in the org belong to an assignment — the shared selection rule for
// every signal derived from the org repo list. Extracted so two readers can't
// drift on an assignment's repo set (notably the sibling-slug guard, without
// which `hw1` silently absorbs `hw1-bonus`'s repos).
//
// Note what this deliberately does NOT do: it is not a submission signal. A repo
// exists from ACCEPT time (with the tool's own Feedback-PR commit), so repo
// presence and `pushed_at` cannot distinguish a student who submitted from one
// who only accepted. Submission counts come from collected detection
// (scores.json's `detected` list, written by collect_scores.py) or the
// submissions page's own commit/tag detection.

/**
 * The assignment repos that exist in the org, by repo name. Individual and group
 * repos share the `<classroom>-<assignment>-` prefix; a sibling assignment whose
 * slug extends this one (`hw1-bonus` under `hw1`) is excluded, the same guard
 * existingGroupRepos applies. `siblingSlugs` is the other assignment slugs in
 * the classroom. Shared by every repo-list-derived signal (presence counts and
 * latestAssignmentPush) so they can't disagree on an assignment's repo set.
 */
export function existingAssignmentRepos(
  repos: GitHubRepo[] | null | undefined,
  classroom: string,
  assignment: string,
  siblingSlugs: string[] = [],
): GitHubRepo[] {
  if (!repos) return []
  const prefix = `${classroom}-${assignment}-`.toLowerCase()
  const overlapPrefixes = siblingSlugs
    .map((slug) => slug.toLowerCase())
    .filter((slug) => slug !== assignment.toLowerCase())
    .map((slug) => `${classroom}-${slug}-`.toLowerCase())
    .filter((siblingPrefix) => siblingPrefix.startsWith(prefix))

  return repos.filter((repo) => {
    const name = repo.name.toLowerCase()
    if (!name.startsWith(prefix)) return false
    if (overlapPrefixes.some((sibling) => name.startsWith(sibling)))
      return false
    // A bare prefix with no owner segment is not a student/group repo.
    return name.slice(prefix.length).length > 0
  })
}
