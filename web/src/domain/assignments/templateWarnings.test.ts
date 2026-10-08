import { describe, expect, it } from "vitest"

import { templateForksNotice } from "./templateWarnings"

describe("templateForksNotice", () => {
  const template = { owner: "cs50", repo: "tmpl", branch: "main" }

  it("names the inherited read once the grant landed", () => {
    expect(
      templateForksNotice(template, { private: true, forks_count: 3 }, true),
    ).toEqual({
      key: "assignments.template.forksInherit",
      params: { owner: "cs50", repo: "tmpl", count: 3 },
    })
  })

  // A withheld grant (owner required) has not reached the forks yet; saying it
  // had would contradict the owner-required warning shown beside it.
  it("switches to the future tense when the grant was withheld", () => {
    expect(
      templateForksNotice(template, { private: true, forks_count: 1 }, false),
    ).toEqual({
      key: "assignments.template.forksWillInherit",
      params: { owner: "cs50", repo: "tmpl", count: 1 },
    })
  })

  it("is silent for a public template, a fork-free one, or an unknown repo", () => {
    expect(
      templateForksNotice(template, { private: false, forks_count: 5 }, true),
    ).toBeUndefined()
    expect(
      templateForksNotice(template, { private: true, forks_count: 0 }, true),
    ).toBeUndefined()
    expect(
      templateForksNotice(template, { private: true }, true),
    ).toBeUndefined()
    expect(templateForksNotice(template, null, true)).toBeUndefined()
  })
})
