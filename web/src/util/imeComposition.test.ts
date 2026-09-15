import { describe, expect, it } from "vitest"
import type { KeyboardEvent } from "react"

import { isComposingKey } from "./imeComposition"

const keyEvent = (init: { isComposing?: boolean; keyCode?: number }) =>
  ({
    keyCode: init.keyCode ?? 13,
    nativeEvent: { isComposing: init.isComposing ?? false },
  }) as unknown as KeyboardEvent

describe("isComposingKey", () => {
  it("is false for a plain Enter", () => {
    expect(isComposingKey(keyEvent({}))).toBe(false)
  })

  it("is true while the native event reports an IME composition", () => {
    expect(isComposingKey(keyEvent({ isComposing: true }))).toBe(true)
  })

  it("is true for the legacy keyCode 229 some engines send instead", () => {
    expect(isComposingKey(keyEvent({ keyCode: 229 }))).toBe(true)
  })
})
