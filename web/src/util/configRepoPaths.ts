// Per-classroom files inside the org's config repo. The filenames are
// byte-mirrors of cli/shared/contract (AssignmentsFilename, ClassroomFilename,
// ScoresFilename, TeamsFilename, RosterFilename): a cross-tool contract with no
// compile-time link across Go, Python and TypeScript, so keep them in lockstep.
// Pure and dependency-free so github-core/ and domain/ can both import downward.

export const ASSIGNMENTS_FILENAME = "assignments.json"
export const CLASSROOM_FILENAME = "classroom.json"
export const SCORES_FILENAME = "scores.json"
export const TEAMS_FILENAME = "teams.json"
export const ROSTER_FILENAME = "roster.csv"

export function assignmentsFilePath(classroom: string): string {
  return `${classroom}/${ASSIGNMENTS_FILENAME}`
}

export function classroomFilePath(classroom: string): string {
  return `${classroom}/${CLASSROOM_FILENAME}`
}

export function scoresFilePath(classroom: string): string {
  return `${classroom}/${SCORES_FILENAME}`
}

export function teamsFilePath(classroom: string): string {
  return `${classroom}/${TEAMS_FILENAME}`
}

export function rosterPath(classroom: string): string {
  return `${classroom}/${ROSTER_FILENAME}`
}
