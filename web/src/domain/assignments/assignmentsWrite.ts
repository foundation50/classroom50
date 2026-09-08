import type { GitHubClient } from "@/github-core/client"
import { assignmentsFilePath } from "@/util/configRepoPaths"

import {
  commitConfigRepoFiles,
  jsonFileEntry,
  readConfigRepoHead,
  readConfigRepoHeadAt,
  type ConfigRepoCommitResult,
  type ConfigRepoHead,
} from "../configRepoWrite"
import {
  getAssignmentsFile,
  type AssignmentsFile,
} from "../queries/assignments"

// The read half of every assignments.json write: the config-repo head plus the
// file as it stands at that head. Shared so no writer can read the file at one
// ref and commit against another.
export type AssignmentsWriteContext = ConfigRepoHead & {
  path: string
  current: AssignmentsFile
}

export async function readAssignmentsForWrite(
  client: GitHubClient,
  org: string,
  classroom: string,
): Promise<AssignmentsWriteContext> {
  const head = await readConfigRepoHead(client, org, classroom)
  return readAssignmentsAtHead(client, org, classroom, head)
}

// For writers that resolved the branch themselves (to overlap it with other
// reads) or must skip the archive guard.
export async function readAssignmentsForWriteAt(
  client: GitHubClient,
  org: string,
  classroom: string,
  configBranch: string,
): Promise<AssignmentsWriteContext> {
  const head = await readConfigRepoHeadAt(client, org, configBranch)
  return readAssignmentsAtHead(client, org, classroom, head)
}

async function readAssignmentsAtHead(
  client: GitHubClient,
  org: string,
  classroom: string,
  head: ConfigRepoHead,
): Promise<AssignmentsWriteContext> {
  const path = assignmentsFilePath(classroom)
  const current = await getAssignmentsFile(client, {
    org,
    path,
    ref: head.headSha,
  })
  return { ...head, path, current }
}

// The write half: assignments.json is the only file in the tree.
export function commitAssignments(
  client: GitHubClient,
  org: string,
  ctx: AssignmentsWriteContext,
  next: AssignmentsFile,
  message: string,
): Promise<ConfigRepoCommitResult> {
  return commitConfigRepoFiles(
    client,
    org,
    ctx,
    [jsonFileEntry(ctx.path, next)],
    message,
  )
}

// The entry the caller named, or the shared not-found error.
export function requireAssignment(ctx: AssignmentsWriteContext, slug: string) {
  const target = ctx.current.assignments.find((a) => a.slug === slug)
  if (!target) {
    throw new Error(`Existing assignment matching ${slug} was not found.`)
  }
  return target
}
