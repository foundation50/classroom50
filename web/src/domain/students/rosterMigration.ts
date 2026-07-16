import type { GitHubClient } from "@/github-core/client"
import {
  createGitCommit,
  createGitTree,
  updateRef,
} from "@/github-core/mutations"
import { withGitConflictRetry } from "../classrooms"
import {
  getBranchRef,
  getCommit,
  getConfigRepoBranch,
} from "@/github-core/configRepoReads"
import { prefixCommit } from "@/util/commit"
import { rosterPath, legacyRosterPath } from "@/util/rosterPath"
import { log, rosterWriteTree, readFileOrNull } from "./rosterPrimitives"

export type MigrateRosterFileResult = {
  // True when a rename commit was made (legacy students.csv -> roster.csv).
  migrated: boolean
}

// Converge a classroom bootstrapped before the roster rename onto roster.csv,
// so the file always physically exists. Mirrors the CLI `gh teacher roster
// migrate`: if only the legacy students.csv is present, write roster.csv with
// its bytes verbatim and delete the legacy file in ONE tree commit. Idempotent:
// a no-op when roster.csv already exists, and nothing-to-do when neither file
// is present (a brand-new classroom's roster.csv is created by the team sync
// instead). Runs inside the conflict-retry loop so a concurrent write (e.g. an
// interleaved roster edit) is re-read rather than clobbered.
export async function migrateRosterFile(
  client: GitHubClient,
  input: { org: string; classroom: string },
): Promise<MigrateRosterFileResult> {
  const { org, classroom } = input
  const rosterFilePath = rosterPath(classroom)
  const legacyPath = legacyRosterPath(classroom)

  return withGitConflictRetry(async () => {
    const configBranch = await getConfigRepoBranch(client, org)
    const ref = await getBranchRef(client, org, configBranch)
    const commit = await getCommit(client, org, ref.object.sha)

    // Read both files' presence at the same commit. roster.csv present -> the
    // classroom is already converged (or has both, and roster.csv is canonical);
    // nothing to migrate.
    const [rosterBytes, legacyBytes] = await Promise.all([
      readFileOrNull(client, org, rosterFilePath, ref.object.sha),
      readFileOrNull(client, org, legacyPath, ref.object.sha),
    ])

    if (rosterBytes !== null || legacyBytes === null) {
      // roster.csv already exists, or neither file does — no rename to do.
      return { migrated: false }
    }

    // Only the legacy file exists: write roster.csv with its bytes verbatim and
    // delete the legacy file in a single commit (mode 100644; sha:null deletes).
    const tree = await createGitTree(client, {
      org,
      base_tree: commit.tree.sha,
      tree: rosterWriteTree(classroom, legacyBytes, true),
    })

    const newCommit = await createGitCommit(client, {
      org,
      message: prefixCommit(`Migrate students.csv to roster.csv: ${classroom}`),
      tree_sha: tree.sha,
      parents: [ref.object.sha],
    })

    await updateRef(client, org, newCommit.sha, configBranch)

    log.info("migrate roster file: renamed students.csv -> roster.csv", {
      org,
      classroom,
    })
    return { migrated: true }
  })
}
