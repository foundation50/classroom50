import type { GitHubClient } from "../client"
import type { GitHubTeam } from "../types"
import { getClassroomJson } from "../configRepoReads"
import { classroomTeamSlug } from "@/util/teamSlug"
import { isClassroomArchived } from "@/types/classroom"
import { marshalTeamDescription } from "@/util/teamDescription"

// The outcome of one reconcile touch, so the caller can decide whether to
// invalidate caches (the description was rewritten) or stay quiet.
export type TeamDescriptionReconcileResult =
  { changed: false } | { changed: true; slug: string }

// Wraps a failure reading the classroom.json source (the FIRST read in the
// reconcile). The backfill hook latches a team-read 404 as permanent (a wrong
// derived slug / deleted team never converges), but a classroom.json read can
// 404 transiently — a fresh config commit still propagating, a rate-limited
// contents read — so its failure must NOT latch: a later entry should retry.
// Rethrowing it as a non-GitHubAPIError keeps it out of the hook's
// `err instanceof GitHubAPIError && err.isNotFound` permanent branch.
export class ClassroomSourceReadError extends Error {
  readonly cause: unknown
  constructor(cause: unknown) {
    super("read classroom.json for team-description reconcile")
    this.name = "ClassroomSourceReadError"
    this.cause = cause
  }
}

// Backfill/reconcile the classroom50/team/v1 bootstrap record onto the SECRET
// student team's GitHub description, so a plain student can enumerate this
// classroom (and recover its capability secret) from GET /user/teams without
// config-repo access. The CLI writes this at classroom add/migrate; this is the
// web equivalent for GUI-created and pre-schema classrooms.
//
// Idempotent: reads classroom.json for the desired record, resolves the team by
// its authoritative slug (classroom.json `team.slug`, else the derived
// `classroom50-<short>`), and PATCHes `description` ONLY when it drifts. A
// classroom whose description already matches is a no-op (one team read). All
// calls are org-owner operations; the caller must gate on the viewer's teacher
// role. Writing to a `secret` team keeps the secret from leaking beyond members.
export async function reconcileStudentTeamDescription(
  client: GitHubClient,
  org: string,
  classroom: string,
): Promise<TeamDescriptionReconcileResult> {
  let current
  try {
    current = await getClassroomJson(client, { org, classroom })
  } catch (err) {
    // A classroom.json read miss is treated as transient (see
    // ClassroomSourceReadError) so the backfill hook retries on a later entry
    // rather than latching this classroom off for the whole mount.
    throw new ClassroomSourceReadError(err)
  }

  const desired = marshalTeamDescription({
    name: current.name,
    term: current.term,
    secret: current.secret,
    active: !isClassroomArchived(current),
  })

  // The persisted slug is authoritative (GitHub may re-slug on collision); fall
  // back to the derived slug for a classroom created before the team ref was
  // recorded.
  const slug = current.team?.slug || classroomTeamSlug(classroom)

  const existing = await client.request<GitHubTeam>(
    `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}`,
  )

  // Only ever write the bootstrap record (which may carry the capability secret)
  // onto a `secret` team, so it can't leak via a `closed` team's description.
  // A non-secret team is a misconfiguration the CLI's adopt path reconciles;
  // skip here rather than risk exposure (and don't spam a PATCH on re-entry).
  if (existing.privacy !== "secret") return { changed: false }

  if (existing.description === desired) return { changed: false }

  await client.request(
    `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(existing.slug)}`,
    {
      method: "PATCH",
      body: { description: desired },
    },
  )
  return { changed: true, slug: existing.slug }
}
