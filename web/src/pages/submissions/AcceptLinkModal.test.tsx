// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
    Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
  }
})

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
  }
})

const orgRepoCreationWarning = vi.fn()
vi.mock("@/hooks/useOrgRepoCreationWarning", () => ({
  default: () => orgRepoCreationWarning(),
}))
// The notice's own copy is covered in OrgRepoCreationNotice.test.tsx; here it
// stands in for "did the modal mount it".
vi.mock("@/components/OrgRepoCreationNotice", async () => {
  const { default: useWarning } =
    await import("@/hooks/useOrgRepoCreationWarning")
  return {
    OrgRepoCreationNotice: () => {
      const warning = useWarning(undefined)
      if (!warning.show) return null
      return <div>{`components.notices.orgRepoCreation.${warning.field}`}</div>
    },
  }
})
// RouterButton is createLink(Button) and needs a live router; the modal's own
// affordances are not what these tests assert.
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>()
  return {
    ...actual,
    RouterButton: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
  }
})

import { AcceptLinkModal } from "./AcceptLinkModal"

const NOTICE = "components.notices.orgRepoCreation.master"
const ROSTER_WARNING = "submissions.accept.warnNoStudents"

beforeEach(() => {
  orgRepoCreationWarning.mockReturnValue({ show: false })
  // happy-dom's <dialog> lacks showModal/close.
  HTMLDialogElement.prototype.showModal = vi.fn()
  HTMLDialogElement.prototype.close = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const renderModal = (
  summary?: Parameters<typeof AcceptLinkModal>[0]["summary"],
) =>
  render(
    <AcceptLinkModal
      open
      onClose={() => {}}
      url="https://classroom50.org/acme/cs101/hw1"
      cli="gh student accept acme cs101 hw1"
      hasSecret={false}
      org="acme"
      classroom="cs101"
      classroomName="CS 101"
      summary={summary}
    />,
  )

// The share modal is the last moment before students hit the accept-time 403, so
// a teacher who is about to hand out the link learns the org will refuse it.
describe("AcceptLinkModal org repo-creation warning", () => {
  it("warns when the org blocks repo creation", () => {
    orgRepoCreationWarning.mockReturnValue({ show: true, field: "master" })
    renderModal({
      resolved: true,
      warnNoStudents: false,
      acceptableStudents: 3,
    })

    expect(screen.queryByText(NOTICE)).not.toBeNull()
  })

  it("renders nothing when the org allows repo creation", () => {
    renderModal({
      resolved: true,
      warnNoStudents: false,
      acceptableStudents: 3,
    })

    expect(screen.queryByText(NOTICE)).toBeNull()
  })

  // The two conditions are independent — an empty roster and a locked-down org
  // are separate blockers, and fixing one doesn't fix the other — so neither
  // notice may suppress the other.
  it("shows both notices alongside an empty roster", () => {
    orgRepoCreationWarning.mockReturnValue({ show: true, field: "master" })
    renderModal({ resolved: true, warnNoStudents: true, acceptableStudents: 0 })

    expect(screen.queryByText(NOTICE)).not.toBeNull()
    expect(screen.queryByText(ROSTER_WARNING)).not.toBeNull()
  })

  // The roster summary is omitted when the classroom hasn't resolved; the org
  // warning has its own read and must not be gated on it.
  it("still warns when no roster summary is available", () => {
    orgRepoCreationWarning.mockReturnValue({ show: true, field: "private" })
    renderModal(undefined)

    expect(
      screen.queryByText("components.notices.orgRepoCreation.private"),
    ).not.toBeNull()
  })
})
