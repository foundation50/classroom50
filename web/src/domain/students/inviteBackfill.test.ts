// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest"

const listInviteTeams = vi.fn()
const readInviteTeam = vi.fn()
const deleteInviteTeam = vi.fn()
const listOrgAdmins = vi.fn()
const withRosterRewrite = vi.fn()

vi.mock("@/github-core/mutations", () => ({
  listInviteTeams: (...a: unknown[]) => listInviteTeams(...a),
  readInviteTeam: (...a: unknown[]) => readInviteTeam(...a),
  deleteInviteTeam: (...a: unknown[]) => deleteInviteTeam(...a),
}))
vi.mock("@/github-core/queries", () => ({
  listOrgAdmins: (...a: unknown[]) => listOrgAdmins(...a),
}))
vi.mock("./rosterPrimitives", () => ({
  withRosterRewrite: (...a: unknown[]) => withRosterRewrite(...a),
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

import { backfillInviteMetadata } from "./inviteBackfill"
import { inviteTeamName } from "@/util/inviteTeam"

const client = {} as never
const OWNER = { id: 1, login: "prof" }

// Build a valid invite-team state for (classroom, email) with the given
// non-owner members, so the description's email hashes back to the slug.
async function inviteState(
  classroom: string,
  email: string,
  members: { id: number; login: string }[],
  extra: { first_name?: string; last_name?: string; section?: string } = {},
) {
  const slug = await inviteTeamName(classroom, email)
  return {
    slug,
    description: {
      schema: "classroom50/invite/v1",
      email,
      classroom,
      ...extra,
    },
    members: [OWNER, ...members],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  listOrgAdmins.mockResolvedValue([OWNER])
  deleteInviteTeam.mockResolvedValue(undefined)
  // Default rewrite: run the mutate fn against an empty roster and report change.
  withRosterRewrite.mockImplementation(
    async (_c: unknown, _i: unknown, mutate: (rows: unknown[]) => unknown) =>
      mutate([]),
  )
})

describe("backfillInviteMetadata", () => {
  it("no invite teams -> no-op", async () => {
    listInviteTeams.mockResolvedValue([])
    const result = await backfillInviteMetadata(client, {
      org: "org",
      classroom: "cs101",
    })
    expect(result.backfilled).toEqual([])
    expect(withRosterRewrite).not.toHaveBeenCalled()
    expect(deleteInviteTeam).not.toHaveBeenCalled()
  })

  it("backfills the one non-owner member (excluding the owner) and deletes the team", async () => {
    const state = await inviteState("cs101", "alice@example.com", [
      { id: 2, login: "alice" },
    ])
    listInviteTeams.mockResolvedValue([{ slug: state.slug }])
    readInviteTeam.mockResolvedValue(state)

    const result = await backfillInviteMetadata(client, {
      org: "org",
      classroom: "cs101",
    })

    expect(result.backfilled).toEqual(["alice@example.com"])
    expect(deleteInviteTeam).toHaveBeenCalledWith(client, "org", state.slug)
    // The rewrite appended an identity row carrying the recovered email.
    const rewriteResult = await withRosterRewrite.mock.results[0].value
    expect(rewriteResult.changed).toBe(1)
    expect(rewriteResult.nextStudents[0]).toMatchObject({
      username: "alice",
      github_id: "2",
      email: "alice@example.com",
    })
  })

  it("skips a still-pending team (owner-only membership) without deleting", async () => {
    const state = await inviteState("cs101", "bob@example.com", [])
    listInviteTeams.mockResolvedValue([{ slug: state.slug }])
    readInviteTeam.mockResolvedValue(state)

    const result = await backfillInviteMetadata(client, {
      org: "org",
      classroom: "cs101",
    })
    expect(result.backfilled).toEqual([])
    expect(deleteInviteTeam).not.toHaveBeenCalled()
  })

  it("skips a team with >1 non-owner member (anomaly)", async () => {
    const state = await inviteState("cs101", "carol@example.com", [
      { id: 2, login: "carol" },
      { id: 3, login: "intruder" },
    ])
    listInviteTeams.mockResolvedValue([{ slug: state.slug }])
    readInviteTeam.mockResolvedValue(state)

    const result = await backfillInviteMetadata(client, {
      org: "org",
      classroom: "cs101",
    })
    expect(result.backfilled).toEqual([])
    expect(deleteInviteTeam).not.toHaveBeenCalled()
  })

  it("ignores a team whose description email doesn't hash to its name (tampered)", async () => {
    const state = await inviteState("cs101", "dan@example.com", [
      { id: 2, login: "dan" },
    ])
    // Tamper: keep the slug, change the recorded email to a different address.
    state.description.email = "attacker@example.com"
    listInviteTeams.mockResolvedValue([{ slug: state.slug }])
    readInviteTeam.mockResolvedValue(state)

    const result = await backfillInviteMetadata(client, {
      org: "org",
      classroom: "cs101",
    })
    expect(result.backfilled).toEqual([])
    expect(deleteInviteTeam).not.toHaveBeenCalled()
  })

  it("ignores a team belonging to another classroom", async () => {
    const state = await inviteState("cs102", "eve@example.com", [
      { id: 2, login: "eve" },
    ])
    listInviteTeams.mockResolvedValue([{ slug: state.slug }])
    readInviteTeam.mockResolvedValue(state)

    const result = await backfillInviteMetadata(client, {
      org: "org",
      classroom: "cs101",
    })
    expect(result.backfilled).toEqual([])
    expect(deleteInviteTeam).not.toHaveBeenCalled()
  })

  it("teacher-entered roster values win over the recovered record", async () => {
    const state = await inviteState(
      "cs101",
      "frank@example.com",
      [{ id: 2, login: "frank" }],
      { first_name: "RecordFirst", section: "RecordSec" },
    )
    listInviteTeams.mockResolvedValue([{ slug: state.slug }])
    readInviteTeam.mockResolvedValue(state)
    // Existing row already has a teacher-set first_name and section.
    withRosterRewrite.mockImplementation(
      async (_c: unknown, _i: unknown, mutate: (rows: unknown[]) => unknown) =>
        mutate([
          {
            username: "frank",
            github_id: "2",
            first_name: "TeacherFirst",
            last_name: "",
            email: "",
            section: "TeacherSec",
            role: "",
          },
        ]),
    )

    await backfillInviteMetadata(client, { org: "org", classroom: "cs101" })
    const rewriteResult = await withRosterRewrite.mock.results[0].value
    const row = rewriteResult.nextStudents[0]
    // Teacher values kept; only the blank email borrowed from the record.
    expect(row.first_name).toBe("TeacherFirst")
    expect(row.section).toBe("TeacherSec")
    expect(row.email).toBe("frank@example.com")
  })

  it("one bad team never blocks the rest", async () => {
    const good = await inviteState("cs101", "grace@example.com", [
      { id: 3, login: "grace" },
    ])
    listInviteTeams.mockResolvedValue([
      { slug: "invite-bad" },
      { slug: good.slug },
    ])
    readInviteTeam.mockImplementation(
      async (_c: unknown, _o: unknown, slug: string) => {
        if (slug === "invite-bad") throw new Error("boom")
        return good
      },
    )

    const result = await backfillInviteMetadata(client, {
      org: "org",
      classroom: "cs101",
    })
    expect(result.backfilled).toEqual(["grace@example.com"])
  })
})
