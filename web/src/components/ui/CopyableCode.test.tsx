// @vitest-environment happy-dom
import { describe, expect, it, afterEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { CopyableCode } from "./CopyableCode"

afterEach(cleanup)

describe("CopyableCode", () => {
  it("renders the value and a copy button labelled for a11y", () => {
    render(
      <CopyableCode
        value="gh student accept"
        copied={false}
        onCopy={() => {}}
        label="Copy command"
      />,
    )
    expect(screen.getByText("gh student accept")).not.toBeNull()
    const btn = screen.getByRole("button", { name: "Copy command" })
    expect(btn).not.toBeNull()
  })

  it("fires onCopy when the button is clicked", async () => {
    const onCopy = vi.fn()
    render(
      <CopyableCode value="x" copied={false} onCopy={onCopy} label="Copy" />,
    )
    await userEvent.click(screen.getByRole("button", { name: "Copy" }))
    expect(onCopy).toHaveBeenCalledOnce()
  })

  it("shows the success state while copied (caller-owned)", () => {
    render(<CopyableCode value="x" copied onCopy={() => {}} label="Copy" />)
    const btn = screen.getByRole("button", { name: "Copy" })
    expect(btn.className).toContain("btn-success")
  })
})
