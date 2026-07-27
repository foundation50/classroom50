// Email helpers shared by the CSV write path (students.ts) and the student
// org-membership flow (/onboard and accept pages). Survivors of the
// team-as-source-of-truth rework.

import { z } from "zod"

// Canonical form for email comparison. Lowercase + trim only: deliberately do
// NOT strip Gmail-style `+tags` or dots — those are provider-specific and would
// collapse genuinely distinct addresses onto one key.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

// Shape check delegated to zod's spec-aware email validator rather than a
// hand-rolled regex — a prior regex allowed commas (so a whole roster.csv row
// like `user,,,a@b.com,,id,role` parsed as one "email"). Still a shape check,
// not deliverability (GitHub validates at invite time); it just rejects
// non-addresses before we commit or preview them.
const EMAIL_SCHEMA = z.email()

export function isValidEmail(email: string): boolean {
  return EMAIL_SCHEMA.safeParse(email.trim()).success
}
