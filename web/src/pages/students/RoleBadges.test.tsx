// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

import { RoleBadges } from "./RoleBadges"

afterEach(() => {
  cleanup()
})

describe("RoleBadges", () => {
  it("renders a chip per role for a mixed-team member (instructor + student)", () => {
    render(<RoleBadges roles={["student", "instructor"]} />)
    expect(screen.getByText("students.roleInstructor")).toBeTruthy()
    expect(screen.getByText("students.roleStudent")).toBeTruthy()
  })

  it("renders exactly one chip for a single-role member", () => {
    const { container } = render(<RoleBadges roles={["student"]} />)
    expect(screen.getByText("students.roleStudent")).toBeTruthy()
    expect(screen.queryByText("students.roleInstructor")).toBeNull()
    // One badge element, not a collapsed-then-duplicated render.
    expect(container.querySelectorAll(".badge")).toHaveLength(1)
  })

  it("orders chips by precedence (instructor before ta before student)", () => {
    const { container } = render(
      <RoleBadges roles={["student", "ta", "instructor"]} />,
    )
    const labels = [...container.querySelectorAll(".badge")].map(
      (el) => el.textContent,
    )
    expect(labels).toEqual([
      "students.roleInstructor",
      "students.roleTa",
      "students.roleStudent",
    ])
  })

  it("renders nothing for an empty role list", () => {
    const { container } = render(<RoleBadges roles={[]} />)
    expect(container.querySelectorAll(".badge")).toHaveLength(0)
  })
})
