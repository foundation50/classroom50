import { queryOptions } from "@tanstack/react-query"
import Papa from "papaparse"

import type { GitHubClient } from "../client"
import type { GitHubCommit, GitHubTreeResponse } from "../types"
import { CONFIG_REPO } from "@/util/configRepo"
import { GitHubAPIError, tolerateGitHubError } from "../errors"
import { decodeBase64Utf8 } from "@/util/github"
import { getCommit } from "../configRepoReads"
import type { GetAssignmentsFileInput } from "@/domain/queries/assignments"
import { githubKeys } from "./keys"

export function rawFileQuery(
  client: GitHubClient,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
) {
  const params = new URLSearchParams()

  if (ref) {
    params.set("ref", ref)
  }

  const suffix = params.size ? `?${params.toString()}` : ""

  return queryOptions({
    queryKey: githubKeys.rawFile(owner, repo, path, ref),
    queryFn: ({ signal }) =>
      client.requestRaw(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
          repo,
        )}/contents/${path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}${suffix}`,
        { method: "GET", signal },
      ),
    enabled: Boolean(owner && repo && typeof path === "string"),
    staleTime: 10 * 60 * 1000,
    retry: false,
  })
}

export function jsonFileQuery<T>(
  client: GitHubClient,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
) {
  return queryOptions({
    queryKey: githubKeys.jsonFile(owner, repo, path, ref),
    queryFn: async ({ signal }) => {
      const raw = await client.requestRaw(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
          repo,
        )}/contents/${path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`,
        { method: "GET", signal },
      )

      // Throw a friendly error naming the file rather than a raw SyntaxError.
      try {
        return JSON.parse(raw) as T
      } catch {
        throw new Error(
          `${path} couldn't be read (the file may be malformed). Try refreshing in a moment.`,
        )
      }
    },
    enabled: Boolean(owner && repo && typeof path === "string"),
    staleTime: 10 * 60 * 1000,
    retry: false,
  })
}

// The most-recent `perPage` commits of the classroom50 config-repo history,
// newest-first — the audit log behind the org Activity view. Each GUI write is a
// structured "[Classroom 50] <verb> <target>" commit (see util/commit.ts), so
// the messages read as an audit trail as-is. A window (not page) model so the
// Activity view's "Load older" just grows perPage and the single query holds the
// whole accumulated list. A missing/uninitialized repo 404s -> [] so a fresh org
// degrades to an empty section rather than an error.
export function configCommitsQuery(
  client: GitHubClient,
  org: string | undefined,
  perPage = 30,
) {
  return queryOptions({
    queryKey: githubKeys.configCommits(org ?? "", perPage),
    queryFn: ({ signal }): Promise<GitHubCommit[]> =>
      tolerateGitHubError(
        () =>
          client.request<GitHubCommit[]>(
            `/repos/${encodeURIComponent(
              org ?? "",
            )}/${CONFIG_REPO}/commits?per_page=${perPage}`,
            { method: "GET", signal },
          ),
        [],
      ),
    enabled: Boolean(org),
    staleTime: 60 * 1000,
    retry: false,
  })
}

export function csvFileQuery<T>(
  client: GitHubClient,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
  // Legacy path tried only when `path` 404s (current roster name -> legacy).
  // The query key stays on `path`, so a post-migration read converges on the
  // current name and optimistic writes never have to know which name served the
  // bytes.
  fallbackPath?: string,
) {
  return queryOptions({
    queryKey: githubKeys.csvFile(owner, repo, path, ref),
    queryFn: async ({ signal }) => {
      let raw: string
      try {
        raw = await readContents(client, owner, repo, path, ref, signal)
      } catch (err) {
        if (
          fallbackPath &&
          err instanceof GitHubAPIError &&
          err.status === 404
        ) {
          raw = await readContents(
            client,
            owner,
            repo,
            fallbackPath,
            ref,
            signal,
          )
        } else {
          throw err
        }
      }

      const csvParse = Papa.parse<T>(raw, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header: string) => header.trim(),
        transform: (value: string) => value.trim(),
      })

      return csvParse.data
    },
    enabled: Boolean(owner && repo && typeof path === "string"),
    staleTime: 10 * 60 * 1000,
    retry: false,
  })
}

function readContents(
  client: GitHubClient,
  owner: string,
  repo: string,
  path: string,
  ref: string | undefined,
  signal: AbortSignal | undefined,
) {
  return client.requestRaw(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo,
    )}/contents/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`,
    { method: "GET", signal },
  )
}

// Raw roster.csv bytes with a legacy fallback (current roster name -> legacy on
// a 404), returning the unparsed text so the caller can run the strict parser
// and surface per-line problems. Keyed on `rosterRawFile` — a namespace of its
// own, distinct from both `rawFile` (rawFileQuery, no fallback, different
// queryFn) and csvFileQuery's parsed-rows key — so this additive
// problem-detection read can never collide with another raw or parsed read of
// the same path. The parsed-rows read (csvFileQuery) still drives display.
export function rosterRawFileQuery(
  client: GitHubClient,
  owner: string,
  repo: string,
  path: string,
  fallbackPath?: string,
  ref?: string,
) {
  return queryOptions({
    queryKey: githubKeys.rosterRawFile(owner, repo, path, ref),
    queryFn: async ({ signal }) => {
      try {
        return await readContents(client, owner, repo, path, ref, signal)
      } catch (err) {
        if (
          fallbackPath &&
          err instanceof GitHubAPIError &&
          err.status === 404
        ) {
          return await readContents(
            client,
            owner,
            repo,
            fallbackPath,
            ref,
            signal,
          )
        }
        throw err
      }
    },
    enabled: Boolean(owner && repo && typeof path === "string"),
    staleTime: 10 * 60 * 1000,
    retry: false,
  })
}

export async function getRawFile(
  client: GitHubClient,
  input: GetAssignmentsFileInput,
): Promise<string> {
  const { org, path, ref } = input

  const file = await client.request<{
    type: "file"
    encoding: "base64"
    content: string
  }>(
    `/repos/${org}/${CONFIG_REPO}/contents/${path}?ref=${encodeURIComponent(ref)}`,
  )

  if (file.type !== "file") {
    throw new Error(`${path} is not a file`)
  }

  return decodeBase64Utf8(file.content)
}

// Read a config file for a WRITE, reporting whether the returned bytes came
// from the legacy fallback path. Callers pass `fromLegacy` to rosterWriteTree,
// where it authorizes deleting the legacy file — so it must NOT be decided by a
// bare Contents-API 404: that API is eventually consistent per path, so right
// after a write to the current name a read pinned to that commit can briefly
// 404 while the legacy name still serves stale bytes. Trusting that 404 would
// overwrite the current file with stale legacy content and delete it on a clean
// fast-forward the conflict-retry loop can't catch — a silently lost write. So
// on a 404 we resolve legacy-vs-lag from the git TREE at the same commit
// (internally consistent, unlike per-path Contents reads). A non-404 error
// propagates unchanged.
export async function getRawFileWithFallbackSource(
  client: GitHubClient,
  input: GetAssignmentsFileInput & { fallbackPath: string },
): Promise<{ content: string; fromLegacy: boolean }> {
  const { fallbackPath, ...primary } = input
  try {
    return { content: await getRawFile(client, primary), fromLegacy: false }
  } catch (err) {
    if (!(err instanceof GitHubAPIError && err.status === 404)) throw err
    // Primary 404 — decide legacy-vs-lag from the commit tree, not the 404.
    if (
      await pathInCommitTree(client, primary.org, primary.path, primary.ref)
    ) {
      // Tree says the current name exists; the 404 was consistency lag. Re-read
      // it so a stale legacy read can't drive an overwrite + delete.
      return { content: await getRawFile(client, primary), fromLegacy: false }
    }
    return {
      content: await getRawFile(client, { ...primary, path: fallbackPath }),
      fromLegacy: true,
    }
  }
}

// True when `path` is a blob in the commit's recursive tree at `ref`. A
// truncated tree is treated as "not confirmed present" so the caller only takes
// the destructive legacy path when the tree positively lacks `path`.
async function pathInCommitTree(
  client: GitHubClient,
  org: string,
  path: string,
  ref: string,
): Promise<boolean> {
  const commit = await getCommit(client, org, ref)
  const tree = await client.request<GitHubTreeResponse>(
    `/repos/${org}/${CONFIG_REPO}/git/trees/${commit.tree.sha}?recursive=1`,
  )
  if (tree.truncated) return false
  return tree.tree.some((e) => e.type === "blob" && e.path === path)
}

export async function getClassroom50Yaml(
  client: GitHubClient,
  org: string,
  repo: string,
): Promise<string> {
  const file = await client.request<{
    type: "file"
    encoding: "base64"
    content: string
  }>(`/repos/${org}/${repo}/contents/.classroom50.yaml?ref=main`)

  if (file.type !== "file") {
    throw new Error(`.classroom50.yaml not found in ${repo}`)
  }

  return decodeBase64Utf8(file.content)
}
