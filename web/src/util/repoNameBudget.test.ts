import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  CLASSROOM_SHORT_NAME_MAX_LEN,
  GITHUB_LOGIN_MAX_LEN,
  GITHUB_REPO_NAME_MAX_LEN,
  REPO_NAME_SLUG_BUDGET,
  assignmentSlugBudget,
  composedRepoNameFits,
} from "./repoNameBudget"

// Same golden constants and cases the Go contract test asserts
// (contract_test.go TestRepoNameBudget_SharedFixtureParity), so this mirror
// can't drift from the single source in cli/shared/contract.
const fixtureUrl = new URL(
  "../../../cli/shared/testdata/repo_name_budget_cases.json",
  import.meta.url,
)
const doc = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), "utf8")) as {
  github_repo_name_max_len: number
  github_login_max_len: number
  repo_name_slug_budget: number
  classroom_short_name_max_len: number
  cases: {
    classroom: string
    slug: string
    worst_case: number
    fits: boolean
  }[]
}

describe("repo-name budget — shared fixture parity", () => {
  it("pins the constants to the fixture", () => {
    expect(GITHUB_REPO_NAME_MAX_LEN).toBe(doc.github_repo_name_max_len)
    expect(GITHUB_LOGIN_MAX_LEN).toBe(doc.github_login_max_len)
    expect(REPO_NAME_SLUG_BUDGET).toBe(doc.repo_name_slug_budget)
    expect(CLASSROOM_SHORT_NAME_MAX_LEN).toBe(doc.classroom_short_name_max_len)
  })

  it("has cases", () => {
    expect(doc.cases.length).toBeGreaterThan(0)
  })

  it.each(doc.cases)("composedRepoNameFits($classroom, $slug)", (c) => {
    expect(composedRepoNameFits(c.classroom, c.slug)).toEqual({
      worstCase: c.worst_case,
      fits: c.fits,
    })
    // The two budget views must agree: a slug fits exactly when it spends no
    // more than the classroom's remaining budget.
    expect(c.slug.length <= assignmentSlugBudget(c.classroom)).toBe(c.fits)
  })
})
