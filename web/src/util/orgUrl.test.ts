import { describe, expect, it } from "vitest"
import { githubTemplateRepoUrl, repoTreeAtRefUrl, repoTagsUrl } from "./orgUrl"

describe("githubTemplateRepoUrl", () => {
  it("links to the repo root when no branch is given", () => {
    expect(githubTemplateRepoUrl("acme", "starter")).toBe(
      "https://github.com/acme/starter",
    )
  })

  it("deep-links to the branch when one is set", () => {
    expect(githubTemplateRepoUrl("acme", "starter", "main")).toBe(
      "https://github.com/acme/starter/tree/main",
    )
  })

  it("uses the given owner, not the classroom org", () => {
    expect(githubTemplateRepoUrl("other-org", "starter", "dev")).toBe(
      "https://github.com/other-org/starter/tree/dev",
    )
  })
})

describe("repoTreeAtRefUrl", () => {
  it("builds a tree URL for an exact tag", () => {
    expect(repoTreeAtRefUrl("acme", "cs101-hw1-alice", "phase1")).toBe(
      "https://github.com/acme/cs101-hw1-alice/tree/phase1",
    )
  })

  it("keeps slashes as path separators but encodes each segment", () => {
    expect(
      repoTreeAtRefUrl(
        "acme",
        "cs101-hw1-alice",
        "submit/2026-01-02T03-04-05Z",
      ),
    ).toBe(
      "https://github.com/acme/cs101-hw1-alice/tree/submit/2026-01-02T03-04-05Z",
    )
  })

  it("accepts a commit sha as the ref", () => {
    expect(repoTreeAtRefUrl("acme", "cs101-hw1-alice", "abc1234")).toBe(
      "https://github.com/acme/cs101-hw1-alice/tree/abc1234",
    )
  })

  it("returns undefined for blank inputs", () => {
    expect(repoTreeAtRefUrl("", "repo", "phase1")).toBeUndefined()
    expect(repoTreeAtRefUrl("acme", "", "phase1")).toBeUndefined()
    expect(repoTreeAtRefUrl("acme", "repo", "")).toBeUndefined()
  })
})

describe("repoTagsUrl", () => {
  it("links to the repo's tags listing page", () => {
    expect(repoTagsUrl("acme", "cs101-hw1-alice")).toBe(
      "https://github.com/acme/cs101-hw1-alice/tags",
    )
  })

  it("returns undefined for blank inputs", () => {
    expect(repoTagsUrl("", "repo")).toBeUndefined()
    expect(repoTagsUrl("acme", "")).toBeUndefined()
  })
})
