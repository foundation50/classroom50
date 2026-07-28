// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { SubmissionsActionsMenu } from "./SubmissionsActionsMenu"

const baseProps = {
  collecting: false,
  regrading: false,
  regradeAllActive: false,
  emptyRoster: false,
  onCollect: () => {},
  onRegradeAll: () => {},
  viewHref: "https://example.test/run",
  viewLabel: "submissions.menu.viewWorkflow",
  onDownloadCsv: () => {},
  downloadDisabled: false,
}

afterEach(() => cleanup())

describe("SubmissionsActionsMenu — canRegradeAll gate", () => {
  it("shows Regrade all when the viewer may batch-regrade", () => {
    render(<SubmissionsActionsMenu {...baseProps} canRegradeAll={true} />)
    expect(screen.queryByText("submissions.regradeAll.label")).not.toBeNull()
    // Collect stays available regardless (all-staff action).
    expect(screen.queryByText("submissions.collect.label")).not.toBeNull()
  })

  it("hides Regrade all for a viewer who can't (TA), keeping Collect", () => {
    render(<SubmissionsActionsMenu {...baseProps} canRegradeAll={false} />)
    expect(screen.queryByText("submissions.regradeAll.label")).toBeNull()
    expect(screen.queryByText("submissions.collect.label")).not.toBeNull()
  })

  it("defaults to showing Regrade all when the prop is omitted", () => {
    render(<SubmissionsActionsMenu {...baseProps} />)
    expect(screen.queryByText("submissions.regradeAll.label")).not.toBeNull()
  })
})

describe("SubmissionsActionsMenu — Metrics item", () => {
  it("does not include Share (moved next to the search bar)", () => {
    render(<SubmissionsActionsMenu {...baseProps} />)
    expect(screen.queryByText("submissions.menu.share")).toBeNull()
  })

  it("shows Metrics only when onMetrics is provided (hidden in live view)", () => {
    const { rerender } = render(<SubmissionsActionsMenu {...baseProps} />)
    expect(screen.queryByText("submissions.menu.metrics")).toBeNull()
    rerender(<SubmissionsActionsMenu {...baseProps} onMetrics={() => {}} />)
    expect(screen.queryByText("submissions.menu.metrics")).not.toBeNull()
  })
})

describe("SubmissionsActionsMenu — Open all Feedback PRs item", () => {
  it("shows the item only when onOpenAllPrs is provided (owner, non-empty_repo)", () => {
    const { rerender } = render(<SubmissionsActionsMenu {...baseProps} />)
    expect(screen.queryByText("submissions.openAllPrs.menuLabel")).toBeNull()
    rerender(<SubmissionsActionsMenu {...baseProps} onOpenAllPrs={() => {}} />)
    expect(
      screen.queryByText("submissions.openAllPrs.menuLabel"),
    ).not.toBeNull()
  })

  it("hides the item for an empty_repo assignment even if a handler is passed", () => {
    render(
      <SubmissionsActionsMenu
        {...baseProps}
        emptyRepo
        onOpenAllPrs={() => {}}
      />,
    )
    // The whole !emptyRepo block (incl. this item) is gone for empty_repo.
    expect(screen.queryByText("submissions.openAllPrs.menuLabel")).toBeNull()
  })
})

describe("SubmissionsActionsMenu — Lock/Unlock item", () => {
  it("shows the item only when onLockToggle is provided (authoring tier)", () => {
    const { rerender } = render(<SubmissionsActionsMenu {...baseProps} />)
    expect(screen.queryByText("submissions.lock.lockLabel")).toBeNull()
    rerender(<SubmissionsActionsMenu {...baseProps} onLockToggle={() => {}} />)
    expect(screen.queryByText("submissions.lock.lockLabel")).not.toBeNull()
  })

  it("shows Unlock when the assignment is already locked", () => {
    render(
      <SubmissionsActionsMenu {...baseProps} locked onLockToggle={() => {}} />,
    )
    expect(screen.queryByText("submissions.lock.unlockLabel")).not.toBeNull()
    expect(screen.queryByText("submissions.lock.lockLabel")).toBeNull()
  })
})
