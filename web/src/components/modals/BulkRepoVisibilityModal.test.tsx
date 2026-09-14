// @vitest-environment happy-dom
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

const mutateAsync = vi.fn()
vi.mock("@/hooks/mutations/useSetRepoVisibility", () => ({
  default: () => ({ mutateAsync }),
}))

import { BulkRepoVisibilityModal } from "./BulkRepoVisibilityModal"

afterEach(() => {
  cleanup()
  mutateAsync.mockReset()
})

function renderModal(autograded?: boolean) {
  return render(
    <BulkRepoVisibilityModal
      open
      onClose={() => {}}
      org="o"
      classroom="cs"
      assignment="hello"
      owners={["alice", "bob"]}
      autograded={autograded}
    />,
  )
}

const pickPublic = () =>
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "public" },
  })

const exposure = "submissions.bulkVisibility.publicWarning"
const autograder = "submissions.bulkVisibility.autograderWarning"

// Picking public on an autograded assignment must warn that grading stops
// (issue #995), next to the existing exposure warning.
describe("BulkRepoVisibilityModal autograder warning", () => {
  it("shows both warnings when public is picked on an autograded assignment", () => {
    renderModal(true)
    expect(screen.queryByText(autograder)).toBeNull()
    pickPublic()
    expect(screen.getByText(exposure)).toBeTruthy()
    expect(screen.getByText(autograder)).toBeTruthy()
  })

  it("keeps only the exposure warning when the assignment doesn't autograde", () => {
    renderModal(false)
    pickPublic()
    expect(screen.getByText(exposure)).toBeTruthy()
    expect(screen.queryByText(autograder)).toBeNull()
  })

  it("shows no autograder warning for private", () => {
    renderModal(true)
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "private" },
    })
    expect(screen.queryByText(autograder)).toBeNull()
  })
})
