import type { TFunction } from "i18next"

import { describeWriteFailure } from "@/components/modals/collaboratorHelpers"
import { GitHubAPIError } from "@/github-core/errors"
import { REPO_READ_CONCURRENCY } from "@/github-core/queries"
import { mapWithConcurrency } from "@/util/concurrency"

// The three outcomes every fan-out can produce. A caller may widen the union
// with its own statuses by returning them from `perOwner`; the widened type
// only has to keep the `owner` + `status` shape.
export type AnyOutcome = { owner: string; status: string }
export type FanOutOutcome =
  | { owner: string; status: "ok" }
  // Never launched: an earlier write tripped a secondary rate limit, the
  // caller asked to stop, or the component unmounted.
  | { owner: string; status: "deferred" }
  | { owner: string; status: "failed"; detail?: string }

export type FanOutResult<O> = {
  outcomes: O[]
  // True once a secondary rate-limit tripped: the remainder was marked
  // deferred rather than launched, so the caller should offer a re-run.
  rateLimited: boolean
}

type RunBulkFanOutParams<O> = {
  owners: string[]
  // One write per owner. Resolve with a custom outcome, or with nothing for a
  // plain "ok". Throw to record a failure; a rate-limit throw stops the rest.
  perOwner: (owner: string) => Promise<O | void>
  // Defaults to the read limit; writes that GitHub throttles harder pass
  // REPO_WRITE_CONCURRENCY.
  concurrency?: number
  // A caller-owned stop condition checked before each launch (e.g. a missing
  // workflow scope that every later owner would also hit).
  shouldStop?: () => boolean
  isMounted: () => boolean
  onProgress: (processed: number, owner: string) => void
  t: TFunction
}

// The bounded per-owner fan-out every bulk modal runs: launch up to
// `concurrency` writes at once, stop launching new ones once a secondary rate
// limit trips (hammering GitHub only deepens the throttle) or the component
// unmounts, and report one outcome per owner in input order.
export async function runBulkFanOut<O extends AnyOutcome = FanOutOutcome>({
  owners,
  perOwner,
  concurrency = REPO_READ_CONCURRENCY,
  shouldStop,
  isMounted,
  onProgress,
  t,
}: RunBulkFanOutParams<O>): Promise<FanOutResult<O>> {
  let processed = 0
  let rateLimited = false

  const outcomes = await mapWithConcurrency(
    owners,
    concurrency,
    async (owner): Promise<O> => {
      if (rateLimited || shouldStop?.() || !isMounted()) {
        processed += 1
        if (isMounted()) onProgress(processed, owner)
        const deferred: FanOutOutcome = { owner, status: "deferred" }
        return deferred as unknown as O
      }
      try {
        const custom = await perOwner(owner)
        if (custom) return custom
        const ok: FanOutOutcome = { owner, status: "ok" }
        return ok as unknown as O
      } catch (err) {
        if (err instanceof GitHubAPIError && err.isRateLimited) {
          rateLimited = true
          const deferred: FanOutOutcome = { owner, status: "deferred" }
          return deferred as unknown as O
        }
        const failed: FanOutOutcome = {
          owner,
          status: "failed",
          detail: describeWriteFailure(err, t),
        }
        return failed as unknown as O
      } finally {
        processed += 1
        if (isMounted()) onProgress(processed, owner)
      }
    },
  )

  return { outcomes, rateLimited }
}

// Split outcomes into the three sections every result view renders.
export function partitionOutcomes<O extends AnyOutcome>(outcomes: O[]) {
  return {
    succeeded: outcomes.filter((o) => o.status === "ok"),
    deferred: outcomes.filter((o) => o.status === "deferred"),
    failed: outcomes.filter(
      (o): o is O & { status: "failed"; detail?: string } =>
        o.status === "failed",
    ),
  }
}
