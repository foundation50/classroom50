// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts down.
import { describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import { copyOneTemplate } from "./templateCopy"
import type { ClassroomAssignmentDetail, MigrationItem } from "./types"

const emptyRateLimit = {
  limit: null,
  remaining: null,
  reset: null,
  used: null,
  resource: null,
  retryAfter: null,
}

const assignment: ClassroomAssignmentDetail = {
  id: 5,
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
    private: true,
    default_branch: "main",
  },
}

const importItem: MigrationItem = {
  assignment,
  action: "import",
  targetName: "hw1",
  targetPrivate: true,
}

describe("copyOneTemplate — import", () => {
  it("generates, marks as template, waits, and returns the ref", async () => {
    const calls: string[] = []
    const request = vi.fn(
      async (url: string, init?: { method?: string; body?: unknown }) => {
        calls.push(`${init?.method ?? "GET"} ${url}`)
        if (url === "/repos/src/hw1/generate") {
          expect(
            (init?.body as { include_all_branches: boolean })
              .include_all_branches,
          ).toBe(true)
          expect((init?.body as { private: boolean }).private).toBe(true)
          return { default_branch: "main" }
        }
        if (init?.method === "PATCH" && url === "/repos/dst/hw1") {
          expect((init?.body as { is_template: boolean }).is_template).toBe(
            true,
          )
          return {}
        }
        if (url.includes("/git/ref/heads/main")) return { object: { sha: "s" } }
        throw new Error(`unexpected: ${init?.method} ${url}`)
      },
    )
    const client = { request } as unknown as GitHubClient

    const res = await copyOneTemplate(client, "dst", 42, importItem)
    expect(res).toEqual({
      owner: "dst",
      repo: "hw1",
      branch: "main",
      private: true,
    })
    expect(calls).toContain("POST /repos/src/hw1/generate")
    expect(calls).toContain("PATCH /repos/dst/hw1")
  })

  it("propagates a generate failure (caller downgrades to skip)", async () => {
    const request = vi.fn(async (url: string) => {
      if (url.endsWith("/generate")) throw new Error("boom")
      throw new Error(`unexpected ${url}`)
    })
    const client = { request } as unknown as GitHubClient
    await expect(copyOneTemplate(client, "dst", 1, importItem)).rejects.toThrow(
      /boom/,
    )
  })

  it("gives an actionable cross-org message on a 403 from the source", async () => {
    const request = vi.fn(async (url: string) => {
      if (url.endsWith("/generate"))
        throw new GitHubAPIError({
          status: 403,
          url,
          message: "Resource not accessible by integration",
          body: null,
          rateLimit: emptyRateLimit,
        })
      throw new Error(`unexpected ${url}`)
    })
    const client = { request } as unknown as GitHubClient
    // importItem's source is src/hw1 (org "src"), target org "dst" — cross-org.
    await expect(copyOneTemplate(client, "dst", 1, importItem)).rejects.toThrow(
      /approve the Classroom 50 app for the "src" organization/,
    )
  })

  it("succeeds once the branch ref resolves", async () => {
    const request = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.endsWith("/generate")) return { default_branch: "main" }
      if (init?.method === "PATCH") return {}
      if (url.includes("/git/ref/heads/main")) return { object: { sha: "s" } }
      throw new Error(`unexpected ${url}`)
    })
    const client = { request } as unknown as GitHubClient
    const res = await copyOneTemplate(client, "dst", 1, importItem)
    expect(res?.branch).toBe("main")
  })
})

describe("copyOneTemplate — reuse", () => {
  it("returns the existing ref without generating", async () => {
    const request = vi.fn(async () => {
      throw new Error("no network expected on reuse")
    })
    const client = { request } as unknown as GitHubClient
    const reuse: MigrationItem = {
      assignment,
      action: "reuse",
      targetName: "hw1",
      branch: "trunk",
      targetPrivate: false,
    }
    const res = await copyOneTemplate(client, "dst", 1, reuse)
    expect(res).toEqual({
      owner: "dst",
      repo: "hw1",
      branch: "trunk",
      private: false,
    })
    expect(request).not.toHaveBeenCalled()
  })
})

describe("copyOneTemplate — template-less", () => {
  it("returns null and makes no network calls", async () => {
    const request = vi.fn(async () => {
      throw new Error("no network expected for template-less")
    })
    const client = { request } as unknown as GitHubClient
    const item: MigrationItem = {
      assignment: { ...assignment, starter_code_repository: null },
      action: "import",
      targetName: "test",
      templateLess: true,
    }
    const res = await copyOneTemplate(client, "dst", 1, item)
    expect(res).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })
})
