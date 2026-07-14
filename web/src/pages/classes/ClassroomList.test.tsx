// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, act } from "@testing-library/react"
import type { ClassroomSummary } from "@/hooks/useClassroomSummaries"
import type { GitHubFileListing } from "@/hooks/github/types"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return { ...actual, Link: ({ children }: { children?: unknown }) => children }
})

// Drive the sort key; changeSort is captured so a test can flip it at runtime.
let sortKey = "name-asc"
const changeSort = vi.fn((k: string) => {
  sortKey = k
})
vi.mock("@/lib/listPrefs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/listPrefs")>()
  return {
    ...actual,
    useListPrefsState: () => ({
      viewMode: "grid",
      sortKey,
      changeView: () => {},
      changeSort,
    }),
  }
})

const summaries = vi.fn()
vi.mock("@/hooks/useClassroomSummaries", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/useClassroomSummaries")>()
  return {
    ...actual,
    default: (...a: unknown[]) => summaries(...a),
    // keep the real classroomDisplayName
  }
})

// Cards render the display name so we can assert sort order from the DOM.
vi.mock("@/pages/classes/ClassroomCard", () => ({
  ClassroomCard: ({ summary }: { summary: ClassroomSummary }) => (
    <div data-testid="card">{summary.name ?? summary.path}</div>
  ),
  ClassroomRow: ({ summary }: { summary: ClassroomSummary }) => (
    <div data-testid="card">{summary.name ?? summary.path}</div>
  ),
}))

// Capture the probe props (paths + onCount) instead of running real probes.
let probeProps: {
  paths: string[]
  onCount: (path: string, count: number | undefined) => void
} | null = null
const probesRendered = vi.fn()
vi.mock("@/pages/classes/StudentCountProbes", () => ({
  StudentCountProbes: (props: {
    paths: string[]
    onCount: (path: string, count: number | undefined) => void
  }) => {
    probesRendered()
    probeProps = props
    return null
  },
}))

import ClassroomList from "./ClassroomList"

const summary = (over: Partial<ClassroomSummary>): ClassroomSummary => ({
  path: over.path ?? "p",
  name: over.name,
  archived: over.archived ?? false,
  loading: over.loading ?? false,
  ...over,
})
const dir = (path: string): GitHubFileListing =>
  ({ path, type: "dir", name: path }) as GitHubFileListing

const cardNames = () =>
  screen.getAllByTestId("card").map((el) => el.textContent)

beforeEach(() => {
  sortKey = "name-asc"
  changeSort.mockClear()
  probesRendered.mockClear()
  probeProps = null
  summaries.mockReturnValue([
    summary({ path: "cs101", name: "Alpha" }),
    summary({ path: "cs202", name: "Beta" }),
    summary({ path: "cs303", name: "Gamma" }),
  ])
})

afterEach(cleanup)

describe("ClassroomList student-count sort", () => {
  it("does not render probes (no fan-out) for a non-count sort", () => {
    render(<ClassroomList org="acme" dirs={[dir("cs101")]} />)
    expect(probesRendered).not.toHaveBeenCalled()
  })

  it("renders probes only for the filtered/visible classrooms when sorting by count", () => {
    sortKey = "student-count"
    // Beta is archived; the default "active" filter should exclude it, so no
    // probe (and thus no team-membership fan-out) fires for it.
    summaries.mockReturnValue([
      summary({ path: "cs101", name: "Alpha" }),
      summary({ path: "cs202", name: "Beta", archived: true }),
      summary({ path: "cs303", name: "Gamma" }),
    ])
    render(
      <ClassroomList
        org="acme"
        dirs={[dir("cs101"), dir("cs202"), dir("cs303")]}
      />,
    )
    expect(probeProps?.paths).toEqual(["cs101", "cs303"])
  })

  it("orders by reported count high-to-low, pinning unknown counts to the bottom", () => {
    sortKey = "student-count"
    render(
      <ClassroomList
        org="acme"
        dirs={[dir("cs101"), dir("cs202"), dir("cs303")]}
      />,
    )
    // Report: Alpha=5, Beta=20, Gamma never reports (unknown -> bottom).
    act(() => {
      probeProps?.onCount("cs101", 5)
      probeProps?.onCount("cs202", 20)
    })
    expect(cardNames()).toEqual(["Beta", "Alpha", "Gamma"])
  })

  it("keeps an errored classroom (undefined) in the unknown bucket, not as a real 0", () => {
    sortKey = "student-count"
    render(
      <ClassroomList
        org="acme"
        dirs={[dir("cs101"), dir("cs202"), dir("cs303")]}
      />,
    )
    // Alpha genuinely has 0 students; Gamma errored (reported undefined). A real
    // 0 sorts among known counts (above unknown); the errored one drops to the
    // bottom in name order.
    act(() => {
      probeProps?.onCount("cs101", 0)
      probeProps?.onCount("cs202", 3)
      probeProps?.onCount("cs303", undefined)
    })
    expect(cardNames()).toEqual(["Beta", "Alpha", "Gamma"])
  })
})
