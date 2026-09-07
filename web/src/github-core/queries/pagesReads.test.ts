import { afterEach, describe, expect, it, vi } from "vitest"
import {
  attemptedPagesAssignmentUrls,
  fetchPagesAssignments,
} from "./pagesReads"

const ORG = "acme"
const CLASSROOM = "cs101"
const CUSTOM_BASE = "https://pages.example.edu/classroom50"
const DEFAULT_URL = `https://${ORG}.github.io/classroom50/${CLASSROOM}/assignments.json`
const CUSTOM_URL = `${CUSTOM_BASE}/${CLASSROOM}/assignments.json`

const MANIFEST = {
  schema: "classroom50/assignments/v1",
  assignments: [{ slug: "hw1", name: "HW 1" }],
}

type StubResponse =
  | { ok: true; body?: unknown }
  | { ok: false; status: number }
  | { network: true }

// Route-keyed fetch stub recording call order, so ordering and fallback
// assertions read directly off the visited URLs.
const stubFetch = (routes: Record<string, StubResponse>) => {
  const calls: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      calls.push(url)
      const route = routes[url]
      if (!route) throw new Error(`unstubbed fetch: ${url}`)
      if ("network" in route) {
        return Promise.reject(new TypeError("Failed to fetch"))
      }
      if (!route.ok) {
        return Promise.resolve({ status: route.status, ok: false })
      }
      return Promise.resolve({
        status: 200,
        ok: true,
        json: () => Promise.resolve(route.body ?? MANIFEST),
      })
    }),
  )
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("attemptedPagesAssignmentUrls", () => {
  it("lists custom first, then the github.io default", () => {
    expect(
      attemptedPagesAssignmentUrls(ORG, CLASSROOM, undefined, CUSTOM_BASE),
    ).toEqual([CUSTOM_URL, DEFAULT_URL])
  })

  it("is default-only without a custom base", () => {
    expect(attemptedPagesAssignmentUrls(ORG, CLASSROOM)).toEqual([DEFAULT_URL])
  })

  it("dedupes when the custom base IS the default", () => {
    expect(
      attemptedPagesAssignmentUrls(
        ORG,
        CLASSROOM,
        undefined,
        `https://${ORG}.github.io/classroom50`,
      ),
    ).toEqual([DEFAULT_URL])
  })

  it("inserts the capability secret into both hosts' paths", () => {
    expect(
      attemptedPagesAssignmentUrls(ORG, CLASSROOM, "a1b2c3d4", CUSTOM_BASE),
    ).toEqual([
      `${CUSTOM_BASE}/${CLASSROOM}/a1b2c3d4/assignments.json`,
      `https://${ORG}.github.io/classroom50/${CLASSROOM}/a1b2c3d4/assignments.json`,
    ])
  })
})

describe("fetchPagesAssignments", () => {
  it("reads the custom host first and never touches the default on success", async () => {
    const calls = stubFetch({ [CUSTOM_URL]: { ok: true } })
    const assignments = await fetchPagesAssignments(
      ORG,
      CLASSROOM,
      undefined,
      CUSTOM_BASE,
    )
    expect(assignments[0].slug).toBe("hw1")
    expect(calls).toEqual([CUSTOM_URL])
  })

  it("falls back to the default host when the custom host fails", async () => {
    const calls = stubFetch({
      [CUSTOM_URL]: { network: true },
      [DEFAULT_URL]: { ok: true },
    })
    const assignments = await fetchPagesAssignments(
      ORG,
      CLASSROOM,
      undefined,
      CUSTOM_BASE,
    )
    expect(assignments[0].slug).toBe("hw1")
    expect(calls).toEqual([CUSTOM_URL, DEFAULT_URL])
  })

  it("combines both hosts' failure with the custom attempt as the detail", async () => {
    stubFetch({
      [CUSTOM_URL]: { network: true },
      [DEFAULT_URL]: { network: true },
    })
    await expect(
      fetchPagesAssignments(ORG, CLASSROOM, undefined, CUSTOM_BASE),
    ).rejects.toMatchObject({
      localized: {
        key: "pagesErrors.classroomUnreachableBothHosts",
        params: {
          customUrl: CUSTOM_URL,
          defaultUrl: DEFAULT_URL,
          detail: { key: "pagesErrors.customHostUnreachable" },
        },
      },
    })
  })

  it("keeps the custom host's 404 as the detail when both hosts fail", async () => {
    stubFetch({
      [CUSTOM_URL]: { ok: false, status: 404 },
      [DEFAULT_URL]: { network: true },
    })
    await expect(
      fetchPagesAssignments(ORG, CLASSROOM, undefined, CUSTOM_BASE),
    ).rejects.toMatchObject({
      localized: {
        key: "pagesErrors.classroomUnreachableBothHosts",
        params: { detail: { key: "pagesErrors.classroomNotPublished" } },
      },
    })
  })

  it("fetches once when the custom base equals the default", async () => {
    const calls = stubFetch({ [DEFAULT_URL]: { ok: true } })
    await fetchPagesAssignments(
      ORG,
      CLASSROOM,
      undefined,
      `https://${ORG}.github.io/classroom50`,
    )
    expect(calls).toEqual([DEFAULT_URL])
  })

  it("keeps the single-host error semantics without a custom base", async () => {
    stubFetch({ [DEFAULT_URL]: { ok: false, status: 404 } })
    await expect(fetchPagesAssignments(ORG, CLASSROOM)).rejects.toMatchObject({
      localized: { key: "pagesErrors.classroomNotPublished" },
    })
  })

  it("names a bare network failure instead of leaking 'Failed to fetch'", async () => {
    stubFetch({ [DEFAULT_URL]: { network: true } })
    await expect(fetchPagesAssignments(ORG, CLASSROOM)).rejects.toMatchObject({
      localized: { key: "pagesErrors.classroomNetworkFailed" },
    })
  })
})
