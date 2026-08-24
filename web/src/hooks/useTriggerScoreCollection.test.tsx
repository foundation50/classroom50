// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}),
}))

vi.mock("@/context/actions/ActionActivityProvider", () => ({
  useActionActivityRegistry: () => ({ register: vi.fn() }),
}))

// Capture the config the tracker primitive is handed: the scope-derived keys
// and timing are this hook's whole job.
const configs: {
  storageKey: string | null
  resetKey: string
  timeoutMs?: number
}[] = []
vi.mock("@/hooks/useGitHubOperation", () => ({
  useGitHubOperation: (config: {
    storageKey: string | null
    resetKey: string
    timeoutMs?: number
  }) => {
    configs.push(config)
    return { trigger: vi.fn(), phase: "idle", run: null, error: null }
  },
}))

import useTriggerScoreCollection from "./useTriggerScoreCollection"

const configFor = (scope?: { classroom: string; assignment?: string }) => {
  configs.length = 0
  renderHook(() => useTriggerScoreCollection("acme", scope))
  return configs[0]
}

describe("useTriggerScoreCollection scope keying", () => {
  it("keeps org-wide, classroom-wide and per-assignment tracking on distinct keys", () => {
    const orgWide = configFor()
    const sweep = configFor({ classroom: "cs50" })
    const one = configFor({ classroom: "cs50", assignment: "hello" })

    expect(orgWide.storageKey).toBe("cl50:collect-scores:acme")
    expect(sweep.storageKey).toBe("cl50:collect-scores:acme:cs50")
    expect(one.storageKey).toBe("cl50:collect-scores:acme:cs50:hello")

    // resetKey re-derives tracking on a target change, so it must separate the
    // same three scopes.
    expect(new Set([orgWide.resetKey, sweep.resetKey, one.resetKey]).size).toBe(
      3,
    )
  })

  it("tracks a classroom sweep against the workflow's 30-minute job cap", () => {
    expect(configFor({ classroom: "cs50" }).timeoutMs).toBe(30 * 60 * 1000)
  })

  it("leaves the default timeout to a per-assignment collect", () => {
    expect(
      configFor({ classroom: "cs50", assignment: "hello" }).timeoutMs,
    ).toBeUndefined()
    expect(configFor().timeoutMs).toBeUndefined()
  })
})
