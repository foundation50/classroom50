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

// The fixed segment in a team-mode assignment repo name
// `<classroom>-<assignment>-group-<n>`. It occupies the username position of
// the individual formula, so parsers must stay MODE-GATED: `group-3` is a
// syntactically valid GitHub login, and only the assignment's mode — never
// the shape — decides which parse applies. Byte-mirror of
// contract.GroupRepoSegment.
export const GROUP_REPO_SEGMENT = "group-"

// The canonical team-mode assignment repo name
// `<classroom>-<assignment>-group-<n>` — the individual formula with the team
// counter in the owner position. The counter maps it back to the group team
// (groupTeamName) by pure function; the authoritative repo<->team link is the
// team->repo attachment, so this name is display/search convention, not the
// binding. Byte-mirror of contract.GroupRepoName.
export const groupRepoName = (
  classroom: string,
  assignment: string,
  n: number,
): string =>
  studentRepoName(classroom, assignment, `${GROUP_REPO_SEGMENT}${n}`)

// Recover the counter from a team-mode repo name for a KNOWN
// classroom+assignment, or null when the name isn't that assignment's
// team-repo shape (counters start at 1, no leading zeros). MODE-GATED by the
// caller — never a shape guess on legacy repos. Byte-mirror of
// contract.ParseGroupRepoCounter.
export const parseGroupRepoCounter = (
  repo: string,
  classroom: string,
  assignment: string,
): number | null => {
  const prefix = `${studentRepoName(classroom, assignment, GROUP_REPO_SEGMENT)}`
  const lowered = repo.toLowerCase()
  if (!lowered.startsWith(prefix)) return null
  const rest = lowered.slice(prefix.length)
  if (!/^[1-9][0-9]*$/.test(rest)) return null
  return Number(rest)
}
