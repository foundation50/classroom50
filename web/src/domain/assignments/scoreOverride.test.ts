import { describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import { editScoreOverride } from "./scoreOverride"

const ORG = "acme"
const CLASSROOM = "cs50"
const ASSIGNMENT = "hw1"

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64")

function notFound(url: string): GitHubAPIError {
  return new GitHubAPIError({
    status: 404,
    url,
    message: "Not Found",
    body: null,
    rateLimit: {
      limit: null,
      remaining: null,
      used: null,
      reset: null,
      resource: null,
      retryAfter: null,
    },
  })
}

// A minimal config-repo write mock: branch/ref/commit reads, the scores.json
// contents read (absent -> 404 unless `scores` supplied), and tree/commit/ref
// writes. Captures the committed scores.json content.
function makeClient(scores?: unknown): {
  client: GitHubClient
  committed: () => string
} {
  let committed = ""
  const request = vi.fn(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET"
    if (method === "GET" && /\/repos\/[^/]+\/classroom50$/.test(url)) {
      return { default_branch: "main" }
    }
    if (method === "GET" && url.includes("/git/ref/heads/main")) {
      return { object: { sha: "refsha" } }
    }
    if (method === "GET" && url.includes("/git/commits/refsha")) {
      return { tree: { sha: "basetree" } }
    }
    if (method === "GET" && url.includes("/contents/cs50/scores.json")) {
      if (scores === undefined) throw notFound(url)
      return {
        type: "file",
        encoding: "base64",
        content: b64(JSON.stringify(scores)),
      }
    }
    if (method === "POST" && url.endsWith("/git/trees")) {
      const body = (init as { body?: { tree: { content: string }[] } }).body
      committed = body!.tree[0].content
      return { sha: "newtree" }
    }
    if (method === "POST" && url.endsWith("/git/commits")) {
      return { sha: "newcommit" }
    }
    if (method === "PATCH" && url.includes("/git/refs/heads/main")) {
      return { object: { sha: "newcommit" } }
    }
    throw new Error(`unexpected request: ${method} ${url}`)
  })
  // classroom.json archive guard: 404 -> active.
  const requestRaw = vi.fn(async () => {
    throw notFound("classroom.json")
  })
  return {
    client: { request, requestRaw } as unknown as GitHubClient,
    committed: () => committed,
  }
}

type WrittenScores = {
  schema: string
  assignments: Record<
    string,
    {
      type: string
      entries: {
        owner: string
        override?: boolean
        submissions: {
          submission: string
          score: number
          "max-score": number
          schema: string
        }[]
      }[]
    }
  >
}

describe("editScoreOverride", () => {
  it("seeds an override entry with a valid synthesized record when scores.json is absent", async () => {
    const { client, committed } = makeClient(undefined)
    const result = await editScoreOverride(client, {
      org: ORG,
      classroom: CLASSROOM,
      assignment: ASSIGNMENT,
      owner: "alice",
      assignmentType: "individual",
      score: 42,
      maxPoints: 50,
    })
    expect(result.newCommitSha).toBe("newcommit")

    const written = JSON.parse(committed()) as WrittenScores
    const entry = written.assignments[ASSIGNMENT].entries[0]
    expect(entry.owner).toBe("alice")
    expect(entry.override).toBe(true)
    const rec = entry.submissions[0]
    expect(rec.score).toBe(42)
    expect(rec["max-score"]).toBe(50)
    // The synthesized record satisfies scores-v1: submission matches ^submit/,
    // and it carries the result sentinel.
    expect(rec.submission.startsWith("submit/")).toBe(true)
    expect(rec.schema).toBe("classroom50/result/v1")
  })

  it("overrides an autograded entry in place, preserving the real submission beneath", async () => {
    const scores = {
      schema: "classroom50/scores/v1",
      assignments: {
        [ASSIGNMENT]: {
          type: "individual",
          entries: [
            {
              owner: "alice",
              submissions: [
                {
                  schema: "classroom50/result/v1",
                  classroom: CLASSROOM,
                  assignment_type: "individual",
                  owner: "alice",
                  submission: "submit/2026-01-01T00-00-00Z-abc1234",
                  commit: "c",
                  release: "r",
                  review: "v",
                  datetime: "2026-01-01T00:00:00Z",
                  score: 10,
                  "max-score": 100,
                  tests: [],
                },
              ],
            },
          ],
        },
      },
    }
    const { client, committed } = makeClient(scores)
    await editScoreOverride(client, {
      org: ORG,
      classroom: CLASSROOM,
      assignment: ASSIGNMENT,
      owner: "alice",
      assignmentType: "individual",
      score: 95,
      maxPoints: 100,
    })
    const written = JSON.parse(committed()) as WrittenScores
    const entry = written.assignments[ASSIGNMENT].entries[0]
    expect(entry.override).toBe(true)
    // Override record leads; the real autograded submission is retained beneath.
    expect(entry.submissions[0].score).toBe(95)
    expect(entry.submissions[0].submission.startsWith("submit/manual-")).toBe(
      true,
    )
    expect(entry.submissions[1].submission).toBe(
      "submit/2026-01-01T00-00-00Z-abc1234",
    )
  })

  it("clearing an override-only entry removes it entirely", async () => {
    const scores = {
      schema: "classroom50/scores/v1",
      assignments: {
        [ASSIGNMENT]: {
          type: "individual",
          entries: [
            {
              owner: "alice",
              override: true,
              submissions: [
                {
                  schema: "classroom50/result/v1",
                  classroom: CLASSROOM,
                  assignment_type: "individual",
                  owner: "alice",
                  submission: "submit/manual-2026-01-01T00-00-00Z",
                  commit: "submit/manual-2026-01-01T00-00-00Z",
                  release: "submit/manual-2026-01-01T00-00-00Z",
                  review: "submit/manual-2026-01-01T00-00-00Z",
                  datetime: "2026-01-01T00:00:00Z",
                  score: 5,
                  "max-score": 10,
                  tests: [],
                },
              ],
            },
          ],
        },
      },
    }
    const { client, committed } = makeClient(scores)
    await editScoreOverride(client, {
      org: ORG,
      classroom: CLASSROOM,
      assignment: ASSIGNMENT,
      owner: "alice",
      assignmentType: "individual",
      clear: true,
    })
    const written = JSON.parse(committed()) as WrittenScores
    // The emptied bucket is dropped.
    expect(written.assignments[ASSIGNMENT]).toBeUndefined()
  })

  it("clearing an override over a real submission strips override and restores it", async () => {
    const real = {
      schema: "classroom50/result/v1",
      classroom: CLASSROOM,
      assignment_type: "individual",
      owner: "alice",
      submission: "submit/2026-01-01T00-00-00Z-abc1234",
      commit: "c",
      release: "r",
      review: "v",
      datetime: "2026-01-01T00:00:00Z",
      score: 10,
      "max-score": 100,
      tests: [],
    }
    const manual = { ...real, submission: "submit/manual-2026-02-02T00-00-00Z", score: 90 }
    const scores = {
      schema: "classroom50/scores/v1",
      assignments: {
        [ASSIGNMENT]: {
          type: "individual",
          entries: [{ owner: "alice", override: true, submissions: [manual, real] }],
        },
      },
    }
    const { client, committed } = makeClient(scores)
    await editScoreOverride(client, {
      org: ORG,
      classroom: CLASSROOM,
      assignment: ASSIGNMENT,
      owner: "alice",
      assignmentType: "individual",
      clear: true,
    })
    const written = JSON.parse(committed()) as WrittenScores
    const entry = written.assignments[ASSIGNMENT].entries[0]
    expect(entry.override).toBeUndefined()
    expect(entry.submissions).toHaveLength(1)
    expect(entry.submissions[0].submission).toBe(
      "submit/2026-01-01T00-00-00Z-abc1234",
    )
  })
})
