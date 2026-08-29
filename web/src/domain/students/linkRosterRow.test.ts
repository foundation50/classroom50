// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest"

const readOrgMembershipState = vi.fn()
const assignRosterMemberRole = vi.fn()
const assertClassroomNotArchived = vi.fn()
const pendingInviteEmails = vi.fn()

// withRosterRewrite is replaced by an in-memory harness: `storedRows` is the
// parsed roster the mutate closure receives; `committedRows` captures what a
// non-zero-change mutate wrote back.
let storedRows: import("@/util/rosterCsv").StudentCsvRow[] = []
let committedRows: import("@/util/rosterCsv").StudentCsvRow[] | null = null

vi.mock("@/github-core/mutations", () => ({
  readOrgMembershipState: (...a: unknown[]) => readOrgMembershipState(...a),
}))
vi.mock("../classrooms", () => ({
  assertClassroomNotArchived: (...a: unknown[]) =>
    assertClassroomNotArchived(...a),
}))
vi.mock("./roleWrites", () => ({
  assignRosterMemberRole: (...a: unknown[]) => assignRosterMemberRole(...a),
}))
vi.mock("./inviteRecoveries", () => ({
  pendingInviteEmails: (...a: unknown[]) => pendingInviteEmails(...a),
}))
vi.mock("./rosterPrimitives", () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  withRosterRewrite: async (
    _client: unknown,
    _input: unknown,
    mutate: (rows: import("@/util/rosterCsv").StudentCsvRow[]) => {
      nextStudents: import("@/util/rosterCsv").StudentCsvRow[]
      changed: number
    },
  ) => {
    const { nextStudents, changed } = mutate(storedRows)
    if (changed > 0) committedRows = nextStudents
    return { changed }
  },
}))

import {
  appendUnlinkedRows,
  linkRosterRowToMember,
  removeUnlinkedRows,
  unlinkedRowRef,
  MemberAlreadyOnRosterError,
  MemberNotActiveError,
  UnlinkedRowAmbiguousError,
  UnlinkedRowNotFoundError,
} from "./linkRosterRow"
import { normalizeStudentRow } from "@/util/rosterCsv"

const client = {} as never
const INPUT = { org: "org", classroom: "cs101" }

const row = (over: Partial<import("@/util/rosterCsv").StudentCsvRow>) =>
  normalizeStudentRow(over)

beforeEach(() => {
  vi.clearAllMocks()
  storedRows = []
  committedRows = null
  assertClassroomNotArchived.mockResolvedValue(undefined)
  readOrgMembershipState.mockResolvedValue("active")
  assignRosterMemberRole.mockResolvedValue({ state: "assigned" })
  pendingInviteEmails.mockResolvedValue(new Set())
})

describe("unlinkedRowRef", () => {
  it("keys on the normalized email when present, else the name tuple", () => {
    expect(
      unlinkedRowRef({
        email: " Ada@X.edu ",
        first_name: "Ada",
        last_name: "L",
        section: "s1",
      }),
    ).toEqual({ email: "ada@x.edu" })
    expect(
      unlinkedRowRef({
        email: "",
        first_name: " Grace ",
        last_name: "Hopper",
        section: "s1",
      }),
    ).toEqual({ first_name: "Grace", last_name: "Hopper", section: "s1" })
  })
})

describe("linkRosterRowToMember", () => {
  const member = { id: 42, login: "ada" }

  it("writes identity onto the matched row, then team-adds", async () => {
    storedRows = [
      row({ first_name: "Ada", email: "ada@x.edu" }),
      row({ username: "bob", github_id: "7" }),
    ]
    const result = await linkRosterRowToMember(client, {
      ...INPUT,
      rowRef: { email: "ada@x.edu" },
      member,
    })
    expect(result.teamAdd).toBe("ok")
    expect(committedRows?.[0]).toMatchObject({
      username: "ada",
      github_id: "42",
      email: "ada@x.edu",
      first_name: "Ada",
    })
    expect(assignRosterMemberRole).toHaveBeenCalledWith(client, {
      org: "org",
      classroom: "cs101",
      username: "ada",
      role: "student",
    })
  })

  it("links a name-only row by its tuple", async () => {
    storedRows = [
      row({ first_name: "Grace", last_name: "Hopper", section: "s1" }),
    ]
    await linkRosterRowToMember(client, {
      ...INPUT,
      rowRef: { first_name: "Grace", last_name: "Hopper", section: "s1" },
      member,
    })
    expect(committedRows?.[0]).toMatchObject({
      username: "ada",
      github_id: "42",
      first_name: "Grace",
    })
  })

  it("refuses when the member is not an active org member (decision-time proof)", async () => {
    readOrgMembershipState.mockResolvedValue("pending")
    storedRows = [row({ first_name: "Ada", email: "a@x.edu" })]
    await expect(
      linkRosterRowToMember(client, {
        ...INPUT,
        rowRef: { email: "a@x.edu" },
        member,
      }),
    ).rejects.toBeInstanceOf(MemberNotActiveError)
    expect(committedRows).toBeNull()
  })

  it("refuses when the member already claims another row (by id or login)", async () => {
    storedRows = [
      row({ first_name: "Ada", email: "a@x.edu" }),
      row({ username: "ADA", github_id: "" }),
    ]
    await expect(
      linkRosterRowToMember(client, {
        ...INPUT,
        rowRef: { email: "a@x.edu" },
        member,
      }),
    ).rejects.toBeInstanceOf(MemberAlreadyOnRosterError)
    expect(committedRows).toBeNull()
  })

  it("fails closed on an ambiguous tuple (two identical twins)", async () => {
    storedRows = [
      row({ first_name: "Grace", last_name: "H", section: "" }),
      row({ first_name: "Grace", last_name: "H", section: "" }),
    ]
    await expect(
      linkRosterRowToMember(client, {
        ...INPUT,
        rowRef: { first_name: "Grace", last_name: "H", section: "" },
        member,
      }),
    ).rejects.toBeInstanceOf(UnlinkedRowAmbiguousError)
  })

  it("misses a row that gained an identity since the view snapshot", async () => {
    storedRows = [row({ username: "someone", email: "a@x.edu" })]
    await expect(
      linkRosterRowToMember(client, {
        ...INPUT,
        rowRef: { email: "a@x.edu" },
        member,
      }),
    ).rejects.toBeInstanceOf(UnlinkedRowNotFoundError)
  })

  it("reports a failed team add without failing the link", async () => {
    assignRosterMemberRole.mockRejectedValue(new Error("boom"))
    storedRows = [row({ first_name: "Ada", email: "a@x.edu" })]
    const result = await linkRosterRowToMember(client, {
      ...INPUT,
      rowRef: { email: "a@x.edu" },
      member,
    })
    expect(result.teamAdd).toBe("failed")
    expect(committedRows?.[0]?.username).toBe("ada")
  })
})

describe("removeUnlinkedRows", () => {
  it("removes matching rows in one pass and reports refs that missed", async () => {
    storedRows = [
      row({ first_name: "Ada", email: "kept@x.edu" }),
      row({ first_name: "Grace", last_name: "H", section: "s1" }),
      row({ username: "bob", github_id: "7" }),
    ]
    const result = await removeUnlinkedRows(client, {
      ...INPUT,
      rowRefs: [
        { email: "kept@x.edu" },
        { first_name: "Grace", last_name: "H", section: "s1" },
        { email: "gone@x.edu" },
      ],
    })
    expect(result).toEqual({ removed: 2, missed: 1 })
    expect(committedRows).toEqual([storedRows[2]])
    // One liveness read covers every email-carrying ref.
    expect(pendingInviteEmails).toHaveBeenCalledTimes(1)
  })

  it("never removes a row that gained an identity mid-flight", async () => {
    storedRows = [row({ username: "ada", email: "a@x.edu" })]
    const result = await removeUnlinkedRows(client, {
      ...INPUT,
      rowRefs: [{ email: "a@x.edu" }],
    })
    expect(result).toEqual({ removed: 0, missed: 1 })
    expect(committedRows).toBeNull()
  })

  it("misses an email target a live pending invitation still backs", async () => {
    // The address was (re-)invited since the view snapshot: the decision-time
    // liveness read proves the row is the invite lifecycle's again, so it is
    // spared, never removed.
    pendingInviteEmails.mockResolvedValue(new Set(["pending@x.edu"]))
    storedRows = [row({ email: "pending@x.edu", first_name: "Ada" })]
    const result = await removeUnlinkedRows(client, {
      ...INPUT,
      rowRefs: [{ email: "pending@x.edu" }],
    })
    expect(result).toEqual({ removed: 0, missed: 1 })
    expect(committedRows).toBeNull()
  })

  it("fails closed on a failed liveness read, but still removes name-only targets", async () => {
    // A null return means the pending list is unknowable: every email-carrying
    // target is missed, while a name-only row (nothing could ever back it)
    // stays removable.
    pendingInviteEmails.mockResolvedValue(null)
    storedRows = [
      row({ email: "maybe@x.edu", first_name: "Ada" }),
      row({ first_name: "Grace", last_name: "H", section: "s1" }),
    ]
    const result = await removeUnlinkedRows(client, {
      ...INPUT,
      rowRefs: [
        { email: "maybe@x.edu" },
        { first_name: "Grace", last_name: "H", section: "s1" },
      ],
    })
    expect(result).toEqual({ removed: 1, missed: 1 })
    expect(committedRows).toEqual([storedRows[0]])
  })

  it("skips the liveness read entirely when every ref is name-only", async () => {
    storedRows = [row({ first_name: "Grace", last_name: "H", section: "s1" })]
    const result = await removeUnlinkedRows(client, {
      ...INPUT,
      rowRefs: [{ first_name: "Grace", last_name: "H", section: "s1" }],
    })
    expect(result).toEqual({ removed: 1, missed: 0 })
    expect(pendingInviteEmails).not.toHaveBeenCalled()
  })
})

describe("appendUnlinkedRows", () => {
  it("writes unlinked rows in one commit, skipping claimed emails and duplicate tuples", async () => {
    storedRows = [
      row({ username: "bob", email: "claimed@x.edu", github_id: "7" }),
      row({ first_name: "Grace", last_name: "H", section: "s1" }),
    ]
    const written = await appendUnlinkedRows(client, INPUT, [
      { email: "claimed@x.edu", first_name: "X" }, // claimed -> skipped
      { first_name: "Grace", last_name: "H", section: "s1" }, // tuple exists -> skipped
      { email: "new@x.edu", first_name: "Ada", section: "s2" },
      { first_name: "Alan", last_name: "T" },
      { section: "s3" }, // neither email nor name -> filtered out
    ])
    expect(written).toBe(2)
    expect(committedRows?.slice(2)).toEqual([
      row({
        email: "new@x.edu",
        first_name: "Ada",
        section: "s2",
      }),
      row({ first_name: "Alan", last_name: "T" }),
    ])
  })

  it("returns 0 and writes nothing when every entry is unusable or claimed", async () => {
    storedRows = [row({ email: "claimed@x.edu" })]
    const written = await appendUnlinkedRows(client, INPUT, [
      { email: "claimed@x.edu" },
      { section: "only" },
    ])
    expect(written).toBe(0)
    expect(committedRows).toBeNull()
  })
})
