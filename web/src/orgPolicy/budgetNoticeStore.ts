// Per-org, per-browser record of the "$0 Actions budget was created for you"
// reminder: whether org setup created the cap this browser has seen, and
// whether the teacher dismissed the banner. UI-derived state, not server data,
// so it lives in localStorage rather than React Query — mirroring
// unresolvedStore.ts. Kept separate from the audit unresolvedStore so the
// audit's "fix-it" outcome semantics stay clean.

const KEY_PREFIX = "c50:budget:notice:v1:"

function canUseStorage(): boolean {
  return (
    typeof window !== "undefined" && typeof window.localStorage !== "undefined"
  )
}

function store(): Storage | null {
  return canUseStorage() ? window.localStorage : null
}

function keyFor(org: string): string {
  return `${KEY_PREFIX}${org}`
}

export type BudgetNotice = {
  // created: org setup created the $0 cap (the banner should show unless
  // dismissed).
  created: boolean
  // dismissed: the teacher closed the banner (durable across reloads).
  dismissed: boolean
}

function empty(): BudgetNotice {
  return { created: false, dismissed: false }
}

// Read the persisted notice for an org. Tolerates missing or corrupt JSON by
// returning defaults — a bad value must never throw and hide the banner logic.
export function readBudgetNotice(org: string): BudgetNotice {
  const ls = store()
  if (ls === null) return empty()
  const raw = ls.getItem(keyFor(org))
  if (raw === null) return empty()
  try {
    const parsed = JSON.parse(raw) as Partial<BudgetNotice>
    return {
      created: parsed.created === true,
      dismissed: parsed.dismissed === true,
    }
  } catch {
    return empty()
  }
}

// Custom same-tab event so a mounted banner can re-read after a create/dismiss
// in this tab (the native `storage` event only fires in *other* tabs).
export const BUDGET_NOTICE_EVENT = "c50:budget-notice-changed"

function notifyChanged(): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(BUDGET_NOTICE_EVENT))
}

function write(org: string, notice: BudgetNotice): void {
  const ls = store()
  if (ls === null) return
  ls.setItem(keyFor(org), JSON.stringify(notice))
  notifyChanged()
}

// Record that org setup created the $0 cap. Preserves an existing `dismissed`
// so re-running setup on an org whose banner the teacher already dismissed
// doesn't resurface it — the reminder is one-time per org.
export function markBudgetCreated(org: string): void {
  const current = readBudgetNotice(org)
  write(org, { created: true, dismissed: current.dismissed })
}

// Record that the teacher dismissed the banner (durable).
export function dismissBudgetNotice(org: string): void {
  const current = readBudgetNotice(org)
  write(org, { created: current.created, dismissed: true })
}

// recordBudgetNoticeFromStep marks the org's banner when an org-setup step
// update reports the budget cap was created this run. A no-op for any other
// step or a "budget already present" outcome. Call from an onStepUpdate handler
// so the banner shows after setup creates the cap.
export function recordBudgetNoticeFromStep(
  org: string,
  stepId: string,
  data: unknown,
): void {
  if (stepId !== "orgBudget") return
  if (
    typeof data === "object" &&
    data !== null &&
    "budgetCreated" in data &&
    (data as { budgetCreated: unknown }).budgetCreated === true
  ) {
    markBudgetCreated(org)
  }
}
