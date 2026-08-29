// @vitest-environment happy-dom
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

// Tests for ConfirmModal's option slot (`children`) and the confirmDisabled
// gate — including Enter in the typed-confirm input, which submits through
// handleSubmit rather than the (already disabled) buttons.

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

import { ConfirmModal } from "./index"

afterEach(cleanup)

const renderConfirm = (
  props: Partial<React.ComponentProps<typeof ConfirmModal>> = {},
) => {
  const onConfirm = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()
  const view = render(
    <ConfirmModal
      open
      title="title"
      confirmText="confirm"
      onConfirm={onConfirm}
      onClose={onClose}
      {...props}
    />,
  )
  return { view, onConfirm, onClose }
}

describe("ConfirmModal — children and confirmDisabled", () => {
  it("renders children before acknowledging and removes them on the typed step", () => {
    renderConfirm({ children: <div data-testid="options" /> })
    expect(screen.getByTestId("options")).toBeTruthy()

    fireEvent.click(screen.getByText("components.confirmModal.yesContinue"))

    expect(screen.queryByTestId("options")).toBeNull()
    expect(screen.getByRole("textbox")).toBeTruthy()
  })

  it("disables the acknowledge button while confirmDisabled", () => {
    renderConfirm({ confirmDisabled: true })
    const ack = screen.getByText(
      "components.confirmModal.yesContinue",
    ) as HTMLButtonElement
    expect(ack.disabled).toBe(true)
  })

  it("disables the single-step confirm button while confirmDisabled", () => {
    renderConfirm({ needsConfirm: false, confirmDisabled: true })
    const confirm = screen.getByText(
      "components.confirmModal.confirm",
    ) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
  })

  it("blocks the Enter-key submit when confirmDisabled turns on mid-dialog", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    const props = {
      open: true,
      title: "title",
      confirmText: "confirm",
      onConfirm,
      onClose,
    }
    const view = render(<ConfirmModal {...props} confirmDisabled={false} />)
    fireEvent.click(screen.getByText("components.confirmModal.yesContinue"))

    // The caller's preview goes to zero after acknowledging (e.g. the
    // selection emptied) — the typed phrase alone must not fire the action.
    view.rerender(<ConfirmModal {...props} confirmDisabled />)
    const input = screen.getByRole("textbox")
    fireEvent.change(input, { target: { value: "confirm" } })
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(onConfirm).not.toHaveBeenCalled()

    // Re-enabled: the same keystroke submits.
    view.rerender(<ConfirmModal {...props} confirmDisabled={false} />)
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalled()
  })

  it("only submits once the typed phrase matches", async () => {
    const { onConfirm } = renderConfirm({})
    fireEvent.click(screen.getByText("components.confirmModal.yesContinue"))
    const input = screen.getByRole("textbox")

    fireEvent.change(input, { target: { value: "nope" } })
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: "confirm" } })
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})

// The rejection contract every converted feedback flow now relies on
// (archive/delete classroom, staff remove, invite cleanup): a rejecting
// onConfirm renders its message inside the dialog, keeps it open, and
// re-enables confirm for a retry. Deleting the catch in a refactor would
// silently destroy all failure feedback for those flows.
describe("ConfirmModal — rejecting onConfirm", () => {
  it("renders the thrown message in-dialog, stays open, and allows retry", async () => {
    const onConfirm = vi
      .fn()
      .mockRejectedValueOnce(new Error("classes.deleteFailed localized"))
      .mockResolvedValueOnce(undefined)
    const onClose = vi.fn()
    render(
      <ConfirmModal
        open
        needsConfirm={false}
        title="title"
        confirmText="confirm"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    )

    await act(async () => {
      fireEvent.click(screen.getByText("components.confirmModal.confirm"))
    })
    expect(screen.getByText("classes.deleteFailed localized")).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()

    // The confirm re-enables and a retry that resolves closes the dialog.
    const confirm = screen.getByText(
      "components.confirmModal.confirm",
    ) as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(confirm)
    })
    expect(onConfirm).toHaveBeenCalledTimes(2)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("falls back to the generic error for a non-Error rejection", async () => {
    const onConfirm = vi.fn().mockRejectedValue("boom")
    render(
      <ConfirmModal
        open
        needsConfirm={false}
        title="title"
        confirmText="confirm"
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    )
    await act(async () => {
      fireEvent.click(screen.getByText("components.confirmModal.confirm"))
    })
    expect(
      screen.getByText("components.confirmModal.genericError"),
    ).toBeTruthy()
  })
})
