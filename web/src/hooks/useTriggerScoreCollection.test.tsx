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

import useTriggerScoreCollection, {
  collectScoresLabel,
} from "./useTriggerScoreCollection"
import type { TFunction } from "i18next"

const configFor = (scope?: { classroom: string; assignment?: string }) => {
  configs.length = 0
  renderHook(() => useTriggerScoreCollection("acme", scope))
  return configs[0]
}

// The banner label is the only thing that tells a per-assignment collect from
// a classroom sweep or an org-wide run: the Actions API lists a dispatch run
// without its inputs, so this has to be decided at dispatch time.
describe("collectScoresLabel", () => {
  const t = ((key: string, opts?: Record<string, string>) =>
    opts ? `${key}:${JSON.stringify(opts)}` : key) as unknown as TFunction

  it("stays generic for an org-wide collect", () => {
    expect(collectScoresLabel(t)).toBe("actionsBanner.workflow.collectScores")
  })

  it("names the classroom for a sweep, preferring the display name", () => {
    expect(
      collectScoresLabel(t, { classroom: "cs50" }, { classroom: "CS50" }),
    ).toBe('actionsBanner.workflow.collectScoresClassroom:{"classroom":"CS50"}')
  })

  it("names the assignment and classroom for a single-assignment collect", () => {
    expect(
      collectScoresLabel(
        t,
        { classroom: "cs50", assignment: "hello" },
        { classroom: "CS50", assignment: "Hello world" },
      ),
    ).toBe(
      'actionsBanner.workflow.collectScoresAssignment:{"classroom":"CS50","assignment":"Hello world"}',
    )
  })

  it("falls back to slugs when the page hasn't loaded display names", () => {
    expect(
      collectScoresLabel(t, { classroom: "cs50", assignment: "hello" }),
    ).toBe(
      'actionsBanner.workflow.collectScoresAssignment:{"classroom":"cs50","assignment":"hello"}',
    )
    expect(
      collectScoresLabel(t, { classroom: "cs50" }, { classroom: "" }),
    ).toBe('actionsBanner.workflow.collectScoresClassroom:{"classroom":"cs50"}')
  })
})

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
