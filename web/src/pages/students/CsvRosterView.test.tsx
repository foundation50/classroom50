// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  render,
  screen,
  cleanup,
  fireEvent,
  within,
} from "@testing-library/react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

import CsvRosterView from "./CsvRosterView"
import type { Student } from "@/types/classroom"

const student = (overrides: Partial<Student> = {}): Student => ({
  username: "alice",
  first_name: "Alice",
  last_name: "Ng",
  email: "",
  section: "S1",
  github_id: "1",
  role: "student",
  ...overrides,
})

afterEach(() => {
  cleanup()
})

describe("CsvRosterView", () => {
  it("shows the CSV-source notice", () => {
    render(<CsvRosterView students={[student()]} />)
    expect(screen.getByText("students.csvRoster.notice")).toBeTruthy()
  })

  it("renders a row per roster.csv entry with name, section, and role", () => {
    render(
      <CsvRosterView
        students={[
          student({ username: "alice", first_name: "Alice", last_name: "Ng" }),
          student({
            username: "bob",
            first_name: "Bob",
            last_name: "Lee",
            section: "S2",
            role: "hta",
          }),
        ]}
      />,
    )
    expect(screen.getByText("Alice Ng")).toBeTruthy()
    expect(screen.getByText("Bob Lee")).toBeTruthy()
    // The head-TA row's role maps to the head-TA badge label.
    expect(screen.getByText("students.roleHeadTa")).toBeTruthy()
  })

  it("maps a blank/unknown role cell to the student badge", () => {
    render(<CsvRosterView students={[student({ role: "" })]} />)
    expect(screen.getByText("students.roleStudent")).toBeTruthy()
  })

  it("maps each known role cell to its badge (teacher/ta)", () => {
    render(
      <CsvRosterView
        students={[
          student({ username: "t", role: "teacher" }),
          student({ username: "a", role: "ta" }),
        ]}
      />,
    )
    expect(screen.getByText("students.roleTeacher")).toBeTruthy()
    expect(screen.getByText("students.roleTa")).toBeTruthy()
  })

  it("maps the role cell case-insensitively", () => {
    render(<CsvRosterView students={[student({ role: "HTA" })]} />)
    expect(screen.getByText("students.roleHeadTa")).toBeTruthy()
  })

  it("falls back to the username when no name is recorded", () => {
    render(
      <CsvRosterView
        students={[
          student({ username: "carol", first_name: "", last_name: "" }),
        ]}
      />,
    )
    // Both the display-name cell and the username line show the login.
    expect(screen.getAllByText("carol").length).toBeGreaterThanOrEqual(1)
  })

  it("renders an empty-state row when roster.csv has no entries", () => {
    render(<CsvRosterView students={[]} />)
    expect(screen.getByText("students.csvRoster.empty")).toBeTruthy()
  })

  it("renders no mutating controls (read-only)", () => {
    const { container } = render(<CsvRosterView students={[student()]} />)
    expect(container.querySelectorAll("button")).toHaveLength(0)
  })

  it("re-sorts by first name vs last name when the toggle changes", () => {
    // Zed Adams vs Amy Brown: first-name order is Amy, Zed; last-name order is
    // Adams (Zed), Brown (Amy) — so flipping the toggle must reorder the rows.
    render(
      <CsvRosterView
        students={[
          student({ username: "zed", first_name: "Zed", last_name: "Adams" }),
          student({ username: "amy", first_name: "Amy", last_name: "Brown" }),
        ]}
      />,
    )

    const names = () =>
      screen
        .getAllByRole("row")
        // Skip the header row (no data cell); read the bold display-name cell.
        .map((r) => within(r).queryByText(/Zed Adams|Amy Brown/)?.textContent)
        .filter(Boolean)

    // Defaults to first-name order.
    expect(names()).toEqual(["Amy Brown", "Zed Adams"])

    fireEvent.change(screen.getByLabelText("students.sortBy.label"), {
      target: { value: "last" },
    })

    // Last-name order: Adams (Zed) before Brown (Amy).
    expect(names()).toEqual(["Zed Adams", "Amy Brown"])
  })
})
