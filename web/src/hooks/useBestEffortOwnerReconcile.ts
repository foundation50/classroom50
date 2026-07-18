import { useEffect, useRef } from "react"
import { useMutation } from "@tanstack/react-query"
import { GitHubAPIError } from "@/github-core/errors"

type ReconcileVars = { org: string; classroom: string }

// Config for one best-effort, owner-only per-(org,classroom) reconcile. The
// varying parts of the pattern; the invariant plumbing (fire-once guard,
// transient/permanent latch, fire-once effect) lives in the hook below.
export type BestEffortOwnerReconcileConfig<TResult> = {
  // Whether to run at all this mount — MUST gate on the resolved owner/teacher
  // role, since these reconciles are org-owner ops that would only 403 for a
  // TA/student.
  enabled: boolean
  org: string | undefined
  classroom: string | undefined
  // The reconcile itself, taking org/classroom as VARIABLES (not closed-over)
  // so a run resolving after a fast classroom switch acts on its own classroom.
  run: (vars: ReconcileVars) => Promise<TResult>
  // Side effects on a settled run (e.g. cache invalidation). Called with the
  // run's own org/classroom. Fires even if the component unmounted, so keep it
  // to data-consistency work (no toasts/nav — those belong at the call site).
  onSettled?: (result: TResult, vars: ReconcileVars) => void
  // Classifies an error as permanently hopeless (its key stays latched so the
  // reconcile doesn't re-fire every entry) vs transient (its key is released so
  // a later render retries). Defaults to "a 403 the viewer can't fix".
  isPermanent?: (err: unknown) => boolean
  // Optional label for the best-effort warning log on failure.
  logSkip?: (err: unknown, vars: ReconcileVars) => void
}

const defaultIsPermanent = (err: unknown): boolean =>
  err instanceof GitHubAPIError && err.isForbidden && !err.isRateLimited

// Fire a best-effort, owner-only reconcile once per (org, classroom) the viewer
// visits. Extracted from the near-identical useTeacherTeamMigration and
// useTeamDescriptionBackfill so the subtle concurrency invariant lives in one
// place. The `inFlight` Set (not a single slot) is load-bearing: it makes
// StrictMode's paired effect invocation a no-op AND stops a superseded run's
// late onError from clearing a newer same-key run's guard.
export function useBestEffortOwnerReconcile<TResult>({
  enabled,
  org,
  classroom,
  run,
  onSettled,
  isPermanent = defaultIsPermanent,
  logSkip,
}: BestEffortOwnerReconcileConfig<TResult>): void {
  const inFlight = useRef<Set<string>>(new Set())

  const reconcile = useMutation<TResult, Error, ReconcileVars>({
    mutationFn: run,
    onSuccess: (result, vars) => onSettled?.(result, vars),
    onError: (err, vars) => {
      const key = `${vars.org}/${vars.classroom}`
      if (!isPermanent(err)) inFlight.current.delete(key)
      logSkip?.(err, vars)
    },
  })

  const { mutate } = reconcile
  useEffect(() => {
    if (!enabled || !org || !classroom) return
    const key = `${org}/${classroom}`
    if (inFlight.current.has(key)) return
    inFlight.current.add(key)
    mutate({ org, classroom })
  }, [enabled, org, classroom, mutate])
}

export default useBestEffortOwnerReconcile
