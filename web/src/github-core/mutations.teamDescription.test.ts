import { describe, expect, it, vi } from "vitest"

import { reconcileStudentTeamDescription } from "./mutations"
import type { GitHubClient } from "./client"

// A fake client covering the reads reconcileStudentTeamDescription makes: the
// classroom.json contents read (requestRaw) and the team GET/PATCH (request).
function makeClient(opts: {
  classroomJson: Record<string, unknown>
  team: { slug: string; privacy: string; description: string | null }
}) {
  const patched: { body: unknown }[] = []

  const requestRaw = vi.fn(async (path: string): Promise<string> => {
    if (path.includes("/contents/") && path.includes("classroom.json")) {
      return JSON.stringify(opts.classroomJson)
    }
    throw new Error(`unexpected requestRaw: ${path}`)
  })

  const request = vi.fn(
    async (path: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? "GET"
      if (method === "GET" && /\/orgs\/[^/]+\/teams\/[^/]+$/.test(path)) {
        return {
          id: 42,
          name: opts.team.slug,
          slug: opts.team.slug,
          privacy: opts.team.privacy,
          description: opts.team.description,
        }
      }
      if (method === "PATCH" && /\/orgs\/[^/]+\/teams\/[^/]+$/.test(path)) {
        patched.push({ body: init?.body })
        return undefined
      }
      throw new Error(`unexpected request: ${method} ${path}`)
    },
  )

  return {
    client: { request, requestRaw } as unknown as GitHubClient,
    patched,
  }
}

const classroom = (over: Record<string, unknown> = {}) => ({
  schema: "classroom50/classroom/v1",
  short_name: "cs101",
  name: "Intro CS",
  term: "Fall 2026",
  org: "acme",
  team: { id: 42, slug: "classroom50-cs101" },
  ...over,
})

describe("reconcileStudentTeamDescription", () => {
  it("PATCHes the description when it drifts from the desired record", async () => {
    const { client, patched } = makeClient({
      classroomJson: classroom({ secret: "a1b2c3d4" }),
      team: {
        slug: "classroom50-cs101",
        privacy: "secret",
        description: null,
      },
    })

    const result = await reconcileStudentTeamDescription(
      client,
      "acme",
      "cs101",
    )

    expect(result).toEqual({ changed: true, slug: "classroom50-cs101" })
    expect(patched).toHaveLength(1)
    const body = patched[0].body as { description: string }
    expect(JSON.parse(body.description)).toEqual({
      schema: "classroom50/team/v1",
      name: "Intro CS",
      term: "Fall 2026",
      secret: "a1b2c3d4",
    })
  })

  it("is a no-op when the description already matches (idempotent)", async () => {
    const desired = JSON.stringify({
      schema: "classroom50/team/v1",
      name: "Intro CS",
      term: "Fall 2026",
    })
    const { client, patched } = makeClient({
      classroomJson: classroom(),
      team: {
        slug: "classroom50-cs101",
        privacy: "secret",
        description: desired,
      },
    })

    const result = await reconcileStudentTeamDescription(
      client,
      "acme",
      "cs101",
    )

    expect(result).toEqual({ changed: false })
    expect(patched).toHaveLength(0)
  })

  it("skips a non-secret team rather than leaking the record", async () => {
    const { client, patched } = makeClient({
      classroomJson: classroom({ secret: "a1b2c3d4" }),
      team: {
        slug: "classroom50-cs101",
        privacy: "closed",
        description: null,
      },
    })

    const result = await reconcileStudentTeamDescription(
      client,
      "acme",
      "cs101",
    )

    expect(result).toEqual({ changed: false })
    expect(patched).toHaveLength(0)
  })

  it("marks an archived classroom active:false in the record", async () => {
    const { client, patched } = makeClient({
      classroomJson: classroom({ active: false }),
      team: {
        slug: "classroom50-cs101",
        privacy: "secret",
        description: null,
      },
    })

    await reconcileStudentTeamDescription(client, "acme", "cs101")

    const body = patched[0].body as { description: string }
    expect(JSON.parse(body.description).active).toBe(false)
  })
})
