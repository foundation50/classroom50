import type { GitHubRepo } from "@/github-core/types"

// Repo-existence presence for an assignment, read from the already-loaded org
// repo list. This is the ONLY submission-adjacent signal that list-level screens
// can derive without a per-repo fan-out, and it deliberately answers a narrower
// question than the submissions page does: "do repos exist for this assignment?",
// not "who submitted?".
//
// Why not a submitted count here (issue #659): a no_autograder repo is created
// at ACCEPT time and the tool immediately writes the Feedback-PR commit, so
// `pushed_at` is set before the student does anything. Counting pushes would
// report every student who merely accepted as a submitter, and in tag mode it
// would count a student who pushed but never tagged. The submissions page trims
// exactly those cases (submissionCommits + detectTagSubmissions), so a
// push-derived count on a summary screen would contradict the page it links to.
// Presence routes the teacher to that authoritative count instead of competing
// with it.

/**
 * The assignment repos that exist in the org, by repo name. Individual and group
 * repos share the `<classroom>-<assignment>-` prefix; a sibling assignment whose
 * slug extends this one (`hw1-bonus` under `hw1`) is excluded, matching
 * latestAssignmentPush's guard. `siblingSlugs` is the other assignment slugs in
 * the classroom.
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

/**
 * How many repos exist for this assignment — the honest "accepted" count for a
 * summary screen. Never presented as a submission count; see the note above.
 */
export function assignmentRepoCount(
  repos: GitHubRepo[] | null | undefined,
  classroom: string,
  assignment: string,
  siblingSlugs: string[] = [],
): number {
  return existingAssignmentRepos(repos, classroom, assignment, siblingSlugs)
    .length
}
