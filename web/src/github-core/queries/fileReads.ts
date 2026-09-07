import { queryOptions } from "@tanstack/react-query"
import Papa from "papaparse"

import type { GitHubClient } from "../client"
import type { GitHubCommit } from "../types"
import { CONFIG_REPO } from "@/util/configRepo"
import { tolerateGitHubError } from "../errors"
import { decodeBase64Utf8 } from "@/util/github"
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

// The most-recent commit touching one config-repo file — the "when was this
// last updated" timestamp behind the roster's Refresh caption. A missing file
// or repo degrades to null (no commit) rather than an error.
export function latestConfigFileCommitQuery(
  client: GitHubClient,
  org: string | undefined,
  path: string,
) {
  return queryOptions({
    queryKey: githubKeys.configFileCommit(org ?? "", path),
    queryFn: async ({ signal }): Promise<GitHubCommit | null> => {
      const commits = await tolerateGitHubError(
        () =>
          client.request<GitHubCommit[]>(
            `/repos/${encodeURIComponent(
              org ?? "",
            )}/${CONFIG_REPO}/commits?path=${encodeURIComponent(
              path,
            )}&per_page=1`,
            { method: "GET", signal },
          ),
        [],
      )
      return commits[0] ?? null
    },
    enabled: Boolean(org && path),
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
) {
  return queryOptions({
    queryKey: githubKeys.csvFile(owner, repo, path, ref),
    queryFn: async ({ signal }) => {
      const raw = await readContents(client, owner, repo, path, ref, signal)

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

// Raw roster.csv bytes, returning the unparsed text so the caller can run the
// strict parser and surface per-line problems. Keyed on `rosterRawFile` — a
// namespace of its own, distinct from both `rawFile` (rawFileQuery, different
// queryFn) and csvFileQuery's parsed-rows key — so this additive
// problem-detection read can never collide with another raw or parsed read of
// the same path. The parsed-rows read (csvFileQuery) still drives display.
export function rosterRawFileQuery(
  client: GitHubClient,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
) {
  return queryOptions({
    queryKey: githubKeys.rosterRawFile(owner, repo, path, ref),
    queryFn: ({ signal }) =>
      readContents(client, owner, repo, path, ref, signal),
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

// A single file from an arbitrary repo at a PINNED ref (commit SHA or branch),
// or null when the path is absent at that ref. The ref pin is what makes a
// read-modify-write build rebase-safe: the content is read at the same parent
// the commit will be built on. Non-404 errors propagate so a transient failure
// isn't misread as "missing".
export async function getRepoFileAtRef(
  client: GitHubClient,
  input: { owner: string; repo: string; path: string; ref: string },
): Promise<string | null> {
  const { owner, repo, path, ref } = input
  const file = await tolerateGitHubError(
    () =>
      client.request<{
        type: "file"
        encoding: "base64"
        content: string
      }>(
        `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      ),
    null,
  )
  if (file === null) return null
  if (file.type !== "file") {
    throw new Error(`${path} is not a file in ${owner}/${repo}`)
  }
  return decodeBase64Utf8(file.content)
}
