// Student/group repo name: the cross-binary formula `<classroom>-<assignment>-
// <owner>` (lowercased), same as the CLI and `gh student accept`. `owner` is
// the repo-name component (student or group owner), so the name is stable
// regardless of who pushed last. Single source of truth shared with the Go CLI.
export const studentRepoName = (
  classroom: string,
  assignment: string,
  owner: string,
): string => `${classroom}-${assignment}-${owner}`.toLowerCase()

export const studentRepoUrl = (
  org: string,
  classroom: string,
  assignment: string,
  owner: string,
): string =>
  `https://github.com/${org}/${studentRepoName(classroom, assignment, owner)}`
