// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest"

const readOrgMembershipState = vi.fn()
const assignRosterMemberRole = vi.fn()
const assertClassroomNotArchived = vi.fn()
const pendingInviteEmails = vi.fn()

// withRosterRewrite is replaced by an in-memory harness: `storedRows` is the
// parsed roster the mutate closure receives; `committedRows` captures what a
// non-zero-change mutate wrote back; `rewriteCalls` counts invocations so the
// batch paths can prove they spend ONE rewrite. Setting `firstAttemptRows`
// makes the harness invoke the closure on those rows first and DISCARD the
// result, then re-invoke on `storedRows` — simulating a git-conflict retry, so
// tests can prove the closure's per-attempt reset.
let storedRows: import("@/util/rosterCsv").StudentCsvRow[] = []
let committedRows: import("@/util/rosterCsv").StudentCsvRow[] | null = null
let rewriteCalls = 0
let firstAttemptRows: import("@/util/rosterCsv").StudentCsvRow[] | null = null

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
    rewriteCalls++
    if (firstAttemptRows) mutate(firstAttemptRows)
    const { nextStudents, changed } = mutate(storedRows)
    if (changed > 0) committedRows = nextStudents
    return { changed }
  },
}))

import {
  appendUnlinkedRows,
  applyRosterEdits,
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
  rewriteCalls = 0
  firstAttemptRows = null
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

describe("applyRosterEdits", () => {
  it("applies a mixed batch (2 links + 1 metadata) in ONE rewrite", async () => {
    storedRows = [
      row({ first_name: "Ada", email: "ada@x.edu" }),
      row({ first_name: "Grace", last_name: "Hopper", section: "s1" }),
      row({ username: "bob", github_id: "7", first_name: "Bob" }),
    ]
    const result = await applyRosterEdits(client, {
      ...INPUT,
      edits: [
        {
          kind: "link",
          rowRef: { email: "ada@x.edu" },
          member: { id: 42, login: "ada" },
        },
        {
          kind: "link",
          rowRef: { first_name: "Grace", last_name: "Hopper", section: "s1" },
          member: { id: 43, login: "grace" },
        },
        {
          kind: "metadata",
          key: { github_id: "7" },
          patch: { first_name: "Robert", last_name: "B", section: "s2" },
        },
      ],
    })
    expect(result).toEqual({
      applied: 3,
      missed: [],
      linkedLogins: ["ada", "grace"],
      teamAddFailedLogins: [],
    })
    expect(rewriteCalls).toBe(1)
    expect(committedRows?.[0]).toMatchObject({
      username: "ada",
      github_id: "42",
    })
    expect(committedRows?.[1]).toMatchObject({
      username: "grace",
      github_id: "43",
    })
    expect(committedRows?.[2]).toMatchObject({
      first_name: "Robert",
      last_name: "B",
      section: "s2",
      username: "bob",
    })
    // One membership read per distinct link member, before the rewrite.
    expect(readOrgMembershipState).toHaveBeenCalledTimes(2)
    // Both linked logins get the best-effort team add, in order.
    expect(assignRosterMemberRole).toHaveBeenCalledTimes(2)
    expect(assignRosterMemberRole.mock.calls[0]?.[1]).toMatchObject({
      username: "ada",
      role: "student",
    })
  })

  it("misses a second link that claims an identity an earlier edit took", async () => {
    storedRows = [
      row({ first_name: "Ada", email: "a@x.edu" }),
      row({ first_name: "Ada2", email: "b@x.edu" }),
    ]
    const result = await applyRosterEdits(client, {
      ...INPUT,
      edits: [
        {
          kind: "link",
          rowRef: { email: "a@x.edu" },
          member: { id: 42, login: "ada" },
        },
        {
          kind: "link",
          rowRef: { email: "b@x.edu" },
          member: { id: 42, login: "ada" },
        },
      ],
    })
    expect(result.applied).toBe(1)
    expect(result.missed).toEqual([
      { label: "ada", reason: "identity-claimed" },
    ])
    expect(result.linkedLogins).toEqual(["ada"])
    expect(committedRows?.[1]).toMatchObject({ username: "", github_id: "" })
  })

  it("reports row-gone and ambiguous misses without aborting the batch", async () => {
    storedRows = [
      row({ first_name: "Twin", last_name: "T", section: "" }),
      row({ first_name: "Twin", last_name: "T", section: "" }),
      row({ username: "bob", github_id: "7" }),
    ]
    const result = await applyRosterEdits(client, {
      ...INPUT,
      edits: [
        {
          kind: "link",
          rowRef: { email: "gone@x.edu" },
          member: { id: 42, login: "ada" },
        },
        {
          kind: "link",
          rowRef: { first_name: "Twin", last_name: "T", section: "" },
          member: { id: 43, login: "grace" },
        },
        {
          kind: "metadata",
          key: { username: "bob" },
          patch: { first_name: "Bob", last_name: "", section: "" },
        },
      ],
    })
    expect(result.applied).toBe(1)
    expect(result.missed).toEqual([
      { label: "gone@x.edu", reason: "row-gone" },
      { label: "Twin T", reason: "ambiguous" },
    ])
    expect(committedRows?.[2]).toMatchObject({ first_name: "Bob" })
  })

  it("misses a metadata edit whose target row is gone", async () => {
    storedRows = [row({ username: "bob", github_id: "7" })]
    const result = await applyRosterEdits(client, {
      ...INPUT,
      edits: [
        {
          kind: "metadata",
          key: { username: "ghost" },
          patch: { first_name: "G", last_name: "", section: "" },
        },
      ],
    })
    expect(result.applied).toBe(0)
    expect(result.missed).toEqual([{ label: "ghost", reason: "row-gone" }])
    expect(committedRows).toBeNull()
  })

  it("excludes a non-active member before the rewrite (member-not-active)", async () => {
    readOrgMembershipState.mockImplementation(
      async (_client: unknown, _org: unknown, login: unknown) =>
        login === "ada" ? "active" : "pending",
    )
    storedRows = [
      row({ first_name: "Ada", email: "a@x.edu" }),
      row({ first_name: "Gone", email: "b@x.edu" }),
    ]
    const result = await applyRosterEdits(client, {
      ...INPUT,
      edits: [
        {
          kind: "link",
          rowRef: { email: "a@x.edu" },
          member: { id: 42, login: "ada" },
        },
        {
          kind: "link",
          rowRef: { email: "b@x.edu" },
          member: { id: 43, login: "leaver" },
        },
      ],
    })
    expect(result.applied).toBe(1)
    expect(result.missed).toEqual([
      { label: "leaver", reason: "member-not-active" },
    ])
    expect(result.linkedLogins).toEqual(["ada"])
    // The excluded member's row is untouched in the committed rewrite.
    expect(committedRows?.[1]).toMatchObject({ username: "", github_id: "" })
    expect(assignRosterMemberRole).toHaveBeenCalledTimes(1)
  })

  it("counts an all-noop metadata batch as applied but makes NO commit", async () => {
    storedRows = [
      row({
        username: "bob",
        github_id: "7",
        first_name: "Bob",
        section: "s1",
      }),
    ]
    const result = await applyRosterEdits(client, {
      ...INPUT,
      edits: [
        {
          kind: "metadata",
          key: { github_id: "7" },
          patch: { first_name: "Bob", last_name: "", section: "s1" },
        },
      ],
    })
    expect(result.applied).toBe(1)
    expect(result.missed).toEqual([])
    expect(rewriteCalls).toBe(1)
    expect(committedRows).toBeNull()
  })

  it("reports a failed team add in teamAddFailedLogins without failing the save", async () => {
    assignRosterMemberRole.mockRejectedValue(new Error("boom"))
    storedRows = [row({ first_name: "Ada", email: "a@x.edu" })]
    const result = await applyRosterEdits(client, {
      ...INPUT,
      edits: [
        {
          kind: "link",
          rowRef: { email: "a@x.edu" },
          member: { id: 42, login: "ada" },
        },
      ],
    })
    expect(result.applied).toBe(1)
    expect(result.linkedLogins).toEqual(["ada"])
    expect(result.teamAddFailedLogins).toEqual(["ada"])
    expect(committedRows?.[0]).toMatchObject({ username: "ada" })
  })

  it("falls back to the unlinked matcher for a metadata edit keyed by rowRef", async () => {
    storedRows = [row({ first_name: "Grace", last_name: "H", section: "s1" })]
    const result = await applyRosterEdits(client, {
      ...INPUT,
      edits: [
        {
          kind: "metadata",
          key: {
            rowRef: { first_name: "Grace", last_name: "H", section: "s1" },
          },
          patch: { first_name: "Grace", last_name: "Hopper", section: "s1" },
        },
      ],
    })
    expect(result.applied).toBe(1)
    expect(committedRows?.[0]).toMatchObject({ last_name: "Hopper" })
  })

  it("resets per attempt on a conflict retry: a row that gained an identity flips to missed, no duplicate linkedLogins", async () => {
    firstAttemptRows = [
      row({ first_name: "Ada", email: "a@x.edu" }),
      row({ first_name: "Grace", email: "b@x.edu" }),
    ]
    // Between attempts the first row gained an identity; the second is intact.
    storedRows = [
      row({ username: "someone", github_id: "9", email: "a@x.edu" }),
      row({ first_name: "Grace", email: "b@x.edu" }),
    ]
    const result = await applyRosterEdits(client, {
      ...INPUT,
      edits: [
        {
          kind: "link",
          rowRef: { email: "a@x.edu" },
          member: { id: 42, login: "ada" },
        },
        {
          kind: "link",
          rowRef: { email: "b@x.edu" },
          member: { id: 43, login: "grace" },
        },
      ],
    })
    // The doomed first attempt's tallies were discarded wholesale: "ada" is
    // missed (not stale-applied) and "grace" appears exactly once.
    expect(result.applied).toBe(1)
    expect(result.missed).toEqual([{ label: "a@x.edu", reason: "row-gone" }])
    expect(result.linkedLogins).toEqual(["grace"])
    expect(assignRosterMemberRole).toHaveBeenCalledTimes(1)
    expect(committedRows?.[0]).toMatchObject({ username: "someone" })
    expect(committedRows?.[1]).toMatchObject({ username: "grace" })
  })

  it("never lands a fused patch on another row when the link misses as identity-claimed on retry", async () => {
    firstAttemptRows = [row({ first_name: "Ada", email: "a@x.edu" })]
    // Second attempt: the member claimed a different row between attempts.
    const existing = row({
      username: "ada",
      github_id: "42",
      first_name: "Existing",
      last_name: "Student",
      section: "s9",
    })
    storedRows = [row({ first_name: "Ada", email: "a@x.edu" }), existing]
    const result = await applyRosterEdits(client, {
      ...INPUT,
      edits: [
        {
          kind: "link",
          rowRef: { email: "a@x.edu" },
          member: { id: 42, login: "ada" },
          patch: { first_name: "Patched", last_name: "P", section: "s1" },
        },
      ],
    })
    // ONE missed unit — the patch died with its link instead of resolving by
    // login to the member's pre-existing row.
    expect(result.applied).toBe(0)
    expect(result.missed).toEqual([
      { label: "ada", reason: "identity-claimed" },
    ])
    expect(result.linkedLogins).toEqual([])
    expect(committedRows).toBeNull()
  })

  it("applies a fused link+patch as ONE unit: identity and metadata land on the matched row in one commit", async () => {
    storedRows = [
      row({ first_name: "Ada", email: "a@x.edu" }),
      row({ username: "bob", github_id: "7" }),
    ]
    const result = await applyRosterEdits(client, {
      ...INPUT,
      edits: [
        {
          kind: "link",
          rowRef: { email: "a@x.edu" },
          member: { id: 42, login: "ada" },
          patch: {
            first_name: "Adalene",
            last_name: "Lovelace",
            section: "s2",
          },
        },
      ],
    })
    expect(result.applied).toBe(1)
    expect(result.missed).toEqual([])
    expect(result.linkedLogins).toEqual(["ada"])
    expect(rewriteCalls).toBe(1)
    expect(committedRows?.[0]).toMatchObject({
      username: "ada",
      github_id: "42",
      first_name: "Adalene",
      last_name: "Lovelace",
      section: "s2",
      email: "a@x.edu",
    })
    expect(committedRows?.[1]).toEqual(storedRows[1])
  })
})
