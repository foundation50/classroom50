// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

vi.mock("react-i18next", async (importActual) => {
  const actual = await importActual<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) }
})

const planDetails = vi.fn()
vi.mock("@/hooks/useGetOrgPlanDetails", () => ({
  default: (...a: unknown[]) => planDetails(...a),
}))

const mutateAsync = vi.fn().mockResolvedValue({})
vi.mock("@/hooks/mutations/useUpdateOrgProfile", () => ({
  useUpdateOrgProfile: () => ({ mutateAsync, isPending: false }),
}))

const notify = vi.fn()
const announce = vi.fn()
vi.mock("@/context/notifications/NotificationProvider", () => ({
  useToast: () => ({ notify, announce, dismiss: vi.fn() }),
}))

// happy-dom lacks <dialog> showModal/close; stub them so <Modal> renders open.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})

import OrgDetailsModal from "./OrgDetailsModal"
import type { Classroom50OrgSummary } from "@/github-core/queries"

const summary = (
  role: "admin" | "member" = "admin",
): Classroom50OrgSummary => ({
  org: {
    login: "classroom50-summer-dev",
    id: 4242,
    avatar_url: "https://example.com/a.png",
    description: "Summer cohort",
    html_url: "https://github.com/classroom50-summer-dev",
  },
  membership: { state: "active", role },
  classroom50: {
    status: "ready",
    canAccessRepo: true,
    canInitialize: false,
    pagesUrl: "",
  },
})

afterEach(() => {
  cleanup()
  planDetails.mockReset()
  mutateAsync.mockClear()
  notify.mockClear()
})

describe("OrgDetailsModal", () => {
  it("shows the display name, slug, plan, org id, and owner role in view mode", () => {
    planDetails.mockReturnValue({
      data: {
        name: "Classroom 50 Summer Dev",
        description: "Summer cohort",
        plan: { name: "team" },
      },
    })
    render(<OrgDetailsModal summary={summary()} open onClose={() => {}} />)
    expect(screen.getByText("Classroom 50 Summer Dev")).toBeTruthy()
    expect(screen.getByText("classroom50-summer-dev")).toBeTruthy()
    expect(screen.getByText("team")).toBeTruthy()
    expect(screen.getByText("4242")).toBeTruthy()
    expect(screen.getByText("orgs.detailsModal.roleAdmin")).toBeTruthy()
    expect(screen.getByText("orgs.detailsModal.manageOnGitHub")).toBeTruthy()
  })

  it("falls back to the slug heading when no display name is set", () => {
    planDetails.mockReturnValue({ data: { name: null } })
    render(<OrgDetailsModal summary={summary()} open onClose={() => {}} />)
    expect(
      screen.getAllByText("classroom50-summer-dev").length,
    ).toBeGreaterThan(0)
  })

  it("for a non-owner: hides Edit, Manage link, plan, and org id", () => {
    planDetails.mockReturnValue({
      data: { name: "Acme", plan: { name: "team" } },
    })
    render(
      <OrgDetailsModal summary={summary("member")} open onClose={() => {}} />,
    )
    expect(screen.queryByText("orgs.detailsModal.edit")).toBeNull()
    expect(screen.queryByText("orgs.detailsModal.manageOnGitHub")).toBeNull()
    expect(screen.queryByText("orgs.detailsModal.plan")).toBeNull()
    expect(screen.queryByText("orgs.detailsModal.orgId")).toBeNull()
    expect(screen.queryByText("team")).toBeNull()
    expect(screen.getByText("orgs.detailsModal.roleMember")).toBeTruthy()
  })

  it("hides profile fields that have no value", () => {
    planDetails.mockReturnValue({
      data: { name: "Acme", description: "hi", location: null, company: "" },
    })
    render(<OrgDetailsModal summary={summary()} open onClose={() => {}} />)
    expect(screen.getByText("orgs.detailsModal.description")).toBeTruthy()
    // Empty location/school rows are omitted entirely.
    expect(screen.queryByText("orgs.detailsModal.location")).toBeNull()
    expect(screen.queryByText("orgs.detailsModal.school")).toBeNull()
  })

  it("lets an owner edit and save the profile", async () => {
    planDetails.mockReturnValue({
      data: { name: "Old Name", description: "old" },
    })
    render(<OrgDetailsModal summary={summary()} open onClose={() => {}} />)

    await userEvent.click(screen.getByText("orgs.detailsModal.edit"))

    const nameInput = screen.getByDisplayValue("Old Name")
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, "New Name")
    await userEvent.click(screen.getByText("orgs.detailsModal.save"))

    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ name: "New Name" }),
    )
    // Evident success (the modal flips back to view mode): no toast, just
    // the SR announcement.
    expect(notify).not.toHaveBeenCalled()
    expect(announce).toHaveBeenCalledWith(
      expect.stringContaining("orgs.detailsModal.saved"),
    )
  })

  it("renders a failed save as an in-dialog banner and stays in edit mode", async () => {
    planDetails.mockReturnValue({
      data: { name: "Old Name", description: "old" },
    })
    mutateAsync.mockRejectedValueOnce(new Error("boom"))
    render(<OrgDetailsModal summary={summary()} open onClose={() => {}} />)

    await userEvent.click(screen.getByText("orgs.detailsModal.edit"))
    await userEvent.click(screen.getByText("orgs.detailsModal.save"))

    // The failure stays inside the dialog (no toast), edit mode is retained
    // so the teacher can retry.
    expect(
      await screen.findByText(/orgs\.detailsModal\.saveError/),
    ).toBeTruthy()
    expect(notify).not.toHaveBeenCalled()
    expect(screen.getByText("orgs.detailsModal.save")).toBeTruthy()
  })

  it("defaults a bare website host to https:// on save", async () => {
    planDetails.mockReturnValue({ data: { name: "Acme", blog: "" } })
    render(<OrgDetailsModal summary={summary()} open onClose={() => {}} />)

    await userEvent.click(screen.getByText("orgs.detailsModal.edit"))
    const websiteInput = screen.getByPlaceholderText(
      "orgs.detailsModal.websitePlaceholder",
    )
    await userEvent.type(websiteInput, "classroom50.org")
    await userEvent.click(screen.getByText("orgs.detailsModal.save"))

    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ blog: "https://classroom50.org" }),
    )
  })

  it("drops an unsafe website scheme from the payload instead of sending it raw", async () => {
    planDetails.mockReturnValue({ data: { name: "Acme", blog: "" } })
    render(<OrgDetailsModal summary={summary()} open onClose={() => {}} />)

    await userEvent.click(screen.getByText("orgs.detailsModal.edit"))
    const websiteInput = screen.getByPlaceholderText(
      "orgs.detailsModal.websitePlaceholder",
    )
    await userEvent.type(websiteInput, "javascript:alert(1)")
    await userEvent.click(screen.getByText("orgs.detailsModal.save"))

    expect(mutateAsync).toHaveBeenCalledTimes(1)
    const payload = mutateAsync.mock.calls[0][0]
    expect(payload).not.toHaveProperty("blog")
  })
})
