import { describe, expect, it } from "vitest"
import {
  isSameGitHubUser,
  memberIdSet,
  memberIdentitySets,
  parseGitHubId,
  rosterClaimSet,
  studentKey,
} from "./identity"
import type { GitHubUser } from "@/github-core/types"

// Characterization tests: these pin the identity-matching rules that gate
// enrollment, "Mark enrolled", and team sync, so a future change to the
// matching semantics has to be deliberate rather than silent.

const member = (id: number, login: string): GitHubUser =>
  ({ id, login, name: null, avatar_url: `https://x/${login}` }) as GitHubUser

describe("studentKey", () => {
  it("prefers github_id, then username, then email", () => {
    expect(studentKey({ github_id: "1", username: "a", email: "e@x.io" })).toBe(
      "1",
    )
    expect(studentKey({ username: "a", email: "e@x.io" })).toBe("a")
    expect(studentKey({ email: "e@x.io" })).toBe("e@x.io")
  })

  it("treats an empty string as absent, not as a key", () => {
    expect(studentKey({ github_id: "", username: "a" })).toBe("a")
    expect(studentKey({ github_id: "", username: "", email: "" })).toBe("")
    expect(studentKey({})).toBe("")
  })
})

describe("isSameGitHubUser", () => {
  it("matches on numeric github_id even when the login changed (rename)", () => {
    expect(
      isSameGitHubUser(
        { id: 583231, login: "new-login" },
        { github_id: "583231", username: "old-login" },
      ),
    ).toBe(true)
  })

  it("matches case-insensitively on login when the row has no github_id", () => {
    expect(
      isSameGitHubUser({ id: 5, login: "OctoCat" }, { username: "octocat" }),
    ).toBe(true)
    expect(
      isSameGitHubUser({ id: 5, login: "octocat" }, { username: " OctoCat " }),
    ).toBe(true)
  })

  it("does not match when neither the id nor the login lines up", () => {
    expect(
      isSameGitHubUser(
        { id: 5, login: "someone-else" },
        { github_id: "583231", username: "octocat" },
      ),
    ).toBe(false)
  })

  it("does not match a missing account", () => {
    const student = { github_id: "583231", username: "octocat" }
    expect(isSameGitHubUser(null, student)).toBe(false)
    expect(isSameGitHubUser(undefined, student)).toBe(false)
  })

  it("does not treat an empty github_id as matching any account id", () => {
    expect(
      isSameGitHubUser({ id: 5, login: "octocat" }, { username: "other" }),
    ).toBe(false)
    expect(
      isSameGitHubUser(
        { id: 5, login: "octocat" },
        { github_id: "", username: "other" },
      ),
    ).toBe(false)
  })

  // The id and login checks are OR'd, so a login hit wins even when the ids
  // positively disagree. Pinned because it is the load-bearing consequence of
  // supporting pre-id roster rows: a recycled/transferred login is read as the
  // same person. Change this only deliberately.
  it("matches on login even when the github_id positively conflicts", () => {
    expect(
      isSameGitHubUser(
        { id: 999, login: "octocat" },
        { github_id: "583231", username: "octocat" },
      ),
    ).toBe(true)
  })
})

describe("parseGitHubId", () => {
  it("parses a positive numeric id", () => {
    expect(parseGitHubId("583231")).toBe(583231)
    expect(parseGitHubId(" 42 ")).toBe(42)
  })

  it("rejects empty, non-numeric, zero, and negative values", () => {
    expect(parseGitHubId("")).toBeNull()
    expect(parseGitHubId("   ")).toBeNull()
    expect(parseGitHubId("octocat")).toBeNull()
    expect(parseGitHubId("0")).toBeNull()
    expect(parseGitHubId("-5")).toBeNull()
    expect(parseGitHubId("Infinity")).toBeNull()
  })

  // Number() coercion is wider than "positive integer": these pass the guard
  // today. Pinned so tightening it to integers-only is a visible change.
  it("also accepts numeric forms that are not plain positive integers", () => {
    expect(parseGitHubId("12.5")).toBe(12.5)
    expect(parseGitHubId("1e3")).toBe(1000)
    expect(parseGitHubId("0x10")).toBe(16)
  })
})

describe("memberIdSet", () => {
  it("stringifies member ids", () => {
    expect(memberIdSet([member(1, "a"), member(583231, "b")])).toEqual(
      new Set(["1", "583231"]),
    )
    expect(memberIdSet([])).toEqual(new Set())
  })
})

describe("memberIdentitySets", () => {
  it("folds members into stringified ids and lowercased logins", () => {
    expect(
      memberIdentitySets([member(1, "OctoCat"), member(2, "MONA")]),
    ).toEqual({
      ids: new Set(["1", "2"]),
      logins: new Set(["octocat", "mona"]),
    })
  })

  it("returns empty sets for no members", () => {
    expect(memberIdentitySets([])).toEqual({
      ids: new Set(),
      logins: new Set(),
    })
  })
})

describe("rosterClaimSet", () => {
  it("collects trimmed ids and lowercased logins across rows", () => {
    expect(
      rosterClaimSet([
        { github_id: " 583231 ", username: " OctoCat " },
        { github_id: "42", username: "MONA" },
      ]),
    ).toEqual({
      ids: new Set(["583231", "42"]),
      logins: new Set(["octocat", "mona"]),
    })
  })

  it("skips blank and whitespace-only claims rather than claiming an empty key", () => {
    expect(
      rosterClaimSet([
        { github_id: "", username: "" },
        { github_id: "   ", username: "   " },
        { username: "only-login" },
        { github_id: "7" },
        {},
      ]),
    ).toEqual({ ids: new Set(["7"]), logins: new Set(["only-login"]) })
  })

  it("returns empty sets for an empty roster", () => {
    expect(rosterClaimSet([])).toEqual({ ids: new Set(), logins: new Set() })
  })
})
