// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ProvenanceBadge } from "./ProvenanceBadge"

// Echo the interpolation options so the assertions can see which login or
// reason each title was built from, not only which key.
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) =>
        opts ? `${key}:${JSON.stringify(opts)}` : key,
    }),
  }
})

afterEach(cleanup)

const badge = () => screen.getByText("submissions.table.unverified")

describe("ProvenanceBadge", () => {
  it("renders nothing for a workflow-published release", () => {
    const { container } = render(<ProvenanceBadge provenance={undefined} />)
    expect(container.firstChild).toBeNull()
  })

  it("shows the collector's stored reason as data", () => {
    const reason = "published by 'alice', not by the autograde workflow"
    render(<ProvenanceBadge provenance={{ kind: "recorded", reason }} />)
    expect(badge().getAttribute("title")).toBe(
      `submissions.table.unverifiedRecordedTitle:${JSON.stringify({ reason })}`,
    )
  })

  it("names the author of a live hand-published release", () => {
    render(<ProvenanceBadge provenance={{ kind: "author", login: "alice" }} />)
    expect(badge().getAttribute("title")).toBe(
      `submissions.table.unverifiedAuthorTitle:${JSON.stringify({ login: "alice" })}`,
    )
  })

  it("names the uploader of a replaced result.json", () => {
    render(
      <ProvenanceBadge provenance={{ kind: "uploader", login: "alice" }} />,
    )
    expect(badge().getAttribute("title")).toBe(
      `submissions.table.unverifiedUploaderTitle:${JSON.stringify({ login: "alice" })}`,
    )
  })

  it("falls back to the unknown-account phrase when GitHub reported no login", () => {
    render(<ProvenanceBadge provenance={{ kind: "uploader", login: null }} />)
    expect(badge().getAttribute("title")).toContain(
      "submissions.table.unverifiedUnknownAccount",
    )
  })
})
