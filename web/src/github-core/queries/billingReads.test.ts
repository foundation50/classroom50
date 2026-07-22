import { describe, expect, it } from "vitest"

import {
  getOrgActionsUsage,
  getOrgActionsBudget,
  includedActionsMinutes,
} from "./billingReads"
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
  it("sums total Actions minutes (grossQuantity) across SKUs, ignoring other products", async () => {
    const request = async () => ({
      usageItems: [
        {
          product: "Actions",
          sku: "actions_linux",
          unitType: "minutes",
          grossQuantity: 200,
          netAmount: 1.5,
        },
        {
          product: "actions",
          sku: "actions_macos",
          unitType: "minutes",
          grossQuantity: 50,
          netAmount: 4.0,
        },
        {
          product: "Actions",
          sku: "actions_storage",
          unitType: "gigabyte-hours",
          grossQuantity: 0.5,
          netAmount: 0.1,
        },
        {
          product: "Codespaces",
          sku: "Compute",
          unitType: "Hours",
          grossQuantity: 3,
          netAmount: 9.0,
        },
      ],
    })
    const client = { request } as unknown as GitHubClient
    expect(await getOrgActionsUsage(client, org)).toEqual({
      minutes: 250,
      netAmountUsd: 5.6,
    })
  })

  it("counts minutes used within the included quota (netQuantity 0, netAmount 0)", async () => {
    // Mirrors the real API for an org still within its plan quota: 466 minutes
    // run, fully discounted — grossQuantity is the true usage, net* are 0.
    const request = async () => ({
      usageItems: [
        {
          product: "Actions",
          sku: "actions_linux",
          unitType: "minutes",
          grossQuantity: 466,
          netQuantity: 0,
          netAmount: 0,
        },
      ],
    })
    const client = { request } as unknown as GitHubClient
    expect(await getOrgActionsUsage(client, org)).toEqual({
      minutes: 466,
      netAmountUsd: 0,
    })
  })

  it("matches a display-name product value ('GitHub Actions'), not just 'actions'", async () => {
    const request = async () => ({
      usageItems: [
        {
          product: "GitHub Actions",
          sku: "actions_linux",
          unitType: "minutes",
          grossQuantity: 300,
          netAmount: 0,
        },
      ],
    })
    const client = { request } as unknown as GitHubClient
    expect(await getOrgActionsUsage(client, org)).toEqual({
      minutes: 300,
      netAmountUsd: 0,
    })
  })

  it("returns null when a non-empty report sums to all-zero (likely preview drift)", async () => {
    // Renamed preview fields read as absent -> every item contributes 0. Don't
    // confidently show "0 min / $0" — treat as unavailable.
    const request = async () => ({
      usageItems: [
        { product: "Actions", sku: "actions_linux", unitType: "minutes" },
      ],
    })
    const client = { request } as unknown as GitHubClient
    expect(await getOrgActionsUsage(client, org)).toBeNull()
  })

  it("returns null (and doesn't throw) on a non-API error", async () => {
    const request = async () => {
      throw new TypeError("boom")
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

describe("includedActionsMinutes", () => {
  it("maps known plans to their monthly quota (case-insensitive)", () => {
    expect(includedActionsMinutes("free")).toBe(2000)
    expect(includedActionsMinutes("Team")).toBe(3000)
    expect(includedActionsMinutes("pro")).toBe(3000)
    expect(includedActionsMinutes("business")).toBe(50000)
    expect(includedActionsMinutes("enterprise")).toBe(50000)
  })

  it("returns null for unknown or missing plans (hide the quota bar)", () => {
    expect(includedActionsMinutes(undefined)).toBeNull()
    expect(includedActionsMinutes("mystery-plan")).toBeNull()
  })
})

describe("getOrgActionsBudget", () => {
  it("classifies a $0 hard-stop cap as enforced", async () => {
    const request = async () => ({
      budgets: [
        {
          budget_scope: "organization",
          budget_product_sku: "actions",
          budget_amount: 0,
          prevent_further_usage: true,
        },
      ],
    })
    const client = { request } as unknown as GitHubClient
    const v = await getOrgActionsBudget(client, org)
    expect(v).toMatchObject({ tier: "enforced", amount: 0 })
  })

  it("classifies no budget as missing", async () => {
    const request = async () => ({ budgets: [] })
    const client = { request } as unknown as GitHubClient
    expect(await getOrgActionsBudget(client, org)).toMatchObject({
      tier: "missing",
    })
  })

  it("returns null when budgets aren't readable (403)", async () => {
    const request = async () => {
      throw apiError(403)
    }
    const client = { request } as unknown as GitHubClient
    expect(await getOrgActionsBudget(client, org)).toBeNull()
  })
})
