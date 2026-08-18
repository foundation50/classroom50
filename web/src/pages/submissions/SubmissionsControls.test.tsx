// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import SubmissionsControls from "./SubmissionsControls"
import { DEFAULT_FILTERS } from "./dashboard"

const baseProps = {
  query: "",
  onQueryChange: () => {},
  filters: DEFAULT_FILTERS,
  onFiltersChange: () => {},
  sort: "name-first" as const,
  onSortChange: () => {},
}

afterEach(() => cleanup())

describe("SubmissionsControls — always-visible sort/status controls", () => {
  it("renders the Status and Sort selects for a name sort", () => {
    render(<SubmissionsControls {...baseProps} sort="name-first" />)
    expect(
      screen.queryByLabelText("submissions.filters.submissionAria"),
    ).not.toBeNull()
    expect(
      screen.queryByLabelText("submissions.filters.sortAria"),
    ).not.toBeNull()
  })

  it("renders the Status and Sort selects for a time sort too", () => {
    render(<SubmissionsControls {...baseProps} sort="recent" />)
    expect(
      screen.queryByLabelText("submissions.filters.submissionAria"),
    ).not.toBeNull()
    expect(
      screen.queryByLabelText("submissions.filters.sortAria"),
    ).not.toBeNull()
  })

  it("renders the Score (passing) select only when passingAvailable", () => {
    const { rerender } = render(
      <SubmissionsControls {...baseProps} passingAvailable={false} />,
    )
    expect(
      screen.queryByLabelText("submissions.filters.passingAria"),
    ).toBeNull()

    rerender(<SubmissionsControls {...baseProps} passingAvailable={true} />)
    expect(
      screen.queryByLabelText("submissions.filters.passingAria"),
    ).not.toBeNull()
  })

  it("labels the clear affordance 'Clear filter' for a filter and 'Clear' for a search term, hidden otherwise", () => {
    const { rerender } = render(<SubmissionsControls {...baseProps} />)
    expect(screen.queryByText("common.clear")).toBeNull()
    expect(screen.queryByText("common.clearFilter")).toBeNull()

    // A filter active → "Clear filter".
    rerender(
      <SubmissionsControls
        {...baseProps}
        filters={{ ...DEFAULT_FILTERS, submission: "submitted" }}
      />,
    )
    expect(screen.queryByText("common.clearFilter")).not.toBeNull()
    expect(screen.queryByText("common.clear")).toBeNull()

    // Only a search term → "Clear".
    rerender(<SubmissionsControls {...baseProps} query="alice" />)
    expect(screen.queryByText("common.clear")).not.toBeNull()
    expect(screen.queryByText("common.clearFilter")).toBeNull()
  })
})
