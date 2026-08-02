// @vitest-environment happy-dom
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

const mutateAsync = vi.fn()
vi.mock("@/hooks/mutations/useSetRepoFeatures", () => ({
  default: () => ({ mutateAsync }),
  useSetRepoFeatures: () => ({ mutateAsync }),
}))

import { BulkRepoFeaturesModal } from "./BulkRepoFeaturesModal"
import { GitHubAPIError } from "@/github-core/errors"

function apiError(status: number): GitHubAPIError {
  return new GitHubAPIError({
    status,
    url: "/repos/o/cs-hw1-bob",
    message: `HTTP ${status}`,
    body: null,
    rateLimit: {
      limit: null,
      remaining: null,
      used: null,
      reset: null,
      resource: null,
      retryAfter: null,
    },
  })
}

afterEach(() => {
  cleanup()
  mutateAsync.mockReset()
})

function renderModal(owners: string[]) {
  return render(
    <BulkRepoFeaturesModal
      open
      onClose={() => {}}
      org="o"
      classroom="cs"
      assignment="hw1"
      owners={owners}
    />,
  )
}

const applyBtn = "submissions.bulkFeatures.apply"

describe("BulkRepoFeaturesModal", () => {
  it("disables Apply until a feature is set to on/off", () => {
    renderModal(["alice", "bob"])
    const apply = screen.getByText(applyBtn).closest("button")!
    expect(apply.disabled).toBe(true)

    // Set Issues -> On.
    const issues = screen
      .getByText("assignments.form.repoFeatures.issues.label")
      .closest("label")!
      .querySelector("select")!
    fireEvent.change(issues, { target: { value: "on" } })
    expect(apply.disabled).toBe(false)
  })

  it("sends only the selected keys and reports success across all repos", async () => {
    mutateAsync.mockResolvedValue(undefined)
    renderModal(["alice", "bob"])
    const wiki = screen
      .getByText("assignments.form.repoFeatures.wiki.label")
      .closest("label")!
      .querySelector("select")!
    fireEvent.change(wiki, { target: { value: "off" } })
    fireEvent.click(screen.getByText(applyBtn))

    await waitFor(() =>
      expect(
        screen.getByText("submissions.bulkFeatures.resultHeadline"),
      ).toBeTruthy(),
    )
    expect(mutateAsync).toHaveBeenCalledTimes(2)
    // Only the wiki key is sent (has_wiki:false); other keys omitted.
    expect(mutateAsync).toHaveBeenCalledWith({
      org: "o",
      repo: "cs-hw1-alice",
      features: { has_wiki: false },
    })
  })

  it("fails open per repo: one repo's error is reported, the rest still apply", async () => {
    mutateAsync
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(apiError(422))
    renderModal(["alice", "bob"])
    const issues = screen
      .getByText("assignments.form.repoFeatures.issues.label")
      .closest("label")!
      .querySelector("select")!
    fireEvent.change(issues, { target: { value: "on" } })
    fireEvent.click(screen.getByText(applyBtn))

    await waitFor(() =>
      expect(
        screen.getByText("submissions.bulkFeatures.failedSection"),
      ).toBeTruthy(),
    )
    expect(mutateAsync).toHaveBeenCalledTimes(2)
  })
})
