import { describe, expect, it } from "vitest"

import type { GitHubRepo } from "@/github-core/types"
import { existingAssignmentRepos } from "@/domain/assignments/assignmentRepoPresence"

const repo = (name: string, pushed_at?: string): GitHubRepo =>
  ({ id: name.length, name, pushed_at }) as GitHubRepo

describe("existingAssignmentRepos", () => {
  it("matches the assignment's own repos by prefix", () => {
    const repos = [
      repo("cs50-hw1-alice"),
      repo("cs50-hw1-bob"),
      repo("cs50-hw2-alice"),
      repo("unrelated"),
    ]
    expect(
      existingAssignmentRepos(repos, "cs50", "hw1").map((r) => r.name),
    ).toEqual(["cs50-hw1-alice", "cs50-hw1-bob"])
    expect(existingAssignmentRepos(repos, "cs50", "hw1").length).toBe(2)
  })

  it("excludes a sibling assignment whose slug extends this one", () => {
    // "hw1-bonus" repos start with the "cs50-hw1-" prefix, so without the
    // sibling guard they'd be counted as hw1 submissions.
    const repos = [repo("cs50-hw1-alice"), repo("cs50-hw1-bonus-alice")]
    expect(
      existingAssignmentRepos(repos, "cs50", "hw1", ["hw1", "hw1-bonus"])
        .length,
    ).toBe(1)
    expect(
      existingAssignmentRepos(repos, "cs50", "hw1", ["hw1-bonus"]).map(
        (r) => r.name,
      ),
    ).toEqual(["cs50-hw1-alice"])
  })

  it("ignores a bare prefix with no owner segment", () => {
    expect(
      existingAssignmentRepos([repo("cs50-hw1-")], "cs50", "hw1").length,
    ).toBe(0)
  })

  it("is case-insensitive on repo names", () => {
    expect(
      existingAssignmentRepos([repo("CS50-HW1-Alice")], "cs50", "hw1").length,
    ).toBe(1)
  })

  it("counts a repo with no push (accepted but never pushed)", () => {
    // Presence is repo existence, not activity: an accepted-but-untouched repo
    // still exists and must not be silently dropped.
    expect(
      existingAssignmentRepos([repo("cs50-hw1-alice")], "cs50", "hw1").length,
    ).toBe(1)
  })

  it("returns empty for a missing repo list", () => {
    expect(existingAssignmentRepos(undefined, "cs50", "hw1")).toEqual([])
    expect(existingAssignmentRepos(null, "cs50", "hw1").length).toBe(0)
  })
})
