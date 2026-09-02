import { describe, expect, it } from "vitest"

import { sortReposNewestFirst } from "./repoOrder"

describe("sortReposNewestFirst", () => {
  it("orders by created_at descending without mutating the input", () => {
    const repos = [
      { name: "old", created_at: "2026-01-01T00:00:00Z" },
      { name: "new", created_at: "2026-03-01T00:00:00Z" },
      { name: "mid", created_at: "2026-02-01T00:00:00Z" },
    ]
    expect(sortReposNewestFirst(repos).map((r) => r.name)).toEqual([
      "new",
      "mid",
      "old",
    ])
    expect(repos.map((r) => r.name)).toEqual(["old", "new", "mid"])
  })

  it("keeps repos without a timestamp last, in their original order", () => {
    const repos = [
      { name: "a" },
      { name: "new", created_at: "2026-03-01T00:00:00Z" },
      { name: "b" },
      { name: "old", created_at: "2026-01-01T00:00:00Z" },
    ]
    expect(sortReposNewestFirst(repos).map((r) => r.name)).toEqual([
      "new",
      "old",
      "a",
      "b",
    ])
  })
})
