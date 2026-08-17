// @vitest-environment happy-dom
import { describe, expect, it, afterEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { I18nextProvider } from "react-i18next"
import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import en from "@/locales/en.json"
import {
  ImportBlockedReport,
  ImportSkippedReport,
} from "./ImportProblemsReport"
import { classifyImportProblems } from "./importProblems"

afterEach(cleanup)

// A real i18n instance with the SHIPPED strings: the per-line sentences are
// rendered through <Trans> with a <v> tag, so a mismatch between the markup here
// and the tag in en.json would silently drop the offending value from the report —
// the one thing a teacher needs to find the row.
await i18n.use(initReactI18next).init({
  lng: "en",
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
})

const renderReport = (problems: ReturnType<typeof classifyImportProblems>) =>
  render(
    <I18nextProvider i18n={i18n}>
      <ImportBlockedReport
        problems={problems}
        onRetry={() => {}}
        onCancel={() => {}}
      />
    </I18nextProvider>,
  )

describe("ImportBlockedReport", () => {
  it("names the line and quotes the offending value", () => {
    renderReport(
      classifyImportProblems(
        [{ line: 4, reason: "bad-email", value: "n/a" }],
        [],
      ),
    )
    expect(screen.getByText(/Line 4/)).toBeTruthy()
    expect(screen.getByText("n/a")).toBeTruthy()
  })

  it("isolates the value as LTR monospace, not the whole sentence", () => {
    // MonoLtr is for the identifier only: applying it to the sentence would break
    // ordering in an RTL locale.
    renderReport(
      classifyImportProblems(
        [{ line: 2, reason: "bad-username", value: "-bad-" }],
        [],
      ),
    )
    const value = screen.getByText("-bad-")
    expect(value.getAttribute("dir")).toBe("ltr")
    expect(value.className).toContain("font-mono")
    expect(value.textContent).toBe("-bad-")
  })

  it("renders a valueless problem without an empty markup tag", () => {
    renderReport(
      classifyImportProblems([{ line: 7, reason: "incomplete" }], []),
    )
    const item = screen.getByRole("listitem")
    expect(item.textContent).toContain("Line 7")
    expect(item.textContent).not.toContain("<v>")
    expect(item.querySelector("[dir=ltr]")).toBeNull()
  })

  it("counts only the blocking problems in its heading", () => {
    // An incomplete row is listed so one editing pass sees everything, but it is
    // not why the import stopped, so it must not inflate the count.
    renderReport(
      classifyImportProblems(
        [
          { line: 2, reason: "bad-email", value: "n/a" },
          { line: 3, reason: "incomplete" },
        ],
        [],
      ),
    )
    expect(screen.getAllByRole("listitem")).toHaveLength(2)
    expect(screen.getByText(/^1 row can't be imported/)).toBeTruthy()
  })

  it("keeps a value containing angle brackets visible", () => {
    // <Trans> parses the interpolated sentence as markup, so an unstripped `<`
    // swallows the rest of the value — hiding the very thing the teacher needs to
    // find the row. `Ada <ada@uni.edu>` would otherwise display as `Ada`.
    renderReport(
      classifyImportProblems(
        [{ line: 2, reason: "bad-email", value: "Ada <ada@uni.edu>" }],
        [],
      ),
    )
    const item = screen.getByRole("listitem")
    expect(item.textContent).toContain("ada@uni.edu")
    expect(item.querySelector("strong")).toBeNull()
  })

  it("offers a retry, not a file edit, when every blocker is transient", () => {
    // The file is fine — GitHub could not be reached — so "fix these lines and
    // upload again" would send the teacher to edit nothing.
    const onRetry = vi.fn()
    render(
      <I18nextProvider i18n={i18n}>
        <ImportBlockedReport
          problems={classifyImportProblems(
            [],
            [{ line: 2, reason: "id-lookup-failed", githubId: "999" }],
          )}
          onRetry={onRetry}
          onCancel={() => {}}
        />
      </I18nextProvider>,
    )
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy()
    expect(screen.queryByText(en.students.importBlockedHint)).toBeNull()
  })

  it("keeps the fix-the-file hint when a blocker is file content", () => {
    renderReport(
      classifyImportProblems(
        [{ line: 2, reason: "bad-email", value: "n/a" }],
        [{ line: 3, reason: "id-lookup-failed", githubId: "999" }],
      ),
    )
    expect(screen.getByText(en.students.importBlockedHint)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull()
  })
})

describe("ImportSkippedReport", () => {
  const renderSkipped = (problems: ReturnType<typeof classifyImportProblems>) =>
    render(
      <I18nextProvider i18n={i18n}>
        <ImportSkippedReport problems={problems} />
      </I18nextProvider>,
    )

  it("renders nothing when there is nothing to skip", () => {
    const { container } = renderSkipped([])
    expect(container.textContent).toBe("")
  })

  it("counts only the non-blocking problems", () => {
    // It receives the same array the blocked report does, so it must filter for
    // itself — counting a blocking row would tell the teacher the import continued
    // when it did not.
    renderSkipped(
      classifyImportProblems(
        [
          { line: 2, reason: "incomplete" },
          { line: 3, reason: "bad-email", value: "n/a" },
        ],
        [],
      ),
    )
    expect(screen.getAllByRole("listitem")).toHaveLength(1)
    expect(screen.getByText(/^1 line was skipped/)).toBeTruthy()
  })
})
