// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import type { OpenAllFeedbackPrsSummary } from "@/domain/assignments"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    // Renders the key plus its count so a test can pin which bucket a line
    // reports and how many repos it claims.
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) =>
        opts && "count" in opts ? `${key}:${String(opts.count)}` : key,
    }),
    Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
  }
})

// The modal renders whatever the bulk hook reports; the domain classification
// itself is covered in feedbackPr.test.ts.
const hookState = vi.fn<
  () => {
    mutate: () => void
    isPending: boolean
    data: OpenAllFeedbackPrsSummary | undefined
    progress: null
    reset: () => void
  }
>()
vi.mock("@/hooks/mutations/useOpenAllFeedbackPrs", () => ({
  useOpenAllFeedbackPrs: () => hookState(),
  default: () => hookState(),
}))

import { OpenAllFeedbackPrsModal } from "./OpenAllFeedbackPrsModal"

const summary = (
  over: Partial<OpenAllFeedbackPrsSummary>,
): OpenAllFeedbackPrsSummary => ({
  total: 0,
  created: 0,
  existed: 0,
  incomplete: [],
  unsupported: [],
  blocked: [],
  failed: [],
  results: [],
  ...over,
})

const renderWith = (data: OpenAllFeedbackPrsSummary) => {
  hookState.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
    data,
    progress: null,
    reset: vi.fn(),
  })
  return render(
    <OpenAllFeedbackPrsModal
      open
      onClose={vi.fn()}
      org="acme"
      assignmentName="Homework 1"
      mode="individual"
      repos={["cs-hw-alice", "cs-hw-bob"]}
    />,
  )
}

beforeEach(() => hookState.mockReset())
afterEach(() => cleanup())

describe("OpenAllFeedbackPrsModal summary", () => {
  // Issue #502: a repo whose accept never wrote the setup marker is the
  // student's to fix, so it is listed by name with re-run guidance, apart from
  // a repo that simply isn't there.
  it("lists never-finished repos and counts missing repos separately", () => {
    renderWith(
      summary({
        total: 2,
        incomplete: [
          { repo: "cs-hw-alice", outcome: "incomplete", reason: "no-baseline" },
        ],
        unsupported: [
          {
            repo: "cs-hw-bob",
            outcome: "unsupported",
            reason: "repo-not-found",
          },
        ],
      }),
    )
    expect(
      screen.getByText("submissions.openAllPrs.summaryIncomplete:1"),
    ).toBeTruthy()
    expect(
      screen.getByText("submissions.openAllPrs.summaryUnsupported:1"),
    ).toBeTruthy()
    expect(
      screen.getByText("submissions.openAllPrs.incompleteTitle"),
    ).toBeTruthy()
    expect(screen.getByText("cs-hw-alice")).toBeTruthy()
    // The missing repo is counted but never handed to the teacher as a
    // student action item.
    expect(screen.queryByText("cs-hw-bob")).toBeNull()
  })

  it("omits the never-finished section when every skip is a missing repo", () => {
    renderWith(
      summary({
        total: 1,
        unsupported: [
          {
            repo: "cs-hw-bob",
            outcome: "unsupported",
            reason: "repo-not-found",
          },
        ],
      }),
    )
    expect(
      screen.queryByText("submissions.openAllPrs.summaryIncomplete:0"),
    ).toBeNull()
    expect(
      screen.queryByText("submissions.openAllPrs.incompleteTitle"),
    ).toBeNull()
  })

  it("keeps a transient read failure in the retryable failed list", () => {
    renderWith(
      summary({
        total: 1,
        failed: [
          { repo: "cs-hw-carol", outcome: "failed", reason: "HTTP 500" },
        ],
      }),
    )
    expect(
      screen.getByText("submissions.openAllPrs.summaryFailed:1"),
    ).toBeTruthy()
    expect(screen.getByText("submissions.openAllPrs.failedTitle")).toBeTruthy()
    expect(
      screen.queryByText("submissions.openAllPrs.incompleteTitle"),
    ).toBeNull()
  })
})
