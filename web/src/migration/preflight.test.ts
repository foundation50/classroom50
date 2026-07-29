// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts down.
import { describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import { buildPreflight } from "./preflight"

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

// Build a route-table client for a source classroom (id 1, org "src-org",
// name "CS 50") with two assignments: hw1 (importable) and hw2 (source not a
// template -> skip). `configRepo`/`dirExists` control the target-org blockers.
function makeClient(opts: {
  configRepo?: boolean
  dirExists?: boolean
  targetHw1Exists?: boolean
}): GitHubClient {
  const request = vi.fn(async (url: string) => {
    // Source classroom + assignments
    if (url === "/classrooms/1")
      return {
        id: 1,
        name: "CS 50",
        archived: false,
        url: "u",
        organization: { login: "src-org" },
      }
    if (url.startsWith("/classrooms/1/assignments"))
      return [
        { id: 10, title: "HW1", slug: "hw1", type: "individual" },
        { id: 11, title: "HW2", slug: "hw2", type: "individual" },
        { id: 12, title: "Essay", slug: "essay", type: "individual" },
      ]
    if (url === "/assignments/10")
      return {
        id: 10,
        slug: "hw1",
        title: "HW1",
        type: "individual",
        deadline: null,
        max_teams: null,
        invite_link: "",
        public_repo: true,
        starter_code_repository: {
          full_name: "src/hw1",
          private: false,
          default_branch: "main",
          id: 1,
          name: "hw1",
        },
      }
    if (url === "/assignments/11")
      return {
        id: 11,
        slug: "hw2",
        title: "HW2",
        type: "individual",
        deadline: null,
        max_teams: null,
        invite_link: "",
        public_repo: true,
        starter_code_repository: {
          full_name: "src/hw2",
          private: false,
          default_branch: "main",
          id: 2,
          name: "hw2",
        },
      }
    if (url === "/assignments/12")
      return {
        id: 12,
        slug: "essay",
        title: "Essay",
        type: "individual",
        deadline: null,
        max_teams: null,
        invite_link: "",
        public_repo: true,
        starter_code_repository: null,
      }
    // Source template reads
    if (url === "/repos/src/hw1") return { is_template: true }
    if (url === "/repos/src/hw2") return { is_template: false }
    // Target template probes (with or without a suffix)
    if (/^\/repos\/dst\/hw1(-|$)/.test(url)) {
      if (opts.targetHw1Exists && url === "/repos/dst/hw1")
        return { is_template: true, default_branch: "main", private: false }
      throw notFound(url)
    }
    if (/^\/repos\/dst\/hw2(-|$)/.test(url)) throw notFound(url)
    // Config repo existence
    if (url === "/repos/dst/classroom50") {
      if (opts.configRepo === false) throw notFound(url)
      return { default_branch: "main" }
    }
    // Dir existence
    if (url.startsWith("/repos/dst/classroom50/contents/")) {
      if (opts.dirExists) return { type: "file" }
      throw notFound(url)
    }
    throw new Error(`unexpected: ${url}`)
  })
  return { request } as unknown as GitHubClient
}

describe("buildPreflight", () => {
  it("classifies items and derives the short-name", async () => {
    const plan = await buildPreflight(makeClient({}), {
      source: "1",
      targetOrg: "dst",
    })
    expect(plan.shortName).toBe("cs-50")
    expect(plan.name).toBe("CS 50")
    expect(plan.counts).toEqual({ import: 2, reuse: 0, skip: 1 })
    expect(plan.blockers).toHaveLength(0)
    const skip = plan.items.find((i) => i.action === "skip")
    expect(skip?.reason?.key).toBe("migration.reason.sourceNotTemplate")
    const templateLess = plan.items.find((i) => i.templateLess)
    expect(templateLess?.action).toBe("import")
    expect(templateLess?.assignment.slug).toBe("essay")
  })

  it("honors an overridden class name", async () => {
    const plan = await buildPreflight(makeClient({}), {
      source: "1",
      targetOrg: "dst",
      name: "My Class",
    })
    expect(plan.name).toBe("My Class")
  })

  it("reuse when the target template already exists", async () => {
    const plan = await buildPreflight(makeClient({ targetHw1Exists: true }), {
      source: "1",
      targetOrg: "dst",
    })
    expect(plan.counts.reuse).toBe(1)
  })

  it("blocks with needs_org_setup when the config repo is absent", async () => {
    const plan = await buildPreflight(makeClient({ configRepo: false }), {
      source: "1",
      targetOrg: "dst",
    })
    expect(plan.blockers).toEqual([
      { kind: "needs_org_setup", params: { org: "dst" } },
    ])
  })

  it("blocks with dir_exists when the short-name dir is taken", async () => {
    const plan = await buildPreflight(makeClient({ dirExists: true }), {
      source: "1",
      targetOrg: "dst",
    })
    expect(plan.blockers).toEqual([
      { kind: "dir_exists", params: { shortName: "cs-50" } },
    ])
  })

  it("honors an explicit short-name and template-suffix", async () => {
    const plan = await buildPreflight(makeClient({}), {
      source: "1",
      targetOrg: "dst",
      shortName: "cs50-fall",
      templateSuffix: "f26",
    })
    expect(plan.shortName).toBe("cs50-fall")
    expect(plan.items[0].targetName).toBe("hw1-f26")
  })
})
