// Repo-name budget for the composed `<classroom>-<assignment>-<username>`
// student-repo name: GitHub caps a repo name at 100 characters and a login at
// 39, so the two slug segments share what's left. A byte-mirror of the CLI's
// cli/shared/contract (GitHubRepoNameMaxLen, GitHubLoginMaxLen,
// RepoNameSlugBudget, ClassroomShortNameMaxLen, AssignmentSlugBudget,
// ComposedRepoNameFits) — a cross-tool contract with no compile-time link, so
// keep in lockstep (pinned by the shared fixture in repoNameBudget.test.ts).

import { studentRepoName } from "@/util/studentRepo"

export const GITHUB_REPO_NAME_MAX_LEN = 100

// Worst-case `<username>` segment; a teacher can't control who enrolls.
export const GITHUB_LOGIN_MAX_LEN = 39

// What the classroom short-name and assignment slug may spend TOGETHER: the
// repo-name cap minus the worst-case login and the two joining hyphens.
export const REPO_NAME_SLUG_BUDGET =
  GITHUB_REPO_NAME_MAX_LEN - GITHUB_LOGIN_MAX_LEN - 2

// Write-time cap for a NEW classroom short-name, reserving a workable slug
// budget for every future assignment; existing classrooms up to the
// SHORT_NAME_PATTERN 100 stay readable.
export const CLASSROOM_SHORT_NAME_MAX_LEN = 40

// Characters remaining for an assignment slug in `classroom`; can be <= 0 for
// a pre-cap over-long classroom.
export function assignmentSlugBudget(classroom: string): number {
  return REPO_NAME_SLUG_BUDGET - classroom.length
}

// Whether the longest student-repo name a classroom+slug pair can produce
// (worst-case GITHUB_LOGIN_MAX_LEN username) fits GitHub's repo-name limit.
// Measured through studentRepoName so it can't drift from the real shape.
export function composedRepoNameFits(
  classroom: string,
  slug: string,
): { worstCase: number; fits: boolean } {
  const worstCase = studentRepoName(
    classroom,
    slug,
    "a".repeat(GITHUB_LOGIN_MAX_LEN),
  ).length
  return { worstCase, fits: worstCase <= GITHUB_REPO_NAME_MAX_LEN }
}
