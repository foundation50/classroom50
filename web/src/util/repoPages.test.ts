import { describe, expect, it } from "vitest"

import { defaultRepoPagesUrl, pagesCreateBody } from "./repoPages"
import type { AssignmentPages } from "@/types/classroom"

describe("pagesCreateBody", () => {
  it("maps workflow to build_type workflow with no source", () => {
    expect(pagesCreateBody({ source: "workflow" }, "main")).toEqual({
      build_type: "workflow",
    })
  })

  it("maps branch to legacy on the repo default branch at / by default", () => {
    expect(pagesCreateBody({ source: "branch" }, "master")).toEqual({
      build_type: "legacy",
      source: { branch: "master", path: "/" },
    })
  })

  it("honors a named branch and /docs", () => {
    expect(
      pagesCreateBody(
        { source: "branch", branch: "gh-pages", path: "/docs" },
        "main",
      ),
    ).toEqual({
      build_type: "legacy",
      source: { branch: "gh-pages", path: "/docs" },
    })
  })

  it("fails closed on a source this release does not know", () => {
    const newer = { source: "container" } as unknown as AssignmentPages
    expect(pagesCreateBody(newer, "main")).toBeNull()
  })
})

describe("defaultRepoPagesUrl", () => {
  it("derives the github.io default, lowercased", () => {
    expect(defaultRepoPagesUrl("CS50", "CS50-Fall-Site-Alice")).toBe(
      "https://cs50.github.io/cs50-fall-site-alice/",
    )
  })
})
