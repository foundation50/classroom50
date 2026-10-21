// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) =>
        opts && "count" in opts ? `${key}:${String(opts.count)}` : key,
    }),
  }
})

import type { GroupPickerStudent } from "@/hooks/useGroupRoster"
import { UnassignedStudentsPanel } from "./UnassignedStudentsPanel"
import { GroupMemberPickerOptions } from "./GroupMemberPickerOptions"

afterEach(() => {
  cleanup()
})

const entry = (
  username: string,
  over: Partial<GroupPickerStudent> = {},
): GroupPickerStudent => ({
  key: username,
  username,
  label: username,
  name: "",
  initials: "",
  isStudent: true,
  ...over,
})

const panelProps = {
  groups: [{ slug: "g1", label: "Group 1" }],
  pending: false,
  busy: false,
  onAdd: () => {},
}

// A head TA on the roster used to show up as an "unassigned student" (#1123).
// The page now hands the panel students only; the panel names the staff it
// left out so a teacher looking for a TA isn't left guessing.
describe("UnassignedStudentsPanel", () => {
  it("lists the students it is given and counts them in the badge", () => {
    render(
      <UnassignedStudentsPanel
        {...panelProps}
        students={[entry("alice"), entry("bob")]}
      />,
    )
    expect(screen.getByText("alice")).toBeTruthy()
    expect(screen.getByText("bob")).toBeTruthy()
    expect(screen.getByText("2")).toBeTruthy()
    expect(screen.queryByText(/manageGroups\.unassigned\.staffNote/)).toBeNull()
  })

  it("notes how many teaching staff are not listed", () => {
    render(
      <UnassignedStudentsPanel
        {...panelProps}
        students={[entry("alice")]}
        unlistedStaffCount={2}
      />,
    )
    expect(screen.getByText("manageGroups.unassigned.staffNote:2")).toBeTruthy()
  })

  it("keeps the empty state when only staff are unassigned", () => {
    render(
      <UnassignedStudentsPanel
        {...panelProps}
        students={[]}
        unlistedStaffCount={1}
      />,
    )
    expect(screen.getByText("manageGroups.unassigned.empty")).toBeTruthy()
    expect(screen.getByText("manageGroups.unassigned.staffNote:1")).toBeTruthy()
  })
})

describe("GroupMemberPickerOptions", () => {
  it("lists students first and staff under their own group", () => {
    render(
      <select aria-label="pick">
        <GroupMemberPickerOptions
          pool={[entry("prof", { isStudent: false }), entry("alice")]}
        />
      </select>,
    )
    const select = screen.getByLabelText("pick") as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(["alice", "prof"])
    const group = select.querySelector("optgroup")
    expect(group?.getAttribute("label")).toBe("manageGroups.staffPickerGroup")
    expect(group?.querySelector("option")?.value).toBe("prof")
  })

  it("renders no staff group when the pool has no staff", () => {
    render(
      <select aria-label="pick">
        <GroupMemberPickerOptions pool={[entry("alice")]} />
      </select>,
    )
    expect(screen.getByLabelText("pick").querySelector("optgroup")).toBeNull()
  })
})
