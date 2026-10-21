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

afterEach(() => {
  cleanup()
})

const entry = (username: string): GroupPickerStudent => ({
  key: username,
  username,
  label: username,
  name: "",
  initials: "",
  isStudent: true,
})

const panelProps = {
  groups: [{ slug: "g1", label: "Group 1" }],
  hasGroups: true,
  pending: false,
  busy: false,
  onAdd: () => {},
}

const staffNote = (count: number) =>
  screen.queryByText(`manageGroups.unassigned.staffNote:${count}`)

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
    expect(staffNote(2)).toBeTruthy()
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
    expect(staffNote(1)).toBeTruthy()
  })

  // The note sends the teacher to a group's Manage dialog, which is a dead end
  // on a fresh assignment with no groups yet.
  it("holds the staff note until a group exists", () => {
    render(
      <UnassignedStudentsPanel
        {...panelProps}
        hasGroups={false}
        groups={[]}
        students={[]}
        unlistedStaffCount={1}
      />,
    )
    expect(staffNote(1)).toBeNull()
  })

  it("holds the staff note while membership is still loading", () => {
    render(
      <UnassignedStudentsPanel
        {...panelProps}
        pending
        students={[]}
        unlistedStaffCount={1}
      />,
    )
    expect(staffNote(1)).toBeNull()
  })
})
