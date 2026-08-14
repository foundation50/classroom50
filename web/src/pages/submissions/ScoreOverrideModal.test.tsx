// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        if (opts && "max" in opts && "score" in opts)
          return `${key}:${String(opts.score)}/${String(opts.max)}`
        if (opts && "max" in opts) return `${key}:${String(opts.max)}`
        if (opts && "name" in opts) return `${key}:${String(opts.name)}`
        return key
      },
    }),
  }
})

const mutate = vi.fn()
let isPending = false
let isError = false
let variables: Record<string, unknown> | undefined
const reset = vi.fn()

vi.mock("@/hooks/mutations/useSetScoreOverride", () => ({
  useSetScoreOverride: () => ({ mutate, isPending, isError, reset, variables }),
}))

// happy-dom's <dialog> doesn't implement showModal/close natively.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.open = true
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false
  })
})

import { ScoreOverrideModal } from "./ScoreOverrideModal"

const autoCtx = {
  org: "acme",
  classroom: "cs50",
  assignment: "hw1",
  assignmentType: "individual" as const,
  maxPoints: 50,
  mode: "auto" as const,
}

beforeEach(() => {
  mutate.mockReset()
  reset.mockReset()
  isPending = false
  isError = false
  variables = undefined
})
afterEach(cleanup)

function renderModal(
  props?: Partial<Parameters<typeof ScoreOverrideModal>[0]>,
) {
  return render(
    <ScoreOverrideModal
      open
      onClose={vi.fn()}
      owner="alice"
      hasGrade
      score={30}
      max={50}
      overridden={false}
      thresholdFraction={null}
      ctx={autoCtx}
      {...props}
    />,
  )
}

describe("ScoreOverrideModal", () => {
  it("blocks save on an out-of-range value and doesn't mutate", async () => {
    const user = userEvent.setup()
    renderModal()
    const input = screen.getByRole("spinbutton")
    await user.clear(input)
    await user.type(input, "99")
    expect(screen.getByRole("alert").textContent).toBe(
      "submissions.scoreOverride.range:50",
    )
    const save = screen.getByRole("button", {
      name: "submissions.scoreOverride.save",
    })
    expect(save.hasAttribute("disabled")).toBe(true)
    await user.click(save)
    expect(mutate).not.toHaveBeenCalled()
  })

  it("saves a valid score with the override context", async () => {
    const user = userEvent.setup()
    renderModal()
    const input = screen.getByRole("spinbutton")
    await user.clear(input)
    await user.type(input, "40")
    await user.click(
      screen.getByRole("button", { name: "submissions.scoreOverride.save" }),
    )
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate.mock.calls[0][0]).toMatchObject({
      org: "acme",
      classroom: "cs50",
      assignment: "hw1",
      owner: "alice",
      score: 40,
      maxPoints: 50,
    })
  })

  it("shows a Clear override action only when overridden, and clears", async () => {
    const user = userEvent.setup()
    const { rerender } = renderModal({ overridden: false })
    expect(
      screen.queryByRole("button", {
        name: "submissions.scoreOverride.clearLabel:alice",
      }),
    ).toBeNull()

    rerender(
      <ScoreOverrideModal
        open
        onClose={vi.fn()}
        owner="alice"
        hasGrade
        score={42}
        max={50}
        overridden
        autogradedScore={30}
        autogradedMax={50}
        thresholdFraction={null}
        ctx={autoCtx}
      />,
    )
    await user.click(
      screen.getByRole("button", {
        name: "submissions.scoreOverride.clearLabel:alice",
      }),
    )
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate.mock.calls[0][0]).toMatchObject({
      owner: "alice",
      clear: true,
    })
  })

  it("surfaces the preserved autograded score for an overridden auto row", () => {
    renderModal({
      overridden: true,
      score: 42,
      max: 50,
      autogradedScore: 30,
      autogradedMax: 50,
    })
    expect(
      screen.getByText("submissions.scoreOverride.currentAutograded"),
    ).toBeTruthy()
    expect(screen.getByText("30/50")).toBeTruthy()
  })

  it("surfaces the correct error copy for a failed clear", () => {
    isError = true
    variables = { clear: true }
    renderModal({ overridden: true, autogradedScore: 30, autogradedMax: 50 })
    expect(
      screen.getByText("submissions.scoreOverride.clearError"),
    ).toBeTruthy()
  })

  it("fires mutate only once when Enter is pressed twice before settling", async () => {
    // The mocked mutate never resolves (no onSettled), so inFlightRef stays set
    // after the first submit — a second Enter must not fire a second write.
    const user = userEvent.setup()
    renderModal()
    const input = screen.getByRole("spinbutton")
    await user.clear(input)
    await user.type(input, "30{Enter}{Enter}")
    expect(mutate).toHaveBeenCalledTimes(1)
  })
})
