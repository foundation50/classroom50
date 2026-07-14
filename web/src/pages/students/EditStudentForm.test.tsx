// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactElement } from "react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}) as unknown,
}))

const updateStudentWithConflictRetry = vi.fn()
vi.mock("@/domain/students", () => ({
  updateStudentWithConflictRetry: (...args: unknown[]) =>
    updateStudentWithConflictRetry(...args),
}))

import EditStudentForm from "./EditStudentForm"
import type { Student } from "@/types/classroom"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const student: Student = {
  username: "octocat",
  first_name: "Mona",
  last_name: "Cat",
  email: "mona@example.com",
  section: "A",
  github_id: "42",
  role: "student",
}

const renderForm = (ui: ReactElement) =>
  render(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  )

// #: a successful save unmounts the form (parent leaves edit mode) while
// react-form's isSubmitting is still true for that render, so the parent never
// received the trailing false. The unmount cleanup must push false so the
// parent's mirrored `submitting` (folded into the modal's `busy` guard) can't
// stay stuck true and wedge the modal shut.
describe("EditStudentForm submitting propagation", () => {
  it("reports submitting false on unmount after a successful save", async () => {
    updateStudentWithConflictRetry.mockResolvedValue({
      student: { ...student, first_name: "Renamed" },
    })
    const user = userEvent.setup()
    const onSubmittingChange = vi.fn<(submitting: boolean) => void>()
    // Mirror the parent: unmount the form when the save reports success.
    const onSaved = vi.fn(() => unmount())

    const { unmount } = renderForm(
      <EditStudentForm
        org="acme"
        classroom="cs50"
        student={student}
        onCancel={() => {}}
        onSaved={onSaved}
        onSubmittingChange={onSubmittingChange}
      />,
    )

    await user.click(screen.getByText("students.saveChanges"))

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    // Whatever the intermediate transitions, the LAST signal the parent hears
    // is false — the modal's busy latch clears.
    await waitFor(() =>
      expect(onSubmittingChange.mock.calls.at(-1)?.[0]).toBe(false),
    )
  })

  it("reports submitting false on a plain unmount (cancel / row switch)", () => {
    const onSubmittingChange = vi.fn<(submitting: boolean) => void>()
    const { unmount } = renderForm(
      <EditStudentForm
        org="acme"
        classroom="cs50"
        student={student}
        onCancel={() => {}}
        onSaved={() => {}}
        onSubmittingChange={onSubmittingChange}
      />,
    )
    onSubmittingChange.mockClear()
    unmount()
    expect(onSubmittingChange).toHaveBeenLastCalledWith(false)
  })
})

// The Save button must be disabled for the WHOLE in-flight write, not just flip
// at the end. Clicking submit should synchronously (within the submit tick)
// mark the form submitting and disable the button until the mutation settles.
describe("EditStudentForm in-flight Save button", () => {
  it("disables Save while the write is in flight", async () => {
    let resolveWrite: (v: unknown) => void = () => {}
    updateStudentWithConflictRetry.mockImplementation(
      () => new Promise((resolve) => (resolveWrite = resolve)),
    )
    const user = userEvent.setup()
    const onSubmittingChange = vi.fn<(submitting: boolean) => void>()

    renderForm(
      <EditStudentForm
        org="acme"
        classroom="cs50"
        student={student}
        onCancel={() => {}}
        onSaved={() => {}}
        onSubmittingChange={onSubmittingChange}
      />,
    )

    const button = screen
      .getByRole("button", { name: /saveChanges|saving/ })
      .closest("button") as HTMLButtonElement

    expect(button.disabled).toBe(false)
    await user.click(button)

    // In flight: the mutation promise is unsettled, the button is disabled.
    await waitFor(() => expect(button.disabled).toBe(true))
    expect(onSubmittingChange.mock.calls.at(-1)?.[0]).toBe(true)

    // Settle so the test doesn't leak a pending promise.
    resolveWrite({ student })
    await waitFor(() =>
      expect(onSubmittingChange.mock.calls.at(-1)?.[0]).toBe(false),
    )
  })

  // The real bug: the roster modal recreates the `student` object every render
  // (rowToStudent(row)) and passes a stable `resetSignal`. A parent re-render
  // mid-submit (e.g. from the submitting flag flowing up) must NOT re-run the
  // form-reset effect — form.reset() clears isSubmitting, re-enabling Save while
  // the write is still running. Keying the reset on `resetSignal` alone fixes
  // it; this pins that a fresh `student` identity mid-flight keeps Save disabled.
  it("keeps Save disabled when the parent recreates `student` mid-flight", async () => {
    let resolveWrite: (v: unknown) => void = () => {}
    updateStudentWithConflictRetry.mockImplementation(
      () => new Promise((resolve) => (resolveWrite = resolve)),
    )
    const user = userEvent.setup()

    // A stable resetSignal across the re-render, mirroring the modal (same
    // row.key + open + editingProfile) while `student` gets a new identity.
    const props = {
      org: "acme",
      classroom: "cs50",
      resetSignal: "octocat:true:true",
      onCancel: () => {},
      onSaved: () => {},
    }
    const client = new QueryClient()
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <EditStudentForm {...props} student={{ ...student }} />
      </QueryClientProvider>,
    )

    const button = screen
      .getByRole("button", { name: /saveChanges|saving/ })
      .closest("button") as HTMLButtonElement

    await user.click(button)
    await waitFor(() => expect(button.disabled).toBe(true))

    // Parent re-renders with a brand-new `student` object (same values) — as the
    // modal does on every render. The button must stay disabled.
    rerender(
      <QueryClientProvider client={client}>
        <EditStudentForm {...props} student={{ ...student }} />
      </QueryClientProvider>,
    )
    expect(button.disabled).toBe(true)

    resolveWrite({ student })
    await waitFor(() => expect(button.disabled).toBe(false))
  })
})
