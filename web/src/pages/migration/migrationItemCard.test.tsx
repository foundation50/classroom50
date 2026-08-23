// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) =>
        opts && "fullName" in opts ? `${key}:${String(opts.fullName)}` : key,
    }),
  }
})

import { MigrationItemCard } from "./migrationItemCard"
import type { ClassroomAssignmentDetail } from "@/migration/types"

afterEach(cleanup)

const assignment: ClassroomAssignmentDetail = {
  id: 1,
  public_repo: false,
  title: "Homework 1",
  type: "individual",
  invite_link: "https://classroom.github.com/a/x",
  slug: "hw1",
  deadline: null,
  max_teams: null,
  starter_code_repository: {
    id: 10,
    name: "hw1",
    full_name: "acme/hw1",
    private: true,
    default_branch: "main",
  },
}

describe("MigrationItemCard", () => {
  it("renders a skip reason as a VISIBLE inline warning (regression: the on-fill token painted it invisible)", () => {
    render(
      <MigrationItemCard
        assignment={assignment}
        status="skip"
        reason={{
          key: "migration.reason.sourceNotTemplate",
          params: { fullName: "acme/hw1" },
        }}
        targetName="hw1"
        targetOrg="acme"
      />,
    )
    const reason = screen
      .getByText("migration.reason.sourceNotTemplate:acme/hw1")
      .closest("p")!
    expect(reason.className).toContain("text-warning")
    expect(reason.className).not.toContain("warning-content")
  })

  it("links a sourceNotTemplate reason to the starter repo's settings", () => {
    render(
      <MigrationItemCard
        assignment={assignment}
        status="skip"
        reason={{
          key: "migration.reason.sourceNotTemplate",
          params: { fullName: "acme/hw1" },
        }}
        targetName="hw1"
        targetOrg="acme"
      />,
    )
    const link = screen.getByRole("link", {
      name: /migration\.item\.openRepoSettings/,
    })
    expect(link.getAttribute("href")).toBe(
      "https://github.com/acme/hw1/settings",
    )
  })

  it("links a targetCollision reason to the colliding repository", () => {
    render(
      <MigrationItemCard
        assignment={assignment}
        status="skip"
        reason={{
          key: "migration.reason.targetCollision",
          params: { org: "acme", name: "hw1" },
        }}
        targetName="hw1"
        targetOrg="acme"
      />,
    )
    const link = screen.getByRole("link", {
      name: /migration\.item\.openCollidingRepo/,
    })
    expect(link.getAttribute("href")).toBe("https://github.com/acme/hw1")
  })

  it("collapses the metadata panels behind a details toggle", async () => {
    const user = userEvent.setup()
    render(
      <MigrationItemCard
        assignment={assignment}
        status="import"
        targetName="hw1"
        targetOrg="acme"
      />,
    )
    expect(screen.queryByText("migration.item.sourcePanel")).toBeNull()

    const toggle = screen.getByRole("button", {
      name: "migration.item.showDetails",
    })
    expect(toggle.getAttribute("aria-expanded")).toBe("false")

    await user.click(toggle)
    await waitFor(() =>
      expect(screen.getByText("migration.item.sourcePanel")).toBeTruthy(),
    )
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(toggle.textContent).toContain("migration.item.hideDetails")
  })
})
