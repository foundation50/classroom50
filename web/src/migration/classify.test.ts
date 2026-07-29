// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts down.
import { describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import { classifyAssignment } from "./classify"
import type { ClassroomAssignmentDetail } from "./types"

const emptyRateLimit = {
  limit: null,
  remaining: null,
  reset: null,
  used: null,
  resource: null,
  retryAfter: null,
}
const notFound = (url: string) =>
  new GitHubAPIError({
    status: 404,
    url,
    message: "Not Found",
    body: null,
    rateLimit: emptyRateLimit,
  })

const assignment = (
  over: Partial<ClassroomAssignmentDetail> = {},
): ClassroomAssignmentDetail => ({
  id: 1,
  public_repo: true,
  title: "HW1",
  type: "individual",
  invite_link: "",
  slug: "hw1",
  deadline: null,
  max_teams: null,
  starter_code_repository: {
    id: 9,
    name: "hw1",
    full_name: "src/hw1",
    private: false,
    default_branch: "main",
  },
  ...over,
})

// Route-table client. `sourceTemplate` controls the source is_template read;
// `target` controls the target-repo probe (undefined -> 404).
function makeClient(opts: {
  sourceTemplate?: boolean
  sourceMissing?: boolean
  target?: { is_template: boolean; default_branch: string; private: boolean }
}): { client: GitHubClient; gets: string[] } {
  const gets: string[] = []
  const request = vi.fn(async (url: string, init?: { method?: string }) => {
    gets.push(`${init?.method ?? "GET"} ${url}`)
    if (url === "/repos/src/hw1") {
      if (opts.sourceMissing) throw notFound(url)
      return { is_template: opts.sourceTemplate ?? true }
    }
    // Any target repo probe (org/name)
    if (/^\/repos\/dst\//.test(url)) {
      if (!opts.target) throw notFound(url)
      return opts.target
    }
    throw new Error(`unexpected: ${url}`)
  })
  return { client: { request } as unknown as GitHubClient, gets }
}

describe("classifyAssignment", () => {
  it("import when source is a template and target 404s", async () => {
    const { client } = makeClient({ sourceTemplate: true })
    const item = await classifyAssignment(client, "dst", "", assignment())
    expect(item.action).toBe("import")
    expect(item.targetName).toBe("hw1")
    expect(item.targetPrivate).toBe(false)
  })

  it("reuse when the target exists and is a template", async () => {
    const { client } = makeClient({
      sourceTemplate: true,
      target: { is_template: true, default_branch: "trunk", private: true },
    })
    const item = await classifyAssignment(client, "dst", "", assignment())
    expect(item.action).toBe("reuse")
    expect(item.branch).toBe("trunk")
    expect(item.targetPrivate).toBe(true)
  })

  it("skip(collision) when the target exists and is not a template", async () => {
    const { client } = makeClient({
      sourceTemplate: true,
      target: { is_template: false, default_branch: "main", private: false },
    })
    const item = await classifyAssignment(client, "dst", "", assignment())
    expect(item.action).toBe("skip")
    expect(item.reason?.key).toBe("migration.reason.targetCollision")
  })

  it("imports as template-less when there is no starter repo", async () => {
    const { client } = makeClient({})
    const item = await classifyAssignment(
      client,
      "dst",
      "",
      assignment({ starter_code_repository: null }),
    )
    expect(item.action).toBe("import")
    expect(item.templateLess).toBe(true)
  })

  it("skip when the source is not a template", async () => {
    const { client } = makeClient({ sourceTemplate: false })
    const item = await classifyAssignment(client, "dst", "", assignment())
    expect(item.reason?.key).toBe("migration.reason.sourceNotTemplate")
  })

  it("skip when the source is not accessible", async () => {
    const { client } = makeClient({ sourceMissing: true })
    const item = await classifyAssignment(client, "dst", "", assignment())
    // src/hw1 is a different org than the target "dst" -> org-access reason.
    expect(item.reason?.key).toBe("migration.reason.sourceOrgAccess")
    expect(item.reason?.params?.org).toBe("src")
  })

  it("uses sourceNotAccessible when the source is in the SAME org as target", async () => {
    const { client } = makeClient({ sourceMissing: true })
    // Target org "src" matches the starter's org, so it's not an app-grant gap.
    const item = await classifyAssignment(client, "src", "", assignment())
    expect(item.reason?.key).toBe("migration.reason.sourceNotAccessible")
  })

  it("skip on an invalid slug without any network call", async () => {
    const { client, gets } = makeClient({})
    const item = await classifyAssignment(
      client,
      "dst",
      "",
      assignment({ slug: "Bad Slug" }),
    )
    expect(item.reason?.key).toBe("migration.reason.invalidSlug")
    expect(gets).toHaveLength(0)
  })

  it("applies the template-suffix to the probed target name", async () => {
    const { client, gets } = makeClient({ sourceTemplate: true })
    const item = await classifyAssignment(client, "dst", "sp26", assignment())
    expect(item.targetName).toBe("hw1-sp26")
    expect(gets.some((g) => g.includes("/repos/dst/hw1-sp26"))).toBe(true)
  })

  it("issues only GET requests (read-only)", async () => {
    const { client, gets } = makeClient({
      sourceTemplate: true,
      target: { is_template: true, default_branch: "main", private: false },
    })
    await classifyAssignment(client, "dst", "", assignment())
    expect(gets.every((g) => g.startsWith("GET "))).toBe(true)
  })
})
