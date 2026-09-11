import { describe, expect, it } from "vitest"

import {
  classifyPublishFailure,
  isFailureConclusion,
  isRunning,
  isSupersededPublish,
  isTerminalPhase,
  orgFromPathname,
  PHASE_LABEL_KEY,
  resolveOpRun,
  runMatchesOp,
  runTimes,
  runUrl,
  trackerPhase,
  workflowFile,
  type ActionOperation,
} from "./actionActivity"
import type { GitHubWorkflowRun } from "@/github-core/types"
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

  it("never matches a dispatch op to a push run of the same workflow (publish-pages runs on both)", () => {
    const dispatchOp = op({
      anchor: {
        kind: "sinceRunId",
        workflow: "publish-pages.yaml",
        sinceRunId: 100,
      },
    })
    // The baseline is read from dispatch runs only, so a push run newer than
    // it is not the dispatched run even though its id is past the baseline.
    expect(
      runMatchesOp(
        dispatchRun(101, "publish-pages.yaml", { event: "push" }),
        dispatchOp,
      ),
    ).toBe(false)
    expect(
      runMatchesOp(dispatchRun(102, "publish-pages.yaml"), dispatchOp),
    ).toBe(true)
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
    // A run that started 10 minutes before this op was dispatched — e.g., an
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

  it("skips a newer push publish and binds a Publish again op to the dispatch run", () => {
    const dispatchOp = op({
      anchor: {
        kind: "sinceRunId",
        workflow: "publish-pages.yaml",
        sinceRunId: 100,
      },
    })
    const runs = [
      dispatchRun(103, "publish-pages.yaml"),
      dispatchRun(101, "publish-pages.yaml", { event: "push" }),
    ]
    expect(resolveOpRun(dispatchOp, runs)?.id).toBe(103)
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

  it("is superseded for a cancelled publish when a newer publish run exists", () => {
    const cancelled = publishRun(10, { conclusion: "cancelled" })
    const newer = publishRun(11, { conclusion: "success" })
    expect(trackerPhase(cancelled, [newer, cancelled])).toBe("superseded")
  })

  it("stays failed for a cancelled publish without the run window", () => {
    const cancelled = publishRun(10, { conclusion: "cancelled" })
    expect(trackerPhase(cancelled)).toBe("failed")
  })
})

// A completed publish-pages run (push-triggered), by id.
const publishRun = (
  id: number,
  over: Partial<GitHubWorkflowRun> = {},
): GitHubWorkflowRun =>
  run({
    id,
    status: "completed",
    path: ".github/workflows/publish-pages.yaml",
    ...over,
  })

describe("isSupersededPublish", () => {
  it("is true only for a cancelled publish with a newer publish run in the window", () => {
    const cancelled = publishRun(10, { conclusion: "cancelled" })
    expect(
      isSupersededPublish(cancelled, [
        publishRun(11, { conclusion: "success" }),
      ]),
    ).toBe(true)
    // A newer run of ANOTHER workflow doesn't carry the publish.
    expect(
      isSupersededPublish(cancelled, [
        dispatchRun(11, "collect-scores.yaml", {
          status: "completed",
          conclusion: "success",
        }),
      ]),
    ).toBe(false)
    // Only older publish runs: a real cancellation, not a superseded one.
    expect(
      isSupersededPublish(cancelled, [
        publishRun(9, { conclusion: "success" }),
      ]),
    ).toBe(false)
  })

  it("never applies to a failed (not cancelled) publish or a non-publish run", () => {
    const newer = publishRun(11, { conclusion: "success" })
    expect(
      isSupersededPublish(publishRun(10, { conclusion: "failure" }), [newer]),
    ).toBe(false)
    expect(
      isSupersededPublish(
        dispatchRun(10, "regrade.yaml", {
          status: "completed",
          conclusion: "cancelled",
        }),
        [newer],
      ),
    ).toBe(false)
  })

  it("requires the newer publish to be running or to have succeeded", () => {
    const cancelled = publishRun(10, { conclusion: "cancelled" })
    // A successor that failed or was itself cancelled left the change
    // unpublished, so the row stays failed and keeps Retry.
    expect(
      isSupersededPublish(cancelled, [
        publishRun(11, { conclusion: "failure" }),
      ]),
    ).toBe(false)
    expect(
      isSupersededPublish(cancelled, [
        publishRun(11, { conclusion: "cancelled" }),
      ]),
    ).toBe(false)
    // Still running: it will carry the change, so the row reads superseded.
    expect(
      isSupersededPublish(cancelled, [
        publishRun(11, { status: "in_progress", conclusion: null }),
      ]),
    ).toBe(true)
    // One failed and one succeeded: the successful one counts.
    expect(
      isSupersededPublish(cancelled, [
        publishRun(11, { conclusion: "failure" }),
        publishRun(12, { conclusion: "success" }),
      ]),
    ).toBe(true)
  })
})

describe("isTerminalPhase", () => {
  it("is true for success, failed, and superseded only", () => {
    expect(isTerminalPhase("success")).toBe(true)
    expect(isTerminalPhase("failed")).toBe(true)
    expect(isTerminalPhase("superseded")).toBe(true)
    expect(isTerminalPhase("pending")).toBe(false)
    expect(isTerminalPhase("running")).toBe(false)
  })
})

describe("classifyPublishFailure", () => {
  // Verbatim from issue #949: deploy-pages appends GitHub's 400 body.
  const lockMessage =
    "Failed to create deployment (status: 400) with build version 8f002501dc9b122a62c6bbebfa810de786430a71. Request ID 1C00:D9342:6FA1D4:966BBD:6AA2954D Responded with: Deployment request failed for 8f002501dc9b122a62c6bbebfa810de786430a71 due to in progress deployment. Please cancel 656e8d140b36230c9ccfe14584b9a81fa8c9c8d0 first or wait for it to complete."

  it("reads GitHub's in-progress lock and extracts the blocking sha", () => {
    expect(
      classifyPublishFailure([{ level: "failure", message: lockMessage }]),
    ).toEqual({
      kind: "deployLocked",
      blockerSha: "656e8d140b36230c9ccfe14584b9a81fa8c9c8d0",
    })
  })

  it("maps deploy-pages' other refusals to their kinds", () => {
    const cases: [string, string][] = [
      [
        "Failed to create deployment (status: 404) with build version abc. Ensure GitHub Pages has been enabled: https://github.com/acme/classroom50/settings/pages",
        "pagesDisabled",
      ],
      [
        'Failed to create deployment (status: 403) with build version abc. Ensure GITHUB_TOKEN has permission "pages: write".',
        "permission",
      ],
      ["Timeout reached, aborting!", "timeout"],
      [
        "Failed to create deployment (status: 502) with build version abc. Server error, is githubstatus.com reporting a Pages outage? Please re-run the deployment at a later time.",
        "outage",
      ],
    ]
    for (const [message, kind] of cases) {
      expect(classifyPublishFailure([{ level: "failure", message }])).toEqual({
        kind,
      })
    }
  })

  it("ignores warnings and notices, and is undefined for an unknown failure", () => {
    expect(
      classifyPublishFailure([{ level: "warning", message: lockMessage }]),
    ).toBeUndefined()
    expect(
      classifyPublishFailure([
        { level: "failure", message: "Process completed with exit code 1." },
      ]),
    ).toBeUndefined()
    expect(classifyPublishFailure([])).toBeUndefined()
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
    for (const phase of [
      "pending",
      "running",
      "success",
      "failed",
      "superseded",
    ] as const) {
      const key = PHASE_LABEL_KEY[phase]
      // Guards the dynamic t(PHASE_LABEL_KEY[phase], { label }) call site the
      // static key audit skips: a rename/removal in en.json must fail here,
      // not ship green and render a raw key to screen readers.
      expect(baseKeys).toHaveProperty(key)
      expect(baseKeys[key]).toContain("{{label}}")
    }
  })
})
