// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useRef } from "react"

import { useDismissOnEscape } from "./useDismissOnEscape"
import { useDismissOnOutsidePointerDown } from "./useDismissOnOutsidePointerDown"

afterEach(() => cleanup())

function Overlay({
  open,
  onDismiss,
}: {
  open: boolean
  onDismiss: () => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  useDismissOnOutsidePointerDown(rootRef, open, onDismiss)
  useDismissOnEscape(rootRef, open, onDismiss)
  return (
    <>
      <div ref={rootRef}>
        <button type="button">Inside</button>
      </div>
      <button
        type="button"
        // A widget that swallows its own pointer-down (a combobox option).
        onPointerDown={(event) => event.stopPropagation()}
      >
        Outside
      </button>
    </>
  )
}

describe("overlay dismissal hooks", () => {
  it("dismisses on an outside pointer-down even when the target stops propagation", () => {
    const onDismiss = vi.fn()
    render(<Overlay open onDismiss={onDismiss} />)
    fireEvent.pointerDown(screen.getByRole("button", { name: "Inside" }))
    expect(onDismiss).not.toHaveBeenCalled()
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it("dismisses on Escape from inside the root and consumes the key", () => {
    const onDismiss = vi.fn()
    const onDocumentKey = vi.fn()
    document.addEventListener("keydown", onDocumentKey)
    render(<Overlay open onDismiss={onDismiss} />)
    fireEvent.keyDown(screen.getByRole("button", { name: "Inside" }), {
      key: "Escape",
    })
    expect(onDismiss).toHaveBeenCalledOnce()
    // Consumed: a dialog or menu listening further up must stay open.
    expect(onDocumentKey).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole("button", { name: "Outside" }), {
      key: "Escape",
    })
    expect(onDismiss).toHaveBeenCalledOnce()
    document.removeEventListener("keydown", onDocumentKey)
  })

  it("listens only while open", () => {
    const onDismiss = vi.fn()
    render(<Overlay open={false} onDismiss={onDismiss} />)
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }))
    fireEvent.keyDown(screen.getByRole("button", { name: "Inside" }), {
      key: "Escape",
    })
    expect(onDismiss).not.toHaveBeenCalled()
  })
})
