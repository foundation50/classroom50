// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { clearActivity, recordError } from "@/lib/activity/activityStore"

// RequireTeacher and PageShell pull in router/query context; stub them so this
// test focuses on the page's activity rendering.
vi.mock("@/components/RequireTeacher", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/PageShell", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ org: "acme" }),
}))
vi.mock("@/hooks/useDocumentTitle", () => ({ useDocumentTitle: () => {} }))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import OrgActivityPage from "./OrgActivityPage"

afterEach(() => {
  cleanup()
  clearActivity()
})

describe("OrgActivityPage", () => {
  it("shows the empty state when the org has no activity", () => {
    render(<OrgActivityPage />)
    expect(screen.getByText("orgActivity.empty.title")).toBeTruthy()
  })

  it("renders error entries for the org with status and request id", () => {
    recordError(new Error("Create classroom failed"), { org: "acme" })
    render(<OrgActivityPage />)
    expect(screen.getByText("Create classroom failed")).toBeTruthy()
  })

  it("does not show another org's activity", () => {
    recordError(new Error("other org failure"), { org: "different" })
    render(<OrgActivityPage />)
    expect(screen.queryByText("other org failure")).toBeNull()
    expect(screen.getByText("orgActivity.empty.title")).toBeTruthy()
  })
})
