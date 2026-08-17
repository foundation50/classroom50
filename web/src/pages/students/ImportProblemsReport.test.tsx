// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { I18nextProvider } from "react-i18next"
import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import en from "@/locales/en.json"
import { ImportBlockedReport } from "./ImportProblemsReport"
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
      <ImportBlockedReport problems={problems} onCancel={() => {}} />
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
})
