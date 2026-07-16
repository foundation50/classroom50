import { CONFIG_REPO, DEFAULT_BRANCH } from "@/util/configRepo"
import { classroomPagesSegment } from "@/util/secret"
import { fetchTextWithFriendlyErrors } from "../queries/assignments"

export function createClassroom50Yaml(params: {
  classroom: string
  assignment: string
  // `id` is the immutable numeric GitHub user id, recorded so the repo<->student
  // binding survives a username rename.
  ownerUsername: string
  ownerId?: number | null
  acceptedAt?: string
  // Optional capability-URL secret copied from the classroom's classroom.json
  // at accept. Written only for a protected classroom; when present, submit and
  // the autograde runner build the `<classroom>/<secret>/...` Pages path.
  secret?: string
  // Lets `gh student submit` re-fetch instructor files; omitted when template-less.
  sourceOwner?: string
  sourceOwnerId?: number | null
  sourceRepo?: string
  sourceBranch?: string
}) {
  const {
    classroom,
    assignment,
    ownerUsername,
    ownerId,
    acceptedAt,
    secret,
    sourceOwner,
    sourceOwnerId,
    sourceRepo,
    sourceBranch,
  } = params

  // id is a number (or null) — never quote it as a string.
  const idValue = (id: number | null | undefined) =>
    typeof id === "number" ? String(id) : "null"

  const lines = [
    `schema: "classroom50/repo-config/v1"`,
    `classroom: ${JSON.stringify(classroom)}`,
    `assignment: ${JSON.stringify(assignment)}`,
  ]

  // Emit the secret right after the identity fields (matching the CLI's field
  // order) and only when present, mirroring the CLI's `omitempty`.
  if (secret) {
    lines.push(`secret: ${JSON.stringify(secret)}`)
  }

  lines.push(
    `owner:`,
    `  username: ${JSON.stringify(ownerUsername)}`,
    `  id: ${idValue(ownerId)}`,
  )

  if (acceptedAt) {
    lines.push(`  accepted_at: ${JSON.stringify(acceptedAt)}`)
  }

  if (sourceOwner && sourceRepo) {
    lines.push(
      `source:`,
      `  owner: ${JSON.stringify(sourceOwner)}`,
      `  owner_id: ${idValue(sourceOwnerId)}`,
      `  repo: ${JSON.stringify(sourceRepo)}`,
      `  branch: ${JSON.stringify(sourceBranch ?? "main")}`,
    )
  }
  lines.push(``)
  return lines.join("\n")
}

function pagesAutograderUrl(params: {
  org: string
  classroom: string
  name: string
  secret?: string
}) {
  const { org, classroom, name, secret } = params
  const segment = classroomPagesSegment(classroom, secret)
  return `https://${org}.github.io/${CONFIG_REPO}/${segment}/autograders/${name}.yaml`
}

export function defaultAutograderWorkflow(
  org: string,
  branch: string,
  configBranch: string,
) {
  return `name: Autograde

on:
  push:
    branches: ["${branch}"]
    tags: ["submit/*"]

jobs:
  grade:
    uses: "${org}/${CONFIG_REPO}/.github/workflows/autograde-runner.yaml@${configBranch}"
    permissions:
      contents: write
      statuses: write
      # Lets the runner open the opt-in Feedback PR. A reusable
      # workflow's token is the intersection with the caller's grants, so
      # this must mirror autograde-runner.yaml's permissions.
      pull-requests: write
`
}

// Whether an autograder name uses the built-in default shim (templated by
// branch here) vs a teacher-authored one fetched from Pages (branch-agnostic).
export function isDefaultAutograder(autograder?: string): boolean {
  return !autograder || autograder === "default"
}

export async function resolveAutograderWorkflow(params: {
  org: string
  classroom: string
  autograder?: string
  secret?: string
  // The assignment repo's default branch (the shim's push trigger) and the
  // config repo's default branch (the reusable-workflow ref). Only used for the
  // built-in default shim; teacher-authored autograders are branch-agnostic.
  branch?: string
  configBranch?: string
}): Promise<string> {
  const { org, classroom, autograder, secret, branch, configBranch } = params
  if (isDefaultAutograder(autograder)) {
    return defaultAutograderWorkflow(
      org,
      branch || DEFAULT_BRANCH,
      configBranch || DEFAULT_BRANCH,
    )
  }
  // Narrowed: isDefaultAutograder returns true for undefined/"default", so a
  // non-default autograder name is a non-empty string here.
  const autograderName = autograder as string

  const workflow = await fetchTextWithFriendlyErrors(
    pagesAutograderUrl({ org, classroom, name: autograderName, secret }),
    `autograder ${autograderName}`,
  )

  if (!workflow.includes("jobs:")) {
    throw new Error(
      `Autograder ${autograderName} may be malformed YAML. Ask your instructor to check the file in the config repo.`,
    )
  }

  return workflow
}
