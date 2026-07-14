import type { GitHubClient } from "@/hooks/github/client"
import {
  extractAssignments,
  fetchJson,
  pagesAssignmentUrl,
  type AssignmentsJson,
} from "@/hooks/github/queries"
import type { Assignment } from "@/types/classroom"
import { decodeBase64Utf8 } from "@/util/github"
import { CONFIG_REPO } from "@/util/configRepo"

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

export async function fetchTextWithFriendlyErrors(
  url: string,
  label: string,
): Promise<string> {
  const response = await fetch(url)

  if (response.status === 404) {
    throw new Error(
      `${label} is not published yet. Ask your instructor to confirm the file exists in the config repo and that publish-pages.yaml has been run.`,
    )
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch ${label}: ${response.status}`)
  }

  const text = await response.text()

  if (!text.trim()) {
    throw new Error(
      "Pages deployment may still be in flight. Retry in a minute.",
    )
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
    throw new Error(`Assignment ${assignmentSlug} was not found.`)
  }

  return assignment
}
