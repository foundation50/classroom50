import type { GitHubClient } from "@/github-core/client"
import { log } from "./accessPrimitives"
import {
  commitAssignments,
  readAssignmentsForWrite,
  requireAssignment,
} from "./assignmentsWrite"

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
  }
}
