// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render } from "@testing-library/react"

import { LanguagePackUpdateToaster } from "./LanguagePackUpdateToaster"

const notify = vi.fn()
let emit: ((codes: string[]) => void) | null = null
let uiLanguage = "en"

vi.mock("@/context/notifications/NotificationProvider", () => ({
  useOptionalToast: () => ({ notify }),
}))

vi.mock("@/i18n/customLocale", async () => {
  // Exercise the real formatter — the locale-aware list is the behavior under
  // test — over stubbed labels, so the assertions don't depend on ICU's
  // language *names* (which vary by ICU version).
  const actual = await vi.importActual<typeof import("@/i18n/customLocale")>(
    "@/i18n/customLocale",
  )
  return {
    languageLabelList: (codes: string[], locale?: string) =>
      actual.languageLabelList(codes, locale),
    subscribeToPackUpdates: (onUpdate: (codes: string[]) => void) => {
      emit = onUpdate
      return () => {
        emit = null
      }
    },
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts: { count: number; list: string }) =>
      `${key}|${opts.count}|${opts.list}`,
    i18n: {
      get language() {
        return uiLanguage
      },
    },
  }),
}))

const messageOf = (call: number) => notify.mock.calls[call][0].message as string

afterEach(() => {
  cleanup()
  notify.mockClear()
  emit = null
  uiLanguage = "en"
})

// The toast names the languages whose packs just updated, so its audience is
// non-English readers by definition. A hard-coded ", " is wrong for most of
// them — Japanese enumerates with "、" and Chinese with no separator at all.
describe("LanguagePackUpdateToaster", () => {
  it("joins an English list with a comma and a conjunction", () => {
    render(<LanguagePackUpdateToaster />)
    emit?.(["de", "ja"])

    expect(notify).toHaveBeenCalledTimes(1)
    expect(messageOf(0)).toBe(
      "language.updatedToast|2|German (de) and Japanese (ja)",
    )
  })

  it("uses the ideographic separator in Japanese, not a comma", () => {
    uiLanguage = "ja"
    render(<LanguagePackUpdateToaster />)
    emit?.(["de", "ja"])

    const message = messageOf(0)
    expect(message).toContain("、")
    expect(message).not.toContain(", ")
  })

  it("passes a single language through unadorned", () => {
    render(<LanguagePackUpdateToaster />)
    emit?.(["ar"])

    expect(messageOf(0)).toBe("language.updatedToast|1|Arabic (ar)")
  })

  it("stays silent when no pack updated", () => {
    render(<LanguagePackUpdateToaster />)
    emit?.([])
    expect(notify).not.toHaveBeenCalled()
  })
})
