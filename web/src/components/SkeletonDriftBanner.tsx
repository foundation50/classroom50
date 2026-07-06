import { useState } from "react"
import { useParams } from "@tanstack/react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, FileWarning } from "lucide-react"
import { AnimatePresence } from "motion/react"
import { useTranslation } from "react-i18next"

import { AppBanner } from "@/components/AppBanner"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { ensureSkeletonFiles } from "@/hooks/github/mutations"
import { githubKeys } from "@/hooks/github/queries"
import { useSkeletonDrift } from "@/hooks/useSkeletonDrift"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import {
  SkeletonOverwriteModal,
  useSkeletonOverwriteConfirm,
} from "@/pages/orgSettings/skeletonOverwriteUi"

export type DriftBannerView = "warning" | "success" | "hidden"

// State the banner view depends on — structural so the tri-state decision stays
// a pure, testable function (mirrors resolveSkeletonDrift).
export type DriftBannerInput = {
  hasOrg: boolean
  hasDrift: boolean
  dismissed: boolean
  isPending: boolean
  // True once a fix for this org completed with no files left drifted. Drives
  // the success view directly off the mutation result rather than re-reading
  // the repo tree — a post-commit tree read is eventually consistent and can
  // still report the old (drifted) SHAs, which would wrongly keep us on the
  // warning view.
  fixResolvedClean: boolean
}

// Tri-state view verdict:
// - success: a fix for this org completed and left no drift.
// - warning: drift remains (including after a declined/failed fix or on first
//   load) and a clean fix hasn't just completed, and the banner isn't dismissed.
// - hidden: everything else.
// Success is checked first so a just-fixed org shows the check; a fix that
// skipped files (declined overwrite) has fixResolvedClean=false and falls
// through to warning.
export function resolveDriftBannerView(
  input: DriftBannerInput,
): DriftBannerView {
  const { hasOrg, hasDrift, dismissed, isPending, fixResolvedClean } = input
  if (!hasOrg || dismissed) return "hidden"
  if (fixResolvedClean && !isPending) return "success"
  if (hasDrift) return "warning"
  return "hidden"
}

// Global warning banner for an org owner when the `classroom50` config repo's
// scaffolded workflows have drifted from the bundled skeleton (e.g. after an
// action-pin bump). Self-service: the owner refreshes the drifted files inline
// (confirming the overwrite), and once the fix resolves cleanly we show a green
// confirmation the owner dismisses (X or the Dismiss button).
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

  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const runFix = useSafeSubmit()

  // The org whose fix just completed with nothing left drifted. Drives the green
  // success view directly off the mutation result (see DriftBannerInput) and is
  // tracked per-org so a fix on org A never greets org B after navigation.
  const [fixedCleanOrg, setFixedCleanOrg] = useState<string>()

  const {
    overwritePaths,
    resolveOverwrite,
    confirmSkeletonOverwrite,
    mountedRef,
  } = useSkeletonOverwriteConfirm()

  const mutation = useMutation({
    mutationFn: () =>
      ensureSkeletonFiles(client, org as string, confirmSkeletonOverwrite),
    onSuccess: (result) => {
      if (!mountedRef.current) return
      // Clean iff the fix completed and left no drifted files behind (a declined
      // overwrite leaves skippedOverwrite non-empty -> stay on the warning view).
      if (
        result.status === "complete" &&
        result.skippedOverwrite.length === 0
      ) {
        setFixedCleanOrg(org)
      }
      // Refresh the cached drift check so the warning banner doesn't re-flash on
      // the next mount. The success view no longer depends on this resolving.
      void queryClient.invalidateQueries({
        queryKey: githubKeys.skeletonDrift(org ?? ""),
      })
    },
  })

  const view = resolveDriftBannerView({
    hasOrg: Boolean(org),
    hasDrift,
    dismissed: dismissedOrg === org,
    isPending: mutation.isPending,
    fixResolvedClean: fixedCleanOrg === org,
  })

  return (
    <>
      <AnimatePresence initial={false}>
        {view === "success" ? (
          <AppBanner
            key="skeleton-drift-success"
            tone="success"
            icon={<CheckCircle2 className="size-5" aria-hidden="true" />}
            title={t("skeletonDrift.success.title")}
            onDismiss={() => setDismissedOrg(org)}
          >
            <p className="text-base-content/70">
              {t("skeletonDrift.success.body")}
            </p>
            <button
              type="button"
              className="btn btn-sm btn-success self-start"
              onClick={() => setDismissedOrg(org)}
            >
              {t("skeletonDrift.success.dismiss")}
            </button>
          </AppBanner>
        ) : view === "warning" ? (
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
            <button
              type="button"
              className="btn btn-sm btn-warning self-start"
              disabled={mutation.isPending}
              onClick={() => {
                if (!mutation.isPending) {
                  void runFix(() => mutation.mutateAsync())
                }
              }}
            >
              {mutation.isPending ? (
                <>
                  <span
                    className="loading loading-spinner loading-xs"
                    aria-hidden="true"
                  />
                  {t("skeletonDrift.updating")}
                </>
              ) : (
                t("skeletonDrift.action")
              )}
            </button>
          </AppBanner>
        ) : null}
      </AnimatePresence>

      <SkeletonOverwriteModal
        paths={overwritePaths}
        onConfirm={() => resolveOverwrite(true)}
        onClose={() => resolveOverwrite(false)}
      />
    </>
  )
}

export default SkeletonDriftBanner
