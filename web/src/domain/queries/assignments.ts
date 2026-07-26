import type { GitHubClient } from "@/github-core/client"
import {
  extractAssignments,
  fetchJson,
  pagesAssignmentUrl,
  type AssignmentsJson,
} from "@/github-core/queries"
import type { Assignment } from "@/types/classroom"
import { decodeBase64Utf8 } from "@/util/github"
import { CONFIG_REPO } from "@/util/configRepo"
import { localizedError, type LocalizedMessage } from "@/types/localizedMessage"

export type GetAssignmentsFileInput = {
  org: string
  path: string
  ref: string
}
export type AssignmentsFile = {
  schema: "classroom50/assignments/v1"
  assignments: Assignment[]
}
export async function getAssignmentsFile(
  client: GitHubClient,
  input: GetAssignmentsFileInput,
): Promise<AssignmentsFile> {
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

  const json = decodeBase64Utf8(file.content)

  return JSON.parse(json) as AssignmentsFile
}

// `label` names what failed for the reader (e.g. the autograder). It is a
// descriptor, not English, so the message renders in the student's language; the
// thrown errors carry the diagnostic form in `Error.message` for logs.
export async function fetchTextWithFriendlyErrors(
  url: string,
  label: LocalizedMessage,
): Promise<string> {
  const response = await fetch(url)
  const named = (key: string, params?: Record<string, string | number>) =>
    localizedError({ key, params: { ...params, label } })

  if (response.status === 404) {
    throw named("pagesErrors.notPublished")
  }

  if (!response.ok) {
    throw named("pagesErrors.fetchFailed", { status: response.status })
  }

  const text = await response.text()

  if (!text.trim()) {
    throw localizedError({ key: "pagesErrors.deployInFlight" })
  }

  return text
}

export async function fetchAssignmentFromPages(
  org: string,
  classroom: string,
  assignmentSlug: string,
  secret?: string,
): Promise<Assignment> {
  const json = await fetchJson<AssignmentsJson>(
    pagesAssignmentUrl(org, classroom, secret),
  )

  const assignments = extractAssignments(json)
  const assignment = assignments.find((entry) => entry.slug === assignmentSlug)

  if (!assignment) {
    throw localizedError({
      key: "pagesErrors.assignmentNotInManifest",
      params: { assignmentSlug },
    })
  }

  return assignment
}
