// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

vi.mock("react-i18next", async (importActual) => {
  const actual = await importActual<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) }
})

import { NotificationProvider, useToast } from "./NotificationProvider"

// A tiny consumer that fires a toast carrying an action on mount.
function FireActionToast({ onAction }: { onAction: () => void }) {
  const { notify } = useToast()
  return (
    <button
      onClick={() =>
        notify({
          message: "Hid acme from your home page.",
          action: { label: "Undo", onClick: onAction },
        })
      }
    >
      fire
    </button>
  )
}

afterEach(cleanup)

describe("NotificationProvider toast action", () => {
  it("renders the action label and runs its onClick, then dismisses the toast", async () => {
    const onAction = vi.fn()
    render(
      <NotificationProvider>
        <FireActionToast onAction={onAction} />
      </NotificationProvider>,
    )

    await userEvent.click(screen.getByText("fire"))
    // The toast and its Undo action are shown.
    expect(screen.getByText("Hid acme from your home page.")).toBeTruthy()
    const undo = screen.getByText("Undo")

    await userEvent.click(undo)
    expect(onAction).toHaveBeenCalledTimes(1)
    // Clicking the action dismisses the toast (after the exit animation).
    await waitFor(() => expect(screen.queryByText("Undo")).toBeNull())
  })

  it("shows no action button for a plain toast without an action", async () => {
    function FirePlainToast() {
      const { notify } = useToast()
      return <button onClick={() => notify({ message: "Saved." })}>fire</button>
    }
    render(
      <NotificationProvider>
        <FirePlainToast />
      </NotificationProvider>,
    )
    await userEvent.click(screen.getByText("fire"))
    expect(screen.getByText("Saved.")).toBeTruthy()
    expect(screen.queryByText("Undo")).toBeNull()
  })
})
