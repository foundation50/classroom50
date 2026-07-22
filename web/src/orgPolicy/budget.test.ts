import { describe, expect, it } from "vitest"

import {
  BUDGET_PRODUCT_SKU_ACTIONS,
  BUDGET_SCOPE_ORG,
  BUDGET_WARN_THRESHOLD,
  classifyBudget,
  type Budget,
} from "./budget"

// Web mirror of the CLI's ClassifyBudget tier tests
// (cli/gh-teacher/internal/orgpolicy/budget_test.go). A divergence here is a
// parity bug.

function actions(amount: number, prevent: boolean): Budget {
  return {
    budget_scope: BUDGET_SCOPE_ORG,
    budget_product_sku: BUDGET_PRODUCT_SKU_ACTIONS,
    budget_amount: amount,
    prevent_further_usage: prevent,
  }
}

describe("classifyBudget", () => {
  it.each([
    { name: "no budgets", budgets: [] as Budget[], tier: "missing" },
    {
      name: "unrelated sku only",
      budgets: [
        {
          budget_scope: BUDGET_SCOPE_ORG,
          budget_product_sku: "packages",
          budget_amount: 0,
          prevent_further_usage: true,
        },
      ],
      tier: "missing",
    },
    {
      name: "wrong scope",
      budgets: [
        {
          budget_scope: "repository",
          budget_product_sku: BUDGET_PRODUCT_SKU_ACTIONS,
          budget_amount: 0,
          prevent_further_usage: true,
        },
      ],
      tier: "missing",
    },
    {
      name: "$0 hard-stop enforced",
      budgets: [actions(0, true)],
      tier: "enforced",
    },
    {
      name: "$0 alert-only missing",
      budgets: [actions(0, false)],
      tier: "missing",
    },
    { name: "$1 hard-stop ok", budgets: [actions(1, true)], tier: "ok" },
    {
      name: "$50 hard-stop ok (boundary)",
      budgets: [actions(BUDGET_WARN_THRESHOLD, true)],
      tier: "ok",
    },
    {
      name: "$50 alert-only missing",
      budgets: [actions(BUDGET_WARN_THRESHOLD, false)],
      tier: "missing",
    },
    {
      name: "$51 hard-stop warns (boundary)",
      budgets: [actions(BUDGET_WARN_THRESHOLD + 1, true)],
      tier: "warn",
    },
    {
      name: "$100 alert-only is missing (stops no spend)",
      budgets: [actions(100, false)],
      tier: "missing",
    },
  ])("$name -> $tier", ({ budgets, tier }) => {
    expect(classifyBudget(budgets).tier).toBe(tier)
  })

  it("carries amount and hard-stop flag", () => {
    const v = classifyBudget([actions(75, true)])
    expect(v.tier).toBe("warn")
    expect(v.amount).toBe(75)
    expect(v.preventsUsage).toBe(true)
  })

  it("classifies the org+actions budget, ignoring other scopes/skus", () => {
    const budgets: Budget[] = [
      {
        budget_scope: "repository",
        budget_product_sku: BUDGET_PRODUCT_SKU_ACTIONS,
        budget_amount: 999,
        prevent_further_usage: true,
      },
      {
        budget_scope: BUDGET_SCOPE_ORG,
        budget_product_sku: "packages",
        budget_amount: 999,
        prevent_further_usage: true,
      },
      actions(0, true),
    ]
    expect(classifyBudget(budgets).tier).toBe("enforced")
  })
})
