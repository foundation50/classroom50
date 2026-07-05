import { describe, expect, it, vi } from "vitest"

import {
  makeConfirmSkeletonOverwrite,
  settleOverwrite,
  type ResolverRef,
} from "./overwriteConfirm"

// These pin the "settle the parked overwrite promise exactly once" guarantees
// RerunOrgSetup/OrgSetupPage depend on but can't easily assert with a DOM. Every
// confirm hits the resolver multiple times (onConfirm true, onClose false, the
// native <dialog> close false again) and must not flip.

describe("settleOverwrite", () => {
  it("resolves the parked promise with the first value and ignores later calls", async () => {
    const ref: ResolverRef = { current: null }
    const parked = new Promise<boolean>((resolve) => {
      ref.current = resolve
    })

    // onConfirm -> true, then onClose -> false, then the dialog's native onClose
    // -> false again. True must win; the falses are inert.
    settleOverwrite(ref, true)
    settleOverwrite(ref, false)
    settleOverwrite(ref, false)

    expect(await parked).toBe(true)
    expect(ref.current).toBeNull()
  })

  it("resolves false when the teacher declines (Keep mine)", async () => {
    const ref: ResolverRef = { current: null }
    const parked = new Promise<boolean>((resolve) => {
      ref.current = resolve
    })

    settleOverwrite(ref, false)

    expect(await parked).toBe(false)
  })

  it("is a no-op when nothing is parked", () => {
    const ref: ResolverRef = { current: null }
    expect(() => settleOverwrite(ref, true)).not.toThrow()
    expect(ref.current).toBeNull()
  })
})

describe("makeConfirmSkeletonOverwrite", () => {
  it("opens the modal and parks until settled with the teacher's choice", async () => {
    const ref: ResolverRef = { current: null }
    const setPending = vi.fn()
    const confirm = makeConfirmSkeletonOverwrite(ref, setPending, () => true)

    const pending = confirm(["a.yaml", "b.py"])
    expect(setPending).toHaveBeenCalledWith(["a.yaml", "b.py"])
    expect(ref.current).not.toBeNull()

    // The modal's Overwrite button settles via the ref.
    settleOverwrite(ref, true)
    expect(await pending).toBe(true)
  })

  it("declines synchronously without opening the modal when unmounted", async () => {
    const ref: ResolverRef = { current: null }
    const setPending = vi.fn()
    const confirm = makeConfirmSkeletonOverwrite(ref, setPending, () => false)

    const result = await confirm(["a.yaml"])

    expect(result).toBe(false)
    expect(setPending).not.toHaveBeenCalled()
    expect(ref.current).toBeNull()
  })

  it("models the unmount cleanup: a parked run settles false rather than hanging", async () => {
    const ref: ResolverRef = { current: null }
    const confirm = makeConfirmSkeletonOverwrite(ref, vi.fn(), () => true)

    const pending = confirm(["a.yaml"])
    // Unmount cleanup does exactly this: settle the parked resolver with false.
    settleOverwrite(ref, false)

    expect(await pending).toBe(false)
  })

  it("declines an already-parked resolver before parking a new one (no orphaned hang)", async () => {
    const ref: ResolverRef = { current: null }
    const confirm = makeConfirmSkeletonOverwrite(ref, vi.fn(), () => true)

    const first = confirm(["a.yaml"])
    const second = confirm(["b.yaml"])

    // The first parked promise must settle (false) instead of hanging forever.
    expect(await first).toBe(false)

    settleOverwrite(ref, true)
    expect(await second).toBe(true)
  })
})
