import { describe, it, expect } from "vitest"

import {
  detectBranchSubmissions,
  detectTagSubmissions,
  detectedSubmissionCount,
  detectedTagHref,
  detectedTagLabel,
  detectedTagRef,
  jumpableTagEntries,
  latestDetectedAt,
  resolveSubmissionMode,
  submissionModeBadgeKey,
  submissionModeCountKey,
  submitTagDatetime,
} from "./submissionDetection"
import {
  FEEDBACK_OPEN_COMMIT_MESSAGE,
  shimUpdateCommitMessage,
} from "@/util/commit"
import type { GitHubCommit, GitHubTag } from "@/github-core/types"
import type { DetectedSubmission } from "./submissionDetection"

function commit(sha: string, date?: string, message = sha): GitHubCommit {
  return {
    sha,
    html_url: `https://x/commit/${sha}`,
    commit: {
      message,
      committer: date ? { date } : undefined,
    },
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

  // Regression: on a TEMPLATED assignment the accept commit (the baseline) sits
  // ON TOP OF the template's generated commit(s), which are OLDER than the
  // baseline. Commits are newest-first, so those template commits appear AFTER
  // the baseline in the list. They are accept-time setup, not student work, and
  // must not count — a plain `sha !== baseline` filter would leave them in.
  it("excludes template commits that predate the baseline", () => {
    const commits = [
      commit("student2"),
      commit("student1"),
      commit("baseline"),
      commit("template-init"),
    ]
    const detected = detectBranchSubmissions(commits, "baseline")
    expect(detected.map((d) => d.sha)).toEqual(["student2", "student1"])
    expect(detectedSubmissionCount(detected)).toBe(2)
  })

  // A freshly-accepted templated repo with NO student push: the only commits
  // are the template's "Initial commit" (oldest), the accept/baseline commit,
  // and the Feedback-PR opener (newest). All three are the tool's — the count
  // must be 0, not 1 (the pre-fix bug left "Initial commit" counting because it
  // predates the baseline).
  it("counts zero for a just-accepted templated repo before any student push", () => {
    const commits = [
      commit("feedback", "2026-08-16T17:02:37Z", FEEDBACK_OPEN_COMMIT_MESSAGE),
      commit("baseline", "2026-08-16T17:02:34Z"),
      commit("initial", "2026-08-16T17:02:30Z", "Initial commit"),
    ]
    const detected = detectBranchSubmissions(commits, "baseline")
    expect(detected).toEqual([])
    expect(detectedSubmissionCount(detected)).toBe(0)
  })

  it("counts all commits when the baseline is unknown (null)", () => {
    const commits = [commit("c2"), commit("c1")]
    const detected = detectBranchSubmissions(commits, null)
    expect(detectedSubmissionCount(detected)).toBe(2)
  })

  // Pinned against the writers themselves: if either drops the [skip ci] body
  // its commit starts counting again, and this fails.
  it("skips the tool's own bookkeeping commits on the default branch", () => {
    const commits = [
      commit("c2"),
      commit("feedback", undefined, FEEDBACK_OPEN_COMMIT_MESSAGE),
      commit("shim-tag", undefined, shimUpdateCommitMessage("tag")),
      commit("shim-push", undefined, shimUpdateCommitMessage("every-push")),
      commit("c1"),
    ]
    const detected = detectBranchSubmissions(commits, null)
    expect(detected.map((d) => d.sha)).toEqual(["c2", "c1"])
  })

  it("counts near misses: quoted tool text, and the student's own submit", () => {
    const detected = detectBranchSubmissions(
      [
        commit("c1", undefined, `Fix ${shimUpdateCommitMessage("tag")}`),
        commit("c2", undefined, "[Classroom 50] Submit hw1"),
      ],
      null,
    )
    expect(detected.map((d) => d.sha)).toEqual(["c1", "c2"])
  })

  // Documents the accepted trade-off (see TOOL_COMMIT_SUBJECTS): matching is by
  // exact subject, so a student commit whose subject is byte-identical to a
  // tool subject is dropped. This pins the current behavior — if the match ever
  // gains a corroborating signal (author/paths), this expectation changes.
  it("drops a student commit whose subject exactly matches a tool subject", () => {
    const detected = detectBranchSubmissions(
      [
        commit("forged-feedback", undefined, FEEDBACK_OPEN_COMMIT_MESSAGE),
        commit("forged-shim", undefined, shimUpdateCommitMessage("tag")),
        commit("real", undefined, "Implement feature"),
      ],
      null,
    )
    expect(detected.map((d) => d.sha)).toEqual(["real"])
  })

  it("carries each commit's time (committer date, else author date)", () => {
    const authored: GitHubCommit = {
      sha: "c1",
      html_url: "https://x/commit/c1",
      commit: { message: "c1", author: { date: "2026-06-01T00:00:00Z" } },
      author: null,
    }
    const detected = detectBranchSubmissions(
      [commit("c2", "2026-06-02T00:00:00Z"), authored],
      null,
    )
    expect(detected.map((d) => d.datetime)).toEqual([
      "2026-06-02T00:00:00Z",
      "2026-06-01T00:00:00Z",
    ])
  })
})

describe("latestDetectedAt", () => {
  it("returns the newest entry time regardless of order", () => {
    const detected = detectBranchSubmissions(
      [
        commit("c1", "2026-06-01T00:00:00Z"),
        commit("c2", "2026-06-03T00:00:00Z"),
      ],
      null,
    )
    expect(latestDetectedAt(detected)).toBe("2026-06-03T00:00:00Z")
  })

  it("returns null when no entry carries a time (tag detection)", () => {
    const detected = detectTagSubmissions([tag("phase1")], ["phase1"])
    expect(latestDetectedAt(detected)).toBeNull()
    expect(latestDetectedAt(undefined)).toBeNull()
  })

  it("ignores unparseable datetimes", () => {
    expect(
      latestDetectedAt([
        { kind: "commit", label: "bad", count: 1, datetime: "not-a-date" },
        {
          kind: "commit",
          label: "ok",
          count: 1,
          datetime: "2026-06-02T00:00:00Z",
        },
      ]),
    ).toBe("2026-06-02T00:00:00Z")
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

  it("decodes a canonical submit/* tag's time from its name", () => {
    const detected = detectTagSubmissions(
      [tag("submit/2026-06-20T10-30-00Z-abc1234")],
      ["submit/*"],
    )
    expect(detected[0].datetime).toBe("2026-06-20T10:30:00Z")
  })

  it("dates a submit/* group by its newest member and uses that member's sha", () => {
    const older = tag("submit/2026-06-19T08-00-00Z-abc1234", "sha-old")
    const newer = tag("submit/2026-06-21T09-00-00Z-def5678", "sha-new")
    const detected = detectTagSubmissions([older, newer], ["submit/*"])
    expect(detected[0]).toMatchObject({
      kind: "tag-group",
      count: 2,
      sha: "sha-new",
      datetime: "2026-06-21T09:00:00Z",
    })
  })

  it("leaves a milestone tag/group dateless (its time comes from a commit lookup)", () => {
    const detected = detectTagSubmissions(
      [tag("phase1"), tag("v1"), tag("v2")],
      ["phase1", "v*"],
    )
    expect(detected[0].datetime).toBeUndefined()
    expect(detected[1].datetime).toBeUndefined()
    // Without an encoded time the group keeps the list's first match as sha.
    expect(detected[1].sha).toBe("sha-v1")
  })
})

describe("submitTagDatetime", () => {
  it("parses the buildSubmitTag format back to ISO", () => {
    expect(submitTagDatetime("submit/2026-06-20T10-30-05Z-abc1234")).toBe(
      "2026-06-20T10:30:05Z",
    )
  })

  it("returns undefined for milestone and malformed names", () => {
    expect(submitTagDatetime("phase1")).toBeUndefined()
    expect(submitTagDatetime("submit/not-a-timestamp")).toBeUndefined()
    expect(submitTagDatetime("submit/2026-06-20T10-30-05Z")).toBeUndefined()
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
