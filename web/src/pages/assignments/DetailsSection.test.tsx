// @vitest-environment happy-dom
import { createElement, type PropsWithChildren } from "react"
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { TFunction } from "i18next"

// Echo the i18n key so assertions match on stable keys; preserve the rest of
// react-i18next (initReactI18next) so the i18n bootstrap import chain works.
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

const useOptionalGitHubClient = vi.fn<() => { request: () => void } | null>(
  () => ({ request: vi.fn() }),
)
vi.mock("@/context/github/GitHubProvider", () => ({
  useOptionalGitHubClient: () => useOptionalGitHubClient(),
}))

import { RepoFeatureControls } from "./sections/RepositorySetupSection"
import { useAssignmentForm } from "./assignmentFormModel"

const t = ((key: string) => key) as unknown as TFunction

// Mount RepoFeatureControls with a real assignment form so form.Field /
// form.Subscribe behave as in production.
function Harness({
  templateRepo,
  emptyRepo = false,
  edit = false,
  org,
}: {
  templateRepo: string
  emptyRepo?: boolean
  edit?: boolean
  org?: string
}) {
  const form = useAssignmentForm(undefined, () => {}, t)
  return (
    <RepoFeatureControls
      form={form}
      edit={edit}
      org={org}
      templateRepo={templateRepo}
      emptyRepo={emptyRepo}
    />
  )
}

function renderControls(props: {
  templateRepo: string
  emptyRepo?: boolean
  edit?: boolean
  org?: string
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  return render(createElement(Harness, props), { wrapper })
}

afterEach(() => {
  cleanup()
  getRepo.mockReset()
  useOptionalGitHubClient.mockReturnValue({ request: vi.fn() })
})

const inheritKey = "assignments.form.repoFeatures.choices.inherit"
const inheritOnKey = "assignments.form.repoFeatures.choices.inheritOn"
const inheritOffKey = "assignments.form.repoFeatures.choices.inheritOff"
const loadingKey = "assignments.form.repoFeatures.choices.inheritLoading"
const defaultKey = "assignments.form.repoFeatures.choices.default"

// The Inherit <option> for a feature select, located by the select's stable id
// (field.name), e.g. "repo_feature_issues".
function inheritOption(
  container: HTMLElement,
  fieldName: string,
): HTMLOptionElement {
  const select = container.querySelector<HTMLSelectElement>(`#${fieldName}`)!
  return Array.from(select.options).find(
    (o) => o.value === "inherit",
  ) as HTMLOptionElement
}

describe("RepoFeatureControls — inherit label resolution", () => {
  it("resolves the inherit label to On/Off from the template's live flags", async () => {
    getRepo.mockResolvedValue({
      has_issues: true,
      has_wiki: false,
      has_projects: true,
      has_pull_requests: false,
    })
    const { container } = renderControls({ templateRepo: "org/template" })

    await waitFor(() => {
      expect(inheritOption(container, "repo_feature_issues").textContent).toBe(
        inheritOnKey,
      )
    })
    expect(inheritOption(container, "repo_feature_wiki").textContent).toBe(
      inheritOffKey,
    )
    expect(inheritOption(container, "repo_feature_projects").textContent).toBe(
      inheritOnKey,
    )
    expect(
      inheritOption(container, "repo_feature_pull_requests").textContent,
    ).toBe(inheritOffKey)
  })

  it("shows a plain Inherit label and does not query without a client", () => {
    useOptionalGitHubClient.mockReturnValue(null)
    const { container } = renderControls({ templateRepo: "org/template" })
    expect(getRepo).not.toHaveBeenCalled()
    expect(inheritOption(container, "repo_feature_issues").textContent).toBe(
      inheritKey,
    )
  })

  it("resolves a bare repo name against the org and reads the template", async () => {
    // Regression: a bare "my-template" (no owner) used to leave the read
    // disabled. It now resolves to <org>/my-template like the Template field.
    getRepo.mockResolvedValue({ has_issues: true })
    const { container } = renderControls({
      templateRepo: "test-template-3branch",
      org: "acme",
    })
    await waitFor(() =>
      expect(getRepo).toHaveBeenCalledWith(
        expect.anything(),
        "acme",
        "test-template-3branch",
      ),
    )
    await waitFor(() =>
      expect(inheritOption(container, "repo_feature_issues").textContent).toBe(
        inheritOnKey,
      ),
    )
  })

  it("shows the Default label and does not query when the org is unknown", () => {
    const { container } = renderControls({
      templateRepo: "test-template-3branch",
      org: undefined,
    })
    expect(getRepo).not.toHaveBeenCalled()
    // A bare name can't resolve without an org, so the default choice is
    // "Default" (no override) rather than an inherit label.
    expect(inheritOption(container, "repo_feature_issues").textContent).toBe(
      defaultKey,
    )
  })

  it("shows the Default label and does not query for an empty_repo assignment", () => {
    const { container } = renderControls({
      templateRepo: "org/template",
      emptyRepo: true,
    })
    expect(getRepo).not.toHaveBeenCalled()
    // An empty_repo assignment is never templated, so the default choice is
    // "Default" (no override) even though a template ref is present in state.
    expect(inheritOption(container, "repo_feature_issues").textContent).toBe(
      defaultKey,
    )
  })
})

describe("RepoFeatureControls — loading + refresh", () => {
  it("disables selects and shows the loading label while fetching, then a refresh refetches", async () => {
    let resolve: (v: unknown) => void = () => {}
    getRepo.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const { container } = renderControls({ templateRepo: "org/template" })

    // While the initial fetch is in flight: loading label + disabled select.
    await waitFor(() => {
      expect(inheritOption(container, "repo_feature_issues").textContent).toBe(
        loadingKey,
      )
    })
    const issuesSelect = container.querySelector<HTMLSelectElement>(
      "#repo_feature_issues",
    )!
    expect(issuesSelect.disabled).toBe(true)

    resolve({ has_issues: true })
    await waitFor(() => {
      expect(inheritOption(container, "repo_feature_issues").textContent).toBe(
        inheritOnKey,
      )
    })
    expect(getRepo).toHaveBeenCalledTimes(1)

    // The refresh button refetches the template's flags.
    fireEvent.click(
      screen.getByLabelText("assignments.form.repoFeatures.refresh"),
    )
    await waitFor(() => expect(getRepo).toHaveBeenCalledTimes(2))
  })

  it("falls back to a plain Inherit label when the template read fails", async () => {
    getRepo.mockRejectedValue(new Error("boom"))
    const { container } = renderControls({ templateRepo: "org/template" })
    await waitFor(() =>
      expect(inheritOption(container, "repo_feature_issues").textContent).toBe(
        inheritKey,
      ),
    )
  })
})

describe("RepoFeatureControls — override warning", () => {
  const templateWarningKey = "assignments.form.repoFeatures.overrideTemplate"
  const noTemplateWarningKey =
    "assignments.form.repoFeatures.overrideNoTemplate"
  const existingWarningKey = "assignments.form.repoFeatures.overrideExisting"

  const forceIssuesOff = (container: HTMLElement) => {
    const issuesSelect = container.querySelector<HTMLSelectElement>(
      "#repo_feature_issues",
    )!
    fireEvent.change(issuesSelect, { target: { value: "off" } })
  }

  it("hides the override warning while every feature is on Inherit", () => {
    renderControls({ templateRepo: "org/template" })
    expect(screen.queryByText(templateWarningKey)).toBeNull()
    expect(screen.queryByText(noTemplateWarningKey)).toBeNull()
  })

  it("shows the template-default warning once a feature is forced, with a template", () => {
    const { container } = renderControls({ templateRepo: "org/template" })
    forceIssuesOff(container)
    expect(screen.getByText(templateWarningKey)).toBeTruthy()
    // No template-less copy, and no edit-only "update existing" line on create.
    expect(screen.queryByText(noTemplateWarningKey)).toBeNull()
    expect(screen.queryByText(existingWarningKey)).toBeNull()
  })

  it("shows the no-template default warning when there is no template", () => {
    const { container } = renderControls({ templateRepo: "" })
    forceIssuesOff(container)
    expect(screen.getByText(noTemplateWarningKey)).toBeTruthy()
    expect(screen.queryByText(templateWarningKey)).toBeNull()
  })

  it("adds the update-existing line only in edit mode", () => {
    const { container } = renderControls({ templateRepo: "", edit: true })
    forceIssuesOff(container)
    expect(screen.getByText(existingWarningKey, { exact: false })).toBeTruthy()
  })
})
