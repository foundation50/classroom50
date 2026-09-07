import { nextAvailableSlug, slugify } from "@/util/slug"
import { assignmentSlugBudget } from "@/util/repoNameBudget"
import { renamedFromSlugs, type Assignment } from "@/types/classroom"

// Slug planning for bulk reuse: one target slug per selected assignment,
// resolved against the target classroom and against the other copies in the
// same run. Same rule as useReuseAssignment's autoSlug (slugify, dodge the
// reserved `renamed_from` slugs, respect the target's repo-name budget), with
// the view owning the edit state and wording.

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
  targetAssignments,
  edits,
}: {
  sources: Assignment[]
  targetClassroom: string
  targetAssignments: Assignment[]
  // Raw input text by source slug, for the rows the teacher has edited.
  edits: Readonly<Record<string, string>>
}): BulkReuseSlugPlan {
  const budget = assignmentSlugBudget(targetClassroom)
  const taken = new Set(
    targetAssignments.map((a) => a.slug.trim().toLowerCase()),
  )
  const reserved = new Set(
    renamedFromSlugs(targetAssignments).map((s) => s.trim().toLowerCase()),
  )
  // Grows as rows resolve, so two copies in one run can't land on one slug.
  const unavailable = new Set([...taken, ...reserved])

  const rows = sources.map((source): BulkReuseSlugRow => {
    const edited = source.slug in edits
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
