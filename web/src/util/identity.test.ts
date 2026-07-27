import { describe, expect, it } from "vitest"
import {
  isMalformedGitHubId,
  isSameGitHubUser,
  memberIdSet,
  memberIdentitySets,
  parseGitHubId,
  resolveGitHubId,
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

  it("rejects numeric-ish forms that are not plain positive integers", () => {
    expect(parseGitHubId("12.5")).toBeNull()
    expect(parseGitHubId("1e3")).toBeNull()
    expect(parseGitHubId("0x10")).toBeNull()
    expect(parseGitHubId("1,000")).toBeNull()
    expect(parseGitHubId("42abc")).toBeNull()
    expect(parseGitHubId("+42")).toBeNull()
  })

  // Beyond 2^53 an id can no longer round-trip exactly, so it would address the
  // wrong account rather than fail loudly.
  it("rejects an id too large to represent exactly", () => {
    expect(parseGitHubId("9007199254740993")).toBeNull()
    expect(parseGitHubId("9".repeat(400))).toBeNull()
    expect(parseGitHubId(String(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    )
  })

  // A padded id parses but never equals the raw string the id-keyed joins compare
  // (String(member.id) is unpadded), so it would read as unenrolled forever.
  // Actions use resolveGitHubId, which does resolve it.
  it("rejects a zero-padded id, which the identity joins could never match", () => {
    expect(parseGitHubId("0583231")).toBeNull()
    expect(parseGitHubId("007")).toBeNull()
  })
})

describe("resolveGitHubId", () => {
  it("resolves a zero-padded cell to the account it addresses", () => {
    expect(resolveGitHubId("0583231")).toBe(583231)
    expect(resolveGitHubId("007")).toBe(7)
    expect(resolveGitHubId(" 0042 ")).toBe(42)
  })

  it("agrees with parseGitHubId on every canonical cell", () => {
    for (const cell of ["583231", " 42 ", String(Number.MAX_SAFE_INTEGER)]) {
      expect(resolveGitHubId(cell)).toBe(parseGitHubId(cell))
    }
  })

  // Tolerating padding must not widen into coercion: these address no account,
  // so resolving one would invite a stranger.
  it("still refuses a cell that addresses no account", () => {
    for (const cell of [
      "",
      "   ",
      "0",
      "000",
      "-5",
      "+42",
      "1e3",
      "0x10",
      "12.5",
      "octocat",
      "9007199254740993",
    ]) {
      expect(resolveGitHubId(cell)).toBeNull()
    }
    expect(resolveGitHubId(undefined)).toBeNull()
  })
})

describe("isMalformedGitHubId", () => {
  it("separates a corrupted cell from an absent one", () => {
    expect(isMalformedGitHubId("1e3")).toBe(true)
    expect(isMalformedGitHubId("0x10")).toBe(true)
    expect(isMalformedGitHubId("octocat")).toBe(true)
    expect(isMalformedGitHubId("")).toBe(false)
    expect(isMalformedGitHubId("   ")).toBe(false)
    expect(isMalformedGitHubId(undefined)).toBe(false)
    expect(isMalformedGitHubId("583231")).toBe(false)
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
