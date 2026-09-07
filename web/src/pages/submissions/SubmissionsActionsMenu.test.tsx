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
  onDownloadAll: () => {},
  downloadAllDisabled: false,
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

// Collect is a workflow dispatch too: the page omits onCollect for a viewer
// without config-repo write (a TA), and the item must go with it.
describe("SubmissionsActionsMenu — Collect item", () => {
  it("hides Collect when onCollect is omitted, keeping the exports", () => {
    render(
      <SubmissionsActionsMenu
        {...baseProps}
        onCollect={undefined}
        canRegradeAll={false}
      />,
    )
    expect(screen.queryByText("submissions.collect.label")).toBeNull()
    expect(screen.queryByText("submissions.downloadCsv")).not.toBeNull()
  })
})

// The trigger only spins for the action it owns (Regrade all). A collect is
// indicated by the toolbar's Collect now button, so the menu must stay usable
// meanwhile, with only the workflow items gated.
describe("SubmissionsActionsMenu — in-flight indicator", () => {
  const trigger = (container: HTMLElement) =>
    container.querySelector(".dropdown > button") as HTMLButtonElement

  it("keeps the trigger as 'Actions' during a collect, gating the workflow items", () => {
    const { container } = render(
      <SubmissionsActionsMenu {...baseProps} collecting />,
    )
    expect(trigger(container).textContent).toContain("submissions.menu.actions")
    expect(trigger(container).getAttribute("aria-busy")).toBeNull()
    const collectItem = screen
      .getByText("submissions.collect.active")
      .closest("button") as HTMLButtonElement
    expect(collectItem.disabled).toBe(true)
    const regradeItem = screen
      .getByText("submissions.regradeAll.label")
      .closest("button") as HTMLButtonElement
    expect(regradeItem.disabled).toBe(true)
    const csvItem = screen
      .getByText("submissions.downloadCsv")
      .closest("button") as HTMLButtonElement
    expect(csvItem.disabled).toBe(false)
  })

  it("turns the trigger into 'Regrading…' while a regrade is in flight", () => {
    const { container } = render(
      <SubmissionsActionsMenu {...baseProps} regrading regradeAllActive />,
    )
    expect(trigger(container).textContent).not.toContain(
      "submissions.menu.actions",
    )
    expect(trigger(container).textContent).toContain(
      "submissions.regradeAll.active",
    )
    expect(trigger(container).getAttribute("aria-busy")).toBe("true")
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

  it("keeps the item for a no_autograder (skipsGrading) assignment when a handler is passed", () => {
    render(
      <SubmissionsActionsMenu
        {...baseProps}
        skipsGrading
        onOpenAllPrs={() => {}}
      />,
    )
    // The page owns the empty_repo gate (handler omitted there); a templated
    // no_autograder repo permits the Feedback PR, so the item must survive
    // skipsGrading.
    expect(
      screen.queryByText("submissions.openAllPrs.menuLabel"),
    ).not.toBeNull()
  })
})

describe("SubmissionsActionsMenu — Download all submissions item", () => {
  it("always shows the item (read-only, not owner-gated) and enables it when there are submissions", () => {
    render(<SubmissionsActionsMenu {...baseProps} />)
    const item = screen.getByText("submissions.downloadAll.menuLabel")
    expect(item).not.toBeNull()
    expect((item.closest("button") as HTMLButtonElement).disabled).toBe(false)
  })

  it("disables the item when there is nothing to download", () => {
    render(<SubmissionsActionsMenu {...baseProps} downloadAllDisabled />)
    const item = screen.getByText("submissions.downloadAll.menuLabel")
    expect((item.closest("button") as HTMLButtonElement).disabled).toBe(true)
  })

  it("stays visible for a non-autograding assignment", () => {
    render(<SubmissionsActionsMenu {...baseProps} skipsGrading />)
    expect(
      screen.queryByText("submissions.downloadAll.menuLabel"),
    ).not.toBeNull()
  })
})

describe("SubmissionsActionsMenu — Update autograding triggers item", () => {
  it("shows the item only when onBulkTrigger is provided (owner + default autograder)", () => {
    const { rerender } = render(<SubmissionsActionsMenu {...baseProps} />)
    expect(screen.queryByText("submissions.bulkTrigger.menuLabel")).toBeNull()
    rerender(<SubmissionsActionsMenu {...baseProps} onBulkTrigger={() => {}} />)
    expect(
      screen.queryByText("submissions.bulkTrigger.menuLabel"),
    ).not.toBeNull()
  })

  it("fires the handler on click", () => {
    const onBulkTrigger = vi.fn()
    render(
      <SubmissionsActionsMenu {...baseProps} onBulkTrigger={onBulkTrigger} />,
    )
    screen.getByText("submissions.bulkTrigger.menuLabel").click()
    expect(onBulkTrigger).toHaveBeenCalledTimes(1)
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

describe("SubmissionsActionsMenu — Close/Reopen submission item", () => {
  it("shows the item only when onCloseToggle is provided (authoring tier)", () => {
    const { rerender } = render(<SubmissionsActionsMenu {...baseProps} />)
    expect(
      screen.queryByText("submissions.closeSubmission.menuLabel"),
    ).toBeNull()
    rerender(<SubmissionsActionsMenu {...baseProps} onCloseToggle={() => {}} />)
    expect(
      screen.queryByText("submissions.closeSubmission.menuLabel"),
    ).not.toBeNull()
  })

  it("shows Reopen when the assignment is already closed", () => {
    render(
      <SubmissionsActionsMenu {...baseProps} closed onCloseToggle={() => {}} />,
    )
    expect(
      screen.queryByText("submissions.closeSubmission.reopenLabel"),
    ).not.toBeNull()
    expect(
      screen.queryByText("submissions.closeSubmission.menuLabel"),
    ).toBeNull()
  })

  it("fires the handler on click", () => {
    const onCloseToggle = vi.fn()
    render(
      <SubmissionsActionsMenu {...baseProps} onCloseToggle={onCloseToggle} />,
    )
    screen.getByText("submissions.closeSubmission.menuLabel").click()
    expect(onCloseToggle).toHaveBeenCalledTimes(1)
  })

  it("is independent of Lock — both items can appear together", () => {
    render(
      <SubmissionsActionsMenu
        {...baseProps}
        onLockToggle={() => {}}
        onCloseToggle={() => {}}
      />,
    )
    expect(screen.queryByText("submissions.lock.lockLabel")).not.toBeNull()
    expect(
      screen.queryByText("submissions.closeSubmission.menuLabel"),
    ).not.toBeNull()
  })
})
