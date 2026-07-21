// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { SubmissionsActionsMenu } from "./SubmissionsActionsMenu"

const baseProps = {
  collecting: false,
  regrading: false,
  regradeAllActive: false,
  emptyRoster: false,
  onCollect: () => {},
  onRegradeAll: () => {},
  viewHref: "https://example.test/run",
  viewLabel: "submissions.menu.viewWorkflow",
  onDownloadCsv: () => {},
  downloadDisabled: false,
}

afterEach(() => cleanup())

describe("SubmissionsActionsMenu — canRegradeAll gate", () => {
  it("shows Regrade all when the viewer may batch-regrade", () => {
    render(<SubmissionsActionsMenu {...baseProps} canRegradeAll={true} />)
    expect(screen.queryByText("submissions.regradeAll.label")).not.toBeNull()
    // Collect stays available regardless (all-staff action).
    expect(screen.queryByText("submissions.collect.label")).not.toBeNull()
  })

  it("hides Regrade all for a viewer who can't (TA), keeping Collect", () => {
    render(<SubmissionsActionsMenu {...baseProps} canRegradeAll={false} />)
    expect(screen.queryByText("submissions.regradeAll.label")).toBeNull()
    expect(screen.queryByText("submissions.collect.label")).not.toBeNull()
  })

  it("defaults to showing Regrade all when the prop is omitted", () => {
    render(<SubmissionsActionsMenu {...baseProps} />)
    expect(screen.queryByText("submissions.regradeAll.label")).not.toBeNull()
  })
})
