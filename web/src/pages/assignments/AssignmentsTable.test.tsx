// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

import type { Assignment } from "@/types/classroom"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
    useNavigate: () => () => {},
  }
})

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}),
}))

const scores = vi.fn()
vi.mock("@/hooks/useGetScores", () => ({
  default: (...a: unknown[]) => scores(...a),
}))

import AssignmentsTable from "./AssignmentsTable"

const wrap = (ui: ReactNode) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

const assignment = (over: Partial<Assignment> = {}): Assignment =>
  ({ slug: "hw1", name: "HW 1", mode: "individual", ...over }) as Assignment

// The submission cell renders "<submitted> / <denominator>" as sibling text
// nodes; read the row's textContent to assert the rendered ratio.
const ratioText = () =>
  screen.getByText("assignments.table.colSubmissions").closest("table")
    ?.textContent ?? ""

beforeEach(() => {
  scores.mockReset()
})

afterEach(cleanup)

describe("AssignmentsTable submission denominator", () => {
  it("uses the student-role count as the denominator, not roster rows", () => {
    scores.mockReturnValue({ data: { submissions: { hw1: [{}, {}, {}] } } })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment()]}
        studentCount={11}
      />,
    )
    // 3 submitted out of 11 students (not the 14 roster rows).
    expect(ratioText()).toContain("3 / 11")
  })

  it("clamps so a non-student submission can't push the ratio above 100%", () => {
    // 5 submission repos but only 3 student-role members: display clamps to 3/3.
    scores.mockReturnValue({
      data: { submissions: { hw1: [{}, {}, {}, {}, {}] } },
    })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment()]}
        studentCount={3}
      />,
    )
    expect(ratioText()).toContain("3 / 3")
    expect(ratioText()).not.toContain("5 / 3")
  })

  it("renders 0 / 0 without dividing by zero when there are no students", () => {
    scores.mockReturnValue({ data: { submissions: { hw1: [{}] } } })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment()]}
        studentCount={0}
      />,
    )
    expect(ratioText()).toContain("0 / 0")
  })

  it("leaves group assignments as a submitted count, no roster denominator", () => {
    scores.mockReturnValue({ data: { submissions: { hw1: [{}, {}] } } })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ mode: "group" })]}
        studentCount={11}
      />,
    )
    expect(ratioText()).toContain("assignments.table.groupsSubmitted")
    expect(ratioText()).not.toContain("/ 11")
  })
})
