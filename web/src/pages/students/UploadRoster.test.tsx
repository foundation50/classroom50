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
const repairRosterUsernames = vi.fn()
const writeClassroomRoles = vi.fn()
const updateClassroomMetadata = vi.fn()
const getUserById = vi.fn()

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
    repairRosterUsernames: (...args: unknown[]) =>
      repairRosterUsernames(...args),
    writeClassroomRoles: (...args: unknown[]) => writeClassroomRoles(...args),
    updateClassroomMetadata: (...args: unknown[]) =>
      updateClassroomMetadata(...args),
  }
})

// The id -> login network fallback, used only for an id the org-member map lacks.
vi.mock("@/github-core/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/github-core/queries")>()
  return {
    ...actual,
    getUserById: (...args: unknown[]) => getUserById(...args),
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
import { GitHubAPIError } from "@/github-core/errors"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// A stub context — its lookups are never invoked because classifyRosterUpload is
// mocked. Each preview test sets the classification via classifyRosterUpload.
const stubContext = {
  lookup: () => undefined,
  storedByIdentity: () => undefined,
  loginById: new Map<number, string>(),
}
beforeEach(() => {
  resolveRosterUploadContext.mockResolvedValue(stubContext)
  classifyRosterUpload.mockReturnValue({
    noAction: [],
    metadataUpdate: [],
    needsInvite: [],
    enroll: [],
    roleChanges: [],
    identityMismatches: [],
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

// Every upload opens as Roster CSV now, so a test exercising the dedicated
// email-list branch has to select it explicitly.
const chooseEmailList = async (user: ReturnType<typeof userEvent.setup>) => {
  const select = await waitFor(
    () => screen.getByLabelText("students.detectedFormat") as HTMLSelectElement,
  )
  await user.selectOptions(select, "email-list")
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
    await chooseEmailList(user)

    // The send button renders and is disabled while a teacher role would grant
    // owner but is unconfirmed.
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
    await chooseEmailList(user)
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

describe("UploadRoster format override", () => {
  it("re-parses the same text and swaps the preview branch (roster <-> email)", async () => {
    const user = userEvent.setup()
    classifyRosterUpload.mockReturnValue({
      noAction: [],
      needsInvite: [{ username: "ada" }],
      enroll: [],
      roleChanges: [],
      metadataUpdate: [],
      identityMismatches: [],
      allAlreadyMembers: false,
    })
    renderModal(
      <UploadRoster org="acme" classroom="cs50" client={client} open={true} />,
    )

    // An address list opens as Roster CSV — the smart parser reads the line as an
    // email identity, so the roster table shows it as an invite-by-email row.
    await uploadFile(user, file("list.txt", "ada@x.edu\n"))
    await waitFor(() => screen.getByText("students.summaryViewDetails"))
    await user.click(screen.getByText("students.summaryViewDetails"))
    expect(screen.getByText("students.previewInviteByEmail")).toBeTruthy()

    // Overriding to the dedicated email branch swaps to the email preview.
    await chooseEmailList(user)
    await waitFor(() => screen.getByText("students.emailsFound:1"))
    expect(screen.queryByText("students.previewInviteByEmail")).toBeNull()

    // Overriding to a username list forces the line to be read as a handle;
    // "ada@x.edu" isn't a plausible one, so no rows survive.
    const overrideSelect = screen.getByLabelText(
      "students.detectedFormat",
    ) as HTMLSelectElement
    await user.selectOptions(overrideSelect, "username-list")
    await waitFor(() =>
      expect(screen.queryByText("students.emailsFound:1")).toBeNull(),
    )
    expect(screen.getByText("students.noUsableRows")).toBeTruthy()
  })
})

describe("UploadRoster open->false reset", () => {
  it("clears preview state so reopening shows the drop zone, not the stale file", async () => {
    const user = userEvent.setup()
    const { rerender } = renderModal(
      <UploadRoster org="acme" classroom="cs50" client={client} open={true} />,
    )

    await uploadFile(user, file("emails.txt", "ada@x.edu\n"))
    await chooseEmailList(user)
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
      identityMismatches: [],
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
      identityMismatches: [],
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
      identityMismatches: [],
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
      identityMismatches: [],
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
      identityMismatches: [],
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

    // Re-upload a file with the SAME username (ada) but a DIFFERENT email, so
    // applyKind must re-arm the gate and the teacher re-confirms. Re-query rather
    // than reusing the node: the changed row content remounts the recap.
    await uploadFile(user, file("roster.csv", "username,email\nada,b@x.edu\n"))
    await waitFor(() => {
      const box = screen
        .getByText(/preflightConfirmMetadata/)
        .closest("label")!
        .querySelector("input[type=checkbox]") as HTMLInputElement
      expect(box.checked).toBe(false)
    })
    expect(
      (
        screen
          .getByRole("button", { name: /updateMetadata/ })
          .closest("button") as HTMLButtonElement
      ).disabled,
    ).toBe(true)
  })
})

describe("UploadRoster email-identity rows in a roster CSV", () => {
  it("makes an email-only CSV processable and invites each address", async () => {
    const user = userEvent.setup()
    // No account rows at all, so every preflight bucket is empty. The gate must
    // still open — the email rows ARE the work.
    renderModal(
      <UploadRoster org="acme" classroom="cs50" client={client} open={true} />,
    )

    await uploadFile(
      user,
      file(
        "roster.csv",
        "email,first_name,last_name,section\nzoe@x.edu,Zoe,Z,Lab 2\n",
      ),
    )

    const button = await waitFor(() => {
      const b = screen
        .getByRole("button", { name: /importAndInviteMembers/ })
        .closest("button") as HTMLButtonElement
      expect(b.disabled).toBe(false)
      return b
    })

    bulkEnrollStudentsInClassroom.mockResolvedValue({
      addedStudents: [],
      skippedStudents: [],
    })
    bulkInviteByEmail.mockResolvedValue({
      invited: [{ email: "zoe@x.edu", role: "student" }],
      skipped: [],
      failed: [],
      deferred: [],
    })

    await user.click(button)

    // The address is invited, carrying the CSV's name and section onto its
    // pending roster row — and the account pipeline is never called, since the
    // file had no account rows.
    await waitFor(() => expect(bulkInviteByEmail).toHaveBeenCalledTimes(1))
    expect(bulkInviteByEmail.mock.calls[0][1]).toMatchObject({
      invites: [
        {
          email: "zoe@x.edu",
          role: "student",
          first_name: "Zoe",
          last_name: "Z",
          section: "Lab 2",
        },
      ],
    })
    expect(bulkEnrollStudentsInClassroom).not.toHaveBeenCalled()
  })

  it("gates a teacher-role email row behind the owner confirmation", async () => {
    const user = userEvent.setup()
    renderModal(
      <UploadRoster org="acme" classroom="cs50" client={client} open={true} />,
    )

    await uploadFile(
      user,
      file("roster.csv", "email,role\nprof@x.edu,teacher\n"),
    )

    // A teacher-role email invitation makes that person an org OWNER, so the
    // roster branch must gate it exactly as the email-list branch does.
    const button = await waitFor(() => {
      const b = screen
        .getByRole("button", { name: /importAndInviteMembers/ })
        .closest("button") as HTMLButtonElement
      expect(b.disabled).toBe(true)
      return b
    })
    expect(screen.getByText(/preflightTeacherEmailNotice/)).toBeTruthy()

    const confirm = screen
      .getByText(/preflightConfirmRoleChanges/)
      .closest("label")!
      .querySelector("input[type=checkbox]") as HTMLInputElement
    await user.click(confirm)
    await waitFor(() => expect(button.disabled).toBe(false))
  })

  it("gates a teacher-role invited account behind the owner confirmation", async () => {
    const user = userEvent.setup()
    // A non-member assigned teacher classifies as needs_invite, not enroll — but
    // accepting still makes them an org OWNER, so it needs the same checkbox.
    classifyRosterUpload.mockReturnValue({
      noAction: [],
      needsInvite: [
        { kind: "needs_invite", username: "prof", role: "teacher" },
      ],
      enroll: [],
      roleChanges: [],
      metadataUpdate: [],
      identityMismatches: [],
      allAlreadyMembers: false,
    })
    renderModal(
      <UploadRoster org="acme" classroom="cs50" client={client} open={true} />,
    )

    await uploadFile(user, file("roster.csv", "username,role\nprof,teacher\n"))

    const button = await waitFor(() => {
      const b = screen
        .getByRole("button", { name: /importAndInviteMembers/ })
        .closest("button") as HTMLButtonElement
      expect(b.disabled).toBe(true)
      return b
    })
    expect(screen.getByText(/preflightRoleChangeOwnerNotice/)).toBeTruthy()

    const confirm = screen
      .getByText(/preflightConfirmRoleChanges/)
      .closest("label")!
      .querySelector("input[type=checkbox]") as HTMLInputElement
    await user.click(confirm)
    await waitFor(() => expect(button.disabled).toBe(false))
  })

  it("counts invitations, not rows, in the primary button and notice", async () => {
    const user = userEvent.setup()
    // The screenshot case: 3 rows, but one is an existing member only getting a
    // details update. The button must not claim to invite that person.
    classifyRosterUpload.mockReturnValue({
      noAction: [],
      needsInvite: [
        { kind: "needs_invite", username: "rliu50", role: "student" },
      ],
      enroll: [],
      roleChanges: [],
      metadataUpdate: [
        {
          kind: "metadata_update",
          username: "rongxin-liu",
          role: "teacher",
          changedFields: ["email"],
          changes: [{ field: "email", from: "old@x.edu", to: "new@x.edu" }],
        },
      ],
      identityMismatches: [],
      allAlreadyMembers: false,
    })
    renderModal(
      <UploadRoster org="acme" classroom="cs50" client={client} open={true} />,
    )

    await uploadFile(
      user,
      file(
        "roster.csv",
        "username,email,role\n" +
          "rliu50,a@x.edu,student\n" +
          "rongxin-liu,new@x.edu,teacher\n" +
          ",zoe@x.edu,student\n",
      ),
    )

    // 1 username invite + 1 email row = 2, not the 3 rows in the file.
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "students.importAndInviteMembers:2",
        }),
      ).toBeTruthy(),
    )
    expect(screen.getByText("students.uploadInviteNotice:2")).toBeTruthy()
  })

  it("re-resolves after a re-parse that yields identical identity cells", async () => {
    const user = userEvent.setup()
    renderModal(
      <UploadRoster org="acme" classroom="cs50" client={client} open={true} />,
    )

    // First upload resolves and previews.
    await uploadFile(user, file("roster.csv", "username,section\nada,Lab 1\n"))
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /noChangesToApply|importMembers/ }),
      ).toBeTruthy(),
    )

    // Re-upload the SAME identity (ada) with only the section changed. The
    // identity set is byte-identical, so an effect keyed on row content alone
    // would clear the resolved rows and never recompute them — leaving an empty
    // preview with no way forward.
    await uploadFile(user, file("roster.csv", "username,section\nada,Lab 9\n"))
    await waitFor(() => expect(screen.getAllByText("ada").length).toBe(1))
    expect(screen.queryByText("students.noUsableRows")).toBeNull()
  })
})

describe("UploadRoster identity mismatch gate", () => {
  it("blocks until the teacher confirms, then repairs the stored username", async () => {
    const user = userEvent.setup()
    // github_id 42 resolves to "ada-new", but the file says "ada-old".
    resolveRosterUploadContext.mockResolvedValue({
      ...stubContext,
      loginById: new Map([[42, "ada-new"]]),
    })
    classifyRosterUpload.mockReturnValue({
      noAction: [],
      needsInvite: [{ username: "ada-new" }],
      enroll: [],
      roleChanges: [],
      metadataUpdate: [],
      identityMismatches: [
        {
          username: "ada-new",
          declaredUsername: "ada-old",
          github_id: "42",
        },
      ],
      allAlreadyMembers: false,
    })
    renderModal(
      <UploadRoster org="acme" classroom="cs50" client={client} open={true} />,
    )

    await uploadFile(
      user,
      file("roster.csv", "github_id,username\n42,ada-old\n"),
    )

    const button = await waitFor(() => {
      const b = screen
        .getByRole("button", { name: /importAndInviteMembers/ })
        .closest("button") as HTMLButtonElement
      expect(b.disabled).toBe(true)
      return b
    })
    // The preview shows the account the id belongs to, and what the file claimed.
    expect(screen.getAllByText("ada-new").length).toBeGreaterThan(0)
    expect(screen.getByText(/previewPreviousUsernameHint/)).toBeTruthy()
    expect(screen.queryByText("ada-old")).toBeNull()

    const confirm = screen
      .getByText(/preflightConfirmIdentity/)
      .closest("label")!
      .querySelector("input[type=checkbox]") as HTMLInputElement
    await user.click(confirm)
    await waitFor(() => expect(button.disabled).toBe(false))

    bulkEnrollStudentsInClassroom.mockResolvedValue({
      addedStudents: [],
      skippedStudents: [],
    })
    inviteRosterStudents.mockResolvedValue({
      invited: [],
      skipped: [],
      failed: [],
      deferred: [],
    })
    await user.click(button)

    // The row is imported under the id's account, and the stale stored login is
    // repaired so the same warning doesn't reappear on every future upload.
    await waitFor(() => expect(repairRosterUsernames).toHaveBeenCalledTimes(1))
    expect(repairRosterUsernames.mock.calls[0][1]).toMatchObject({
      repairs: [{ github_id: "42", username: "ada-new" }],
    })
  })

  it("keeps a mismatch-only upload processable so the repair can land", async () => {
    const user = userEvent.setup()
    // Every row is already correct except for a stale stored username. That
    // repair IS the work, so the button must not read "no changes to apply".
    resolveRosterUploadContext.mockResolvedValue({
      ...stubContext,
      loginById: new Map([[42, "ada-new"]]),
    })
    classifyRosterUpload.mockReturnValue({
      noAction: [{ kind: "no_action", username: "ada-new", role: "student" }],
      needsInvite: [],
      enroll: [],
      roleChanges: [],
      metadataUpdate: [],
      identityMismatches: [
        { username: "ada-new", declaredUsername: "ada-old", github_id: "42" },
      ],
      allAlreadyMembers: true,
    })
    renderModal(
      <UploadRoster org="acme" classroom="cs50" client={client} open={true} />,
    )

    await uploadFile(
      user,
      file("roster.csv", "github_id,username\n42,ada-old\n"),
    )

    const confirm = await waitFor(
      () =>
        screen
          .getByText(/preflightConfirmIdentity/)
          .closest("label")!
          .querySelector("input[type=checkbox]") as HTMLInputElement,
    )
    await user.click(confirm)
    // "Confirm changes", not "no changes to apply" — and enabled.
    const button = screen
      .getByRole("button", { name: /confirmChanges/ })
      .closest("button") as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
  })

  it("skips a row whose github_id cannot be resolved, rather than using its username", async () => {
    const user = userEvent.setup()
    // The id is absent from the org-member map and the network lookup 404s, so
    // the row must be reported — never re-keyed to the username cell, which
    // could belong to someone else entirely.
    getUserById.mockRejectedValue(
      new GitHubAPIError({
        status: 404,
        url: "https://api.github.com/user/999",
        message: "not found",
        body: null,
        rateLimit: {
          limit: null,
          remaining: null,
          used: null,
          reset: null,
          resource: null,
          retryAfter: null,
        },
      }),
    )
    renderModal(
      <UploadRoster org="acme" classroom="cs50" client={client} open={true} />,
    )

    await uploadFile(
      user,
      file("roster.csv", "github_id,username\n999,someone-else\n"),
    )

    await waitFor(() =>
      expect(screen.getByText(/unresolvedIdRows/)).toBeTruthy(),
    )
    expect(screen.queryByText("someone-else")).toBeNull()
  })
})
