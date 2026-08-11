import { describe, it, expect } from "vitest"

import {
  detectBranchSubmissions,
  detectTagSubmissions,
  detectedSubmissionCount,
} from "./submissionDetection"
import type { GitHubCommit, GitHubTag } from "@/github-core/types"

function commit(sha: string): GitHubCommit {
  return {
    sha,
    html_url: `https://x/commit/${sha}`,
    commit: { message: sha },
    author: null,
  }
}

function tag(name: string, sha = `sha-${name}`): GitHubTag {
  return { name, commit: { sha } }
}

describe("detectBranchSubmissions", () => {
  it("counts every default-branch commit except the baseline", () => {
    const commits = [commit("c2"), commit("c1"), commit("baseline")]
    const detected = detectBranchSubmissions(commits, "baseline")
    expect(detected.map((d) => d.sha)).toEqual(["c2", "c1"])
    expect(detectedSubmissionCount(detected)).toBe(2)
  })

  it("returns nothing when only the baseline commit exists", () => {
    const detected = detectBranchSubmissions([commit("baseline")], "baseline")
    expect(detected).toEqual([])
    expect(detectedSubmissionCount(detected)).toBe(0)
  })

  it("counts all commits when the baseline is unknown (null)", () => {
    const commits = [commit("c2"), commit("c1")]
    const detected = detectBranchSubmissions(commits, null)
    expect(detectedSubmissionCount(detected)).toBe(2)
  })
})

describe("detectTagSubmissions", () => {
  it("yields one submission for an exact tag that is present", () => {
    const tags = [tag("phase1"), tag("other")]
    const detected = detectTagSubmissions(tags, ["phase1"])
    expect(detected).toHaveLength(1)
    expect(detected[0]).toMatchObject({ kind: "tag", label: "phase1", count: 1 })
  })

  it("yields nothing for an exact tag that is absent", () => {
    const detected = detectTagSubmissions([tag("other")], ["phase1"])
    expect(detected).toEqual([])
  })

  it("groups all glob matches into one submission set", () => {
    const tags = [tag("v1"), tag("v2"), tag("v3"), tag("phase1")]
    const detected = detectTagSubmissions(tags, ["v*"])
    expect(detected).toHaveLength(1)
    expect(detected[0]).toMatchObject({
      kind: "tag-group",
      label: "v*",
      count: 3,
    })
    expect(detectedSubmissionCount(detected)).toBe(3)
  })

  it("yields nothing for a glob with no matches", () => {
    const detected = detectTagSubmissions([tag("phase1")], ["v*"])
    expect(detected).toEqual([])
  })

  it("does not double-count a tag matched by more than one pattern", () => {
    // "v1" matches both the exact "v1" and the glob "v*"; the first pattern
    // claims it, so the total is 3 (v1, then v2+v3 grouped), not 4.
    const tags = [tag("v1"), tag("v2"), tag("v3")]
    const detected = detectTagSubmissions(tags, ["v1", "v*"])
    expect(detectedSubmissionCount(detected)).toBe(3)
    expect(detected[0]).toMatchObject({ kind: "tag", label: "v1" })
    expect(detected[1]).toMatchObject({ kind: "tag-group", count: 2 })
  })
})
