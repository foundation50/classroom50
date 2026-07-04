// The skeleton-overwrite confirmation parks initClassroom50's run on a promise
// while a modal asks the teacher whether to overwrite drifted skeleton files.
// The resolver lives in a ref so the modal's button handlers (and an unmount
// cleanup) can settle the awaiting hook. This factors the resolver bookkeeping
// out of the React components so the tricky "settle exactly once" guarantees
// are unit-testable without a DOM: both the wizard (OrgSetupPage) and the
// re-run surface (RerunOrgSetup) build their confirmSkeletonOverwrite hook
// from this.

// A mutable ref cell — structurally compatible with React's
// useRef<((ok: boolean) => void) | null>() so callers can pass their ref
// straight through.
export type ResolverRef = { current: ((ok: boolean) => void) | null }

// Settle the parked promise (if any) with `ok`, then clear the resolver so a
// follow-up call can't settle it again. This null-after-settle is what makes
// the modal's onConfirm-then-onClose double call, and the unmount cleanup,
// idempotent: only the first call wins.
export function settleOverwrite(ref: ResolverRef, ok: boolean): void {
  ref.current?.(ok)
  ref.current = null
}

// Build a confirmSkeletonOverwrite hook. It is invoked mid-run with the paths
// about to be overwritten; it opens the modal (via setPending) and parks on a
// promise whose resolver is stashed in `ref`. If the surface is already
// unmounted (isMounted() === false) it declines synchronously rather than
// parking a promise that could never settle. If a resolver is somehow already
// parked (re-entrant invocation — not reachable with today's sequential init,
// but cheap to guard), the prior one is declined before the new one parks so it
// can't be orphaned into a permanent hang.
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
