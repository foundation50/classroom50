// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, within } from "@testing-library/react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) =>
        opts && "count" in opts ? `${key}:${opts.count}` : key,
    }),
  }
})

import { RosterPreviewTable, type RowChanges } from "./RosterPreviewTable"
import type { ResolvedImportRow } from "./rosterImportResolve"

afterEach(cleanup)

const account = (username: string): ResolvedImportRow["identity"] => ({
  kind: "account",
  username,
})

const rows: ResolvedImportRow[] = [
  {
    identity: account("ada"),
    first_name: "Ada",
    last_name: "Lovelace",
    email: "ada@x.edu",
    section: "Lab 1",
  },
  {
    identity: account("bob"),
    first_name: "Bob",
    last_name: "B",
    email: "bob@x.edu",
    section: "Lab 2",
  },
]

const cellFor = (name: string) =>
  screen.getByText(name).closest("td") as HTMLTableCellElement

describe("RosterPreviewTable change highlighting", () => {
  it("renders plainly when there are no changes", () => {
    render(
      <RosterPreviewTable
        rows={rows}
        rolesByUser={{}}
        onRoleChange={vi.fn()}
      />,
    )
    const emailCell = cellFor("ada@x.edu")
    expect(emailCell.className).not.toContain("bg-warning")
    // No tooltip element on an unchanged cell.
    expect(emailCell.querySelector("[data-tip]")).toBeNull()
  })

  it("highlights a changed cell and exposes a stored->CSV tooltip", () => {
    const changes: RowChanges = {
      "login:ada": [{ field: "email", from: "old@x.edu", to: "ada@x.edu" }],
    }
    render(
      <RosterPreviewTable
        rows={rows}
        rolesByUser={{}}
        onRoleChange={vi.fn()}
        changes={changes}
      />,
    )
    const emailCell = cellFor("ada@x.edu")
    expect(emailCell.className).toContain("bg-warning")
    const tip = emailCell.querySelector("[data-tip]") as HTMLElement
    expect(tip).toBeTruthy()
    // Tooltip shows the field label and the from -> to transition.
    expect(tip.getAttribute("data-tip")).toContain("old@x.edu → ada@x.edu")
    // An unchanged sibling cell (section) is not highlighted.
    expect(cellFor("Lab 1").className).not.toContain("bg-warning")
  })

  it("highlights the merged Name cell when either first or last name changed", () => {
    const changes: RowChanges = {
      "login:ada": [{ field: "last_name", from: "L", to: "Lovelace" }],
    }
    render(
      <RosterPreviewTable
        rows={rows}
        rolesByUser={{}}
        onRoleChange={vi.fn()}
        changes={changes}
      />,
    )
    const nameCell = cellFor("Ada Lovelace")
    expect(nameCell.className).toContain("bg-warning")
    const tip = nameCell.querySelector("[data-tip]") as HTMLElement
    expect(tip.getAttribute("data-tip")).toContain("L → Lovelace")
  })

  it("renders the (empty) fallback in the tooltip for a previously-blank value", () => {
    const changes: RowChanges = {
      "login:ada": [{ field: "section", from: "", to: "Lab 9" }],
    }
    render(
      <RosterPreviewTable
        rows={[{ ...rows[0], section: "Lab 9" }]}
        rolesByUser={{}}
        onRoleChange={vi.fn()}
        changes={changes}
      />,
    )
    const cell = cellFor("Lab 9")
    const tip = cell.querySelector("[data-tip]") as HTMLElement
    expect(tip.getAttribute("data-tip")).toContain(
      "students.preflightMetadataEmpty → Lab 9",
    )
  })

  it("marks the whole row as changed while leaving unchanged rows plain", () => {
    const changes: RowChanges = {
      "login:ada": [{ field: "email", from: "old@x.edu", to: "ada@x.edu" }],
    }
    render(
      <RosterPreviewTable
        rows={rows}
        rolesByUser={{}}
        onRoleChange={vi.fn()}
        changes={changes}
      />,
    )
    const adaRow = within(screen.getByText("ada").closest("tr")!)
    expect(screen.getByText("ada").closest("tr")!.className).toContain(
      "bg-warning",
    )
    // The tooltip carrier is inside ada's row.
    expect(adaRow.getByText("ada@x.edu").closest("[data-tip]")).toBeTruthy()
    // bob's row is untouched.
    expect(
      screen.getByText("bob").closest("tr")!.className ?? "",
    ).not.toContain("bg-warning")
  })

  it("highlights the Role cell and marks the row when the role changes", () => {
    render(
      <RosterPreviewTable
        rows={rows}
        rolesByUser={{ "login:ada": "student" }}
        onRoleChange={vi.fn()}
        roleChanges={{ "login:ada": { from: "teacher", to: "student" } }}
      />,
    )
    // The Role cell (the one containing the role Select) is highlighted...
    const roleCell = screen
      .getByText("ada")
      .closest("tr")!
      .querySelector("select")!
      .closest("td") as HTMLTableCellElement
    expect(roleCell.className).toContain("bg-warning")
    // ...with an inline "was <previous role>" hint (no hover tooltip that would
    // overlap the native Select dropdown).
    expect(within(roleCell).getByText(/rolePreviousHint/)).toBeTruthy()
    expect(roleCell.querySelector("[data-tip]")).toBeNull()
    // ...and the whole row is marked changed even with no metadata change.
    expect(screen.getByText("ada").closest("tr")!.className).toContain(
      "bg-warning",
    )
  })

  it("renders skeletons for the change columns while loading", () => {
    const { container } = render(
      <RosterPreviewTable
        rows={rows}
        rolesByUser={{}}
        onRoleChange={vi.fn()}
        loading={true}
      />,
    )
    // Skeleton bars stand in for the still-resolving columns...
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0)
    // ...including the identity column, which is change-bearing now that a
    // github_id can correct a stale login: showing the file's value first and
    // flipping it later is the flash this skeleton exists to prevent.
    expect(screen.queryByText("ada")).toBeNull()
    // ...and no role Select renders while loading (its change is unknown yet).
    expect(container.querySelector("select")).toBeNull()
    // The table announces its busy state, and the decorative skeleton rows are
    // hidden from assistive tech (no rows of empty cells read aloud).
    expect(container.querySelector("table")?.getAttribute("aria-busy")).toBe(
      "true",
    )
    for (const tr of container.querySelectorAll("tbody tr")) {
      expect(tr.getAttribute("aria-hidden")).toBe("true")
    }
  })

  it("clears aria-busy once loaded", () => {
    const { container } = render(
      <RosterPreviewTable
        rows={rows}
        rolesByUser={{}}
        onRoleChange={vi.fn()}
      />,
    )
    expect(
      container.querySelector("table")?.getAttribute("aria-busy"),
    ).toBeNull()
  })
})
