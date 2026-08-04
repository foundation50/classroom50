// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"

// Drive the two router reads the hook depends on. useParams supplies the
// org/classroom/assignment scope; useRouterState({select}) is called with a
// state whose `matches` carry the route ids the hook matches against.
const params = vi.fn<() => Record<string, string | undefined>>(() => ({}))
const matchedRouteIds = vi.fn<() => string[]>(() => [])

vi.mock("@tanstack/react-router", () => ({
  useParams: () => params(),
  useRouterState: ({
    select,
  }: {
    select: (s: { matches: { routeId: string }[] }) => unknown
  }) => select({ matches: matchedRouteIds().map((routeId) => ({ routeId })) }),
}))

import { useSidebarNav } from "./useSidebarNav"

const run = (p: Record<string, string | undefined>, ids: string[]) => {
  params.mockReturnValue(p)
  matchedRouteIds.mockReturnValue(ids)
  return renderHook(() => useSidebarNav()).result.current
}

afterEach(() => {
  vi.clearAllMocks()
})

describe("useSidebarNav — route -> page/selected", () => {
  it("no org: orgs list is the default row", () => {
    expect(run({}, ["/_authed/"])).toMatchObject({
      page: "orgs",
      selected: "",
      settings: false,
    })
  })

  it("no org: account settings selects settings", () => {
    expect(run({}, ["/_authed/settings/"])).toMatchObject({
      page: "orgs",
      selected: "settings",
      settings: true,
    })
  })

  it("org, no classroom: classes home is the default row", () => {
    expect(run({ org: "acme" }, ["/_authed/$org/"])).toMatchObject({
      page: "classes",
      selected: "",
      settings: false,
    })
  })

  it.each([
    ["/_authed/$org/published/", "published", false],
    ["/_authed/$org/members/", "members", false],
    ["/_authed/$org/activity/", "activity", false],
    ["/_authed/$org/settings/", "settings", true],
  ])("classes level %s -> %s", (routeId, selected, settings) => {
    expect(run({ org: "acme" }, [routeId])).toMatchObject({
      page: "classes",
      selected,
      settings,
    })
  })

  it("classroom level: assignments is the default row", () => {
    expect(
      run({ org: "acme", classroom: "cs101" }, [
        "/_authed/$org/$classroom/assignments/",
      ]),
    ).toMatchObject({ page: "", selected: "assignments", settings: false })
  })

  it.each([
    ["/_authed/$org/$classroom/roster/", "roster"],
    ["/_authed/$org/$classroom/settings/", "settings"],
  ])("classroom level %s -> %s", (routeId, selected) => {
    expect(run({ org: "acme", classroom: "cs101" }, [routeId])).toMatchObject({
      page: "",
      selected,
    })
  })
})

describe("useSidebarNav — levelKey (menu-swap identity)", () => {
  it("is stable within a level but scoped per org/classroom/assignment", () => {
    const orgs = run({}, ["/_authed/"]).levelKey
    const classes = run({ org: "acme" }, ["/_authed/$org/"]).levelKey
    const classroom = run({ org: "acme", classroom: "cs101" }, [
      "/_authed/$org/$classroom/assignments/",
    ]).levelKey
    const assignment = run(
      { org: "acme", classroom: "cs101", assignment: "hw1" },
      ["/_authed/$org/$classroom/assignments/$assignment/"],
    ).levelKey

    // Each level is a distinct key (so AnimatePresence swaps between them)...
    expect(new Set([orgs, classes, classroom, assignment]).size).toBe(4)
    expect(classes).toBe("classes:acme")
    expect(classroom).toBe("classroom:acme/cs101")
    expect(assignment).toBe("assignment:acme/cs101/hw1")
  })

  it("stays constant across a within-classroom navigation (so the highlight glides)", () => {
    const onAssignments = run({ org: "acme", classroom: "cs101" }, [
      "/_authed/$org/$classroom/assignments/",
    ]).levelKey
    const onRoster = run({ org: "acme", classroom: "cs101" }, [
      "/_authed/$org/$classroom/roster/",
    ]).levelKey
    expect(onAssignments).toBe(onRoster)
  })

  it("changes when the classroom changes (so the menu body swaps)", () => {
    const a = run({ org: "acme", classroom: "cs101" }, [
      "/_authed/$org/$classroom/assignments/",
    ]).levelKey
    const b = run({ org: "acme", classroom: "cs303" }, [
      "/_authed/$org/$classroom/assignments/",
    ]).levelKey
    expect(a).not.toBe(b)
  })
})
