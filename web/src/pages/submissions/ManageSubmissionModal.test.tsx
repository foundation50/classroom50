// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) =>
        opts && "repo" in opts ? `${key}:${String(opts.repo)}` : key,
    }),
  }
})

// Only the hub's own composition/hand-off is under test; the per-action hooks
// are stubbed so no GitHub/provider wiring is needed.
vi.mock("@/hooks/useGetFeedbackPr", () => ({
  default: () => ({ refetch: vi.fn() }),
}))
vi.mock("@/hooks/mutations/useRepairFeedbackPr", () => ({
  default: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock("@/context/notifications/NotificationProvider", () => ({
  useToast: () => ({ notify: vi.fn() }),
}))
vi.mock("@/hooks/useTriggerRegrade", () => ({
  default: () => ({ regrade: vi.fn(), phase: "idle", anyRegrading: false }),
}))
vi.mock("@/hooks/mutations/useDownloadSubmission", () => ({
  default: () => ({ mutate: vi.fn(), isPending: false }),
}))

import { ManageSubmissionModal } from "./ManageSubmissionModal"

const individualAction = {
  mode: "individual" as const,
  org: "acme",
  classroom: "cs101",
  assignment: "hw1",
  owner: "alice",
  repo: "cs101-hw1-alice",
  hasRepo: true,
  emptyRepo: false,
}

afterEach(cleanup)

describe("ManageSubmissionModal", () => {
  it("closes the hub, then opens the access editor when Manage access is chosen", async () => {
    const user = userEvent.setup()
    const onManageAccess = vi.fn()
    const onClose = vi.fn()
    render(
      <ManageSubmissionModal
        onClose={onClose}
        title="Alice"
        repo="cs101-hw1-alice"
        repoHref="https://github.com/acme/cs101-hw1-alice"
        isGroup={false}
        action={{ ...individualAction, onManageAccess }}
      />,
    )
    await user.click(
      screen.getByRole("button", {
        name: "submissions.table.manageAccessAria",
      }),
    )
    // Hand-off, not a nested modal: the hub's onClose fires (dialog.close) and
    // the dedicated editor callback runs.
    expect(onManageAccess).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalled()
  })

  it("offers the group members hand-off and omits per-student access", async () => {
    const user = userEvent.setup()
    const onManageMembers = vi.fn()
    render(
      <ManageSubmissionModal
        onClose={vi.fn()}
        title="cs101-hw1-team"
        repo="cs101-hw1-team"
        repoHref="https://github.com/acme/cs101-hw1-team"
        isGroup
        onManageMembers={onManageMembers}
        action={{
          ...individualAction,
          mode: "group",
          owner: "team",
          repo: "cs101-hw1-team",
        }}
      />,
    )
    expect(
      screen.queryByRole("button", {
        name: "submissions.table.manageAccessAria",
      }),
    ).toBeNull()
    await user.click(
      screen.getByRole("button", { name: /submissions\.table\.members/ }),
    )
    expect(onManageMembers).toHaveBeenCalledOnce()
  })

  it("disables the repo-scoped actions when no repo exists yet", () => {
    render(
      <ManageSubmissionModal
        onClose={vi.fn()}
        title="Alice"
        repo="cs101-hw1-alice"
        isGroup={false}
        action={{
          ...individualAction,
          hasRepo: false,
          onManageAccess: vi.fn(),
        }}
      />,
    )
    expect(
      screen
        .getByRole("button", { name: "submissions.rowDownload.aria" })
        .hasAttribute("disabled"),
    ).toBe(true)
    expect(
      screen
        .getByRole("button", { name: "submissions.table.reviewAria" })
        .hasAttribute("disabled"),
    ).toBe(true)
  })
})
