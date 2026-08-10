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
import { prefixCommit } from "@/util/commit"
import { paginateAll } from "../paginate"
import { SUBMISSION_TAG_PREFIX } from "../queries/releaseRunReads"
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
        path: `${classroom}/assignments.json`,
        mode,
        type,
        content: JSON.stringify(ASSIGNMENTS_TEMPLATE, null, 2),
      },
      {
        path: `${classroom}/roster.csv`,
        mode,
        type,
        content: STUDENTS_CSV_HEADER,
      },
      {
        path: `${classroom}/scores.json`,
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
        path: `${classroom}/classroom.json`,
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
  return client.request<GitHubCreateTree>(
    `/repos/${org}/${CONFIG_REPO}/git/trees`,
    {
      method: "POST",
      body: createClassroomBody(
        base_tree,
        org,
        classroom,
        name,
        term,
        team,
        input.secret,
        teams,
      ),
    },
  )
}

export function createTreeRepo(
  client: GitHubClient,
  input: {
    base_tree: string
    org: string
    repo: string
    tree: { path: string; mode: string; type: string; content: string }[]
  },
) {
  const { base_tree, org, repo, tree } = input

  return client.request<GitHubTree>(`/repos/${org}/${repo}/git/trees`, {
    method: "POST",
    body: {
      base_tree,
      tree,
    },
  })
}

type GitHubTree = {
  sha: string
}

type GitHubTreeEntry = {
  path: string
  mode: "100644"
  type: "blob"
  content: string
}
export function createTreeForAssignment(params: {
  client: GitHubClient
  owner: string
  repo: string
  baseTreeSha: string
  metadataYaml: string
  autogradeYaml: string
}) {
  const { client, owner, repo, baseTreeSha, metadataYaml, autogradeYaml } =
    params

  const tree: GitHubTreeEntry[] = [
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

  return client.request<GitHubTree>(`/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: {
      base_tree: baseTreeSha,
      tree,
    },
  })
}

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
  return client.request<GitHubCreateCommit>(
    `/repos/${org}/${CONFIG_REPO}/git/commits`,
    {
      method: "POST",
      body: {
        message:
          message ||
          prefixCommit(`Create init files for new classroom: ${classroom}`),
        tree: tree_sha,
        parents,
      },
    },
  )
}

export function createCommitRepo(
  client: GitHubClient,
  input: {
    org: string
    repo: string
    parents: [string]
    tree: string
    message: string
  },
) {
  const { org, repo, parents, tree, message } = input

  return client.request<GitHubCreateCommit>(
    `/repos/${org}/${repo}/git/commits`,
    {
      method: "POST",
      body: {
        message,
        tree,
        parents,
      },
    },
  )
}

export function createCommitForAssignment(params: {
  client: GitHubClient
  owner: string
  repo: string
  message: string
  treeSha: string
  parentSha: string
}) {
  const { client, owner, repo, message, treeSha, parentSha } = params

  return client.request<GitHubCreateCommit>(
    `/repos/${owner}/${repo}/git/commits`,
    {
      method: "POST",
      body: {
        message,
        tree: treeSha,
        parents: [parentSha],
      },
    },
  )
}

export function updateRef(
  client: GitHubClient,
  org: string,
  sha: string,
  branch = DEFAULT_BRANCH,
) {
  return client.request<GitHubMoveBranch>(
    `/repos/${org}/${CONFIG_REPO}/git/refs/heads/${encodeURIComponent(branch)}`,
    {
      method: "PATCH",
      body: {
        sha,
        force: false,
      },
    },
  )
}

type GitHubRef = {
  ref: string
  object: {
    sha: string
    type: string
    url: string
  }
}
export function updateRefForRepo(params: {
  client: GitHubClient
  owner: string
  repo: string
  branch: string
  commitSha: string
}) {
  const { client, owner, repo, branch, commitSha } = params

  return client.request<GitHubRef>(
    `/repos/${owner}/${repo}/git/refs/heads/${branch}`,
    {
      method: "PATCH",
      body: {
        sha: commitSha,
        force: false,
      },
    },
  )
}

// Create a lightweight tag ref at a commit. Used by the tag-mode submit flow
// to push the submit/<UTC-timestamp>-<short-sha> tag with the user's token —
// user pushes fire workflows, which is exactly the point (the runner's own
// github.token tag pushes deliberately don't).
export function createTagRefForRepo(params: {
  client: GitHubClient
  owner: string
  repo: string
  tag: string
  commitSha: string
}) {
  const { client, owner, repo, tag, commitSha } = params

  return client.request<GitHubRef>(`/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: {
      ref: `refs/tags/${tag}`,
      sha: commitSha,
    },
  })
}

// First submit/* tag pointing at `sha`, or null. The tag-mode submit flow
// checks this before creating a fresh tag — mirroring the runner's ls-remote
// idempotency check — so a retry after a tag-push failure reuses the existing
// tag and the same commit never grades twice. matching-refs is a prefix match
// (the prefix's slash needs encoding); the response carries each ref's target.
// Paginated: a tag-mode repo accrues one submit/* tag per submission, so a
// semester's worth easily exceeds one page — an unpaginated read would miss
// the existing tag and mint a duplicate (one redundant graded run).
export async function findSubmitTagAtSha(params: {
  client: GitHubClient
  owner: string
  repo: string
  sha: string
}): Promise<string | null> {
  const { client, owner, repo, sha } = params
  const prefix = encodeURIComponent(SUBMISSION_TAG_PREFIX)
  const refs = await paginateAll<GitHubRef>(
    client,
    (page) =>
      `/repos/${owner}/${repo}/git/matching-refs/tags/${prefix}?per_page=100&page=${page}`,
  )
  for (const ref of refs) {
    if (ref.object?.sha === sha) {
      return ref.ref.replace(/^refs\/tags\//, "")
    }
  }
  return null
}

// One entry in a git tree write. GitHub accepts either inline `content` or a
// `sha` (existing blob, or `null` to delete the path).
export type GitTreeFileMode = "100644" | "100755" | "120000"
export type GitTreeEntry = {
  path: string
  mode: GitTreeFileMode
  type: "blob"
} & ({ content: string } | { sha: string | null })
export type CreateGitTreeInput = {
  org: string
  base_tree: string
  tree: GitTreeEntry[]
}
export function createGitTree(client: GitHubClient, input: CreateGitTreeInput) {
  const { org, base_tree, tree } = input

  return client.request<GitHubCreateTree>(
    `/repos/${org}/${CONFIG_REPO}/git/trees`,
    {
      method: "POST",
      body: {
        base_tree,
        tree,
      },
    },
  )
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
  const { org, message, tree_sha, parents } = input

  return client.request<GitHubCreateCommit>(
    `/repos/${org}/${CONFIG_REPO}/git/commits`,
    {
      method: "POST",
      body: {
        message,
        tree: tree_sha,
        parents,
      },
    },
  )
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

// Create a blob in an ARBITRARY repo with an explicit encoding. Unlike createBlob
// (pinned to CONFIG_REPO + utf-8), this backs student-repo writes that may carry
// binary content (base64). The caller base64-encodes bytes and passes
// encoding:"base64"; utf-8 text can pass through as-is. A longer timeout suits a
// large upload blob (the default request timeout is tuned for small JSON writes).
export async function createBlobForRepo(params: {
  client: GitHubClient
  owner: string
  repo: string
  content: string
  encoding: "utf-8" | "base64"
  timeoutMs?: number
}) {
  const { client, owner, repo, content, encoding, timeoutMs } = params
  return client.request<GitHubBlob>(`/repos/${owner}/${repo}/git/blobs`, {
    method: "POST",
    body: { content, encoding },
    ...(timeoutMs ? { timeoutMs } : {}),
  })
}

// One entry in a raw git tree read. GitHub returns `mode` too, which a tree
// rewrite must echo back so a file's executable/symlink bit isn't lost.
export type GitHubTreeEntryFull = {
  path: string
  mode: string
  type: "blob" | "tree" | "commit"
  sha: string
}

// Recursively list every entry in a repo's tree at `treeSha`. Used to carry
// preserved paths (.github/**, .classroom50.yaml) into a replace-all snapshot by
// their existing blob SHAs. `truncated` is surfaced so a caller can refuse to
// build a partial (and thus destructive) tree from an incomplete listing.
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

// Create an AUTHORITATIVE tree in an arbitrary repo from explicit entries.
// Omitting base_tree means only the listed paths exist, so a replace-all
// snapshot drops prior files not carried over (the submit semantics).
export async function createTreeFromFullEntries(params: {
  client: GitHubClient
  owner: string
  repo: string
  tree: GitHubTreeEntryFull[]
}) {
  const { client, owner, repo, tree } = params
  return client.request<GitHubTree>(`/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: { tree },
  })
}

export async function createTreeFromEntries(
  client: GitHubClient,
  input: {
    org: string
    base_tree: string
    tree: Array<{
      path: string
      mode: "100644"
      type: "blob"
      sha: string
    }>
  },
) {
  return client.request<GitHubTree>(
    `/repos/${input.org}/${CONFIG_REPO}/git/trees`,
    {
      method: "POST",
      body: {
        base_tree: input.base_tree,
        tree: input.tree,
      },
    },
  )
}
