// @vitest-environment happy-dom
import { describe, expect, it, afterEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { BulkPhaseFooter } from "./resultView"

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
