// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

// Assert on stable i18n keys, not English copy. Trans renders its key so the
// link-bearing message is still findable.
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, string>) =>
        opts ? `${key}:${JSON.stringify(opts)}` : key,
    }),
    Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
  }
})

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    Link: ({ children }: { children?: React.ReactNode }) => (
      <a href="#rerun-org-setup">{children}</a>
    ),
  }
})

import ServiceTokenTestResult from "./ServiceTokenTestResult"
import { ProbeWorkflowMissingError } from "@/github-core/mutations"

type State = Parameters<typeof ServiceTokenTestResult>[0]["state"]

const run = {
  id: 77,
  html_url: "https://github.com/acme/classroom50/actions/runs/77",
} as unknown as NonNullable<State["run"]>

const state = (over: Partial<State>): State =>
  ({
    test: vi.fn(),
    phase: "idle",
    failure: null,
    run: undefined,
    error: null,
    inFlight: false,
    annotations: undefined,
    ...over,
  }) as State

afterEach(cleanup)

describe("ServiceTokenTestResult", () => {
  it("renders nothing before a result exists (the button and banner carry progress)", () => {
    for (const phase of ["idle", "dispatching", "running"] as const) {
      const { container } = render(
        <ServiceTokenTestResult state={state({ phase, inFlight: true })} />,
      )
      expect(container.innerHTML).toBe("")
      cleanup()
    }
  })

  it("shows the pass verdict with a link to the run", () => {
    render(
      <ServiceTokenTestResult
        state={state({ phase: "completed", run, annotations: [] })}
      />,
    )
    expect(
      screen.getByText("orgSettings.serviceToken.test.passed"),
    ).toBeTruthy()
    expect(
      screen.getByRole("link", { name: /viewRun/ }).getAttribute("href"),
    ).toBe(run.html_url)
  })

  it("lists the probe's failure annotations and what to do next", () => {
    render(
      <ServiceTokenTestResult
        state={state({
          phase: "failed",
          failure: "run",
          run,
          annotations: [
            { level: "notice", message: "ignored" },
            { level: "failure", message: "probe FAILED: Members: Read" },
          ],
        })}
      />,
    )
    expect(screen.getByRole("alert")).toBeTruthy()
    expect(
      screen.getByText("orgSettings.serviceToken.test.failedTitle"),
    ).toBeTruthy()
    expect(screen.getByText("probe FAILED: Members: Read")).toBeTruthy()
    expect(screen.queryByText("ignored")).toBeNull()
    expect(
      screen.getByText("orgSettings.serviceToken.test.failedNext"),
    ).toBeTruthy()
  })

  it("says the details are loading, then falls back when the run emitted none", () => {
    render(
      <ServiceTokenTestResult
        state={state({ phase: "failed", failure: "run", run })}
      />,
    )
    expect(
      screen.getByText("orgSettings.serviceToken.test.failedLoading"),
    ).toBeTruthy()
    cleanup()

    render(
      <ServiceTokenTestResult
        state={state({ phase: "failed", failure: "run", run, annotations: [] })}
      />,
    )
    expect(
      screen.getByText("orgSettings.serviceToken.test.failedNoDetails"),
    ).toBeTruthy()
  })

  it("points an org without the workflow at the setup section", () => {
    render(
      <ServiceTokenTestResult
        state={state({
          phase: "failed",
          failure: "dispatch",
          error: new ProbeWorkflowMissingError(new Error("404")),
        })}
      />,
    )
    expect(
      screen.getByText("orgSettings.serviceToken.test.workflowMissing"),
    ).toBeTruthy()
    // A missing workflow is a setup gap, not an error the teacher caused.
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("names the reason when the dispatch itself was rejected", () => {
    render(
      <ServiceTokenTestResult
        state={state({
          phase: "failed",
          failure: "dispatch",
          error: new Error("Forbidden"),
        })}
      />,
    )
    expect(screen.getByRole("alert").textContent).toContain(
      "orgSettings.serviceToken.test.startFailed",
    )
  })

  it("keeps the run link on a timeout", () => {
    render(<ServiceTokenTestResult state={state({ phase: "timeout", run })} />)
    expect(
      screen.getByText("orgSettings.serviceToken.test.timeout"),
    ).toBeTruthy()
    expect(screen.getByRole("link", { name: /viewRun/ })).toBeTruthy()
  })
})
