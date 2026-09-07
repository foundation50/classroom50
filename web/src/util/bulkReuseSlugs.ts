import { nextAvailableSlug, slugify } from "@/util/slug"
import { assignmentSlugBudget } from "@/util/repoNameBudget"
import type { Assignment } from "@/types/classroom"

// The one slug rule for reuse, single or bulk: slugify, auto-suffix past the
// target's taken and reserved (`renamed_from`) slugs, respect the target's
// repo-name budget. useReuseAssignment plans one source through it; the bulk
// modal plans the selection, where rows also resolve against each other.
// The view owns the edit state and wording.

export type BulkReuseSlugIssue =
  | "empty"
  | "overBudget"
  // Already an assignment in the target.
  | "taken"
  // A pre-rename slug the target still reserves.
  | "reserved"
  // Another row in this run already claims it.
  | "duplicate"

export type BulkReuseSlugRow = {
  source: Assignment
  // What the input shows: raw text once edited, else the auto-resolved slug.
  value: string
  // slugify(value): what would be written.
  targetSlug: string
  edited: boolean
  issue: BulkReuseSlugIssue | null
}

export type BulkReuseSlugPlan = {
  rows: BulkReuseSlugRow[]
  budget: number
  valid: boolean
}

export function planBulkReuseSlugs({
  sources,
  targetClassroom,
  takenSlugs,
  reservedSlugs,
  edits,
}: {
  sources: Assignment[]
  targetClassroom: string
  // Existing slugs in the target.
  takenSlugs: readonly string[]
  // Pre-rename slugs the target still reserves (renamedFromSlugs).
  reservedSlugs: readonly string[]
  // Raw input text by source slug, for the rows the teacher has edited.
  edits: Readonly<Record<string, string>>
}): BulkReuseSlugPlan {
  const budget = assignmentSlugBudget(targetClassroom)
  const taken = new Set(takenSlugs.map((s) => s.trim().toLowerCase()))
  const reserved = new Set(reservedSlugs.map((s) => s.trim().toLowerCase()))
  // Grows as rows resolve, so two copies in one run can't land on one slug.
  const unavailable = new Set([...taken, ...reserved])

  const rows = sources.map((source): BulkReuseSlugRow => {
    // hasOwn, not `in`: a slug such as "constructor" is a prototype key.
    const edited = Object.hasOwn(edits, source.slug)
    const value = edited
      ? edits[source.slug]
      : nextAvailableSlug(slugify(source.slug), unavailable, budget)
    const targetSlug = slugify(value)
    const lower = targetSlug.toLowerCase()
    const issue = classifySlug(targetSlug, lower, {
      budget,
      taken,
      reserved,
      unavailable,
    })
    // An invalid row still claims its slug, or a later row could take it too.
    if (lower) unavailable.add(lower)
    return { source, value, targetSlug, edited, issue }
  })

  return { rows, budget, valid: rows.every((r) => r.issue === null) }
}

function classifySlug(
  targetSlug: string,
  lower: string,
  sets: {
    budget: number
    taken: ReadonlySet<string>
    reserved: ReadonlySet<string>
    unavailable: ReadonlySet<string>
  },
): BulkReuseSlugIssue | null {
  // A budget under 2 means the classroom name eats it all: nothing can fit.
  if (!targetSlug) return sets.budget < 2 ? "overBudget" : "empty"
  if (targetSlug.length > sets.budget) return "overBudget"
  if (sets.taken.has(lower)) return "taken"
  if (sets.reserved.has(lower)) return "reserved"
  if (sets.unavailable.has(lower)) return "duplicate"
  return null
}
