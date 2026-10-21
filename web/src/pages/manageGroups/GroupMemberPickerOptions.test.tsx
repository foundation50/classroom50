// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

import type { GroupPickerStudent } from "@/hooks/useGroupRoster"
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
