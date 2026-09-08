import type { GitHubClient } from "@/github-core/client"
import { getRawFile } from "@/github-core/queries"
import { rosterPath } from "@/util/configRepoPaths"

import {
  commitConfigRepoFiles,
  readConfigRepoHead,
  readConfigRepoHeadAt,
  type ConfigRepoCommitResult,
  type ConfigRepoHead,
} from "../configRepoWrite"

// The read half of every roster.csv write: the config-repo head plus the file
// as it stands at that head, so no writer reads at one ref and commits
// against another. The CSV is returned raw because the writers split on how
// to parse it (lenient parseStudentsCsv vs strict parseRosterCsv).
export type RosterWriteContext = ConfigRepoHead & {
  path: string
  currentCsv: string
}

export async function readRosterForWrite(
  client: GitHubClient,
  org: string,
  classroom: string,
): Promise<RosterWriteContext> {
  const head = await readConfigRepoHead(client, org, classroom)
  return readRosterAtHead(client, org, classroom, head)
}

// For writers that ran the archive guard themselves (outside a retry loop) or
// resolved the branch to overlap it with other reads.
export async function readRosterForWriteAt(
  client: GitHubClient,
  org: string,
  classroom: string,
  configBranch: string,
): Promise<RosterWriteContext> {
  const head = await readConfigRepoHeadAt(client, org, configBranch)
  return readRosterAtHead(client, org, classroom, head)
}

async function readRosterAtHead(
  client: GitHubClient,
  org: string,
  classroom: string,
  head: ConfigRepoHead,
): Promise<RosterWriteContext> {
  const path = rosterPath(classroom)
  // Read at the freshly fetched head, never a commit we just wrote, so a 404
  // means roster.csv is genuinely absent rather than read-your-own-write lag.
  const currentCsv = await getRawFile(client, { org, path, ref: head.headSha })
  return { ...head, path, currentCsv }
}

// The write half: roster.csv is the only file in the tree.
export function commitRoster(
  client: GitHubClient,
  org: string,
  ctx: RosterWriteContext,
  nextCsv: string,
  message: string,
): Promise<ConfigRepoCommitResult> {
  return commitConfigRepoFiles(
    client,
    org,
    ctx,
    [{ path: ctx.path, mode: "100644", type: "blob", content: nextCsv }],
    message,
  )
}
