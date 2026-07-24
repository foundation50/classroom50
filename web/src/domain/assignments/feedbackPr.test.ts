import { describe, it, expect, vi } from "vitest"

import ensureFeedbackPrPySource from "../../../../cli/gh-teacher/skeleton/dotgithub/scripts/ensure_feedback_pr.py?raw"
import {
  FEEDBACK_BASE_BRANCH,
  FEEDBACK_PR_TITLE,
  FEEDBACK_OPEN_COMMIT_MESSAGE,
  feedbackLabelForMode,
  feedbackPrBody,
  ensureFeedbackPullRequest,
} from "./feedbackPr"
import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"

// ---------------------------------------------------------------------------
// Cross-language parity: the runner's ensure_feedback_pr.py is the de-facto
// source of truth for the Feedback PR's title/labels/body; the TS copies have
// NO compile-time link to it (or to cli/shared/contract). These read the
// actual python source so a one-sided edit fails the web build too.
// ---------------------------------------------------------------------------
describe("feedback PR contract parity vs ensure_feedback_pr.py", () => {
  it("pins the base branch to the python BASE_BRANCH", () => {
    expect(ensureFeedbackPrPySource).toContain(
      `BASE_BRANCH = "${FEEDBACK_BASE_BRANCH}"`,
    )
  })

  it("pins the PR title", () => {
    expect(FEEDBACK_PR_TITLE).toBe("Feedback")
    expect(ensureFeedbackPrPySource).toContain(`"${FEEDBACK_PR_TITLE}"`)
  })

  it("pins the mode labels and colors to the python _LABELS", () => {
    for (const mode of ["individual", "group"] as const) {
      const { name, color } = feedbackLabelForMode(mode)
      expect(ensureFeedbackPrPySource).toContain(`("${name}", "${color}")`)
    }
    // Unknown modes fall back to individual, like python's label_for_mode.
    expect(feedbackLabelForMode("")).toEqual(feedbackLabelForMode("individual"))
    expect(feedbackLabelForMode(" GROUP ")).toEqual(
      feedbackLabelForMode("group"),
    )
  })

  it("mirrors pr_body's load-bearing fragments", () => {
    const body = feedbackPrBody("HEAD_BRANCH", "RELEASE_URL")
    for (const fragment of [
      ":wave:! Classroom 50 opened this pull request as a place for your ",
      "**Don't close or merge this pull request** unless your teacher tells you to.",
      "the **Subscribe** button to be notified when that happens.",
    ]) {
      expect(body).toContain(fragment)
      expect(ensureFeedbackPrPySource).toContain(fragment)
    }
  })

  it("embeds the release URL (the runner's backfill trigger)", () => {
    // backfill_release_link() rewrites any OPEN PR body lacking the
    // releases/latest link — an accept-time body without it would be
    // clobbered on the first submission.
    const body = feedbackPrBody(
      "main",
      "https://github.com/o/r/releases/latest",
    )
    expect(body).toContain("https://github.com/o/r/releases/latest")
  })

  it("keeps [skip ci] in the empty commit message", () => {
    expect(FEEDBACK_OPEN_COMMIT_MESSAGE).toBe(
      "[Classroom 50] Open Feedback PR (gh student accept)\n\n[skip ci]",
    )
  })
})

// ---------------------------------------------------------------------------
// Orchestration. A minimal fake GitHubClient records requests; scenarios
// mirror the CLI's feedback_pr_test.go so the two implementations can't
// drift in behavior.
// ---------------------------------------------------------------------------

type Call = { url: string; method: string; body?: unknown }

function apiError(status: number, message: string): GitHubAPIError {
  return new GitHubAPIError({
    status,
    url: "https://api.github.com/test",
    message,
    body: { message },
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

// Scriptable client: `existingPr` short-circuits; `headHasDiff` skips the
// zero-diff 422; `failPrCreate` hard-fails every pulls POST.
function fakeClient(opts: {
  existingPr?: { number: number; state: string }
  headHasDiff?: boolean
  failPrCreate?: boolean
}) {
  const calls: Call[] = []
  let refPatched = false

  const request = vi.fn(
    async (url: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? "GET"
      calls.push({ url, method, body: init?.body })

      if (url.startsWith("/repos/o/r/pulls?")) {
        return opts.existingPr ? [opts.existingPr] : []
      }
      if (url === "/repos/o/r/pulls" && method === "POST") {
        if (opts.failPrCreate) {
          throw apiError(403, "Resource not accessible by integration")
        }
        if (!opts.headHasDiff && !refPatched) {
          throw apiError(422, "No commits between feedback and main")
        }
        return {
          number: 1,
          state: "open",
          html_url: "https://github.com/o/r/pull/1",
        }
      }
      if (url === "/repos/o/r/git/refs" && method === "POST") return {}
      if (url === "/repos/o/r/git/ref/heads/main") {
        return { object: { sha: "accept-sha" } }
      }
      if (url === "/repos/o/r/git/commits/accept-sha") {
        return { sha: "accept-sha", tree: { sha: "tree-sha" } }
      }
      if (url === "/repos/o/r/git/commits" && method === "POST") {
        return { sha: "empty-sha" }
      }
      if (url === "/repos/o/r/git/refs/heads/main" && method === "PATCH") {
        refPatched = true
        return {}
      }
      if (url === "/repos/o/r/labels" && method === "POST") return {}
      if (url === "/repos/o/r/issues/1/labels" && method === "POST") return []
      throw new Error(`unexpected request: ${method} ${url}`)
    },
  )

  const client = { request } as unknown as GitHubClient
  return { client, calls }
}

const writeCalls = (calls: Call[]) => calls.filter((c) => c.method !== "GET")

describe("ensureFeedbackPullRequest", () => {
  it("fresh accept: freezes base, lands ONE [skip ci] empty commit, retries the PR, labels it", async () => {
    const { client, calls } = fakeClient({})
    const result = await ensureFeedbackPullRequest({
      client,
      owner: "o",
      repo: "r",
      branch: "main",
      acceptCommitSha: "accept-sha",
      mode: "individual",
    })
    expect(result).toEqual({ ok: true, created: true })

    const refCreate = calls.find(
      (c) => c.url === "/repos/o/r/git/refs" && c.method === "POST",
    )
    expect(refCreate?.body).toEqual({
      ref: `refs/heads/${FEEDBACK_BASE_BRANCH}`,
      sha: "accept-sha",
    })

    const commits = calls.filter(
      (c) => c.url === "/repos/o/r/git/commits" && c.method === "POST",
    )
    expect(commits).toHaveLength(1)
    expect(commits[0].body).toEqual({
      message: FEEDBACK_OPEN_COMMIT_MESSAGE,
      // Same tree as the head — a different tree would be a non-empty commit.
      tree: "tree-sha",
      parents: ["accept-sha"],
    })

    const prCreates = calls.filter(
      (c) => c.url === "/repos/o/r/pulls" && c.method === "POST",
    )
    expect(prCreates).toHaveLength(2) // zero-diff 422, then success
    const pr = prCreates[1].body as Record<string, string>
    expect(pr.base).toBe(FEEDBACK_BASE_BRANCH)
    expect(pr.head).toBe("main")
    expect(pr.title).toBe(FEEDBACK_PR_TITLE)
    expect(pr.body).toContain("https://github.com/o/r/releases/latest")

    const labelAdd = calls.find((c) => c.url === "/repos/o/r/issues/1/labels")
    expect(labelAdd?.body).toEqual({ labels: ["Individual Assignment"] })
  })

  it("group mode applies the Group Assignment label", async () => {
    const { client, calls } = fakeClient({})
    await ensureFeedbackPullRequest({
      client,
      owner: "o",
      repo: "r",
      branch: "main",
      acceptCommitSha: "accept-sha",
      mode: "group",
    })
    const labelAdd = calls.find((c) => c.url === "/repos/o/r/issues/1/labels")
    expect(labelAdd?.body).toEqual({ labels: ["Group Assignment"] })
  })

  it.each(["open", "closed", "merged"])(
    "re-accept with an existing %s PR is read-only",
    async (state) => {
      const { client, calls } = fakeClient({
        existingPr: { number: 7, state },
      })
      const result = await ensureFeedbackPullRequest({
        client,
        owner: "o",
        repo: "r",
        branch: "main",
        acceptCommitSha: "accept-sha",
        mode: "individual",
      })
      expect(result).toEqual({ ok: true, created: false })
      expect(writeCalls(calls)).toHaveLength(0)
    },
  )

  it("does not push a second empty commit when the head already has a diff", async () => {
    const { client, calls } = fakeClient({ headHasDiff: true })
    const result = await ensureFeedbackPullRequest({
      client,
      owner: "o",
      repo: "r",
      branch: "main",
      acceptCommitSha: "accept-sha",
      mode: "individual",
    })
    expect(result).toEqual({ ok: true, created: true })
    expect(
      calls.filter(
        (c) => c.url === "/repos/o/r/git/commits" && c.method === "POST",
      ),
    ).toHaveLength(0)
  })

  it("resolves {ok: false} instead of throwing on a hard failure", async () => {
    const { client } = fakeClient({ failPrCreate: true })
    const result = await ensureFeedbackPullRequest({
      client,
      owner: "o",
      repo: "r",
      branch: "main",
      acceptCommitSha: "accept-sha",
      mode: "individual",
    })
    expect(result.ok).toBe(false)
  })
})
