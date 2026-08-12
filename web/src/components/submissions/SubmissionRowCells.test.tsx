// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

import { LastSubmittedCell, SubmissionCountCell } from "./SubmissionRowCells"

afterEach(cleanup)

describe("SubmissionCountCell", () => {
  it("renders the type-aware count label and opens on click", async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(<SubmissionCountCell mode="tag" count={3} onOpen={onOpen} />)
    const button = screen.getByRole("button", {
      name: "submissions.type.countTag",
    })
    await user.click(button)
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it("uses the every-push count key for push mode", () => {
    render(
      <SubmissionCountCell mode="every-push" count={2} onOpen={() => {}} />,
    )
    expect(
      screen.getByRole("button", { name: "submissions.type.countEveryPush" }),
    ).toBeTruthy()
  })

  it("shows the stale hint only when staleCount is set", () => {
    const { rerender } = render(
      <SubmissionCountCell mode="every-push" count={1} onOpen={() => {}} />,
    )
    expect(screen.queryByText("submissions.table.staleCount")).toBeNull()
    rerender(
      <SubmissionCountCell
        mode="every-push"
        count={1}
        onOpen={() => {}}
        staleCount
      />,
    )
    expect(screen.getByText("submissions.table.staleCount")).toBeTruthy()
  })
})

describe("LastSubmittedCell", () => {
  it("omits the teacher-only sub-lines when only a datetime is given", () => {
    render(<LastSubmittedCell datetime="2026-06-20T10:00:00Z" />)
    expect(screen.queryByText("submissions.table.late")).toBeNull()
    expect(screen.queryByText(/submissions\.table\.gradedAt/)).toBeNull()
    expect(screen.queryByText(/submissions\.table\.liveLatest/)).toBeNull()
  })

  it("renders the late badge and graded-at sub-line for the teacher view", () => {
    render(
      <LastSubmittedCell
        datetime="2026-06-20T10:00:00Z"
        late
        gradedAt="2026-06-21T10:00:00Z"
      />,
    )
    expect(screen.getByText("submissions.table.late")).toBeTruthy()
    expect(screen.getByText(/submissions\.table\.gradedAt/)).toBeTruthy()
  })
})
