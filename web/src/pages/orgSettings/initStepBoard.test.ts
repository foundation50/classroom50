import { describe, expect, it } from "vitest"

import type { InitStepId } from "@/hooks/github/mutations"
import {
  INIT_STEP_META,
  INIT_STEP_ORDER,
  applyStepUpdate,
  initialInitSteps,
} from "./initStepBoard"

// The board is the single source of truth shared by the org setup wizard and
// the re-run surface. These guard against the three ways the surfaces could
// drift: a step missing from the order, a step missing its explanation, or a
// settings link that no longer points at the org/repo it's supposed to.

describe("init step board metadata", () => {
  it("orders, initial state, and explanations cover the exact same steps", () => {
    const order = [...INIT_STEP_ORDER].sort()
    const initial = Object.keys(initialInitSteps).sort()
    const meta = Object.keys(INIT_STEP_META).sort()

    expect(order).toEqual(initial)
    expect(order).toEqual(meta)
  })

  it("every step explains what it does, why, and how to recover", () => {
    for (const id of INIT_STEP_ORDER) {
      const m = INIT_STEP_META[id]
      expect(m.what.length, `${id}.what`).toBeGreaterThan(0)
      expect(m.why.length, `${id}.why`).toBeGreaterThan(0)
      expect(m.remediation.length, `${id}.remediation`).toBeGreaterThan(0)
    }
  })

  it("settings links target the org or the classroom50 repo for that org", () => {
    const org = "acme-school"
    for (const id of INIT_STEP_ORDER) {
      const url = INIT_STEP_META[id].settingsUrl(org)
      if (url === null) continue
      expect(url, id).toMatch(
        new RegExp(
          `^https://github\\.com/(organizations/${org}/settings|${org}/classroom50/settings)`,
        ),
      )
    }
  })

  it("repo + file creation steps have no single settings page to deep-link", () => {
    expect(INIT_STEP_META.configRepo.settingsUrl("acme-school")).toBeNull()
    expect(INIT_STEP_META.skeleton.settingsUrl("acme-school")).toBeNull()
  })
})

describe("applyStepUpdate", () => {
  it("merges a partial update onto an existing step without dropping fields", () => {
    const id: InitStepId = "pages"
    const next = applyStepUpdate(initialInitSteps, {
      id,
      status: "warning",
      message: "Pages needs Team or Enterprise",
    })

    expect(next.pages.status).toBe("warning")
    expect(next.pages.message).toBe("Pages needs Team or Enterprise")
    // Title from the initial state is preserved by the merge.
    expect(next.pages.title).toBe(initialInitSteps.pages.title)
    // Other steps are untouched.
    expect(next.orgDefaults).toBe(initialInitSteps.orgDefaults)
  })
})
