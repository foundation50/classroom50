import { describe, expect, it } from "vitest"

import type { SubmissionRow } from "@/hooks/useGetScores"
import type { GitHubRepo } from "@/hooks/github/types"
import type { Student } from "@/types/classroom"
import {
  DEFAULT_FILTERS,
  acceptedRosterCount,
  acceptedUsernames,
  buildSectionLookup,
  computeStats,
  distinctSections,
  filterAndSortRows,
  filterNonSubmitters,
  hasAccepted,
  rowMatchesQuery,
  rowPassState,
  showsNonSubmitters,
  type SubmissionFilters,
} from "./dashboard"

// Minimal row factory — only the fields the dashboard logic reads.
const row = (over: Partial<SubmissionRow> = {}): SubmissionRow => ({
  usernames: ["alice"],
  owner: "alice",
  datetime: "2026-06-20T10:00:00Z",
  commit: "",
  release: "",
  review: "",
  score: 8,
  "max-score": 10,
  submissionCount: 1,
  late: false,
  submissions: [],
  ...over,
})

const student = (over: Partial<Student> = {}): Student => ({
  username: "alice",
  first_name: "Alice",
  last_name: "Adams",
  email: "alice@example.edu",
  section: "",
  github_id: "1",
  ...over,
})

const repo = (name: string): GitHubRepo => ({ name }) as GitHubRepo

const filters = (over: Partial<SubmissionFilters> = {}): SubmissionFilters => ({
  ...DEFAULT_FILTERS,
  ...over,
})

describe("rowPassState", () => {
  it("passes at or above the threshold fraction of max", () => {
    expect(rowPassState({ score: 7, "max-score": 10 }, 0.7)).toBe("passing")
    expect(rowPassState({ score: 10, "max-score": 10 }, 0.7)).toBe("passing")
    expect(rowPassState({ score: 10, "max-score": 10 }, 1)).toBe("passing")
  })

  it("fails below the threshold fraction", () => {
    expect(rowPassState({ score: 6, "max-score": 10 }, 0.7)).toBe("failing")
    expect(rowPassState({ score: 0, "max-score": 10 }, 0.7)).toBe("failing")
    // At the default full-marks bar (1.0), anything short of max fails.
    expect(rowPassState({ score: 9, "max-score": 10 }, 1)).toBe("failing")
  })

  it("treats max-score 0 / non-finite as ungraded, never failing", () => {
    expect(rowPassState({ score: 0, "max-score": 0 }, 1)).toBe("ungraded")
    expect(rowPassState({ score: 5, "max-score": NaN }, 1)).toBe("ungraded")
    expect(rowPassState({ score: NaN, "max-score": 10 }, 1)).toBe("ungraded")
  })

  it("returns ungraded when no threshold is configured (null)", () => {
    expect(rowPassState({ score: 10, "max-score": 10 }, null)).toBe("ungraded")
    expect(rowPassState({ score: 0, "max-score": 10 }, null)).toBe("ungraded")
  })
})

describe("computeStats", () => {
  it("counts passing/failing/ungraded and late over rows; rostered passes through", () => {
    const rows = [
      row({ score: 9, "max-score": 10 }), // passing at 0.7
      row({ score: 3, "max-score": 10, late: true }), // failing + late
      row({ score: 0, "max-score": 0 }), // ungraded
    ]
    const stats = computeStats(rows, 5, 0.7)
    expect(stats).toEqual({
      submitted: 3,
      rostered: 5,
      passing: 1,
      failing: 1,
      ungraded: 1,
      late: 1,
    })
  })

  it("respects the threshold: 9/10 passes at 0.7 but fails at the 1.0 default", () => {
    const rows = [row({ score: 9, "max-score": 10 })]
    expect(computeStats(rows, 1, 0.7).passing).toBe(1)
    expect(computeStats(rows, 1, 1).passing).toBe(0)
    expect(computeStats(rows, 1, 1).failing).toBe(1)
  })

  it("counts everything as ungraded (no passing/failing) when threshold is null", () => {
    const rows = [
      row({ score: 10, "max-score": 10 }),
      row({ score: 2, "max-score": 10 }),
    ]
    const stats = computeStats(rows, 5, null)
    expect(stats.passing).toBe(0)
    expect(stats.failing).toBe(0)
    expect(stats.ungraded).toBe(2)
  })

  it("handles an empty set", () => {
    expect(computeStats([], 0, 1)).toEqual({
      submitted: 0,
      rostered: 0,
      passing: 0,
      failing: 0,
      ungraded: 0,
      late: 0,
    })
  })
})

describe("rowMatchesQuery", () => {
  const students = [student({ username: "alice", first_name: "Alice" })]

  it("matches an empty query (no constraint)", () => {
    expect(rowMatchesQuery(row(), "", students)).toBe(true)
  })

  it("matches by username, case-insensitively", () => {
    expect(
      rowMatchesQuery(row({ usernames: ["aLiCe"] }), "ALI", students),
    ).toBe(true)
  })

  it("matches by roster display name even though rows carry only logins", () => {
    expect(
      rowMatchesQuery(row({ usernames: ["alice"] }), "adams", students),
    ).toBe(true)
  })

  it("does not match an unrelated query", () => {
    expect(rowMatchesQuery(row(), "zzz", students)).toBe(false)
  })
})

describe("filterAndSortRows", () => {
  const students = [
    student({ username: "alice", first_name: "Alice", last_name: "Adams" }),
    student({ username: "bob", first_name: "Bob", last_name: "Brown" }),
  ]
  const base = {
    query: "",
    filters: DEFAULT_FILTERS,
    sort: "recent" as const,
    students,
    sectionByUsername: new Map<string, string>(),
    thresholdFraction: 0.7,
  }

  const rows = [
    row({
      owner: "alice",
      usernames: ["alice"],
      datetime: "2026-06-22T10:00:00Z",
      score: 9,
      "max-score": 10,
      late: false,
    }),
    row({
      owner: "bob",
      usernames: ["bob"],
      datetime: "2026-06-20T10:00:00Z",
      score: 4,
      "max-score": 10,
      late: true,
    }),
  ]

  it("sorts newest-first by default", () => {
    const out = filterAndSortRows(rows, base)
    expect(out.map((r) => r.owner)).toEqual(["alice", "bob"])
  })

  it("sorts oldest-first", () => {
    const out = filterAndSortRows(rows, { ...base, sort: "oldest" })
    expect(out.map((r) => r.owner)).toEqual(["bob", "alice"])
  })

  it("sorts by name A-Z and Z-A using the roster display name", () => {
    expect(
      filterAndSortRows(rows, { ...base, sort: "name-asc" }).map(
        (r) => r.owner,
      ),
    ).toEqual(["alice", "bob"])
    expect(
      filterAndSortRows(rows, { ...base, sort: "name-desc" }).map(
        (r) => r.owner,
      ),
    ).toEqual(["bob", "alice"])
  })

  it("filters to late only", () => {
    const out = filterAndSortRows(rows, {
      ...base,
      filters: filters({ submission: "late" }),
    })
    expect(out.map((r) => r.owner)).toEqual(["bob"])
  })

  it("filters to on-time only", () => {
    const out = filterAndSortRows(rows, {
      ...base,
      filters: filters({ submission: "on-time" }),
    })
    expect(out.map((r) => r.owner)).toEqual(["alice"])
  })

  it("filters by passing/failing", () => {
    expect(
      filterAndSortRows(rows, {
        ...base,
        filters: filters({ passing: "passing" }),
      }).map((r) => r.owner),
    ).toEqual(["alice"])
    expect(
      filterAndSortRows(rows, {
        ...base,
        filters: filters({ passing: "failing" }),
      }).map((r) => r.owner),
    ).toEqual(["bob"])
  })

  it("hides all submitted rows for not-submitted and not-accepted filters", () => {
    expect(
      filterAndSortRows(rows, {
        ...base,
        filters: filters({ submission: "not-submitted" }),
      }),
    ).toEqual([])
    expect(
      filterAndSortRows(rows, {
        ...base,
        filters: filters({ accepted: "not-accepted" }),
      }),
    ).toEqual([])
  })

  it("combines filters with AND (late AND passing matches nothing here)", () => {
    const out = filterAndSortRows(rows, {
      ...base,
      filters: filters({ submission: "late", passing: "passing" }),
    })
    expect(out).toEqual([])
  })
})

describe("acceptedUsernames / hasAccepted / acceptedRosterCount", () => {
  const roster = [
    student({ username: "alice" }),
    student({ username: "bob" }),
    student({ username: "charlie" }),
  ]
  const repos = [
    repo("cs101-hw1-alice"),
    repo("cs101-hw1-bob"),
    repo("cs101-hw2-alice"),
    repo("cs101-hw1"),
    repo("unrelated-repo"),
  ]

  it("derives accepted roster usernames for the exact classroom+assignment", () => {
    const set = acceptedUsernames(repos, "cs101", "hw1", roster)
    // charlie is on the roster but has no hw1 repo -> not accepted.
    expect([...set].sort()).toEqual(["alice", "bob"])
  })

  it("is case-insensitive on the repo name", () => {
    const set = acceptedUsernames([repo("CS101-HW1-Alice")], "cs101", "hw1", [
      student({ username: "alice" }),
    ])
    expect(hasAccepted("alice", set)).toBe(true)
  })

  it("does NOT bleed a sibling assignment whose slug extends this one", () => {
    // Assignment "hw" (prefix "cs101-hw-") must not capture repos of "hw-bonus"
    // (prefix-collision regression).
    const set = acceptedUsernames(
      [repo("cs101-hw-bonus-alice"), repo("cs101-hw-alice")],
      "cs101",
      "hw",
      [student({ username: "alice" })],
    )
    expect([...set]).toEqual(["alice"])
    expect(set.has("bonus-alice")).toBe(false)
  })

  it("does not match a numeric-adjacent slug (hw1 vs hw10)", () => {
    const set = acceptedUsernames([repo("cs101-hw10-alice")], "cs101", "hw1", [
      student({ username: "alice" }),
    ])
    expect(set.size).toBe(0)
  })

  it("only includes roster students (a repo for a non-roster owner is ignored)", () => {
    const set = acceptedUsernames(
      [repo("cs101-hw1-alice"), repo("cs101-hw1-charlie")],
      "cs101",
      "hw1",
      [student({ username: "alice" })], // charlie not on roster
    )
    expect([...set]).toEqual(["alice"])
  })

  it("returns an empty set for null/undefined repos", () => {
    expect(acceptedUsernames(null, "cs101", "hw1", roster).size).toBe(0)
    expect(acceptedUsernames(undefined, "cs101", "hw1", roster).size).toBe(0)
  })

  it("counts roster students who accepted", () => {
    const set = acceptedUsernames(repos, "cs101", "hw1", roster)
    expect(acceptedRosterCount(roster, set)).toBe(2)
  })
})

describe("section helpers", () => {
  const roster = [
    student({ username: "alice", section: "Period 1" }),
    student({ username: "bob", section: "Period 2" }),
    student({ username: "carol", section: "Period 1" }),
    student({ username: "dave", section: "" }), // no section
  ]

  it("distinctSections returns sorted, de-duped, non-empty sections", () => {
    expect(distinctSections(roster)).toEqual(["Period 1", "Period 2"])
  })

  it("distinctSections is empty when no one has a section", () => {
    expect(distinctSections([student({ section: "" })])).toEqual([])
  })

  it("buildSectionLookup maps lowercased username -> section, omitting blanks", () => {
    const map = buildSectionLookup(roster)
    expect(map.get("alice")).toBe("Period 1")
    expect(map.get("bob")).toBe("Period 2")
    expect(map.has("dave")).toBe(false)
  })

  it("filterAndSortRows filters submitted rows by section", () => {
    const students = [
      student({ username: "alice", section: "Period 1" }),
      student({ username: "bob", section: "Period 2" }),
    ]
    const rows = [
      row({ owner: "alice", usernames: ["alice"] }),
      row({ owner: "bob", usernames: ["bob"] }),
    ]
    const out = filterAndSortRows(rows, {
      query: "",
      filters: filters({ section: "Period 1" }),
      sort: "recent",
      students,
      sectionByUsername: buildSectionLookup(students),
      thresholdFraction: 1,
    })
    expect(out.map((r) => r.owner)).toEqual(["alice"])
  })

  it("filterNonSubmitters filters by section", () => {
    const out = filterNonSubmitters(
      roster,
      "",
      filters({ section: "Period 1" }),
      new Set(),
    )
    expect(out.map((s) => s.username)).toEqual(["alice", "carol"])
  })
})

describe("showsNonSubmitters", () => {
  it("shows for all and not-submitted", () => {
    expect(showsNonSubmitters(filters({ submission: "all" }))).toBe(true)
    expect(showsNonSubmitters(filters({ submission: "not-submitted" }))).toBe(
      true,
    )
  })

  it("hides for submitted/late/on-time and any passing filter", () => {
    expect(showsNonSubmitters(filters({ submission: "submitted" }))).toBe(false)
    expect(showsNonSubmitters(filters({ submission: "late" }))).toBe(false)
    expect(showsNonSubmitters(filters({ passing: "passing" }))).toBe(false)
  })

  it("still shows when only the accepted filter is set", () => {
    expect(showsNonSubmitters(filters({ accepted: "not-accepted" }))).toBe(true)
    expect(showsNonSubmitters(filters({ accepted: "accepted" }))).toBe(true)
  })
})

describe("filterNonSubmitters", () => {
  const roster = [
    student({ username: "alice", first_name: "Alice", last_name: "Adams" }),
    student({ username: "bob", first_name: "Bob", last_name: "Brown" }),
    student({ username: "carol", first_name: "Carol", last_name: "Clark" }),
  ]
  // alice accepted (has a repo); bob and carol did not.
  const accepted = new Set(["alice"])

  it("filters by search query (name or username)", () => {
    const out = filterNonSubmitters(roster, "brown", DEFAULT_FILTERS, accepted)
    expect(out.map((s) => s.username)).toEqual(["bob"])
  })

  it("accepted filter keeps only those who accepted", () => {
    const out = filterNonSubmitters(
      roster,
      "",
      filters({ accepted: "accepted" }),
      accepted,
    )
    expect(out.map((s) => s.username)).toEqual(["alice"])
  })

  it("not-accepted filter keeps only those who did not accept", () => {
    const out = filterNonSubmitters(
      roster,
      "",
      filters({ accepted: "not-accepted" }),
      accepted,
    )
    expect(out.map((s) => s.username)).toEqual(["bob", "carol"])
  })

  it("combines query AND accepted filter", () => {
    const out = filterNonSubmitters(
      roster,
      "c", // matches carol (name/username) — and "clark"
      filters({ accepted: "not-accepted" }),
      accepted,
    )
    expect(out.map((s) => s.username)).toEqual(["carol"])
  })
})
