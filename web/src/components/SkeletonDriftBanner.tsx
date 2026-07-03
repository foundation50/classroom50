import { useState } from "react"
import { Link, useParams } from "@tanstack/react-router"
import { FileWarning } from "lucide-react"
import { AnimatePresence } from "motion/react"
import { useTranslation } from "react-i18next"

import { AppBanner } from "@/components/AppBanner"
import { useSkeletonDrift } from "@/hooks/useSkeletonDrift"
import { RERUN_ONBOARDING_ANCHOR } from "@/pages/orgSettings/RerunOnboarding"

// Global warning banner shown to a teacher when the org's `classroom50` config
// repo has scaffolded workflow files that drifted from the current bundled
// skeleton (e.g. after an action-pin bump). Routes to the existing "Re-run
// onboarding" Org Settings section, which performs the overwrite.
//
// The copy states plainly that updating REPLACES any customized workflow files
// with the defaults — the overwrite is byte-for-byte from the skeleton, so a
// teacher who hand-edited collect-scores/regrade/publish-pages/autograde-runner
// loses those edits. The re-run flow's overwrite-confirmation modal gates it
// per file, but the banner warns up front so nobody is surprised.
//
// Dismiss is per-session (component-local state, like ScopeWarningBanner): it
// reappears on reload until the drift is actually resolved.
export function SkeletonDriftBanner() {
  // Org-level and classroom routes both live under /_authed/$org, so read the
  // param loosely; org-less routes (the org picker) yield undefined and the
  // teacher-gated hook stays disabled.
  const { org } = useParams({ strict: false })
  const { hasDrift } = useSkeletonDrift(org)
  const [dismissed, setDismissed] = useState(false)
  const { t } = useTranslation()

  const show = Boolean(org) && hasDrift && !dismissed

  return (
    <AnimatePresence initial={false}>
      {show ? (
        <AppBanner
          key="skeleton-drift"
          tone="warning"
          icon={<FileWarning className="size-5" aria-hidden="true" />}
          title={t("skeletonDrift.title")}
          onDismiss={() => setDismissed(true)}
        >
          <p className="text-base-content/70">{t("skeletonDrift.body")}</p>
          <p className="text-base-content/70">
            <span className="font-semibold text-base-content">
              {t("skeletonDrift.overwriteWarning_label")}
            </span>{" "}
            {t("skeletonDrift.overwriteWarning")}
          </p>
          <Link
            to="/$org/settings"
            params={{ org: org as string }}
            hash={RERUN_ONBOARDING_ANCHOR}
            className="btn btn-sm btn-warning self-start"
          >
            {t("skeletonDrift.action")}
          </Link>
        </AppBanner>
      ) : null}
    </AnimatePresence>
  )
}

export default SkeletonDriftBanner
