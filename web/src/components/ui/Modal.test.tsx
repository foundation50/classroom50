// @vitest-environment happy-dom
import { describe, expect, it, afterEach, vi, beforeAll } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { createRef } from "react"

import { Modal, ModalFooterPortal } from "./Modal"

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
    // The close X is an exposed button; the backdrop close button is
    // aria-hidden + tabIndex=-1 (mouse-only), so only the X has button role.
    expect(screen.getAllByRole("button")).toHaveLength(1)
    // The backdrop close control still exists in the DOM as a click target.
    expect(container.querySelector(".modal-backdrop button")).not.toBeNull()
  })

  it("hides the close X when hideCloseButton", () => {
    const { container } = render(
      <Modal open hideCloseButton aria-label="dlg">
        x
      </Modal>,
    )
    // The X is gone; the only remaining control is the aria-hidden backdrop
    // button, which is not exposed with a button role.
    expect(screen.queryAllByRole("button")).toHaveLength(0)
    expect(container.querySelector(".modal-backdrop button")).not.toBeNull()
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
    const { container } = render(
      <Modal open closeDisabled aria-label="dlg">
        x
      </Modal>,
    )
    for (const btn of screen.getAllByRole("button")) {
      expect((btn as HTMLButtonElement).disabled).toBe(true)
    }
    // The aria-hidden backdrop button (not role-exposed) is disabled too.
    const backdropBtn = container.querySelector(
      ".modal-backdrop button",
    ) as HTMLButtonElement
    expect(backdropBtn.disabled).toBe(true)
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

    // The lock should continue to hold the dialog even if the parent flips
    // open back to true while closeDisabled remains active.
    rerender(
      <Modal open closeDisabled aria-label="dlg">
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

  it("defers onClose until the closeDisabled lock releases", () => {
    const onClose = vi.fn()
    const { container, rerender } = render(
      <Modal open closeDisabled onClose={onClose} aria-label="dlg">
        x
      </Modal>,
    )
    const dialog = container.querySelector("dialog") as HTMLDialogElement
    expect(dialog.open).toBe(true)
    expect(onClose).not.toHaveBeenCalled()

    rerender(
      <Modal open={false} closeDisabled onClose={onClose} aria-label="dlg">
        x
      </Modal>,
    )
    expect(dialog.open).toBe(true)
    expect(onClose).not.toHaveBeenCalled()

    rerender(
      <Modal open={false} onClose={onClose} aria-label="dlg">
        x
      </Modal>,
    )
    expect(dialog.open).toBe(false)
    expect(onClose).toHaveBeenCalledTimes(1)
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

  it("wires title to aria-labelledby and subtitle to aria-describedby automatically", () => {
    const { container } = render(
      <Modal open title="My dialog" subtitle="More context">
        body
      </Modal>,
    )
    const dialog = container.querySelector("dialog") as HTMLDialogElement

    const heading = screen.getByRole("heading", { name: "My dialog" })
    expect(heading.tagName).toBe("H3")
    expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id)

    const subtitle = screen.getByText("More context")
    expect(dialog.getAttribute("aria-describedby")).toBe(subtitle.id)
  })

  it("lets an explicit aria-labelledby win over the title wiring", () => {
    const { container } = render(
      <Modal open title="My dialog" aria-labelledby="external-id">
        body
      </Modal>,
    )
    const dialog = container.querySelector("dialog") as HTMLDialogElement
    expect(dialog.getAttribute("aria-labelledby")).toBe("external-id")
  })

  it("renders the footer slot inside the canonical modal-action row", () => {
    const { container } = render(
      <Modal open title="t" footer={<button type="button">Save</button>}>
        body
      </Modal>,
    )
    const action = container.querySelector(".modal-action")
    expect(action).not.toBeNull()
    expect(action?.textContent).toContain("Save")
  })

  it("portals body-owned buttons into the same footer row", () => {
    const { container } = render(
      <Modal open title="t">
        <p>step body</p>
        <ModalFooterPortal>
          <button type="button">Apply</button>
        </ModalFooterPortal>
      </Modal>,
    )
    const action = container.querySelector(".modal-action")
    expect(action?.textContent).toContain("Apply")
    // The portal moved the button out of the body flow into the footer row.
    expect(screen.getByText("Apply").parentElement).toBe(action)
  })

  it("composes the footer prop with portal content in one row", () => {
    const { container } = render(
      <Modal open title="t" footer={<button type="button">Close</button>}>
        <ModalFooterPortal>
          <button type="button">Apply</button>
        </ModalFooterPortal>
      </Modal>,
    )
    const actions = container.querySelectorAll(".modal-action")
    expect(actions).toHaveLength(1)
    expect(actions[0].textContent).toContain("Close")
    expect(actions[0].textContent).toContain("Apply")
  })

  it("keeps the empty footer row hidden when neither prop nor portal fills it", () => {
    const { container } = render(
      <Modal open title="t">
        body
      </Modal>,
    )
    const action = container.querySelector(".modal-action") as HTMLElement
    expect(action.childNodes).toHaveLength(0)
    // empty:hidden removes the row (and its top margin) from layout.
    expect(action.className).toContain("empty:hidden")
  })

  it("passes role through for confirmation dialogs", () => {
    const { container } = render(
      <Modal open title="t" role="alertdialog">
        body
      </Modal>,
    )
    expect(container.querySelector("dialog")?.getAttribute("role")).toBe(
      "alertdialog",
    )
  })

  it("tolerates block-level subtitle content (ConfirmModal descriptions)", () => {
    render(
      <Modal
        open
        title="t"
        subtitle={
          <div>
            <ul>
              <li>consequence</li>
            </ul>
          </div>
        }
      >
        body
      </Modal>,
    )
    // The subtitle wrapper is a <div>, so the block content stays inside the
    // described-by element instead of being split out of an auto-closed <p>.
    const item = screen.getByText("consequence")
    expect(item.closest("[id]")?.textContent).toContain("consequence")
  })
})
