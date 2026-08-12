// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { Assignment } from "@/types/classroom"

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

import { AssignmentSetupBadge } from "./AssignmentSetupBadge"

// happy-dom doesn't implement <dialog> showModal/close; stub them so the modal
// opens on click.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})

afterEach(cleanup)

const base: Assignment = {
  slug: "hw",
  name: "HW",
  mode: "individual",
  autograder: "default",
}

describe("AssignmentSetupBadge", () => {
  it("shows the empty-repo badge and opens the empty-repo detail on click", async () => {
    const user = userEvent.setup()
    render(<AssignmentSetupBadge assignment={{ ...base, empty_repo: true }} />)
    // Badge label.
    expect(screen.getByText("submissions.setup.badgeEmpty")).toBeTruthy()
    await user.click(
      screen.getByRole("button", {
        name: "submissions.setup.viewDetailsTitle",
      }),
    )
    // Detail message renders in the modal.
    expect(screen.getByText("submissions.setup.detailEmpty")).toBeTruthy()
    // No template repo -> no template link.
    expect(screen.queryByText(/submissions\.setup\.viewTemplate/)).toBeNull()
  })

  it("links the template repo in the detail modal for a templated assignment", async () => {
    const user = userEvent.setup()
    render(
      <AssignmentSetupBadge
        assignment={{
          ...base,
          template: { owner: "acme", repo: "starter", branch: "main" },
        }}
      />,
    )
    expect(screen.getByText("submissions.setup.badgeTemplate")).toBeTruthy()
    await user.click(
      screen.getByRole("button", {
        name: "submissions.setup.viewDetailsTitle",
      }),
    )
    expect(screen.getByText("submissions.setup.detailTemplate")).toBeTruthy()
    const link = screen.getByRole("link", {
      name: "submissions.setup.viewTemplate:acme/starter",
    })
    expect(link.getAttribute("href")).toBe(
      "https://github.com/acme/starter/tree/main",
    )
  })

  it("labels a templated custom-CI assignment distinctly", () => {
    render(
      <AssignmentSetupBadge
        assignment={{
          ...base,
          template: { owner: "acme", repo: "starter", branch: "main" },
          no_autograder: true,
        }}
      />,
    )
    expect(screen.getByText("submissions.setup.badgeCustomCi")).toBeTruthy()
  })
})
