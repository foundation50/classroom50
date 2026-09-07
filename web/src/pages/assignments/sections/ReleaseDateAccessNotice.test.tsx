// @vitest-environment happy-dom
import { createElement, type PropsWithChildren } from "react"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { TFunction } from "i18next"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

const getRepo = vi.fn()
vi.mock("@/github-core/repoReads", () => ({
  getRepo: (...args: unknown[]) => getRepo(...args),
}))

vi.mock("@/context/github/GitHubProvider", () => ({
  useOptionalGitHubClient: () => ({ request: vi.fn() }),
}))

import { ReleaseDateAccessNotice } from "./ReleaseDateAccessNotice"
import {
  useAssignmentForm,
  type CreateAssignmentFormValues,
} from "../assignmentFormModel"

const t = ((key: string) => key) as unknown as TFunction
const ORG = "cs50"
const TITLE_KEY = "assignments.form.releaseTemplateReadableTitle"
const REMINDER_KEY = "assignments.form.releaseLockedReminder"
const LOCK_KEY = "assignments.form.lockAssignment"

// A datetime-local value one day out, so the release date is in the future
// regardless of when the suite runs.
const tomorrowLocal = () => {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const YESTERDAY_LOCAL = "2020-01-01T09:00"

function Harness({
  defaults,
}: {
  defaults: Partial<CreateAssignmentFormValues>
}) {
  const form = useAssignmentForm(defaults, () => {}, t)
  return (
    <>
      <ReleaseDateAccessNotice form={form} org={ORG} />
      {/* Expose the form's lock state so tests can assert the inline action
          actually wrote it. */}
      <form.Subscribe selector={(s) => s.values.locked}>
        {(locked) => <output data-testid="locked">{String(locked)}</output>}
      </form.Subscribe>
    </>
  )
}

function renderNotice(defaults: Partial<CreateAssignmentFormValues>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  return render(createElement(Harness, { defaults }), { wrapper })
}

const privateInOrg = {
  repo_source: "template",
  template_repo: `${ORG}/hw1-template`,
  available_from_date: tomorrowLocal(),
} satisfies Partial<CreateAssignmentFormValues>

afterEach(() => {
  cleanup()
  getRepo.mockReset()
})

describe("ReleaseDateAccessNotice", () => {
  it("warns when an unlocked private in-org template has a future release date", async () => {
    getRepo.mockResolvedValue({ private: true })
    renderNotice(privateInOrg)
    expect(await screen.findByText(TITLE_KEY)).toBeTruthy()
    expect(screen.queryByText(REMINDER_KEY)).toBeNull()
  })

  it("locks the assignment from the inline action", async () => {
    getRepo.mockResolvedValue({ private: true })
    renderNotice(privateInOrg)
    fireEvent.click(await screen.findByText(LOCK_KEY))
    expect(screen.getByTestId("locked").textContent).toBe("true")
    // The warning gives way to the unlock reminder.
    expect(await screen.findByText(REMINDER_KEY)).toBeTruthy()
    expect(screen.queryByText(TITLE_KEY)).toBeNull()
  })

  it("shows the unlock reminder when already locked", async () => {
    getRepo.mockResolvedValue({ private: true })
    renderNotice({ ...privateInOrg, locked: true })
    expect(await screen.findByText(REMINDER_KEY)).toBeTruthy()
    expect(screen.queryByText(TITLE_KEY)).toBeNull()
  })

  it("stays silent when the release date has passed", async () => {
    getRepo.mockResolvedValue({ private: true })
    renderNotice({ ...privateInOrg, available_from_date: YESTERDAY_LOCAL })
    await Promise.resolve()
    expect(screen.queryByText(TITLE_KEY)).toBeNull()
    expect(getRepo).not.toHaveBeenCalled()
  })

  it("stays silent without a release date", async () => {
    getRepo.mockResolvedValue({ private: true })
    renderNotice({ ...privateInOrg, available_from_date: "" })
    await Promise.resolve()
    expect(screen.queryByText(TITLE_KEY)).toBeNull()
    expect(getRepo).not.toHaveBeenCalled()
  })

  it("stays silent for a public template (nothing to lock away)", async () => {
    getRepo.mockResolvedValue({ private: false })
    renderNotice(privateInOrg)
    await vi.waitFor(() => expect(getRepo).toHaveBeenCalled())
    expect(screen.queryByText(TITLE_KEY)).toBeNull()
  })

  it("stays silent for a private template outside the org (no team grant)", async () => {
    getRepo.mockResolvedValue({ private: true })
    renderNotice({ ...privateInOrg, template_repo: "other-org/hw1-template" })
    await vi.waitFor(() => expect(getRepo).toHaveBeenCalled())
    expect(screen.queryByText(TITLE_KEY)).toBeNull()
  })

  it("stays silent when the assignment has no template source", async () => {
    getRepo.mockResolvedValue({ private: true })
    renderNotice({ ...privateInOrg, repo_source: "none" })
    await Promise.resolve()
    expect(screen.queryByText(TITLE_KEY)).toBeNull()
    expect(getRepo).not.toHaveBeenCalled()
  })
})
