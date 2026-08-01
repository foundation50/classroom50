// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) =>
        opts && "reason" in opts
          ? `${key}:${String(opts.reason)}`
          : opts && "repo" in opts
            ? `${key}:${String(opts.repo)}`
            : key,
    }),
  }
})

// The row's data hooks and the toast provider are stubbed so the test targets
// only ReviewButton's own review/repair branching.
const refetch = vi.fn()
const mutate = vi.fn()
const notify = vi.fn()

vi.mock("@/hooks/useGetFeedbackPr", () => ({
  default: () => ({ refetch }),
}))
vi.mock("@/hooks/mutations/useRepairFeedbackPr", () => ({
  default: () => ({ mutate, isPending: false }),
}))
vi.mock("@/context/notifications/NotificationProvider", () => ({
  useToast: () => ({ notify }),
}))

import { ReviewButton } from "./ReviewButton"

const ORG = "acme"
const REPO = "cs101-hw1-alice"

// Open the empty-PR modal: no open PR -> Review shows the modal with Repair.
async function openRepairModal(user: ReturnType<typeof userEvent.setup>) {
  refetch.mockResolvedValueOnce({ data: null, error: null })
  await user.click(
    screen.getByRole("button", { name: "submissions.table.reviewAria" }),
  )
  await screen.findByText("submissions.reviewModal.emptyTitle")
}

beforeEach(() => {
  refetch.mockReset()
  mutate.mockReset()
  notify.mockReset()
  vi.stubGlobal("open", vi.fn())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("ReviewButton — repair flow", () => {
  it("on a created PR: toasts success, closes, refetches and opens the PR", async () => {
    const user = userEvent.setup()
    // The repair resolves created:true; the follow-up refetch returns the PR.
    mutate.mockImplementation((_vars, opts) =>
      opts.onSuccess({ ok: true, created: true }),
    )
    render(<ReviewButton org={ORG} repo={REPO} mode="individual" />)
    await openRepairModal(user)

    refetch.mockResolvedValueOnce({
      data: { html_url: "https://github.com/acme/cs101-hw1-alice/pull/1" },
    })
    await user.click(screen.getByText("submissions.repairPr.repair"))

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          tone: "success",
          message: `submissions.repairPr.created:${REPO}`,
        }),
      ),
    )
    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith(
        "https://github.com/acme/cs101-hw1-alice/pull/1",
        "_blank",
        "noopener,noreferrer",
      ),
    )
  })

  it("on an already-existing PR: toasts alreadyExists (created:false)", async () => {
    const user = userEvent.setup()
    mutate.mockImplementation((_vars, opts) =>
      opts.onSuccess({ ok: true, created: false }),
    )
    render(<ReviewButton org={ORG} repo={REPO} mode="individual" />)
    await openRepairModal(user)

    refetch.mockResolvedValueOnce({ data: null })
    await user.click(screen.getByText("submissions.repairPr.repair"))

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          message: `submissions.repairPr.alreadyExists:${REPO}`,
        }),
      ),
    )
  })

  it("maps an unsupported no-baseline verdict to terminal modal copy", async () => {
    const user = userEvent.setup()
    mutate.mockImplementation((_vars, opts) =>
      opts.onSuccess({ ok: false, reason: "no-baseline", unsupported: true }),
    )
    render(<ReviewButton org={ORG} repo={REPO} mode="individual" />)
    await openRepairModal(user)

    await user.click(screen.getByText("submissions.repairPr.repair"))

    expect(
      await screen.findByText("submissions.repairPr.noBaseline"),
    ).toBeTruthy()
    // Repair button is hidden once an error message is shown.
    expect(screen.queryByText("submissions.repairPr.repair")).toBeNull()
    expect(notify).not.toHaveBeenCalled()
  })

  it("maps a repo-not-found verdict to terminal modal copy", async () => {
    const user = userEvent.setup()
    mutate.mockImplementation((_vars, opts) =>
      opts.onSuccess({
        ok: false,
        reason: "repo-not-found",
        unsupported: true,
      }),
    )
    render(<ReviewButton org={ORG} repo={REPO} mode="individual" />)
    await openRepairModal(user)

    await user.click(screen.getByText("submissions.repairPr.repair"))

    expect(
      await screen.findByText(`submissions.repairPr.repoNotFound:${REPO}`),
    ).toBeTruthy()
  })

  it("maps a blocked base-mismatch code to terminal modal copy (not retryable)", async () => {
    const user = userEvent.setup()
    mutate.mockImplementation((_vars, opts) =>
      opts.onSuccess({
        ok: false,
        reason: "feedback branch is at X, not the baseline",
        code: "base-mismatch",
      }),
    )
    render(<ReviewButton org={ORG} repo={REPO} mode="individual" />)
    await openRepairModal(user)

    await user.click(screen.getByText("submissions.repairPr.repair"))

    expect(
      await screen.findByText("submissions.repairPr.baseMismatch"),
    ).toBeTruthy()
  })

  it("maps a transient failure to the retryable failed copy with the reason", async () => {
    const user = userEvent.setup()
    mutate.mockImplementation((_vars, opts) =>
      opts.onSuccess({ ok: false, reason: "GitHub 500", code: "transient" }),
    )
    render(<ReviewButton org={ORG} repo={REPO} mode="individual" />)
    await openRepairModal(user)

    await user.click(screen.getByText("submissions.repairPr.repair"))

    expect(
      await screen.findByText("submissions.repairPr.failed:GitHub 500"),
    ).toBeTruthy()
  })

  it("surfaces an unexpected mutation error in the modal", async () => {
    const user = userEvent.setup()
    mutate.mockImplementation((_vars, opts) =>
      opts.onError(new Error("network down")),
    )
    render(<ReviewButton org={ORG} repo={REPO} mode="individual" />)
    await openRepairModal(user)

    await user.click(screen.getByText("submissions.repairPr.repair"))

    expect(await screen.findByText("network down")).toBeTruthy()
  })
})
