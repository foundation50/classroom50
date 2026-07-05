import { describe, expect, it, vi } from "vitest"

import { createSafeSubmit } from "./useSafeSubmit"

// useSafeSubmit's correctness is the synchronous latch: a second same-tick call
// must be a no-op while the first is in flight, and the latch must reset after
// the work settles so the next genuine submit proceeds. The latch lives in
// createSafeSubmit (pure, no React) so it tests in the pure-function style.
describe("createSafeSubmit", () => {
  it("rejects a second same-tick call while the first is in flight", async () => {
    const run = createSafeSubmit()
    const fn = vi.fn(() => new Promise((resolve) => setTimeout(resolve, 10)))

    // Two calls dispatched in the same tick (the double-click window).
    const first = run(fn)
    const second = run(fn)

    await Promise.all([first, second])

    // Only the first started work; the second was latched out.
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("allows a subsequent call after the first settles", async () => {
    const run = createSafeSubmit()
    const fn = vi.fn(() => Promise.resolve())

    await run(fn)
    await run(fn)

    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("resets the latch even when the work rejects (error owned by the mutation)", async () => {
    const run = createSafeSubmit()
    const failing = vi.fn(() => Promise.reject(new Error("boom")))

    // run swallows the rejection (the wrapped mutation owns error handling), but
    // the latch must still reset so the next submit proceeds.
    await expect(run(failing)).resolves.toBeUndefined()

    const ok = vi.fn(() => Promise.resolve())
    await run(ok)
    expect(ok).toHaveBeenCalledTimes(1)
  })
})
