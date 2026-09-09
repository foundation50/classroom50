import { describe, expect, it } from "vitest"

import {
  customRepoPagesUrl,
  defaultRepoPagesUrl,
  pagesCreateBody,
  studentRepoPagesUrls,
} from "./repoPages"

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
})

describe("student repo Pages URLs", () => {
  it("derives the github.io default, lowercased", () => {
    expect(defaultRepoPagesUrl("CS50", "CS50-Fall-Site-Alice")).toBe(
      "https://cs50.github.io/cs50-fall-site-alice/",
    )
  })

  it("derives the custom-domain URL only for the org-root layout", () => {
    expect(customRepoPagesUrl("https://cs.example.edu/classroom50", "r")).toBe(
      "https://cs.example.edu/r/",
    )
    expect(customRepoPagesUrl("https://cs.example.edu", "r")).toBeNull()
    expect(customRepoPagesUrl(undefined, "r")).toBeNull()
    expect(customRepoPagesUrl("not a url", "r")).toBeNull()
  })

  it("lists the default first, then the custom domain when present", () => {
    expect(
      studentRepoPagesUrls("cs50", "r", "https://cs.example.edu/classroom50"),
    ).toEqual(["https://cs50.github.io/r/", "https://cs.example.edu/r/"])
    expect(studentRepoPagesUrls("cs50", "r")).toEqual([
      "https://cs50.github.io/r/",
    ])
  })
})
