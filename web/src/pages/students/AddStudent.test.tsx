// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactElement } from "react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) =>
        opts && "label" in opts ? `${key}:${opts.label}` : key,
    }),
  }
})

// The classroom (student) team is always ready in these tests.
vi.mock("@/hooks/useEnsureTeam", () => ({
  default: () => ({ team: { slug: "classroom50-cs50-students" } }),
}))

const notify = vi.fn()
vi.mock("@/context/notifications/NotificationProvider", () => ({
  useToast: () => ({ notify }),
}))

// Both mutation hooks are stubbed so the test asserts which backend a role
// routes to, without touching GitHub.
const enrollMutateAsync = vi.fn()
const staffMutateAsync = vi.fn()

vi.mock("@/hooks/mutations/useEnrollOrInviteStudent", () => ({
  useEnrollOrInviteStudent: () => ({
    mutateAsync: enrollMutateAsync,
    isPending: false,
  }),
}))
vi.mock("@/hooks/mutations/useAddStaffMember", () => ({
  useAddStaffMember: () => ({
    mutateAsync: staffMutateAsync,
    isPending: false,
  }),
}))

import AddStudent from "./AddStudent"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderModal(): ReactElement {
  return <AddStudent org="cs50" classroom="cs50" open onClose={() => {}} />
}

// mutateAsync(value, { onSuccess }) — resolve and fire the success callback so
// the modal's post-submit effects run.
function resolveEnroll(result: unknown) {
  enrollMutateAsync.mockImplementation(
    async (_v: unknown, opts?: { onSuccess?: (r: unknown) => void }) => {
      opts?.onSuccess?.(result)
      return result
    },
  )
}
function resolveStaff(result: { trimmed: string; role: string }) {
  staffMutateAsync.mockImplementation(
    async (_v: unknown, opts?: { onSuccess?: (r: unknown) => void }) => {
      opts?.onSuccess?.(result)
      return result
    },
  )
}

describe("AddStudent — role routing", () => {
  it("defaults to Student and routes a username to the student backend", async () => {
    resolveEnroll({ kind: "username", label: "octocat", warning: "" })
    render(renderModal())

    await userEvent.type(
      screen.getByLabelText("students.usernameAria"),
      "octocat",
    )
    await userEvent.click(
      screen.getByRole("button", { name: "students.addButton" }),
    )

    await waitFor(() => expect(enrollMutateAsync).toHaveBeenCalledTimes(1))
    expect(staffMutateAsync).not.toHaveBeenCalled()
    expect(enrollMutateAsync.mock.calls[0][0]).toMatchObject({
      username: "octocat",
    })
  })

  it("routes a Teacher selection to the staff backend with the role", async () => {
    resolveStaff({ trimmed: "prof", role: "teacher" })
    render(renderModal())

    await userEvent.selectOptions(
      screen.getByLabelText("students.addRoleLabel"),
      "teacher",
    )
    await userEvent.type(screen.getByLabelText("students.usernameAria"), "prof")
    await userEvent.click(
      screen.getByRole("button", { name: "students.addButton" }),
    )

    await waitFor(() => expect(staffMutateAsync).toHaveBeenCalledTimes(1))
    expect(enrollMutateAsync).not.toHaveBeenCalled()
    expect(staffMutateAsync.mock.calls[0][0]).toEqual({
      username: "prof",
      role: "teacher",
    })
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "success" }),
    )
  })

  it("routes a TA selection to the staff backend", async () => {
    resolveStaff({ trimmed: "grader", role: "ta" })
    render(renderModal())

    await userEvent.selectOptions(
      screen.getByLabelText("students.addRoleLabel"),
      "ta",
    )
    await userEvent.type(
      screen.getByLabelText("students.usernameAria"),
      "grader",
    )
    await userEvent.click(
      screen.getByRole("button", { name: "students.addButton" }),
    )

    await waitFor(() => expect(staffMutateAsync).toHaveBeenCalledTimes(1))
    expect(staffMutateAsync.mock.calls[0][0]).toEqual({
      username: "grader",
      role: "ta",
    })
  })

  it("hides name/email/section fields for a staff role", async () => {
    render(renderModal())

    // Student default shows the email + section fields.
    expect(screen.getByLabelText("students.emailAria")).toBeTruthy()
    expect(screen.getByLabelText("students.sectionAria")).toBeTruthy()

    await userEvent.selectOptions(
      screen.getByLabelText("students.addRoleLabel"),
      "teacher",
    )

    expect(screen.queryByLabelText("students.emailAria")).toBeNull()
    expect(screen.queryByLabelText("students.sectionAria")).toBeNull()
    // Username stays.
    expect(screen.getByLabelText("students.usernameAria")).toBeTruthy()
  })
})
