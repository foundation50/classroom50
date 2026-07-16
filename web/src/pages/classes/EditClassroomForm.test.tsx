// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// i18n as identity so we can assert on raw keys.
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

const notify = vi.fn()
vi.mock("@/context/notifications/NotificationProvider", () => ({
  useToast: () => ({ notify }),
}))

// The hook under the call site: mutateAsync resolves with whatever the current
// test sets, so we can drive the teamDeleteWarning branch.
let deleteResult: { deleted: boolean; teamDeleteWarning?: boolean } = {
  deleted: true,
}
const mutateAsync = vi.fn(() => Promise.resolve(deleteResult))
vi.mock("@/hooks/mutations/useDeleteClassroom", () => ({
  useDeleteClassroom: () => ({ mutateAsync }),
}))

import { DeleteClassroomButton } from "./EditClassroomForm"

const ORG = "acme"
const SLUG = "cs101"

// Walks the ConfirmModal from trigger to confirmed: open, acknowledge the
// dangerous prompt, type the required "<org>/<slug>" phrase, confirm.
async function confirmDelete() {
  const user = userEvent.setup()
  await user.click(screen.getByLabelText("classes.deleteClassroomAria"))
  await user.click(screen.getByText("components.confirmModal.yesContinue"))
  const input = await screen.findByRole("textbox")
  await user.type(input, `${ORG}/${SLUG}`)
  await user.click(screen.getByText("classes.deleteClassroomConfirm"))
}

beforeEach(() => {
  deleteResult = { deleted: true }
  mutateAsync.mockClear()
  notify.mockClear()
})

afterEach(cleanup)

describe("EditClassroomForm DeleteClassroomButton", () => {
  it("surfaces the team-cleanup warning toast when teamDeleteWarning is set", async () => {
    deleteResult = { deleted: true, teamDeleteWarning: true }
    const onDeleteClassroom = vi.fn()
    render(
      <DeleteClassroomButton
        org={ORG}
        classroom={SLUG}
        onDeleteClassroom={onDeleteClassroom}
      />,
    )

    await confirmDelete()

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          tone: "warning",
          message: "classes.deleteTeamWarning",
        }),
      ),
    )
    expect(onDeleteClassroom).toHaveBeenCalled()
  })

  it("does not toast a warning when teamDeleteWarning is absent, but still navigates", async () => {
    deleteResult = { deleted: true }
    const onDeleteClassroom = vi.fn()
    render(
      <DeleteClassroomButton
        org={ORG}
        classroom={SLUG}
        onDeleteClassroom={onDeleteClassroom}
      />,
    )

    await confirmDelete()

    await waitFor(() => expect(onDeleteClassroom).toHaveBeenCalled())
    expect(notify).not.toHaveBeenCalled()
  })
})
