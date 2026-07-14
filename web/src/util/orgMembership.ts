// Email helpers shared by the CSV write path (students.ts) and the student
// org-membership flow (/onboard and accept pages). Survivors of the
// team-as-source-of-truth rework.

// Canonical form for email comparison. Lowercase + trim only: deliberately do
// NOT strip Gmail-style `+tags` or dots — those are provider-specific and would
// collapse genuinely distinct addresses onto one key.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

// Minimal email shape check. Deliberately permissive (GitHub validates at
// invite time); only catches obvious typos before committing.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email.trim())
}
