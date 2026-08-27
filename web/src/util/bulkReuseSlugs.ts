import { nextAvailableSlug, slugify } from "@/util/slug"
import { assignmentSlugBudget } from "@/util/repoNameBudget"
import { renamedFromSlugs, type Assignment } from "@/types/classroom"

// Slug planning for bulk reuse: one target slug per selected assignment,
// resolved against the target classroom AND against the other copies in the
// same run. The single-assignment reuse lets the teacher see and edit the slug
// before copying; this is that same field, once per selection, so a run into a
// classroom that already holds "hw1" shows "hw1-2" up front instead of
// reporting it afterwards.
//
// Pure and view-free: the modal owns the edit state and the wording, this owns
// the rule. Same rule as useReuseAssignment's autoSlug — slugify, dodge the
// reserved `renamed_from` slugs (taking one would sever GitHub's redirects for
// renamed student repos), and respect the TARGET classroom's repo-name budget
// (#691).

// Why a row can't be copied as it stands. Null means the slug is usable.
export type BulkReuseSlugIssue =
  // Emptied by hand, or slugified down to nothing.
  | "empty"
  // Longer than the target classroom's remaining repo-name budget.
  | "overBudget"
  // Already an assignment in the target.
  | "taken"
  // A pre-rename slug the target still reserves.
  | "reserved"
  // Another row in THIS run already claims it.
  | "duplicate"

export type BulkReuseSlugRow = {
  source: Assignment
  // What the input shows: the teacher's raw text once edited, else the
  // auto-resolved slug.
  value: string
  // What would actually be written (slugify(value)).
  targetSlug: string
  edited: boolean
  issue: BulkReuseSlugIssue | null
}

export type BulkReuseSlugPlan = {
  rows: BulkReuseSlugRow[]
  // The target classroom's slug budget, for the over-budget message.
  budget: number
  // Every row carries a usable slug, so the run can start.
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
  // The target's existing assignments — their slugs and the `renamed_from`
  // slugs they still reserve.
  targetAssignments: Assignment[]
  // Raw input text by SOURCE slug, for the rows the teacher has edited.
  edits: Readonly<Record<string, string>>
}): BulkReuseSlugPlan {
  const budget = assignmentSlugBudget(targetClassroom)
  const taken = new Set(
    targetAssignments.map((a) => a.slug.trim().toLowerCase()),
  )
  const reserved = new Set(
    renamedFromSlugs(targetAssignments).map((s) => s.trim().toLowerCase()),
  )
  // Everything a new copy may NOT take, growing as rows resolve so two copies
  // in one run can't land on one slug — neither auto-resolved (nextAvailableSlug
  // sees the earlier ones) nor typed (the duplicate shows on the later row).
  // One set rather than three spread into a fresh array per row: this runs on
  // every keystroke in every slug field.
  const unavailable = new Set([...taken, ...reserved])

  const rows = sources.map((source): BulkReuseSlugRow => {
    const edited = source.slug in edits
    const value = edited
      ? edits[source.slug]
      : // An edited row upstream is already in `unavailable`, so the
        // auto-resolved slugs step around what the teacher typed.
        nextAvailableSlug(slugify(source.slug), unavailable, budget)
    const targetSlug = slugify(value)
    const lower = targetSlug.toLowerCase()
    const issue = classify()
    // An invalid row still claims its slug: submit is blocked anyway, and
    // leaving it unclaimed would let a later row silently take the same one.
    if (lower) unavailable.add(lower)
    return { source, value, targetSlug, edited, issue }

    // Declared here so the row's own inputs stay in scope; it reads only
    // `targetSlug`, `lower` and the sets above.
    function classify(): BulkReuseSlugIssue | null {
      // No slug at all: either the classroom name eats the whole budget (a
      // legacy over-long classroom — nothing the teacher can type will fit,
      // which reuseSlugStatus words for itself from the budget), or the field
      // is simply empty and wants one.
      if (!targetSlug) return budget < 2 ? "overBudget" : "empty"
      if (targetSlug.length > budget) return "overBudget"
      if (taken.has(lower)) return "taken"
      if (reserved.has(lower)) return "reserved"
      // Neither the target's nor a reservation's, so an earlier row's.
      if (unavailable.has(lower)) return "duplicate"
      return null
    }
  })

  return { rows, budget, valid: rows.every((r) => r.issue === null) }
}
