import { describe, expect, it } from "vitest"

import type { SubmissionRow } from "@/hooks/useGetScores"
import type { GitHubRepo } from "@/github-core/types"
import type { Student } from "@/types/classroom"
import {
  DEFAULT_FILTERS,
  acceptedRosterCount,
  acceptedUsernames,
  applyStatusSelection,
  buildScoresCsvRows,
  buildSectionLookup,
  classAverage,
  computeStats,
  distinctSections,
  existingGroupRepos,
  filterAndSortRows,
  filterNonSubmitters,
  hasAccepted,
  mergeLiveRows,
  nonSubmitterStatus,
  reconcileNonSubmitters,
  rosterScopedRows,
  rowMatchesQuery,
  rowOnRoster,
  rowPassState,
  scoreTone,
  selectActiveWorkflowAction,
  showsNonSubmitters,
  statusSelectValue,
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
  role: "",
  ...over,
})

const repo = (name: string): GitHubRepo => ({ name }) as GitHubRepo

const filters = (over: Partial<SubmissionFilters> = {}): SubmissionFilters => ({
  ...DEFAULT_FILTERS,
  ...over,
})

describe("rowOnRoster / rosterScopedRows", () => {
  const roster = [student({ username: "alice" }), student({ username: "bob" })]

  it("keeps an individual row whose owner is on the roster", () => {
    const logins = new Set(["alice", "bob"])
    expect(rowOnRoster(row({ usernames: ["alice"] }), logins)).toBe(true)
    expect(rowOnRoster(row({ usernames: ["carol"] }), logins)).toBe(false)
  })

  it("matches case-insensitively", () => {
    expect(rowOnRoster(row({ usernames: ["ALICE"] }), new Set(["alice"]))).toBe(
      true,
    )
  })

  it("keeps a group row with at least one still-enrolled member", () => {
    const logins = new Set(["alice"])
    // bob unenrolled, alice still on the roster -> group stays visible.
    expect(rowOnRoster(row({ usernames: ["alice", "bob"] }), logins)).toBe(true)
    // all members unenrolled -> dropped.
    expect(rowOnRoster(row({ usernames: ["bob", "carol"] }), logins)).toBe(
      false,
    )
  })

  it("drops rows credited only to since-unenrolled students", () => {
    const rows = [
      row({ owner: "alice", usernames: ["alice"] }),
      row({ owner: "carol", usernames: ["carol"] }), // no longer on roster
    ]
    const out = rosterScopedRows(rows, roster)
    expect(out.map((r) => r.owner)).toEqual(["alice"])
  })

  it("ignores blank roster usernames (never matches an empty login)", () => {
    const rows = [row({ owner: "", usernames: [""] })]
    expect(rosterScopedRows(rows, [student({ username: "" })])).toEqual([])
  })
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

describe("existingGroupRepos", () => {
  const repos = [
    repo("cs101-hw1-alice"),
    repo("cs101-hw1-bob-team"),
    repo("cs101-hw2-alice"),
    repo("cs101-hw1"),
    repo("unrelated-repo"),
  ]

  it("lists group repos for the exact classroom+assignment, keyed by founder", () => {
    const out = existingGroupRepos(repos, "cs101", "hw1")
    expect(out.map((r) => r.owner).sort()).toEqual(["alice", "bob-team"])
  })

  it("returns the repo name alongside the founder", () => {
    const out = existingGroupRepos([repo("cs101-hw1-alice")], "cs101", "hw1")
    expect(out).toEqual([{ owner: "alice", repoName: "cs101-hw1-alice" }])
  })

  it("rejects a slug-extending sibling assignment's repos (hw1 vs hw1-bonus)", () => {
    const out = existingGroupRepos(
      [repo("cs101-hw1-alice"), repo("cs101-hw1-bonus-alice")],
      "cs101",
      "hw1",
      ["hw1", "hw1-bonus"],
    )
    // Without the sibling guard, `bonus-alice` would leak in as a phantom row.
    expect(out.map((r) => r.owner)).toEqual(["alice"])
  })

  it("keeps a sibling repo when the sibling slug isn't a prefix extension", () => {
    // `hw1b` is not `hw1-<something>`, so it never shares the `cs101-hw1-` prefix.
    const out = existingGroupRepos([repo("cs101-hw1-alice")], "cs101", "hw1", [
      "hw1",
      "hw1b",
    ])
    expect(out.map((r) => r.owner)).toEqual(["alice"])
  })

  it("rejects a bare `<classroom>-<assignment>-` with an empty owner segment", () => {
    const out = existingGroupRepos([repo("cs101-hw1-")], "cs101", "hw1")
    expect(out).toEqual([])
  })

  it("is case-insensitive on the repo name and founder", () => {
    const out = existingGroupRepos(
      [repo("CS101-HW1-TeamRocket")],
      "cs101",
      "hw1",
    )
    expect(out).toEqual([
      { owner: "teamrocket", repoName: "cs101-hw1-teamrocket" },
    ])
  })

  it("does not match a numeric-adjacent slug (hw1 vs hw10)", () => {
    const out = existingGroupRepos([repo("cs101-hw10-team")], "cs101", "hw1")
    expect(out).toEqual([])
  })

  it("returns an empty list for null/undefined repos", () => {
    expect(existingGroupRepos(null, "cs101", "hw1")).toEqual([])
    expect(existingGroupRepos(undefined, "cs101", "hw1")).toEqual([])
  })
})

describe("reconcileNonSubmitters", () => {
  const roster = [
    student({ username: "alice" }),
    student({ username: "bob" }),
    student({ username: "carol" }),
  ]

  it("excludes students credited on a score row", () => {
    const out = reconcileNonSubmitters(
      roster,
      [{ usernames: ["alice"] }],
      new Set(),
    )
    expect(out.map((s) => s.username).sort()).toEqual(["bob", "carol"])
  })

  it("excludes a group-repo member so they aren't double-listed as no-group (#245)", () => {
    // bob is a teammate on a formed-but-unsubmitted group repo (no score row
    // yet); he must not surface as "no group".
    const out = reconcileNonSubmitters(roster, [], new Set(["bob"]))
    expect(out.map((s) => s.username).sort()).toEqual(["alice", "carol"])
  })

  it("re-lists a teammate as no-group when the member set is empty (fetch failed)", () => {
    // Guards the failure-mode contract: an empty groupRepoMembers (e.g. the
    // bounded fetch errored) degrades to listing everyone uncredited.
    const out = reconcileNonSubmitters(roster, [], new Set())
    expect(out.map((s) => s.username).sort()).toEqual(["alice", "bob", "carol"])
  })

  it("matches credit and membership case-insensitively", () => {
    const out = reconcileNonSubmitters(
      [student({ username: "Alice" }), student({ username: "Bob" })],
      [{ usernames: ["ALICE"] }],
      new Set(["bob"]),
    )
    expect(out).toEqual([])
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

describe("scoreTone", () => {
  it("is ghost (ungraded) when there is no threshold", () => {
    expect(scoreTone(8, 10, null)).toEqual({ ghost: true })
  })

  it("is ghost when max is zero or non-finite (ungraded)", () => {
    expect(scoreTone(0, 0, 0.7)).toEqual({ ghost: true })
    expect(scoreTone(5, NaN, 0.7)).toEqual({ ghost: true })
  })

  it("is success at or above the threshold, error below", () => {
    expect(scoreTone(7, 10, 0.7)).toEqual({ tone: "success" })
    expect(scoreTone(10, 10, 1)).toEqual({ tone: "success" })
    expect(scoreTone(6, 10, 0.7)).toEqual({ tone: "error" })
  })
})

describe("buildScoresCsvRows", () => {
  it("orders submitters newest-first, then non-submitters, preserving the column contract", () => {
    const older = row({
      usernames: ["alice"],
      datetime: "2026-06-20T10:00:00Z",
      score: 8,
      "max-score": 10,
      submissionCount: 2,
      late: true,
      commit: "c1",
      review: "r1",
      release: "rel1",
    })
    const newer = row({
      usernames: ["bob", "carol"],
      datetime: "2026-06-21T10:00:00Z",
      score: 9,
      "max-score": 10,
      submissionCount: 1,
      late: false,
      commit: "c2",
      review: "r2",
      release: "rel2",
    })
    const out = buildScoresCsvRows(
      [older, newer],
      [student({ username: "dave" })],
    )

    expect(out).toHaveLength(3)
    // Newest submission first.
    expect(out[0]).toEqual({
      usernames: "bob, carol",
      score: 9,
      max_score: 10,
      submissions: 1,
      submitted_at: new Date("2026-06-21T10:00:00Z").toISOString(),
      late: "no",
      commit: "c2",
      review: "r2",
      release: "rel2",
    })
    expect(out[1].usernames).toBe("alice")
    expect(out[1].late).toBe("yes")
    // Non-submitter pinned last with a 0 score and blank fields.
    expect(out[2]).toEqual({
      usernames: "dave",
      score: 0,
      max_score: "",
      submissions: 0,
      submitted_at: "",
      late: "",
      commit: "",
      review: "",
      release: "",
    })
  })
})

describe("selectActiveWorkflowAction", () => {
  const idle = { running: false, idle: true }
  it("returns null when both actions are idle", () => {
    expect(selectActiveWorkflowAction(idle, idle)).toBeNull()
  })
  it("prefers a running action, collect over regrade", () => {
    expect(
      selectActiveWorkflowAction(
        { running: true, idle: false },
        { running: true, idle: false },
      ),
    ).toBe("collect")
    expect(
      selectActiveWorkflowAction(idle, { running: true, idle: false }),
    ).toBe("regrade")
  })
  it("falls back to the most recently non-idle action when neither runs", () => {
    expect(
      selectActiveWorkflowAction({ running: false, idle: false }, idle),
    ).toBe("collect")
    expect(
      selectActiveWorkflowAction(idle, { running: false, idle: false }),
    ).toBe("regrade")
  })
})

describe("nonSubmitterStatus", () => {
  it("is no-group for group assignments", () => {
    expect(nonSubmitterStatus("alice", { isGroup: true })).toBe("no-group")
    // Group ignores acceptance data entirely.
    expect(
      nonSubmitterStatus("alice", {
        isGroup: true,
        acceptedUsernames: new Set(["alice"]),
      }),
    ).toBe("no-group")
  })

  it("is not-submitted when acceptance data is unavailable (individual)", () => {
    expect(nonSubmitterStatus("alice", { isGroup: false })).toBe(
      "not-submitted",
    )
  })

  it("distinguishes accepted-not-submitted from not-accepted", () => {
    const accepted = new Set(["alice"])
    expect(
      nonSubmitterStatus("alice", {
        isGroup: false,
        acceptedUsernames: accepted,
      }),
    ).toBe("accepted-not-submitted")
    expect(
      nonSubmitterStatus("bob", {
        isGroup: false,
        acceptedUsernames: accepted,
      }),
    ).toBe("not-accepted")
  })
})

describe("statusSelectValue / applyStatusSelection", () => {
  it("maps filters to the combined value, submission taking precedence", () => {
    expect(statusSelectValue(filters())).toBe("all")
    expect(statusSelectValue(filters({ submission: "late" }))).toBe("late")
    expect(statusSelectValue(filters({ accepted: "not-accepted" }))).toBe(
      "not-accepted",
    )
    // Submission wins when both axes are set (a submitted row is accepted).
    expect(
      statusSelectValue(
        filters({ submission: "submitted", accepted: "accepted" }),
      ),
    ).toBe("submitted")
  })

  it("round-trips every option through apply then read", () => {
    for (const value of [
      "all",
      "submitted",
      "on-time",
      "late",
      "not-submitted",
      "accepted",
      "not-accepted",
    ] as const) {
      expect(statusSelectValue(applyStatusSelection(filters(), value))).toBe(
        value,
      )
    }
  })

  it("resets the other axis so the two stay mutually exclusive", () => {
    const afterSubmission = applyStatusSelection(
      filters({ accepted: "accepted" }),
      "late",
    )
    expect(afterSubmission.submission).toBe("late")
    expect(afterSubmission.accepted).toBe("all")

    const afterAccepted = applyStatusSelection(
      filters({ submission: "late" }),
      "not-accepted",
    )
    expect(afterAccepted.accepted).toBe("not-accepted")
    expect(afterAccepted.submission).toBe("all")

    const cleared = applyStatusSelection(
      filters({ submission: "late", accepted: "accepted" }),
      "all",
    )
    expect(cleared.submission).toBe("all")
    expect(cleared.accepted).toBe("all")
  })

  it("preserves the section and passing axes it doesn't own", () => {
    const out = applyStatusSelection(
      filters({ section: "P3", passing: "failing" }),
      "submitted",
    )
    expect(out.section).toBe("P3")
    expect(out.passing).toBe("failing")
  })
})

describe("mergeLiveRows", () => {
  const live = (owner: string, datetime: string) => ({
    owner,
    datetime,
    release: `https://github.com/o/${owner}/releases/tag/submit`,
  })

  it("keeps snapshot rows unchanged", () => {
    const snapshot = [row({ owner: "alice", score: 8 })]
    const merged = mergeLiveRows(snapshot, [])
    expect(merged).toHaveLength(1)
    expect(merged[0].score).toBe(8)
    expect(merged[0].pending).toBeUndefined()
  })

  it("adds a pending row for a live-only owner absent from the snapshot", () => {
    const snapshot = [row({ owner: "alice" })]
    const merged = mergeLiveRows(snapshot, [
      live("bob", "2026-06-21T10:00:00Z"),
    ])
    const bob = merged.find((r) => r.owner === "bob")
    expect(bob).toBeDefined()
    expect(bob?.pending).toBe(true)
    expect(bob?.["max-score"]).toBe(0)
    expect(bob?.usernames).toEqual(["bob"])
  })

  it("does not duplicate an owner already in the snapshot (snapshot wins)", () => {
    const snapshot = [row({ owner: "alice", score: 9 })]
    const merged = mergeLiveRows(snapshot, [
      live("Alice", "2026-06-25T10:00:00Z"),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].score).toBe(9)
    expect(merged[0].pending).toBeUndefined()
  })

  it("matches owners case-insensitively", () => {
    const snapshot = [row({ owner: "Alice" })]
    const merged = mergeLiveRows(snapshot, [
      live("alice", "2026-06-25T10:00:00Z"),
    ])
    expect(merged).toHaveLength(1)
  })

  it("orders live-only rows newest-first", () => {
    const merged = mergeLiveRows(
      [],
      [
        live("old", "2026-01-01T00:00:00Z"),
        live("new", "2026-09-01T00:00:00Z"),
      ],
    )
    expect(merged.map((r) => r.owner)).toEqual(["new", "old"])
  })

  it("pending rows are excluded from the class average", () => {
    const rows = [
      row({ owner: "alice", score: 10, "max-score": 10 }),
      row({ owner: "bob", score: 0, "max-score": 0, pending: true }),
    ]
    // Only alice's 10 counts; bob's placeholder 0 must not drag it to 5.
    expect(classAverage(rows)).toBe(10)
  })

  it("pending rows export a blank score/max, not a graded zero", () => {
    const rows = [
      row({
        owner: "bob",
        usernames: ["bob"],
        score: 0,
        "max-score": 0,
        pending: true,
      }),
    ]
    const [csv] = buildScoresCsvRows(rows, [])
    expect(csv.score).toBe("")
    expect(csv.max_score).toBe("")
    expect(csv.usernames).toBe("bob")
  })
})
