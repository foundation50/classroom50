import type { GitHubClient } from "@/github-core/client"
import { log } from "./accessPrimitives"
import {
  commitAssignments,
  readAssignmentsForWrite,
  requireAssignment,
} from "./assignmentsWrite"
import { withGitConflictRetry } from "../classrooms"

export type DeleteAssignmentInput = {
  org: string
  classroom: string
  assignment: string
}
export async function deleteAssignment(
  client: GitHubClient,
  input: DeleteAssignmentInput,
) {
  const { org, classroom, assignment: slug } = input

  log.info("delete assignment: started", { org, classroom, slug })

  const ctx = await readAssignmentsForWrite(client, org, classroom)
  requireAssignment(ctx, slug)

  const nextAssignments = {
    ...ctx.current,
    assignments: ctx.current.assignments.filter((a) => a.slug !== slug),
  }

  const written = await commitAssignments(
    client,
    org,
    ctx,
    nextAssignments,
    `Delete assignment: ${classroom}/${slug}`,
  )

  return {
    previousCommitSha: ctx.headSha,
    baseTreeSha: ctx.baseTreeSha,
    ...written,
    // The committed file, for seeding the read cache instead of a refetch
    // GitHub may still serve stale (#1004).
    assignments: nextAssignments,
  }
}

// Re-reads the ref and assignments.json each attempt, so a 409 from a
// concurrent commit is safe to retry (as every other assignments.json writer).
export function deleteAssignmentWithConflictRetry(
  client: GitHubClient,
  input: DeleteAssignmentInput,
) {
  return withGitConflictRetry(() => deleteAssignment(client, input))
}
