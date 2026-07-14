import { describe, expect, it, vi } from "vitest"

import { bulkUnenrollRoster } from "./bulkUnenrollRoster"
import type { Student } from "@/types/classroom"
import type { TeamRosterRow } from "@/util/teamRoster"

// bulkUnenrollStudents (the single-commit batch writer) is stubbed: this
// adapter's contract is mapping every selected roster row to a target and
// reconciling the batch result (removed / notFound) to per-row outcomes.
const bulkUnenrollMock = vi.fn()

vi.mock("@/domain/students", () => ({
  bulkUnenrollStudents: (...args: unknown[]) => bulkUnenrollMock(...args),
}))
vi.mock("@/github-core/errorMessage", () => ({
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}))

const client = {} as never

const row = (over: Partial<TeamRosterRow> = {}): TeamRosterRow => ({
  key: "1",
  state: "enrolled",
  roles: ["student"],
  username: "alice",
  github_id: "1",
  first_name: "",
  last_name: "",
  section: "",
  email: "alice@x.edu",
  avatar_url: "",
  ...over,
})

describe("bulkUnenrollRoster", () => {
  it("sends every selected row to the batch writer and marks removed", async () => {
    bulkUnenrollMock.mockReset().mockImplementation((_c, input) =>
      Promise.resolve({
        removed: input.students as Student[],
        notFound: [],
        warnings: [],
      }),
    )

    const res = await bulkUnenrollRoster(client, {
      org: "acme",
      classroom: "cs101",
      rows: [
        row({ key: "1" }),
        row({ key: "2", username: "bob", github_id: "2" }),
      ],
    })

    expect(bulkUnenrollMock).toHaveBeenCalledTimes(1)
    expect(res.removedCount).toBe(2)
    expect(res.outcomes.every((o) => o.status === "removed")).toBe(true)
  })

  it("marks a row skipped when the writer reports it not found", async () => {
    bulkUnenrollMock.mockReset().mockResolvedValue({
      removed: [{ username: "alice", github_id: "1" }],
      notFound: [{ username: "bob", github_id: "2" }],
      warnings: ["heads up"],
    })

    const res = await bulkUnenrollRoster(client, {
      org: "acme",
      classroom: "cs101",
      rows: [
        row({ key: "1" }),
        row({ key: "2", username: "bob", github_id: "2" }),
      ],
    })

    const byKey = Object.fromEntries(res.outcomes.map((o) => [o.key, o.status]))
    expect(byKey["1"]).toBe("removed")
    expect(byKey["2"]).toBe("skipped")
    expect(res.warnings).toEqual(["heads up"])
  })

  it("marks all rows failed when the batch write throws", async () => {
    bulkUnenrollMock.mockReset().mockRejectedValue(new Error("boom"))

    const res = await bulkUnenrollRoster(client, {
      org: "acme",
      classroom: "cs101",
      rows: [row({ key: "1" })],
    })

    expect(res.removedCount).toBe(0)
    expect(res.outcomes[0].status).toBe("failed")
    expect(res.outcomes[0].detail).toBe("boom")
  })

  it("no-ops on an empty selection", async () => {
    bulkUnenrollMock.mockReset()
    const res = await bulkUnenrollRoster(client, {
      org: "acme",
      classroom: "cs101",
      rows: [],
    })
    expect(bulkUnenrollMock).not.toHaveBeenCalled()
    expect(res).toEqual({ outcomes: [], removedCount: 0, warnings: [] })
  })
})
