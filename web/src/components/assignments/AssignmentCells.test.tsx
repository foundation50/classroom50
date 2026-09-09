// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

import { DueDateCell } from "./AssignmentCells"
import {
  dueDeadlineInstant,
  formatDueDate,
  formatRelativeToNow,
} from "@/util/formatDate"

afterEach(cleanup)

describe("DueDateCell", () => {
  it("renders a past due date as the red badge by default (the teacher table's path)", () => {
    const { container } = render(<DueDateCell due="2020-01-01" />)
    const badge = container.querySelector(".badge-error")
    expect(badge).not.toBeNull()
    expect(badge!.textContent).toContain(formatDueDate("2020-01-01"))
  })

  it("renders a past due date as plain data when overdue highlighting is off", () => {
    const { container } = render(
      <DueDateCell due="2020-01-01" highlightOverdue={false} />,
    )
    expect(container.querySelector(".badge-error")).toBeNull()
    expect(container.textContent).toContain(formatDueDate("2020-01-01"))
  })

  it("leaves a future due date untouched by the highlight flag, countdown included", () => {
    const { container } = render(
      <DueDateCell due="2099-01-01" relative highlightOverdue={false} />,
    )
    expect(container.querySelector(".badge-error")).toBeNull()
    expect(container.textContent).toContain(formatDueDate("2099-01-01"))
    expect(container.textContent).toContain(
      formatRelativeToNow(dueDeadlineInstant("2099-01-01")!),
    )
  })

  it("shows the muted placeholder when there is no due date", () => {
    render(<DueDateCell />)
    expect(screen.getByText("assignments.table.noDueDate")).toBeTruthy()
  })
})
