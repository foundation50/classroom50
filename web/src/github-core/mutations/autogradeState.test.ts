import { describe, expect, it, vi } from "vitest"

import {
  AUTOGRADE_WORKFLOW_FILE,
  getAutogradeState,
  setAutogradeState,
} from "./autogradeState"
import { GitHubAPIError } from "../errors"
import type { GitHubClient } from "../client"

const ORG = "cs50"
const REPO = "cs50-fall-2026-hello-alice"
const workflowPath = `/repos/${ORG}/${REPO}/actions/workflows/${AUTOGRADE_WORKFLOW_FILE}`

function apiError(status: number): GitHubAPIError {
  return new GitHubAPIError({
    status,
    url: workflowPath,
    message: `HTTP ${status}`,
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

describe("AUTOGRADE_WORKFLOW_FILE", () => {
  it("is the shim's basename (byte-mirror of AUTOGRADE_SHIM_PATH)", () => {
    expect(AUTOGRADE_WORKFLOW_FILE).toBe("autograde.yaml")
  })
})

describe("getAutogradeState", () => {
  const call = (state: string | GitHubAPIError) => {
    const request = vi.fn(async (path: string) => {
      if (path !== workflowPath) throw new Error(`unexpected request: ${path}`)
      if (state instanceof GitHubAPIError) throw state
      return { state }
    })
    const client = { request } as unknown as GitHubClient
    return { client, request }
  }

  it("maps active -> enabled", async () => {
    const { client } = call("active")
    await expect(
      getAutogradeState({ client, org: ORG, repo: REPO }),
    ).resolves.toBe("enabled")
  })

  it("maps disabled_manually -> paused", async () => {
    const { client } = call("disabled_manually")
    await expect(
      getAutogradeState({ client, org: ORG, repo: REPO }),
    ).resolves.toBe("paused")
  })

  it("maps GitHub-imposed disables -> pausedByGitHub", async () => {
    for (const s of ["disabled_fork", "disabled_inactivity"]) {
      const { client } = call(s)
      await expect(
        getAutogradeState({ client, org: ORG, repo: REPO }),
      ).resolves.toBe("pausedByGitHub")
    }
  })

  it("maps deleted / unknown -> notGradable", async () => {
    for (const s of ["deleted", "something_new"]) {
      const { client } = call(s)
      await expect(
        getAutogradeState({ client, org: ORG, repo: REPO }),
      ).resolves.toBe("notGradable")
    }
  })

  it("treats a 404 (no workflow / not accepted) as notGradable, not an error", async () => {
    const { client } = call(apiError(404))
    await expect(
      getAutogradeState({ client, org: ORG, repo: REPO }),
    ).resolves.toBe("notGradable")
  })

  it("propagates non-404 errors (rate limit, permission)", async () => {
    const err = apiError(403)
    const { client } = call(err)
    await expect(
      getAutogradeState({ client, org: ORG, repo: REPO }),
    ).rejects.toBe(err)
  })
})

describe("setAutogradeState", () => {
  const call = (result: "ok" | GitHubAPIError) => {
    const request = vi.fn(async () => {
      if (result instanceof GitHubAPIError) throw result
      return undefined
    })
    const client = { request } as unknown as GitHubClient
    return { client, request }
  }

  it("pause PUTs the disable endpoint", async () => {
    const { client, request } = call("ok")
    const out = await setAutogradeState({
      client,
      org: ORG,
      repo: REPO,
      action: "pause",
    })
    expect(out).toEqual({ status: "ok" })
    expect(request).toHaveBeenCalledWith(`${workflowPath}/disable`, {
      method: "PUT",
    })
  })

  it("resume PUTs the enable endpoint", async () => {
    const { client, request } = call("ok")
    const out = await setAutogradeState({
      client,
      org: ORG,
      repo: REPO,
      action: "resume",
    })
    expect(out).toEqual({ status: "ok" })
    expect(request).toHaveBeenCalledWith(`${workflowPath}/enable`, {
      method: "PUT",
    })
  })

  it("returns notGradable on a 404 (no autograde workflow)", async () => {
    const { client } = call(apiError(404))
    await expect(
      setAutogradeState({ client, org: ORG, repo: REPO, action: "pause" }),
    ).resolves.toEqual({ status: "notGradable" })
  })

  it("propagates a non-404 failure (rate limit, permission)", async () => {
    const err = apiError(403)
    const { client } = call(err)
    await expect(
      setAutogradeState({ client, org: ORG, repo: REPO, action: "resume" }),
    ).rejects.toBe(err)
  })
})
