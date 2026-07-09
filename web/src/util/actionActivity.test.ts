import { describe, expect, it } from "vitest"

import {
  isFailureConclusion,
  isRunning,
  orgFromPathname,
  PHASE_LABEL_KEY,
  resolveOpRun,
  runMatchesOp,
  runTimes,
  runUrl,
  trackerPhase,
  workflowFile,
} from "./actionActivity"
import type { GitHubWorkflowRun } from "@/hooks/github/types"
import type { ActionOperation } from "@/context/actions/ActionActivityProvider"
import en from "@/locales/en.json"
import { flattenBundle } from "@/i18n/customLocale"

const run = (over: Partial<GitHubWorkflowRun>): GitHubWorkflowRun =>
  ({
    id: 1,
    status: "in_progress",
    conclusion: null,
    created_at: "2026-07-03T00:00:00Z",
    html_url: "https://github.com/acme/classroom50/actions/runs/1",
    event: "push",
    ...over,
  }) as GitHubWorkflowRun

// A dispatch run carries its workflow file path, which runMatchesOp reads to
// match a sinceRunId-anchored op.
const dispatchRun = (
  id: number,
  workflow: string,
  over: Partial<GitHubWorkflowRun> = {},
): GitHubWorkflowRun =>
  run({
    id,
    event: "workflow_dispatch",
    path: `.github/workflows/${workflow}`,
    ...over,
  })

const op = (over: Partial<ActionOperation>): ActionOperation => ({
  id: "op-1",
  org: "acme",
  label: 'Publishing "hw1" to student site',
  anchor: { kind: "sha", sha: "abc123" },
  startedAt: Date.now(),
  ...over,
})

describe("orgFromPathname", () => {
  it("reads the first segment as the org (no base)", () => {
    expect(orgFromPathname("/acme/cs50/assignments", "")).toBe("acme")
  })

  it("strips the Vite base path before reading the org", () => {
    expect(orgFromPathname("/classroom50/acme/cs50", "/classroom50")).toBe(
      "acme",
    )
    // Trailing slash on the base is tolerated.
    expect(orgFromPathname("/classroom50/acme", "/classroom50/")).toBe("acme")
  })

  it("returns undefined for the org picker and login", () => {
    expect(orgFromPathname("/", "")).toBeUndefined()
    expect(orgFromPathname("/login", "")).toBeUndefined()
    expect(orgFromPathname("/classroom50/", "/classroom50")).toBeUndefined()
  })

  it("decodes a percent-encoded org segment", () => {
    expect(orgFromPathname("/my%20org/cs50", "")).toBe("my org")
  })
})

describe("runUrl", () => {
  it("builds the run page URL from org + run id", () => {
    expect(runUrl("acme", 42)).toBe(
      "https://github.com/acme/classroom50/actions/runs/42",
    )
  })
})

describe("runTimes", () => {
  it("uses run_started_at for start and leaves end open while running", () => {
    const r = run({
      status: "in_progress",
      run_started_at: "2026-07-03T00:00:10Z",
      updated_at: "2026-07-03T00:00:30Z",
    })
    const { startedAtMs, endedAtMs } = runTimes(r)
    expect(startedAtMs).toBe(Date.parse("2026-07-03T00:00:10Z"))
    expect(endedAtMs).toBeUndefined()
  })

  it("sets end from updated_at once completed", () => {
    const r = run({
      status: "completed",
      conclusion: "success",
      run_started_at: "2026-07-03T00:00:10Z",
      updated_at: "2026-07-03T00:02:40Z",
    })
    const { startedAtMs, endedAtMs } = runTimes(r)
    expect(startedAtMs).toBe(Date.parse("2026-07-03T00:00:10Z"))
    expect(endedAtMs).toBe(Date.parse("2026-07-03T00:02:40Z"))
  })

  it("falls back to created_at when run_started_at is absent", () => {
    const r = run({ status: "queued", run_started_at: undefined })
    expect(runTimes(r).startedAtMs).toBe(Date.parse(r.created_at))
  })
})

describe("workflowFile", () => {
  it("extracts the workflow file name from the run path", () => {
    expect(
      workflowFile(run({ path: ".github/workflows/publish-pages.yaml" })),
    ).toBe("publish-pages.yaml")
  })

  it("is undefined when the run has no path", () => {
    expect(workflowFile(run({}))).toBeUndefined()
  })
})

describe("runMatchesOp", () => {
  it("matches a sha op by head_sha", () => {
    expect(runMatchesOp(run({ head_sha: "abc123" }), op({}))).toBe(true)
    expect(runMatchesOp(run({ head_sha: "nope" }), op({}))).toBe(false)
  })

  it("matches a dispatch op by workflow file + newer id", () => {
    const dispatchOp = op({
      anchor: {
        kind: "sinceRunId",
        workflow: "regrade.yaml",
        sinceRunId: 100,
      },
    })
    expect(runMatchesOp(dispatchRun(101, "regrade.yaml"), dispatchOp)).toBe(
      true,
    )
    expect(runMatchesOp(dispatchRun(100, "regrade.yaml"), dispatchOp)).toBe(
      false,
    )
    expect(
      runMatchesOp(dispatchRun(200, "collect-scores.yaml"), dispatchOp),
    ).toBe(false)
  })

  it("null baseline matches a run started at/after the dispatch time", () => {
    const started = Date.now()
    const r = dispatchRun(5, "regrade.yaml", {
      run_started_at: new Date(started + 1000).toISOString(),
    })
    const dispatchOp = op({
      startedAt: started,
      anchor: {
        kind: "sinceRunId",
        workflow: "regrade.yaml",
        sinceRunId: null,
      },
    })
    expect(runMatchesOp(r, dispatchOp)).toBe(true)
  })

  it("null baseline does NOT match a run that started well before the dispatch (later cron/other run)", () => {
    const started = Date.now()
    // A run that started 10 minutes before this op was dispatched — e.g. an
    // earlier cron run only now in the poll window.
    const r = dispatchRun(5, "regrade.yaml", {
      run_started_at: new Date(started - 10 * 60_000).toISOString(),
    })
    const dispatchOp = op({
      startedAt: started,
      anchor: {
        kind: "sinceRunId",
        workflow: "regrade.yaml",
        sinceRunId: null,
      },
    })
    expect(runMatchesOp(r, dispatchOp)).toBe(false)
  })
})

describe("resolveOpRun", () => {
  it("returns null when no run matches yet (still pending)", () => {
    expect(resolveOpRun(op({}), [run({ head_sha: "other" })])).toBeNull()
  })

  it("resolves a sha op to the run with the matching head_sha", () => {
    const target = run({ id: 7, head_sha: "abc123" })
    const resolved = resolveOpRun(op({}), [run({ head_sha: "x" }), target])
    expect(resolved?.id).toBe(7)
  })

  it("resolves a dispatch op to the OLDEST run newer than the baseline", () => {
    const dispatchOp = op({
      anchor: {
        kind: "sinceRunId",
        workflow: "regrade.yaml",
        sinceRunId: 100,
      },
    })
    const runs = [
      dispatchRun(103, "regrade.yaml"),
      dispatchRun(101, "regrade.yaml"),
      dispatchRun(102, "regrade.yaml"),
    ]
    expect(resolveOpRun(dispatchOp, runs)?.id).toBe(101)
  })

  it("excludes already-claimed runs so racing dispatches bind distinctly", () => {
    const dispatchOp = op({
      anchor: {
        kind: "sinceRunId",
        workflow: "regrade.yaml",
        sinceRunId: 100,
      },
    })
    const runs = [
      dispatchRun(101, "regrade.yaml"),
      dispatchRun(102, "regrade.yaml"),
    ]
    const claimed = new Set<number>([101])
    // 101 is taken by an earlier op, so this op binds to 102.
    expect(resolveOpRun(dispatchOp, runs, claimed)?.id).toBe(102)
  })
})

describe("trackerPhase", () => {
  it("is pending when no run is bound", () => {
    expect(trackerPhase(null)).toBe("pending")
  })

  it("is running while the run is in flight", () => {
    expect(trackerPhase(run({ status: "in_progress" }))).toBe("running")
    expect(trackerPhase(run({ status: "queued" }))).toBe("running")
  })

  it("is failed for a completed run with a failure conclusion", () => {
    expect(
      trackerPhase(run({ status: "completed", conclusion: "failure" })),
    ).toBe("failed")
    expect(
      trackerPhase(run({ status: "completed", conclusion: "timed_out" })),
    ).toBe("failed")
  })

  it("is success for a completed run that concluded cleanly", () => {
    expect(
      trackerPhase(run({ status: "completed", conclusion: "success" })),
    ).toBe("success")
    expect(
      trackerPhase(run({ status: "completed", conclusion: "skipped" })),
    ).toBe("success")
  })
})

describe("isRunning", () => {
  it("is true until GitHub reports status 'completed'", () => {
    for (const status of [
      "queued",
      "in_progress",
      "waiting",
      "requested",
      "pending",
    ] as const) {
      expect(isRunning(run({ status }))).toBe(true)
    }
  })

  it("is false once completed (regardless of conclusion)", () => {
    expect(isRunning(run({ status: "completed", conclusion: "failure" }))).toBe(
      false,
    )
    expect(isRunning(run({ status: "completed", conclusion: "success" }))).toBe(
      false,
    )
  })
})

describe("isFailureConclusion", () => {
  it("treats failure/cancelled/timed_out/action_required/stale as failures", () => {
    for (const c of [
      "failure",
      "cancelled",
      "timed_out",
      "action_required",
      "stale",
    ] as const) {
      expect(isFailureConclusion(c)).toBe(true)
    }
  })

  it("treats success/skipped/neutral and null as non-failures", () => {
    for (const c of ["success", "skipped", "neutral", null] as const) {
      expect(isFailureConclusion(c)).toBe(false)
    }
  })
})

describe("PHASE_LABEL_KEY", () => {
  const baseKeys = flattenBundle(en)

  it("maps every tracker phase to a distinct actionsBanner.state key", () => {
    const keys = Object.values(PHASE_LABEL_KEY)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("resolves every phase key to an en.json template carrying {{label}}", () => {
    for (const phase of ["pending", "running", "success", "failed"] as const) {
      const key = PHASE_LABEL_KEY[phase]
      // Guards the dynamic t(PHASE_LABEL_KEY[phase], { label }) call site the
      // static key audit skips: a rename/removal in en.json must fail here,
      // not ship green and render a raw key to screen readers.
      expect(baseKeys).toHaveProperty(key)
      expect(baseKeys[key]).toContain("{{label}}")
    }
  })
})
