// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). Maps GitHub Classroom source shapes
// into Classroom 50 shapes (short-name, assignment entry, migrated_from).
// Mirrors the CLI's migrate_translate.go.

import type { Assignment, DueMeta, MigratedFrom } from "@/types/classroom"
import { GROUP_SIZE_MAX, GROUP_SIZE_MIN } from "@/types/classroom"
import { localizedError } from "@/types/localizedMessage"
import {
  SHORT_NAME_PATTERN,
  SHORT_NAME_PATTERN_DESCRIPTION,
  assertValidShortName,
} from "@/util/shortName"
import { CLASSROOM_SHORT_NAME_MAX_LEN } from "@/util/repoNameBudget"
import type { ClassroomAssignmentDetail, ClassroomDetail } from "./types"

// The only migrated_from.source value today.
export const MIGRATE_SOURCE_GITHUB_CLASSROOM = "github_classroom"

// The universal autograde shim name — every migrated assignment gets this;
// autograding config is never migrated.
export const DEFAULT_AUTOGRADER_NAME = "default"

// Clamp a source `max_teams` into a valid Classroom 50 group size. A sane
// source value (GROUP_SIZE_MIN..MAX) is kept; anything missing/odd/out-of-range
// falls back to the cap so migration never fails on it (the teacher tightens
// later). Shared by the written entry and the confirm preview so the two can't
// drift.
export function clampMigratedGroupSize(maxTeams: number | null): number {
  return maxTeams != null &&
    maxTeams >= GROUP_SIZE_MIN &&
    maxTeams <= GROUP_SIZE_MAX
    ? maxTeams
    : GROUP_SIZE_MAX
}

// classroom-level migrated_from block for classroom.json. (The web Classroom
// type doesn't type this field, so it rides through as an extra key on write.)
export type ClassroomMigratedFrom = {
  source: string
  classroom_id: number
  original_name: string
  original_org_login: string
  url: string
  migrated_at: string
}

export function classroomMigratedFrom(
  detail: ClassroomDetail,
  migratedAt: Date,
): ClassroomMigratedFrom {
  return {
    source: MIGRATE_SOURCE_GITHUB_CLASSROOM,
    classroom_id: detail.id,
    original_name: detail.name,
    original_org_login: detail.organization.login,
    url: detail.url,
    migrated_at: migratedAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
  }
}

// Slugify a free-form classroom name into a valid short-name, or throw asking
// for an explicit one. lowercase -> non-alnum to '-' -> collapse -> trim ->
// truncate to 100 -> validate pattern AND canonical-team-slug. Mirrors the CLI's
// deriveShortName plus the up-front canonical-team-slug guard.
export function deriveShortName(rawName: string): string {
  const lowered = rawName.trim().toLowerCase()
  if (!lowered) {
    throw localizedError({ key: "migration.error.classroomNameEmpty" })
  }
  let slug = lowered.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  // Truncate to the creation cap (not the pattern's 100) so a migrated
  // classroom keeps a workable assignment-slug budget (#691). Mirrors the
  // CLI's deriveShortName.
  if (slug.length > CLASSROOM_SHORT_NAME_MAX_LEN) {
    slug = slug.slice(0, CLASSROOM_SHORT_NAME_MAX_LEN).replace(/-+$/g, "")
  }
  assertValidShortName(slug, rawName)
  return slug
}

// A deadline is kept only if it parses as RFC 3339 WITH an explicit offset
// (`Z` or ±HH:MM). A zone-less value has no knowable zone, so guessing UTC
// would shift the deadline — drop it. Returns the UTC instant + provenance, or
// null. Mirrors the CLI's ParseDueTime(hadOffset) gate with source "migrated".
export function migratedDueFields(
  deadline: string | null,
): { due: string; due_meta: DueMeta } | null {
  if (!deadline) return null
  const trimmed = deadline.trim()
  if (!trimmed) return null

  // Require an explicit offset: trailing Z, or ±HH:MM / ±HHMM after a time.
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(trimmed)
  if (!hasOffset) return null

  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) return null

  const offsetMatch = /(Z|[+-]\d{2}:?\d{2})$/.exec(trimmed)
  const offset = offsetMatch
    ? offsetMatch[1] === "Z"
      ? "+00:00"
      : normalizeOffset(offsetMatch[1])
    : "+00:00"

  return {
    due: parsed.toISOString().replace(/\.\d{3}Z$/, "Z"),
    due_meta: {
      input: trimmed,
      offset,
      source: "migrated",
    },
  }
}

// Normalize ±HHMM to ±HH:MM; leave an already-colon'd offset as-is.
function normalizeOffset(raw: string): string {
  if (raw.includes(":")) return raw
  return `${raw.slice(0, 3)}:${raw.slice(3)}`
}

// Map a source assignment + resolved target template into an on-disk Assignment
// entry with migrated_from provenance. `targetTemplate` is the post-copy repo,
// or null for a template-less import (the entry omits `template`, and students
// get a README-initialized repo with the autograding files on accept). The
// original source starter lives in migrated_from.starter_repo. Throws on an
// invalid slug/mode (the caller skips those before generating any repo).
export function assignmentToEntry(
  detail: ClassroomAssignmentDetail,
  classroomId: number,
  targetTemplate: { owner: string; repo: string; branch: string } | null,
  migratedAt: Date,
): Assignment {
  if (!detail.slug) {
    throw new Error(`Source assignment ${detail.id} has an empty slug.`)
  }
  if (!SHORT_NAME_PATTERN.test(detail.slug)) {
    throw new Error(
      `Source assignment ${detail.id} slug "${detail.slug}" is invalid — must be ${SHORT_NAME_PATTERN_DESCRIPTION}.`,
    )
  }
  if (detail.type !== "individual" && detail.type !== "group") {
    throw new Error(
      `Source assignment ${detail.id} ("${detail.slug}") has unknown type "${detail.type}" (must be individual or group).`,
    )
  }

  const migratedFrom: MigratedFrom = {
    source: MIGRATE_SOURCE_GITHUB_CLASSROOM,
    classroom_id: classroomId,
    assignment_id: detail.id,
    migrated_at: migratedAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...(detail.invite_link ? { invite_link: detail.invite_link } : {}),
    ...(detail.starter_code_repository?.full_name
      ? { starter_repo: detail.starter_code_repository.full_name }
      : {}),
  }

  const entry: Assignment = {
    slug: detail.slug,
    name: detail.title,
    ...(targetTemplate ? { template: targetTemplate } : {}),
    mode: detail.type,
    autograder: DEFAULT_AUTOGRADER_NAME,
    migrated_from: migratedFrom,
  }

  // Feedback PR: an absent `feedback_pr` reads as OFF (accept.ts checks `===
  // true`, matching the schema), so migrated assignments start with the Feedback
  // PR disabled — the teacher re-enables it in the assignment editor. This
  // mirrors the Go CLI migrate, which likewise never enables it. We still write
  // an explicit `false` when the source disabled it, to record the source's
  // intent in the entry; the enabled/absent cases both read OFF, so they're left
  // unwritten. Migration never enables it for a template-less import either —
  // the teacher opts in from the assignment editor.
  if (targetTemplate && detail.feedback_pull_requests_enabled === false) {
    entry.feedback_pr = false
  }

  const due = migratedDueFields(detail.deadline)
  if (due) {
    entry.due = due.due
    entry.due_meta = due.due_meta
  }

  if (detail.type === "group") {
    // Use the source max_teams when sane (2..cap); else fall back to the cap so
    // migration never fails on a missing/odd value (the teacher tightens later).
    entry.max_group_size = clampMigratedGroupSize(detail.max_teams)
  }

  return entry
}
