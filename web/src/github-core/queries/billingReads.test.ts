import { describe, expect, it } from "vitest"

import { getOrgActionsUsage } from "./billingReads"
import { GitHubAPIError } from "../errors"
import type { GitHubClient } from "../client"

const org = "acme"

const rateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

const apiError = (status: number) =>
  new GitHubAPIError({
    status,
    url: `/organizations/${org}/settings/billing/usage/summary`,
    message: `http ${status}`,
    body: {},
    rateLimit,
  })

describe("getOrgActionsUsage", () => {
  it("sums Actions minutes and net cost across SKUs, ignoring other products", async () => {
    const request = async () => ({
      usageItems: [
        {
          product: "Actions",
          sku: "Actions Linux",
          unitType: "Minutes",
          netAmount: 1.5,
          netQuantity: 200,
        },
        {
          product: "actions",
          sku: "Actions macOS",
          unitType: "minutes",
          netAmount: 4.0,
          netQuantity: 50,
        },
        {
          product: "Codespaces",
          sku: "Compute",
          unitType: "Hours",
          netAmount: 9.0,
          netQuantity: 3,
        },
      ],
    })
    const client = { request } as unknown as GitHubClient
    expect(await getOrgActionsUsage(client, org)).toEqual({
      minutes: 250,
      netAmountUsd: 5.5,
    })
  })

  it("returns null when billing isn't readable (403)", async () => {
    const request = async () => {
      throw apiError(403)
    }
    const client = { request } as unknown as GitHubClient
    expect(await getOrgActionsUsage(client, org)).toBeNull()
  })

  it("returns null when the endpoint is gone (410)", async () => {
    const request = async () => {
      throw apiError(410)
    }
    const client = { request } as unknown as GitHubClient
    expect(await getOrgActionsUsage(client, org)).toBeNull()
  })

  it("handles an empty usage report", async () => {
    const request = async () => ({ usageItems: [] })
    const client = { request } as unknown as GitHubClient
    expect(await getOrgActionsUsage(client, org)).toEqual({
      minutes: 0,
      netAmountUsd: 0,
    })
  })
})
