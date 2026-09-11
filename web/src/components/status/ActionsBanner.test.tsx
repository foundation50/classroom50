// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import type { ActionActivity, Tracker } from "@/hooks/useActionActivity"
import type { PublishFailureDetail } from "@/hooks/usePublishFailureDetail"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

// The banner is a projection of the hook: the test sets what the hook returns.
let activity: ActionActivity
vi.mock("@/hooks/useActionActivity", () => ({
  useActionActivity: () => activity,
}))

let detail: PublishFailureDetail
vi.mock("@/hooks/usePublishFailureDetail", () => ({
  usePublishFailureDetail: () => detail,
}))

import { ActionsBanner } from "./ActionsBanner"

const failedPublish: Tracker = {
  id: "op-a",
  displayLabel: "Publishing hw1: failed",
  phase: "failed",
  htmlUrl: "https://github.com/acme/classroom50/actions/runs/10",
  runId: 10,
  workflow: "publish-pages.yaml",
  dismissible: true,
  retriable: true,
  startedAtMs: 1,
  endedAtMs: 2,
}

const baseActivity = (): ActionActivity => ({
  org: "acme",
  trackers: [failedPublish],
  anyFailed: true,
  pollError: false,
  dismiss: vi.fn(),
  retry: vi.fn(),
  unstick: vi.fn(),
  busy: new Set(),
  unsticking: new Set(),
})

const locked: PublishFailureDetail = {
  state: "known",
  failure: { kind: "deployLocked", blockerSha: "656e8d" },
  blockerInProgress: true,
}

// The banner reveals itself 150ms after load, so every assertion waits. In
// happy-dom the measured height stays 0, so only the aria-hidden measuring
// probe renders; role queries therefore opt in to hidden elements. The probe
// renders the same body as the visible bar, which is the invariant the
// shared-state design keeps.
const role = (name: string) =>
  screen.findAllByRole("button", { name, hidden: true })
const queryRole = (name: string) =>
  screen.queryByRole("button", { name, hidden: true })

describe("ActionsBanner publish failure detail", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    )
    activity = baseActivity()
    detail = locked
  })
  afterEach(() => cleanup())

  it("offers to cancel the blocking deployment and hands the sha to unstick", async () => {
    render(<ActionsBanner />)
    const [button] = await role("actionsBanner.publishFailure.unstick")
    expect(
      screen.getAllByText("actionsBanner.publishFailure.deployLocked").length,
    ).toBeGreaterThan(0)
    fireEvent.click(button)
    expect(activity.unstick).toHaveBeenCalledWith("op-a", "656e8d")
  })

  it("drops the cancel action once the blocker has cleared", async () => {
    detail = { ...locked, blockerInProgress: false }
    render(<ActionsBanner />)
    await waitFor(() =>
      expect(
        screen.getAllByText("actionsBanner.publishFailure.deployLockCleared")
          .length,
      ).toBeGreaterThan(0),
    )
    expect(queryRole("actionsBanner.publishFailure.unstick")).toBeNull()
  })

  it("disables both Retry and the cancel action while a cancel is in flight", async () => {
    activity = {
      ...baseActivity(),
      busy: new Set(["op-a"]),
      unsticking: new Set(["op-a"]),
    }
    render(<ActionsBanner />)
    const cancelButtons = await role("actionsBanner.publishFailure.unsticking")
    for (const b of cancelButtons)
      expect((b as HTMLButtonElement).disabled).toBe(true)
    for (const b of await role("actionsBanner.retry")) {
      expect((b as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it("explains a non-lock cause without offering a cancel", async () => {
    detail = { state: "known", failure: { kind: "timeout" } }
    render(<ActionsBanner />)
    await waitFor(() =>
      expect(
        screen.getAllByText("actionsBanner.publishFailure.timeout").length,
      ).toBeGreaterThan(0),
    )
    expect(queryRole("actionsBanner.publishFailure.unstick")).toBeNull()
  })

  it("shows only the run link when the cause is unknown", async () => {
    detail = { state: "unknown" }
    render(<ActionsBanner />)
    await screen.findAllByText("actionsBanner.viewRun")
    expect(screen.queryByText(/actionsBanner\.publishFailure\./)).toBeNull()
  })
})
