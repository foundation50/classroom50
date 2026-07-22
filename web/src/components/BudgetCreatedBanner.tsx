import { useEffect, useState } from "react"
import { useParams } from "@tanstack/react-router"
import { PiggyBank } from "lucide-react"
import { AnimatePresence } from "motion/react"
import { useTranslation } from "react-i18next"

import { AppBanner } from "@/components/AppBanner"
import { Button } from "@/components/ui"
import { orgBudgetsUrl } from "@/orgPolicy/budget"
import {
  BUDGET_NOTICE_EVENT,
  dismissBudgetNotice,
  readBudgetNotice,
} from "@/orgPolicy/budgetNoticeStore"

export type BudgetBannerView = "success" | "hidden"

export type BudgetBannerInput = {
  hasOrg: boolean
  created: boolean
  dismissed: boolean
}

// Pure view verdict (mirrors resolveDriftBannerView) so the show/hide decision
// is unit-testable without a render.
export function resolveBudgetBannerView(
  input: BudgetBannerInput,
): BudgetBannerView {
  const { hasOrg, created, dismissed } = input
  if (!hasOrg) return "hidden"
  return created && !dismissed ? "success" : "hidden"
}

// Global reminder banner shown once per org after org-setup reconciliation
// CREATES the $0 GitHub Actions budget cap (never for an org whose cap already
// existed). Persisted per-org in localStorage so dismissal survives reloads and
// the reminder doesn't resurface on a later re-run. Mounts once in the stable
// _authed layout; all per-org state lives in the store, keyed by org.
export function BudgetCreatedBanner() {
  const { org } = useParams({ strict: false })
  const { t } = useTranslation()

  // Re-read the per-org notice on org change and whenever the store changes in
  // this tab (a create/dismiss fires BUDGET_NOTICE_EVENT).
  const [notice, setNotice] = useState(() =>
    org ? readBudgetNotice(org) : { created: false, dismissed: false },
  )
  useEffect(() => {
    const refresh = () =>
      setNotice((prev) => {
        const next = org
          ? readBudgetNotice(org)
          : { created: false, dismissed: false }
        // Skip the re-render when nothing changed (the common case: most orgs
        // never created a cap, so every event would otherwise re-set an equal
        // {created:false, dismissed:false}).
        return prev.created === next.created &&
          prev.dismissed === next.dismissed
          ? prev
          : next
      })
    refresh()
    window.addEventListener(BUDGET_NOTICE_EVENT, refresh)
    return () => window.removeEventListener(BUDGET_NOTICE_EVENT, refresh)
  }, [org])

  const view = resolveBudgetBannerView({
    hasOrg: Boolean(org),
    created: notice.created,
    dismissed: notice.dismissed,
  })

  const dismiss = () => {
    if (org) dismissBudgetNotice(org)
  }

  return (
    <AnimatePresence initial={false}>
      {view !== "hidden" && org ? (
        <AppBanner
          key="budget-created"
          tone="success"
          icon={<PiggyBank className="size-5" aria-hidden="true" />}
          title={t("budgetCreated.title")}
          onDismiss={dismiss}
        >
          <p className="text-base-content/70">{t("budgetCreated.body")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={orgBudgetsUrl(org)}
              target="_blank"
              rel="noreferrer"
              className="link link-primary text-sm"
            >
              {t("budgetCreated.manage")}
            </a>
          </div>
          <Button
            variant="success"
            size="sm"
            className="self-start"
            onClick={dismiss}
          >
            {t("budgetCreated.dismiss")}
          </Button>
        </AppBanner>
      ) : null}
    </AnimatePresence>
  )
}

export default BudgetCreatedBanner
