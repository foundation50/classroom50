import { describe, it, expect } from "vitest"

import {
  detectBranchSubmissions,
  detectTagSubmissions,
  detectedSubmissionCount,
  detectedTagHref,
  detectedTagLabel,
  detectedTagRef,
  jumpableTagEntries,
  resolveSubmissionMode,
  submissionModeBadgeKey,
  submissionModeCountKey,
} from "./submissionDetection"
import type { GitHubCommit, GitHubTag } from "@/github-core/types"
import type { DetectedSubmission } from "./submissionDetection"

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
    expect(detected[0]).toMatchObject({
      kind: "tag",
      label: "phase1",
      count: 1,
    })
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

describe("jumpableTagEntries", () => {
  const entries: DetectedSubmission[] = [
    { kind: "commit", label: "aaa1111", count: 1, sha: "aaa1111" },
    { kind: "tag", label: "phase1", count: 1, sha: "bbb2222" },
    { kind: "tag-group", label: "v*", count: 2, sha: "ccc3333" },
  ]

  it("keeps only tag and tag-group entries (commit entries have no tag)", () => {
    expect(jumpableTagEntries(entries)).toEqual([entries[1], entries[2]])
  })

  it("returns an empty array when there are no tags", () => {
    expect(jumpableTagEntries([entries[0]])).toEqual([])
  })
})

describe("detectedTagRef", () => {
  it("uses the tag name for an exact tag", () => {
    expect(
      detectedTagRef({ kind: "tag", label: "phase1", count: 1, sha: "aaa" }),
    ).toBe("phase1")
  })

  it("uses the representative commit sha for a glob group", () => {
    expect(
      detectedTagRef({ kind: "tag-group", label: "v*", count: 3, sha: "bbb" }),
    ).toBe("bbb")
  })
})

describe("detectedTagLabel", () => {
  it("strips the canonical submit/ prefix", () => {
    expect(detectedTagLabel("submit/2026-01-02T03-04-05Z-abc1234")).toBe(
      "2026-01-02T03-04-05Z-abc1234",
    )
  })

  it("leaves a milestone tag unchanged", () => {
    expect(detectedTagLabel("phase1")).toBe("phase1")
  })
})

describe("detectedTagHref", () => {
  it("builds a tree URL at the tag name for an exact tag", () => {
    expect(
      detectedTagHref(
        { kind: "tag", label: "phase1", count: 1, sha: "aaa1111" },
        "acme",
        "cs101-hw1-alice",
      ),
    ).toBe("https://github.com/acme/cs101-hw1-alice/tree/phase1")
  })

  it("builds a tree URL at the representative sha for a glob group", () => {
    expect(
      detectedTagHref(
        { kind: "tag-group", label: "v*", count: 2, sha: "bbb2222" },
        "acme",
        "cs101-hw1-alice",
      ),
    ).toBe("https://github.com/acme/cs101-hw1-alice/tree/bbb2222")
  })

  it("returns undefined when the ref can't form a safe link", () => {
    expect(
      detectedTagHref(
        { kind: "tag-group", label: "v*", count: 2 },
        "acme",
        "cs101-hw1-alice",
      ),
    ).toBeUndefined()
  })
})

describe("resolveSubmissionMode", () => {
  it("defaults an absent mode to every-push (the wire default)", () => {
    expect(resolveSubmissionMode(undefined)).toBe("every-push")
  })

  it("passes through an explicit mode", () => {
    expect(resolveSubmissionMode("tag")).toBe("tag")
    expect(resolveSubmissionMode("every-push")).toBe("every-push")
  })
})

describe("submissionModeBadgeKey / submissionModeCountKey", () => {
  it("maps tag mode to the tag keys", () => {
    expect(submissionModeBadgeKey("tag")).toBe("submissions.type.badgeTag")
    expect(submissionModeCountKey("tag")).toBe("submissions.type.countTag")
  })

  it("maps every-push (and absent) mode to the every-push keys", () => {
    expect(submissionModeBadgeKey("every-push")).toBe(
      "submissions.type.badgeEveryPush",
    )
    expect(submissionModeCountKey(undefined)).toBe(
      "submissions.type.countEveryPush",
    )
  })
})
