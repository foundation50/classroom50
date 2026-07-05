import { useState } from "react"
import { Link, useParams } from "@tanstack/react-router"
import { FileWarning } from "lucide-react"
import { AnimatePresence } from "motion/react"
import { useTranslation } from "react-i18next"

import { AppBanner } from "@/components/AppBanner"
import { useSkeletonDrift } from "@/hooks/useSkeletonDrift"
import { RERUN_ORG_SETUP_ANCHOR } from "@/pages/orgSettings/RerunOrgSetup"

// Global warning banner for an org owner when the `classroom50` config repo's
// scaffolded workflows have drifted from the bundled skeleton (e.g. after an
// action-pin bump). Routes to the owner-only "Re-run org setup" section, which
// overwrites (its modal still confirms per file).
//
// Dismiss is per-session and per-org: the banner mounts once in the stable
// _authed layout and never remounts on org navigation, so dismissal is tracked
// by org — dismissing org A must not suppress org B. Reappears on reload.
export function SkeletonDriftBanner() {
  // Loose param read: org-less routes (the org picker) yield undefined and the
  // owner-gated hook stays disabled.
  const { org } = useParams({ strict: false })
  const { hasDrift } = useSkeletonDrift(org)
  const [dismissedOrg, setDismissedOrg] = useState<string>()
  const { t } = useTranslation()

  const show = Boolean(org) && hasDrift && dismissedOrg !== org

  return (
    <AnimatePresence initial={false}>
      {show ? (
        <AppBanner
          key="skeleton-drift"
          tone="warning"
          icon={<FileWarning className="size-5" aria-hidden="true" />}
          title={t("skeletonDrift.title")}
          onDismiss={() => setDismissedOrg(org)}
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
            hash={RERUN_ORG_SETUP_ANCHOR}
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
