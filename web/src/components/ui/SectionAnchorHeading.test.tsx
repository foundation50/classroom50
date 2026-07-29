// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, opts?: { section?: string }) =>
      opts?.section ? `${k}:${opts.section}` : k,
  }),
}))

const navigate = vi.fn<(opts?: unknown) => Promise<void>>(() =>
  Promise.resolve(),
)
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}))

import { SectionAnchorHeading } from "./SectionAnchorHeading"

afterEach(() => {
  cleanup()
  navigate.mockClear()
})

describe("SectionAnchorHeading", () => {
  it("renders a heading whose text links to the section hash", () => {
    render(
      <SectionAnchorHeading anchorId="danger-zone">
        Danger
      </SectionAnchorHeading>,
    )
    const link = screen.getByRole("link", {
      name: "common.linkToSection:Danger",
    })
    expect(link.getAttribute("href")).toBe("#danger-zone")
  })

  it("updates the hash on click (letting the hook own the scroll)", async () => {
    render(
      <SectionAnchorHeading anchorId="danger-zone">
        Danger
      </SectionAnchorHeading>,
    )
    await userEvent.click(screen.getByRole("link"))

    expect(navigate).toHaveBeenCalledTimes(1)
    const arg = navigate.mock.calls[0][0] as {
      to: string
      hash: string
      replace: boolean
      state: (prev: Record<string, unknown>) => { scrollNonce?: number }
    }
    expect(arg.to).toBe(".")
    expect(arg.hash).toBe("danger-zone")
    expect(arg.replace).toBe(true)
    // A fresh, strictly-increasing scrollNonce is stamped so an identical-hash
    // re-click always re-fires (never a same-millisecond collision).
    const first = arg.state({}).scrollNonce as number
    const second = arg.state({}).scrollNonce as number
    expect(first).toEqual(expect.any(Number))
    expect(second).toBeGreaterThan(first)
  })
})
