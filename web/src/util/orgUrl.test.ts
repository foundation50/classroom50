import { describe, expect, it } from "vitest"
import { githubTemplateRepoUrl } from "./orgUrl"

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
