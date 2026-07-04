// Email + team-slug helpers shared by the CSV write path (students.ts) and the
// student onboarding flow. (The self-report / onboarding-repo machinery and the
// email_hash/invite-token columns this file once also held were removed with
// the team-as-source-of-truth rework and the students.csv schema prune.)

// The classroom team slug a STUDENT derives (the authoritative slug is in the
// private classroom.json they can't read). Safe-degrade: on a slug collision the
// derived slug 404s and the membership read simply reports "not a member", so a
// miss never grants false access. The teacher side reads the real slug via
// resolveClassroomTeam.
export function classroomTeamSlugHeuristic(classroom: string): string {
  return `classroom50-${classroom}`
}

// Canonical form for email comparison. Lowercase + trim only: deliberately do
// NOT strip Gmail-style `+tags` or dots, since those are provider-specific and
// would collapse genuinely distinct addresses onto one key.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

// Minimal email shape check. Deliberately permissive (GitHub is the real
// validator at invite time); only catches obvious typos before committing.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email.trim())
}
