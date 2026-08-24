import { describe, expect, it, vi } from "vitest"

import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"
import {
  CollectInputsUnsupportedError,
  triggerScoreCollection,
} from "./workflowDispatch"
import type { GitHubClient } from "../client"

const noRateLimit: GitHubRateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

const unexpectedInputs422 = () =>
  new GitHubAPIError({
    status: 422,
    url: "https://api.github.com/x",
    message: "Unexpected inputs provided",
    body: { message: "Unexpected inputs provided" },
    rateLimit: noRateLimit,
  })

// A client stub for the three calls triggerScoreCollection makes: getRepo,
// the baseline runs read, and the dispatch POST (whose behavior varies per
// test via `onDispatch`).
const makeClient = (onDispatch: () => unknown) => {
  const request = vi.fn<(url: string, options?: unknown) => Promise<unknown>>(
    (url) => {
      if (url.endsWith("/repos/acme/classroom50")) {
        return Promise.resolve({ default_branch: "main" })
      }
      if (url.includes("/runs?")) {
        return Promise.resolve({ workflow_runs: [{ id: 41 }] })
      }
      try {
        return Promise.resolve(onDispatch())
      } catch (err) {
        return Promise.reject(err as Error)
      }
    },
  )
  return { client: { request } as unknown as GitHubClient, request }
}

describe("triggerScoreCollection", () => {
  it("dispatches with empty inputs when unscoped", async () => {
    const { client, request } = makeClient(() => ({}))

    const result = await triggerScoreCollection(client, "acme")

    expect(result.sinceRunId).toBe(41)
    const dispatchCall = request.mock.calls.find(([url]) =>
      (url as string).endsWith("/dispatches"),
    )
    expect(dispatchCall?.[1]).toMatchObject({
      method: "POST",
      body: { ref: "main", inputs: {} },
    })
  })

  it("sends classroom + assignment inputs when scoped", async () => {
    const { client, request } = makeClient(() => ({}))

    await triggerScoreCollection(client, "acme", {
      classroom: "cs50",
      assignment: "hello",
    })

    const dispatchCall = request.mock.calls.find(([url]) =>
      (url as string).endsWith("/dispatches"),
    )
    expect(dispatchCall?.[1]).toMatchObject({
      body: { inputs: { classroom: "cs50", assignment: "hello" } },
    })
  })

  // The classroom sweep: `assignment` must be absent, not empty — the workflow
  // treats a present-but-blank input as "collect the whole classroom" too, but
  // an org whose collect-scores.yaml predates the `assignment` input 422s on the
  // key itself.
  it("sends only the classroom input when the scope has no assignment", async () => {
    const { client, request } = makeClient(() => ({}))

    await triggerScoreCollection(client, "acme", { classroom: "cs50" })

    const dispatchCall = request.mock.calls.find(([url]) =>
      (url as string).endsWith("/dispatches"),
    )
    expect(
      (dispatchCall?.[1] as { body: { inputs: Record<string, string> } }).body
        .inputs,
    ).toEqual({ classroom: "cs50" })
  })

  it("maps a scoped 422 'unexpected inputs' to CollectInputsUnsupportedError", async () => {
    const { client } = makeClient(() => {
      throw unexpectedInputs422()
    })

    await expect(
      triggerScoreCollection(client, "acme", {
        classroom: "cs50",
        assignment: "hello",
      }),
    ).rejects.toBeInstanceOf(CollectInputsUnsupportedError)
  })

  it("rethrows an unscoped 422 unchanged (not an outdated-workflow signal)", async () => {
    const { client } = makeClient(() => {
      throw unexpectedInputs422()
    })

    await expect(triggerScoreCollection(client, "acme")).rejects.toBeInstanceOf(
      GitHubAPIError,
    )
  })

  it("rethrows other scoped dispatch errors unchanged", async () => {
    const { client } = makeClient(() => {
      throw new GitHubAPIError({
        status: 403,
        url: "https://api.github.com/x",
        message: "Forbidden",
        body: null,
        rateLimit: noRateLimit,
      })
    })

    await expect(
      triggerScoreCollection(client, "acme", {
        classroom: "cs50",
        assignment: "hello",
      }),
    ).rejects.toBeInstanceOf(GitHubAPIError)
  })
})
