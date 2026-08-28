// @vitest-environment happy-dom
import { describe, expect, it, afterEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import {
  BulkPhaseFooter,
  BulkProgressBlock,
  BulkProgressInline,
  BulkProgressRow,
  bulkProgressPct,
} from "./resultView"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

afterEach(cleanup)

const base = {
  busy: false,
  showApply: true,
  applyLabel: "Apply",
  onApply: () => {},
  onClose: () => {},
}

describe("BulkPhaseFooter", () => {
  it("renders ghost Cancel plus primary Apply while idle", () => {
    render(<BulkPhaseFooter {...base} phase="idle" />)
    expect(screen.getByRole("button", { name: "common.cancel" })).toBeDefined()
    expect(screen.getByRole("button", { name: "Apply" })).toBeDefined()
  })

  it("hides Apply when there is nothing to run on", () => {
    render(<BulkPhaseFooter {...base} phase="idle" showApply={false} />)
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull()
  })

  it("disables Apply via applyDisabled without hiding it", () => {
    render(<BulkPhaseFooter {...base} phase="idle" applyDisabled />)
    const apply = screen.getByRole("button", {
      name: "Apply",
    }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
  })

  it("shows only a disabled Cancel while working", () => {
    render(<BulkPhaseFooter {...base} phase="working" busy />)
    const cancel = screen.getByRole("button", {
      name: "common.cancel",
    }) as HTMLButtonElement
    expect(cancel.disabled).toBe(true)
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull()
  })

  it.each(["complete", "error"] as const)(
    "dismisses a finished %s run with a single primary Done",
    (phase) => {
      const onClose = vi.fn()
      render(<BulkPhaseFooter {...base} phase={phase} onClose={onClose} />)
      const done = screen.getByRole("button", { name: "common.done" })
      expect(screen.getAllByRole("button")).toHaveLength(1)
      done.click()
      expect(onClose).toHaveBeenCalledTimes(1)
    },
  )
})

const getBar = (container: HTMLElement) => {
  const bar = container.querySelector("progress")
  if (!bar) throw new Error("no <progress> rendered")
  return bar
}

describe("BulkProgressBlock", () => {
  it("renders a valued percent bar by default", () => {
    const { container } = render(
      <BulkProgressBlock
        workingLabel="working"
        caption="3 of 4"
        progress={{ processed: 3, total: 4 }}
      />,
    )
    const bar = getBar(container)
    expect(bar.getAttribute("value")).toBe("75")
    expect(bar.getAttribute("max")).toBe("100")
    expect(screen.getByText("3 of 4")).toBeDefined()
  })

  it("omits value until the first item lands with indeterminateUntilFirst", () => {
    const { container } = render(
      <BulkProgressBlock
        workingLabel="working"
        caption="starting"
        progress={{ processed: 0, total: 8 }}
        indeterminateUntilFirst
      />,
    )
    expect(getBar(container).hasAttribute("value")).toBe(false)
  })

  it("restores the value once the first item lands", () => {
    const { container } = render(
      <BulkProgressBlock
        workingLabel="working"
        caption="1 of 8"
        progress={{ processed: 1, total: 8 }}
        indeterminateUntilFirst
      />,
    )
    expect(getBar(container).getAttribute("value")).toBe("13")
  })

  it("renders 0, not NaN, when total is 0", () => {
    const { container } = render(
      <BulkProgressBlock
        workingLabel="working"
        caption="none"
        progress={{ processed: 0, total: 0 }}
      />,
    )
    expect(getBar(container).getAttribute("value")).toBe("0")
  })
})

describe("BulkProgressRow", () => {
  it("renders the message heading, both captions, and trailing children", () => {
    const { container } = render(
      <BulkProgressRow
        progress={{ processed: 2, total: 5, message: "Removing…" }}
        processedCaption="2 / 5"
        percentCaption="40%"
      >
        <p>keep this tab open</p>
      </BulkProgressRow>,
    )
    expect(screen.getByText("Removing…")).toBeDefined()
    expect(screen.getByText("2 / 5")).toBeDefined()
    expect(screen.getByText("40%")).toBeDefined()
    expect(screen.getByText("keep this tab open")).toBeDefined()
    expect(getBar(container).getAttribute("value")).toBe("40")
  })
})

describe("BulkProgressInline", () => {
  it("renders the status line and a valued bar", () => {
    const { container } = render(
      <BulkProgressInline label="Opening 1 of 2" progress={{ processed: 1, total: 2 }} />,
    )
    expect(screen.getByText("Opening 1 of 2")).toBeDefined()
    expect(getBar(container).getAttribute("value")).toBe("50")
  })
})

describe("bulkProgressPct", () => {
  it("rounds the ratio and guards a zero total", () => {
    expect(bulkProgressPct({ processed: 1, total: 3 })).toBe(33)
    expect(bulkProgressPct({ processed: 0, total: 0 })).toBe(0)
  })
})
