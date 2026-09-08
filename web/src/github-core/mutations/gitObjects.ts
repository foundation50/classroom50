import type { GitHubClient } from "../client"
import {
  type GitHubCreateTree,
  type GitHubCreateCommit,
  type GitHubMoveBranch,
  type GitHubBlob,
} from "../types"
import type { CreateClassroomInput } from "@/domain/classrooms"
import { STUDENT_CSV_FIELDS } from "@/util/rosterCsv"
import { CONFIG_REPO, DEFAULT_BRANCH } from "@/util/configRepo"
import {
  assignmentsFilePath,
  classroomFilePath,
  rosterPath,
  scoresFilePath,
} from "@/util/configRepoPaths"
import { prefixCommit } from "@/util/commit"
import type { ClassroomTeamRef, StaffTeamRefs } from "./teams"

// The branch a config repo's default is renamed TO when normalizing it.
export const CONFIG_REPO_BRANCH = DEFAULT_BRANCH

export const ASSIGNMENTS_TEMPLATE = {
  schema: "classroom50/assignments/v1",
  assignments: [],
}
export const createClassroomMetadata = (
  org: string,
  classroom: string,
  name: string | undefined,
  term: string,
  team?: ClassroomTeamRef,
  secret?: string,
  teams?: StaffTeamRefs,
) => ({
  schema: "classroom50/classroom/v1",
  // Fall back to the slug when no display name was supplied.
  name: name || classroom,
  short_name: classroom,
  term,
  org,
  // Written only when a team was provisioned (matches the CLI's `omitempty`).
  // Grants rostered students read on private org templates.
  ...(team ? { team } : {}),
  // Per-classroom staff teams (teacher/hta/ta) backing in-app roles. Written
  // only when provisioned. A
  // generic presence check so a future staff role flows in without reopening
  // the silent-drop trap (an unenumerated role would drop the whole block).
  ...(teams && Object.values(teams).some(Boolean) ? { teams } : {}),
  // Written only when the teacher opted into protected resources (CLI
  // `omitempty`). When present, Pages resources publish under
  // `<classroom>/<secret>/...`.
  ...(secret ? { secret } : {}),
})

// Seed header for a new classroom's empty roster.csv. Derived from the single
// source of truth (STUDENT_CSV_FIELDS) so it can't drift. The parser is
// header-based, so an older roster still parses.
export const STUDENTS_CSV_HEADER = STUDENT_CSV_FIELDS.join(",") + "\n"
export const createClassroomBody = (
  base_tree: string,
  org: string,
  classroom: string,
  name: string | undefined,
  term: string,
  team?: ClassroomTeamRef,
  secret?: string,
  teams?: StaffTeamRefs,
) => {
  const mode = "100644"
  const type = "blob"

  return {
    base_tree,
    tree: [
      {
        path: assignmentsFilePath(classroom),
        mode,
        type,
        content: JSON.stringify(ASSIGNMENTS_TEMPLATE, null, 2),
      },
      {
        path: rosterPath(classroom),
        mode,
        type,
        content: STUDENTS_CSV_HEADER,
      },
      {
        path: scoresFilePath(classroom),
        mode,
        type,
        content: JSON.stringify(
          {
            schema: "classroom50/scores/v1",
            assignments: {},
          },
          null,
          2,
        ),
      },
      {
        path: classroomFilePath(classroom),
        mode,
        type,
        content: JSON.stringify(
          createClassroomMetadata(
            org,
            classroom,
            name,
            term,
            team,
            secret,
            teams,
          ),
          null,
          2,
        ),
      },
    ],
  }
}

// One entry in a git tree write. GitHub accepts either inline `content` or a
// `sha` (an existing blob, or `null` to remove the path from base_tree, which
// mirrors the CLI's gittree.DeletionEntries).
export type GitTreeFileMode = "100644" | "100755" | "120000"
export type GitTreeEntry = {
  path: string
  mode: GitTreeFileMode
  type: "blob"
} & ({ content: string } | { sha: string | null })

// The three git-data writes, for any repo. Every config-repo and student-repo
// commit in the app is these three calls in order; the named wrappers below
// only fix the repo or the message.
export type CreateRepoTreeInput = {
  owner: string
  repo: string
  baseTreeSha: string
  tree: GitTreeEntry[]
}
export function createRepoTree(
  client: GitHubClient,
  input: CreateRepoTreeInput,
) {
  const { owner, repo, baseTreeSha, tree } = input
  return client.request<GitHubCreateTree>(`/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: { base_tree: baseTreeSha, tree },
  })
}

export type CreateRepoCommitInput = {
  owner: string
  repo: string
  message: string
  treeSha: string
  parentSha: string
}
export function createRepoCommit(
  client: GitHubClient,
  input: CreateRepoCommitInput,
) {
  const { owner, repo, message, treeSha, parentSha } = input
  return client.request<GitHubCreateCommit>(
    `/repos/${owner}/${repo}/git/commits`,
    {
      method: "POST",
      body: { message, tree: treeSha, parents: [parentSha] },
    },
  )
}

export type UpdateRepoRefInput = {
  owner: string
  repo: string
  branch: string
  commitSha: string
}
// Fast-forward only (`force: false`): a concurrent write to the same branch
// surfaces as a 409 the callers' conflict-retry re-reads and retries on.
export function updateRepoRef(client: GitHubClient, input: UpdateRepoRefInput) {
  const { owner, repo, branch, commitSha } = input
  return client.request<GitHubMoveBranch>(
    `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
    {
      method: "PATCH",
      body: { sha: commitSha, force: false },
    },
  )
}

// The config-repo partials. Kept under their long-standing names and
// signatures because the domain writers are their callers.
export type CreateGitTreeInput = {
  org: string
  base_tree: string
  tree: GitTreeEntry[]
}
export function createGitTree(client: GitHubClient, input: CreateGitTreeInput) {
  return createRepoTree(client, {
    owner: input.org,
    repo: CONFIG_REPO,
    baseTreeSha: input.base_tree,
    tree: input.tree,
  })
}

export type CreateGitCommitInput = {
  org: string
  message: string
  tree_sha: string
  parents: [string]
}
export function createGitCommit(
  client: GitHubClient,
  input: CreateGitCommitInput,
) {
  return createRepoCommit(client, {
    owner: input.org,
    repo: CONFIG_REPO,
    message: input.message,
    treeSha: input.tree_sha,
    parentSha: input.parents[0],
  })
}

export function updateRef(
  client: GitHubClient,
  org: string,
  sha: string,
  branch = DEFAULT_BRANCH,
) {
  return updateRepoRef(client, {
    owner: org,
    repo: CONFIG_REPO,
    branch,
    commitSha: sha,
  })
}

// The classroom-seed tree: the four files a new classroom starts with.
export function createTree(
  client: GitHubClient,
  input: CreateClassroomInput & {
    base_tree: string
    term: string
    team?: ClassroomTeamRef
    teams?: StaffTeamRefs
  },
) {
  const { base_tree, org, classroom, name, term, team, teams } = input
  const body = createClassroomBody(
    base_tree,
    org,
    classroom,
    name,
    term,
    team,
    input.secret,
    teams,
  )
  return createRepoTree(client, {
    owner: org,
    repo: CONFIG_REPO,
    baseTreeSha: base_tree,
    tree: body.tree as GitTreeEntry[],
  })
}

// The classroom-seed commit; the message defaults to the seed subject.
export function createCommit(
  client: GitHubClient,
  input: {
    org: string
    classroom: string
    parents: [string]
    tree_sha: string
    message?: string
  },
) {
  const { classroom, tree_sha, org, parents, message } = input
  return createRepoCommit(client, {
    owner: org,
    repo: CONFIG_REPO,
    message:
      message ||
      prefixCommit(`Create init files for new classroom: ${classroom}`),
    treeSha: tree_sha,
    parentSha: parents[0],
  })
}

// The accept-time tree for a student repo: the marker, the autograde shim
// unless the assignment has none, and any paths the accept removes.
export function createTreeForAssignment(params: {
  client: GitHubClient
  owner: string
  repo: string
  baseTreeSha: string
  metadataYaml: string
  autogradeYaml: string
  // Paths to remove from base_tree in the same commit (the init_shim accept
  // deletes the auto_init README this way).
  deletePaths?: string[]
}) {
  const {
    client,
    owner,
    repo,
    baseTreeSha,
    metadataYaml,
    autogradeYaml,
    deletePaths = [],
  } = params

  const tree: GitTreeEntry[] = [
    {
      path: ".classroom50.yaml",
      mode: "100644",
      type: "blob",
      content: metadataYaml,
    },
  ]
  // A no-shim accept (empty_repo or no_autograder) passes an empty shim: commit
  // only the marker, never an empty .github/workflows/autograde.yaml. Landing
  // an empty workflow file would make the runner shape ambiguous and churn the
  // teacher's own CI path. Mirrors the CLI's classroomcfg.DropFiles.
  if (autogradeYaml !== "") {
    tree.push({
      path: ".github/workflows/autograde.yaml",
      mode: "100644",
      type: "blob",
      content: autogradeYaml,
    })
  }
  for (const path of deletePaths) {
    tree.push({ path, mode: "100644", type: "blob", sha: null })
  }

  return createRepoTree(client, { owner, repo, baseTreeSha, tree })
}

export async function createBlob(
  client: GitHubClient,
  input: {
    org: string
    content: string
  },
) {
  return client.request<GitHubBlob>(
    `/repos/${input.org}/${CONFIG_REPO}/git/blobs`,
    {
      method: "POST",
      body: {
        content: input.content,
        encoding: "utf-8",
      },
    },
  )
}

// One entry in a raw git tree read. GitHub returns `mode` too, which a tree
// rewrite must echo back so a file's executable/symlink bit isn't lost.
export type GitHubTreeEntryFull = {
  path: string
  mode: string
  type: "blob" | "tree" | "commit"
  sha: string
}

// Recursively list every entry in a repo's tree at `treeSha`. `truncated` is
// surfaced so a caller can refuse to act on an incomplete listing.
export async function getRepoTreeRecursive(params: {
  client: GitHubClient
  owner: string
  repo: string
  treeSha: string
}): Promise<{ tree: GitHubTreeEntryFull[]; truncated: boolean }> {
  const { client, owner, repo, treeSha } = params
  return client.request<{ tree: GitHubTreeEntryFull[]; truncated: boolean }>(
    `/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`,
  )
}
