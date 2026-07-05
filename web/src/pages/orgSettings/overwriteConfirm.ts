// The skeleton-overwrite confirmation parks initClassroom50's run on a promise
// while a modal asks whether to overwrite drifted skeleton files. The resolver
// lives in a ref so the modal's handlers (and unmount cleanup) can settle the
// awaiting hook. Factored out of the components so the "settle exactly once"
// guarantees are unit-testable without a DOM; both the wizard (OrgSetupPage) and
// re-run surface (RerunOrgSetup) build their confirmSkeletonOverwrite from this.

// Mutable ref cell — structurally compatible with
// useRef<((ok: boolean) => void) | null>() so callers pass their ref straight
// through.
export type ResolverRef = { current: ((ok: boolean) => void) | null }

// Settle the parked promise (if any) with `ok`, then clear the resolver so a
// follow-up can't settle it again. This null-after-settle makes the modal's
// onConfirm-then-onClose double call, and the unmount cleanup, idempotent: only
// the first call wins.
export function settleOverwrite(ref: ResolverRef, ok: boolean): void {
  ref.current?.(ok)
  ref.current = null
}

// Build a confirmSkeletonOverwrite hook. Invoked mid-run with the paths about to
// be overwritten; opens the modal (via setPending) and parks on a promise whose
// resolver is stashed in `ref`. If already unmounted (isMounted() === false) it
// declines synchronously rather than parking a promise that can't settle. If a
// resolver is somehow already parked (re-entrant — not reachable with today's
// sequential init, but cheap to guard), the prior one is declined first so it
// can't hang.
export function makeConfirmSkeletonOverwrite(
  ref: ResolverRef,
  setPending: (paths: string[] | null) => void,
  isMounted: () => boolean,
): (paths: string[]) => Promise<boolean> {
  return (paths: string[]) => {
    if (!isMounted()) return Promise.resolve(false)
    ref.current?.(false)
    setPending(paths)
    return new Promise<boolean>((resolve) => {
      ref.current = resolve
    })
  }
}
