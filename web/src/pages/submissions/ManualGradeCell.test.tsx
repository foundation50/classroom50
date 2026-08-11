// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) =>
        opts && "max" in opts
          ? `${key}:${String(opts.max)}`
          : opts && "name" in opts
            ? `${key}:${String(opts.name)}`
            : key,
    }),
  }
})

const mutate = vi.fn()
let isPending = false
let isError = false
const reset = vi.fn()

vi.mock("@/hooks/mutations/useSetScoreOverride", () => ({
  useSetScoreOverride: () => ({ mutate, isPending, isError, reset }),
}))

import { ManualGradeCell } from "./ManualGradeCell"

const ctx = {
  org: "acme",
  classroom: "cs50",
  assignment: "hw1",
  assignmentType: "individual" as const,
  maxPoints: 50,
}

beforeEach(() => {
  mutate.mockReset()
  reset.mockReset()
  isPending = false
  isError = false
})
afterEach(cleanup)

function renderCell(props?: Partial<Parameters<typeof ManualGradeCell>[0]>) {
  return render(
    <ManualGradeCell
      owner="alice"
      score={0}
      max={50}
      hasGrade={false}
      thresholdFraction={null}
      ctx={ctx}
      {...props}
    />,
  )
}

describe("ManualGradeCell", () => {
  it("shows the ungraded empty state (not a 0) when no grade exists", () => {
    renderCell({ hasGrade: false })
    expect(screen.getByText("submissions.manualGrade.notGraded")).toBeTruthy()
    // No score badge (which would read 0/50) in the ungraded state.
    expect(screen.queryByText("0/50")).toBeNull()
  })

  it("shows the current score badge when a grade exists", () => {
    renderCell({ hasGrade: true, score: 42, max: 50 })
    expect(screen.getByText("42/50")).toBeTruthy()
  })

  it("enters edit mode, validates the range, and blocks save until valid", async () => {
    const user = userEvent.setup()
    renderCell({ hasGrade: false })
    await user.click(
      screen.getByRole("button", {
        name: "submissions.manualGrade.addLabel:alice",
      }),
    )
    const input = screen.getByRole("spinbutton", {
      name: "submissions.manualGrade.inputLabel:alice",
    })
    // Over the max -> range error, save disabled, mutate not called.
    await user.type(input, "99")
    expect(screen.getByRole("alert").textContent).toBe(
      "submissions.manualGrade.range:50",
    )
    const save = screen.getByRole("button", { name: "common.save" })
    expect(save.hasAttribute("disabled")).toBe(true)
    await user.click(save)
    expect(mutate).not.toHaveBeenCalled()
  })

  it("saves a valid score with override context", async () => {
    const user = userEvent.setup()
    renderCell({ hasGrade: false })
    await user.click(
      screen.getByRole("button", {
        name: "submissions.manualGrade.addLabel:alice",
      }),
    )
    const input = screen.getByRole("spinbutton", {
      name: "submissions.manualGrade.inputLabel:alice",
    })
    await user.type(input, "40")
    await user.click(screen.getByRole("button", { name: "common.save" }))
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate.mock.calls[0][0]).toMatchObject({
      org: "acme",
      classroom: "cs50",
      assignment: "hw1",
      owner: "alice",
      score: 40,
      maxPoints: 50,
    })
  })

  it("cancels back to idle without saving", async () => {
    const user = userEvent.setup()
    renderCell({ hasGrade: true, score: 10, max: 50 })
    await user.click(
      screen.getByRole("button", {
        name: "submissions.manualGrade.editLabel:alice",
      }),
    )
    await user.click(screen.getByRole("button", { name: "common.cancel" }))
    expect(mutate).not.toHaveBeenCalled()
    // Back to the idle badge.
    expect(screen.getByText("10/50")).toBeTruthy()
  })
})
