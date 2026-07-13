// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"

const studentCount = vi.fn()
vi.mock("@/hooks/useStudentCount", () => ({
  default: (...a: [string, string]) => studentCount(...a),
}))

import { StudentCountProbes } from "./StudentCountProbes"

beforeEach(() => {
  studentCount.mockReset()
})

afterEach(cleanup)

describe("StudentCountProbes", () => {
  it("reports the role-aware count per classroom via onCount", async () => {
    // Distinct role-aware counts per path (not roster row counts).
    studentCount.mockImplementation((_org: string, path: string) => ({
      studentCount: path === "cs101" ? 11 : 3,
      isLoading: false,
      isError: false,
    }))
    const onCount = vi.fn()

    render(
      <StudentCountProbes
        org="acme"
        paths={["cs101", "cs202"]}
        onCount={onCount}
      />,
    )

    await waitFor(() => {
      expect(onCount).toHaveBeenCalledWith("cs101", 11)
      expect(onCount).toHaveBeenCalledWith("cs202", 3)
    })
  })

  it("passes each classroom path through to useStudentCount", () => {
    studentCount.mockReturnValue({
      studentCount: 0,
      isLoading: false,
      isError: false,
    })
    render(
      <StudentCountProbes org="acme" paths={["cs101"]} onCount={() => {}} />,
    )
    expect(studentCount).toHaveBeenCalledWith("acme", "cs101")
  })

  it("renders no probes (no fan-out) when there are no paths", () => {
    render(<StudentCountProbes org="acme" paths={[]} onCount={() => {}} />)
    expect(studentCount).not.toHaveBeenCalled()
  })
})
