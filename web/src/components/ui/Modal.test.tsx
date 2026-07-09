// @vitest-environment happy-dom
import { describe, expect, it, afterEach, vi, beforeAll } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { createRef } from "react"

import { Modal } from "./Modal"

// happy-dom doesn't implement <dialog> showModal/close; stub them so the
// open-sync effect can run without throwing.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
    this.dispatchEvent(new Event("close"))
  }
})

afterEach(cleanup)

describe("Modal", () => {
  it("renders the box with the mapped size and a close button", () => {
    const { container } = render(
      <Modal open size="md" aria-label="dlg">
        <p>hi</p>
      </Modal>,
    )
    const box = container.querySelector(".modal-box")
    expect(box?.className).toContain("max-w-md")
    expect(screen.getByText("hi")).toBeDefined()
    // one close X + one backdrop close button
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(2)
  })

  it("hides the close X when hideCloseButton", () => {
    render(
      <Modal open hideCloseButton aria-label="dlg">
        x
      </Modal>,
    )
    // only the backdrop close button remains
    expect(screen.getAllByRole("button")).toHaveLength(1)
  })

  it("opens the native dialog when open flips true", () => {
    const { container } = render(
      <Modal open aria-label="dlg">
        x
      </Modal>,
    )
    const dialog = container.querySelector("dialog") as HTMLDialogElement
    expect(dialog.open).toBe(true)
  })

  it("fires onClose on the native close event", async () => {
    const onClose = vi.fn()
    const { container } = render(
      <Modal open onClose={onClose} aria-label="dlg">
        x
      </Modal>,
    )
    const dialog = container.querySelector("dialog") as HTMLDialogElement
    dialog.close()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("disables the close controls when closeDisabled", () => {
    render(
      <Modal open closeDisabled aria-label="dlg">
        x
      </Modal>,
    )
    for (const btn of screen.getAllByRole("button")) {
      expect((btn as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it("vetoes Esc (cancel) when closeDisabled", () => {
    const { container } = render(
      <Modal open closeDisabled aria-label="dlg">
        x
      </Modal>,
    )
    const dialog = container.querySelector("dialog") as HTMLDialogElement
    const cancel = new Event("cancel", { cancelable: true })
    dialog.dispatchEvent(cancel)
    expect(cancel.defaultPrevented).toBe(true)
  })

  it("allows Esc (cancel) when not closeDisabled", () => {
    const { container } = render(
      <Modal open aria-label="dlg">
        x
      </Modal>,
    )
    const dialog = container.querySelector("dialog") as HTMLDialogElement
    const cancel = new Event("cancel", { cancelable: true })
    dialog.dispatchEvent(cancel)
    expect(cancel.defaultPrevented).toBe(false)
  })

  it("holds the dialog open against open=false while closeDisabled, then closes when the lock releases", () => {
    const { container, rerender } = render(
      <Modal open closeDisabled aria-label="dlg">
        x
      </Modal>,
    )
    const dialog = container.querySelector("dialog") as HTMLDialogElement
    expect(dialog.open).toBe(true)

    // A parent flipping open=false mid-submit must not dismiss the guarded
    // dialog — the lock covers the programmatic close path, not just user
    // dismissal.
    rerender(
      <Modal open={false} closeDisabled aria-label="dlg">
        x
      </Modal>,
    )
    expect(dialog.open).toBe(true)

    // Once the submit finishes and the lock releases, the pending open=false
    // takes effect and the dialog closes.
    rerender(
      <Modal open={false} aria-label="dlg">
        x
      </Modal>,
    )
    expect(dialog.open).toBe(false)
  })

  it("stays closed in ref-driven mode until opened imperatively, and wires dialogRef", () => {
    const onClose = vi.fn()
    const dialogRef = createRef<HTMLDialogElement | null>()
    const { container } = render(
      <Modal dialogRef={dialogRef} onClose={onClose} aria-label="dlg">
        x
      </Modal>,
    )
    const dialog = container.querySelector("dialog") as HTMLDialogElement

    // `open` is omitted: the sync effect early-returns, so the dialog is not
    // auto-opened and the ref is populated for the caller to drive.
    expect(dialog.open).toBe(false)
    expect(dialogRef.current).toBe(dialog)

    // Opening imperatively still routes native close through onClose.
    dialogRef.current?.showModal()
    expect(dialog.open).toBe(true)
    dialog.close()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
