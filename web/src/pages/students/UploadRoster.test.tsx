// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
const resolveRosterUploadContext = vi.fn()
const inviteRosterStudents = vi.fn()
const bulkEnrollStudentsInClassroom = vi.fn()

vi.mock("@/domain/students", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/students")>()
  return {
    ...actual,
    bulkInviteByEmail: (...args: unknown[]) => bulkInviteByEmail(...args),
    resolveRosterUploadContext: (...args: unknown[]) =>
      resolveRosterUploadContext(...args),
    inviteRosterStudents: (...args: unknown[]) => inviteRosterStudents(...args),
    bulkEnrollStudentsInClassroom: (...args: unknown[]) =>
      bulkEnrollStudentsInClassroom(...args),
  }
})

// The component fetches a role-independent context (mocked to a stub here) and
// then runs the REAL pure classifyRosterUpload on it. Mock classify so each test
// can pin the resulting PreflightResult directly, as before.
const classifyRosterUpload = vi.fn()

vi.mock("@/util/rosterUploadPreflight", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/util/rosterUploadPreflight")>()
  return {
    ...actual,
    classifyRosterUpload: (...args: unknown[]) => classifyRosterUpload(...args),
  }
})

import UploadRoster from "./UploadRoster"
import type { GitHubClient } from "@/github-core/client"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// A stub context — its lookups are never invoked because classifyRosterUpload is
// mocked. Each preview test sets the classification via classifyRosterUpload.
const stubContext = {
  lookup: () => undefined,
  storedByIdentity: () => undefined,
}
beforeEach(() => {
  resolveRosterUploadContext.mockResolvedValue(stubContext)
  classifyRosterUpload.mockReturnValue({
    noAction: [],
    metadataUpdate: [],
    needsInvite: [],
    enroll: [],
    roleChanges: [],
    allAlreadyMembers: true,
  })
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
  it("keeps Send disabled for a teacher email until the owner checkbox is ticked", async () => {
    const user = userEvent.setup()
    renderModal(
      <UploadRoster org="acme" classroom="cs50" client={client} open={true} />,
    )

    await uploadFile(user, file("emails.txt", "prof@x.edu\n"))

    // Auto-detected as email-list; the send button renders and is disabled
    // while a teacher role would grant owner but is unconfirmed.
    const send = await waitFor(() => primaryButton())

    // Assign the sole address the teacher role -> owner-grant path.
    const roleSelect = screen.getByLabelText(
      "students.assignRoleLabel",
    ) as HTMLSelectElement
    await user.selectOptions(roleSelect, "teacher")

    expect(send.disabled).toBe(true)

    // Ticking the confirmation enables Send.
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement
    await user.click(checkbox)
    await waitFor(() => expect(primaryButton().disabled).toBe(false))

    // And it actually sends when clicked.
    bulkInviteByEmail.mockResolvedValue({
      invited: [{ email: "prof@x.edu", role: "teacher" }],
      skipped: [],
      failed: [],
      deferred: [],
    })
    await user.click(primaryButton())
    await waitFor(() => expect(bulkInviteByEmail).toHaveBeenCalledTimes(1))
  })

  it("never sends a teacher email invite while the box is unchecked", async () => {
    const user = userEvent.setup()
    renderModal(
      <UploadRoster org="acme" classroom="cs50" client={client} open={true} />,
    )

    await uploadFile(user, file("emails.txt", "prof@x.edu\n"))
    await waitFor(() => primaryButton())
    await user.selectOptions(
      screen.getByLabelText("students.assignRoleLabel"),
      "teacher",
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
    classifyRosterUpload.mockReturnValue({
      noAction: [],
      needsInvite: [{ username: "ada" }],
      enroll: [],
      roleChanges: [],
      metadataUpdate: [],
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
    expect(screen.getByText("students.noValidUsernames")).toBeTruthy()
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
    classifyRosterUpload.mockReturnValue({
      noAction: [{ username: "ada" }],
      needsInvite: [],
      enroll: [],
      roleChanges: [],
      metadataUpdate: [],
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

    // The full CSV preview is still shown (not collapsed) so the teacher can
    // confirm the file was read correctly even though there's nothing to apply.
    expect(screen.getByText("ada")).toBeTruthy()
    // ...and the summary reports everyone is already up to date.
    expect(screen.getByText(/summary_skip/)).toBeTruthy()
    // No details toggle when the table is force-shown for the no-changes case.
    expect(
      screen.queryByRole("button", { name: /summaryViewDetails/ }),
    ).toBeNull()
  })

  it("enables the button for a metadata-only upload only after confirmation", async () => {
    const user = userEvent.setup()
    classifyRosterUpload.mockReturnValue({
      noAction: [],
      needsInvite: [],
      enroll: [],
      roleChanges: [],
      metadataUpdate: [
        {
          kind: "metadata_update",
          username: "ada",
          role: "student",
          changedFields: ["email"],
          changes: [{ field: "email", from: "old@x.edu", to: "ada@x.edu" }],
        },
      ],
      allAlreadyMembers: true,
    })
    renderModal(
      <UploadRoster org="acme" classroom="cs50" client={client} open={true} />,
    )

    await uploadFile(
      user,
      file("roster.csv", "username,email\nada,ada@x.edu\n"),
    )

    // The primary button reads "Update ..." and starts disabled (unconfirmed).
    const button = await waitFor(() => {
      const b = screen
        .getByRole("button", { name: /updateMetadata/ })
        .closest("button") as HTMLButtonElement
      return b
    })
    expect(button.disabled).toBe(true)

    // Checking the metadata confirmation enables it.
    const checkbox = screen
      .getByText(/preflightConfirmMetadata/)
      .closest("label")!
      .querySelector("input[type=checkbox]") as HTMLInputElement
    await user.click(checkbox)
    await waitFor(() => expect(button.disabled).toBe(false))

    // The CSV metadata must reach the classifier, or metadata_update can never
    // be detected. Guards against a dropped field in the preflightRows mapping.
    expect(classifyRosterUpload).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ username: "ada", email: "ada@x.edu" }),
      ]),
      expect.anything(),
      expect.anything(),
    )
  })
})

describe("UploadRoster role-edit reclassification", () => {
  it("reclassifies on a role change without re-fetching the membership context", async () => {
    const user = userEvent.setup()
    // A role change forces the details table open, so the role Select is visible.
    classifyRosterUpload.mockReturnValue({
      noAction: [],
      needsInvite: [],
      enroll: [],
      roleChanges: [
        {
          username: "ada",
          role: "ta",
          currentRole: "student",
          currentRoles: ["student"],
          changedFields: [],
          changes: [],
        },
      ],
      metadataUpdate: [],
      allAlreadyMembers: true,
    })
    renderModal(
      <UploadRoster org="acme" classroom="cs50" client={client} open={true} />,
    )

    await uploadFile(user, file("roster.csv", "username\nada\n"))
    // The context read resolves once and the preview table renders (a role
    // change forces details open, so the per-row role Select is present).
    const roleSelect = await waitFor(() => {
      const selects = screen.getAllByRole("combobox")
      // Selects: the DetectedFormat picker + the per-row role picker. Grab the
      // row one by its aria-label.
      const row = selects.find(
        (s) => s.getAttribute("aria-label") === "students.assignRoleLabel",
      )
      if (!row) throw new Error("role select not rendered yet")
      return row as HTMLSelectElement
    })
    expect(resolveRosterUploadContext).toHaveBeenCalledTimes(1)
    const classifyCallsAfterLoad = classifyRosterUpload.mock.calls.length
    expect(classifyCallsAfterLoad).toBeGreaterThan(0)

    // Change the row's role: this must re-run the pure classifier but NOT
    // re-fetch the membership context (no network, no loading skeleton).
    await user.selectOptions(roleSelect, "ta")

    await waitFor(() =>
      expect(classifyRosterUpload.mock.calls.length).toBeGreaterThan(
        classifyCallsAfterLoad,
      ),
    )
    // Still exactly one context fetch — the expensive read was not repeated.
    expect(resolveRosterUploadContext).toHaveBeenCalledTimes(1)
    // ...and the table never flips back into the loading skeleton on the edit.
    expect(document.querySelectorAll(".skeleton").length).toBe(0)
  })

  it("re-clears a ticked confirmation when a role is edited", async () => {
    const user = userEvent.setup()
    classifyRosterUpload.mockReturnValue({
      noAction: [],
      needsInvite: [],
      enroll: [],
      roleChanges: [
        {
          username: "ada",
          role: "ta",
          currentRole: "student",
          currentRoles: ["student"],
          changedFields: [],
          changes: [],
        },
      ],
      metadataUpdate: [],
      allAlreadyMembers: true,
    })
    renderModal(
      <UploadRoster org="acme" classroom="cs50" client={client} open={true} />,
    )

    await uploadFile(user, file("roster.csv", "username\nada\n"))
    const roleSelect = await waitFor(() => {
      const row = screen
        .getAllByRole("combobox")
        .find(
          (s) => s.getAttribute("aria-label") === "students.assignRoleLabel",
        )
      if (!row) throw new Error("role select not rendered yet")
      return row as HTMLSelectElement
    })

    // Tick the role-change confirmation → primary button enables.
    const confirm = screen
      .getByText(/preflightConfirmRoleChanges/)
      .closest("label")!
      .querySelector("input[type=checkbox]") as HTMLInputElement
    await user.click(confirm)
    const button = screen
      .getByRole("button", { name: /confirmChanges/ })
      .closest("button") as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))

    // Editing a role invalidates the prior confirmation: checkbox clears and the
    // button disables until the teacher re-confirms.
    await user.selectOptions(roleSelect, "hta")
    await waitFor(() => expect(confirm.checked).toBe(false))
    expect(button.disabled).toBe(true)
  })

  it("re-requires metadata confirmation after a same-username re-upload with changed details", async () => {
    const user = userEvent.setup()
    // A metadata_update forces the details table open + the metadata checkbox.
    classifyRosterUpload.mockReturnValue({
      noAction: [],
      needsInvite: [],
      enroll: [],
      roleChanges: [],
      metadataUpdate: [
        {
          kind: "metadata_update",
          username: "ada",
          role: "student",
          changedFields: ["email"],
          changes: [{ field: "email", from: "old@x.edu", to: "a@x.edu" }],
        },
      ],
      allAlreadyMembers: true,
    })
    renderModal(
      <UploadRoster org="acme" classroom="cs50" client={client} open={true} />,
    )

    await uploadFile(user, file("roster.csv", "username,email\nada,a@x.edu\n"))
    const confirm = await waitFor(() => {
      const box = screen
        .getByText(/preflightConfirmMetadata/)
        .closest("label")!
        .querySelector("input[type=checkbox]") as HTMLInputElement
      return box
    })
    await user.click(confirm)
    const button = screen
      .getByRole("button", { name: /updateMetadata/ })
      .closest("button") as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))

    // Re-upload a file with the SAME username (ada) but a DIFFERENT email. The
    // username set + roles are unchanged, so the rolesKey reset effect alone
    // wouldn't fire — applyKind must re-arm the gate so the teacher re-confirms.
    await uploadFile(user, file("roster.csv", "username,email\nada,b@x.edu\n"))
    await waitFor(() => expect(confirm.checked).toBe(false))
    expect(button.disabled).toBe(true)
  })
})
