import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  GROUP_HASH_HEX_LEN,
  GROUP_TEAM_PREFIX,
  groupTeamAssignmentPrefix,
  groupTeamHash,
  groupTeamName,
  isGroupTeamSlug,
  parseGroupTeamCounter,
} from "./teamSlug"
import {
  GROUP_DESCRIPTION_SCHEMA,
  marshalGroupDescription,
  parseGroupDescription,
  verifyGroupDescription,
} from "./groupTeam"
import { groupRepoName, parseGroupRepoCounter } from "./studentRepo"

// The shared vectors are the cross-language oracle (the Go suite asserts the
// same file), so a one-sided formula edit fails on the other language's copy.
const fixtureUrl = new URL(
  "../../../cli/shared/testdata/group_vectors.json",
  import.meta.url,
)
const doc = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), "utf8")) as {
  hash_hex_len: number
  prefix: string
  cases: {
    classroom: string
    assignment: string
    hash: string
    team_1: string
  }[]
}

describe("group team naming (shared vectors)", () => {
  it("pins the fixture's contract halves", () => {
    expect(doc.hash_hex_len).toBe(GROUP_HASH_HEX_LEN)
    expect(doc.prefix).toBe(GROUP_TEAM_PREFIX)
    expect(doc.cases.length).toBeGreaterThan(0)
  })

  it.each(doc.cases)(
    "derives $team_1 for ($classroom, $assignment)",
    async ({ classroom, assignment, hash, team_1 }) => {
      expect(await groupTeamHash(classroom, assignment)).toBe(hash)
      expect(await groupTeamName(classroom, assignment, 1)).toBe(team_1)
      expect(isGroupTeamSlug(team_1)).toBe(true)
      const prefix = await groupTeamAssignmentPrefix(classroom, assignment)
      expect(parseGroupTeamCounter(team_1, prefix)).toBe(1)
    },
  )
})

describe("isGroupTeamSlug", () => {
  const hash = "cee5352cb880dff5"
  it.each([
    [`${GROUP_TEAM_PREFIX}${hash}-1`, true],
    [`${GROUP_TEAM_PREFIX}${hash}-42`, true],
    [`${GROUP_TEAM_PREFIX}${hash}-0`, false], // counters start at 1
    [`${GROUP_TEAM_PREFIX}${hash}-01`, false], // no leading zeros
    [`${GROUP_TEAM_PREFIX}${hash}-`, false],
    [`${GROUP_TEAM_PREFIX}${hash}`, false],
    [`${GROUP_TEAM_PREFIX}${hash.slice(0, 15)}-1`, false], // short hash
    ["classroom50-group-theory", false], // human team in the namespace
    ["classroom50-cs50", false], // classroom student team
    [`invite-${hash}`, false],
    [`x${GROUP_TEAM_PREFIX}${hash}-1`, false], // anchored
  ])("%s -> %s", (slug, want) => {
    expect(isGroupTeamSlug(slug)).toBe(want)
  })
})

describe("group repo naming", () => {
  it("composes and parses the counter, mode-gated by the caller", () => {
    expect(groupRepoName("CS101", "HW1", 3)).toBe("cs101-hw1-group-3")
    expect(parseGroupRepoCounter("cs101-hw1-group-3", "cs101", "hw1")).toBe(3)
    expect(parseGroupRepoCounter("CS101-HW1-GROUP-3", "cs101", "hw1")).toBe(3)
    for (const bad of [
      "cs101-hw1-group-0",
      "cs101-hw1-group-03",
      "cs101-hw1-group-",
      "cs101-hw1-group-x",
      "cs101-hw1-alice",
      "cs101-hw2-group-3", // other assignment
    ]) {
      expect(parseGroupRepoCounter(bad, "cs101", "hw1")).toBeNull()
    }
  })
})

describe("group description record", () => {
  it("round-trips and hash-verifies against the team slug", async () => {
    const meta = { classroom: "cs50", assignment: "project", name: "Sharks" }
    const record = parseGroupDescription(marshalGroupDescription(meta))
    expect(record).toEqual({ schema: GROUP_DESCRIPTION_SCHEMA, ...meta })
    const slug = await groupTeamName("cs50", "project", 2)
    expect(await verifyGroupDescription(slug, record!)).toBe(true)
    // A maintainer-edited record pointing at another assignment must fail the
    // re-hash check — the trust boundary for student-editable descriptions.
    const forged = parseGroupDescription(
      marshalGroupDescription({ classroom: "cs50", assignment: "other" }),
    )
    expect(await verifyGroupDescription(slug, forged!)).toBe(false)
  })

  it("omits an empty display name and tolerates junk descriptions", () => {
    expect(
      marshalGroupDescription({
        classroom: "cs50",
        assignment: "project",
        name: "  ",
      }),
    ).not.toContain('"name"')
    expect(parseGroupDescription(null)).toBeNull()
    expect(parseGroupDescription("not json")).toBeNull()
    expect(parseGroupDescription('{"schema":"classroom50/invite/v1"}')).toBe(
      null,
    )
  })
})
