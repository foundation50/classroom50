// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactElement } from "react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    // Return the key, interpolating {{count}} so labels stay distinguishable.
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) =>
        opts && "count" in opts ? `${key}:${opts.count}` : key,
    }),
  }
})

// Mock the mutations module so the modal's helpers stay real (parseRosterImportFile
// etc. are defined IN UploadRoster) while the network-touching calls are stubbed.
const bulkInviteByEmail = vi.fn()
const resolveRosterUploadPreflight = vi.fn()
const inviteRosterStudents = vi.fn()
const bulkEnrollStudentsInClassroom = vi.fn()

vi.mock("@/api/mutations/students", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/api/mutations/students")>()
  return {
    ...actual,
    bulkInviteByEmail: (...args: unknown[]) => bulkInviteByEmail(...args),
    resolveRosterUploadPreflight: (...args: unknown[]) =>
      resolveRosterUploadPreflight(...args),
    inviteRosterStudents: (...args: unknown[]) => inviteRosterStudents(...args),
  }
})

vi.mock("@/hooks/github/mutations", () => ({
  bulkEnrollStudentsInClassroom: (...args: unknown[]) =>
    bulkEnrollStudentsInClassroom(...args),
}))

import UploadRoster from "./UploadRoster"
import type { GitHubClient } from "@/hooks/github/client"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const client = {} as unknown as GitHubClient

const renderModal = (ui: ReactElement) => render(ui)

const file = (name: string, contents: string) =>
  new File([contents], name, { type: "text/plain" })

// Upload a file through the hidden <input type="file">. userEvent.upload fires
// the change event ingestFile listens on.
const uploadFile = async (
  user: ReturnType<typeof userEvent.setup>,
  f: File,
) => {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  await user.upload(input, f)
}

const primaryButton = () =>
  screen
    .getByRole("button", {
      name: /sendInviteCount|importAndInviteMembers|importMembers|confirmChanges|noChangesToApply/,
    })
    .closest("button") as HTMLButtonElement

describe("UploadRoster email-invite owner-confirmation gate", () => {
  it("keeps Send disabled for an instructor email until the owner checkbox is ticked", async () => {
    const user = userEvent.setup()
    renderModal(
      <UploadRoster org="acme" classroom="cs50" client={client} open={true} />,
    )

    await uploadFile(user, file("emails.txt", "prof@x.edu\n"))

    // Auto-detected as email-list; the send button renders and is disabled
    // while an instructor role would grant owner but is unconfirmed.
    const send = await waitFor(() => primaryButton())

    // Assign the sole address the instructor role -> owner-grant path.
    const roleSelect = screen.getByLabelText(
      "students.assignRoleLabel",
    ) as HTMLSelectElement
    await user.selectOptions(roleSelect, "instructor")

    expect(send.disabled).toBe(true)

    // Ticking the confirmation enables Send.
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement
    await user.click(checkbox)
    await waitFor(() => expect(primaryButton().disabled).toBe(false))

    // And it actually sends when clicked.
    bulkInviteByEmail.mockResolvedValue({
      invited: [{ email: "prof@x.edu", role: "instructor" }],
      skipped: [],
      failed: [],
      deferred: [],
    })
    await user.click(primaryButton())
    await waitFor(() => expect(bulkInviteByEmail).toHaveBeenCalledTimes(1))
  })

  it("never sends an instructor email invite while the box is unchecked", async () => {
    const user = userEvent.setup()
    renderModal(
      <UploadRoster org="acme" classroom="cs50" client={client} open={true} />,
    )

    await uploadFile(user, file("emails.txt", "prof@x.edu\n"))
    await waitFor(() => primaryButton())
    await user.selectOptions(
      screen.getByLabelText("students.assignRoleLabel"),
      "instructor",
    )

    // The disabled button can't be clicked to send.
    expect(primaryButton().disabled).toBe(true)
    await user.click(primaryButton())
    expect(bulkInviteByEmail).not.toHaveBeenCalled()
  })
})

describe("UploadRoster detected-kind override", () => {
  it("re-parses the same text and swaps the preview branch (email <-> roster)", async () => {
    const user = userEvent.setup()
    resolveRosterUploadPreflight.mockResolvedValue({
      noAction: [],
      needsInvite: [{ username: "ada" }],
      enroll: [],
      roleChanges: [],
      allAlreadyMembers: false,
    })
    renderModal(
      <UploadRoster org="acme" classroom="cs50" client={client} open={true} />,
    )

    // An email list auto-detects as email-list: the email preview shows.
    await uploadFile(user, file("list.txt", "ada@x.edu\n"))
    await waitFor(() => screen.getByText("students.emailsFound:1"))

    // Override to a username list: the same text re-parses on the roster path,
    // the email preview is gone and the roster table (username row) appears.
    const overrideSelect = screen.getByLabelText(
      "students.detectedFormat",
    ) as HTMLSelectElement
    await user.selectOptions(overrideSelect, "username-list")

    await waitFor(() =>
      expect(screen.queryByText("students.emailsFound:1")).toBeNull(),
    )
    // "ada@x.edu" is not a valid GitHub username, so the roster parse yields no
    // rows -> the no-valid-usernames warning, proving the branch swapped and
    // the email state was cleared.
    expect(screen.getByText("students.usernamesFound:0")).toBeTruthy()
  })
})

describe("UploadRoster open->false reset", () => {
  it("clears preview state so reopening shows the drop zone, not the stale file", async () => {
    const user = userEvent.setup()
    const { rerender } = renderModal(
      <UploadRoster org="acme" classroom="cs50" client={client} open={true} />,
    )

    await uploadFile(user, file("emails.txt", "ada@x.edu\n"))
    await waitFor(() => screen.getByText("students.emailsFound:1"))

    // Close (open -> false), then reopen (open -> true).
    rerender(
      <UploadRoster org="acme" classroom="cs50" client={client} open={false} />,
    )
    rerender(
      <UploadRoster org="acme" classroom="cs50" client={client} open={true} />,
    )

    // The drop zone is back; the abandoned file's preview is gone.
    await waitFor(() =>
      expect(screen.getByText("students.uploadDropPrompt")).toBeTruthy(),
    )
    expect(screen.queryByText("students.emailsFound:1")).toBeNull()
  })
})

describe("UploadRoster canProcess gating", () => {
  it("disables the primary button when the preflight resolves to all no-action", async () => {
    const user = userEvent.setup()
    // Every uploaded row is already a correctly-enrolled member: nothing to do.
    resolveRosterUploadPreflight.mockResolvedValue({
      noAction: [{ username: "ada" }],
      needsInvite: [],
      enroll: [],
      roleChanges: [],
      allAlreadyMembers: true,
    })
    renderModal(
      <UploadRoster org="acme" classroom="cs50" client={client} open={true} />,
    )

    await uploadFile(user, file("roster.csv", "username\nada\n"))

    // Once the preflight resolves to no actionable work, the primary button
    // reads "no changes to apply" and is disabled.
    const button = await waitFor(() => {
      const b = screen
        .getByRole("button", { name: /noChangesToApply/ })
        .closest("button") as HTMLButtonElement
      return b
    })
    expect(button.disabled).toBe(true)
  })
})
