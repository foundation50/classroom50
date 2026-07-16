import { useEffect, useRef, useState } from "react"
import { useParams } from "@tanstack/react-router"
import { CheckCircle2, FileWarning } from "lucide-react"
import { AnimatePresence } from "motion/react"
import { useTranslation } from "react-i18next"

import { AppBanner } from "@/components/AppBanner"
import {
  useFixSkeletonDrift,
  isFixResolvedClean,
} from "@/hooks/mutations/useFixSkeletonDrift"
import { useSkeletonDrift } from "@/hooks/useSkeletonDrift"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import {
  SkeletonOverwriteModal,
  useSkeletonOverwriteConfirm,
} from "@/components/skeletonOverwrite/skeletonOverwriteUi"
import { Button } from "@/components/ui"

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
// _authed layout and never remounts on org navigation, so all per-org state
// (dismissal, the just-fixed org, the in-flight org) is keyed by org — a fix or
// dismiss on org A must not affect org B. Reappears on reload.
export function SkeletonDriftBanner() {
  // Loose param read: org-less routes (the org picker) yield undefined and the
  // owner-gated hook stays disabled.
  const { org } = useParams({ strict: false })
  const { hasDrift } = useSkeletonDrift(org)
  const [dismissedOrg, setDismissedOrg] = useState<string>()
  const { t } = useTranslation()

  const runFix = useSafeSubmit()

  // The org whose fix just completed with nothing left drifted. Drives the green
  // success view directly off the mutation result (see DriftBannerInput).
  const [fixedCleanOrg, setFixedCleanOrg] = useState<string>()

  // The org a fix is currently running for. The mutation is shared across orgs,
  // so this scopes the pending spinner/disabled state to the org that launched it.
  const [pendingOrg, setPendingOrg] = useState<string>()

  const {
    overwritePaths,
    resolveOverwrite,
    confirmSkeletonOverwrite,
    mountedRef,
  } = useSkeletonOverwriteConfirm()

  // Decline any parked overwrite modal when the org changes, so a modal opened
  // for org A doesn't linger on org B (resolveOverwrite is a no-op when nothing
  // is parked). Read through a ref so the effect can depend on org alone yet
  // always call the latest resolver.
  const resolveOverwriteRef = useRef(resolveOverwrite)
  useEffect(() => {
    resolveOverwriteRef.current = resolveOverwrite
  })
  useEffect(() => {
    return () => resolveOverwriteRef.current(false)
  }, [org])

  const mutation = useFixSkeletonDrift(confirmSkeletonOverwrite)

  const view = resolveDriftBannerView({
    hasOrg: Boolean(org),
    hasDrift,
    dismissed: dismissedOrg === org,
    // Scope pending to this org: a fix parked for another org must not disable
    // or spin this org's button.
    isPending: pendingOrg === org,
    fixResolvedClean: fixedCleanOrg === org,
  })

  const isSuccess = view === "success"

  return (
    <>
      <AnimatePresence initial={false}>
        {view !== "hidden" ? (
          // key stays view-scoped so AnimatePresence animates the warning->success swap.
          <AppBanner
            key={isSuccess ? "skeleton-drift-success" : "skeleton-drift"}
            tone={view}
            icon={
              isSuccess ? (
                <CheckCircle2 className="size-5" aria-hidden="true" />
              ) : (
                <FileWarning className="size-5" aria-hidden="true" />
              )
            }
            title={t(
              isSuccess ? "skeletonDrift.success.title" : "skeletonDrift.title",
            )}
            onDismiss={() => setDismissedOrg(org)}
          >
            {isSuccess ? (
              <>
                <p className="text-base-content/70">
                  {t("skeletonDrift.success.body")}
                </p>
                <Button
                  variant="success"
                  size="sm"
                  className="self-start"
                  onClick={() => setDismissedOrg(org)}
                >
                  {t("skeletonDrift.success.dismiss")}
                </Button>
              </>
            ) : (
              <>
                <p className="text-base-content/70">
                  {t("skeletonDrift.body")}
                </p>
                <p className="text-base-content/70">
                  <span className="font-semibold text-base-content">
                    {t("skeletonDrift.overwriteWarning_label")}
                  </span>{" "}
                  {t("skeletonDrift.overwriteWarning")}
                </p>
                <Button
                  variant="warning"
                  size="sm"
                  className="self-start"
                  loading={pendingOrg === org}
                  loadingLabel={t("skeletonDrift.updating")}
                  disabled={pendingOrg === org}
                  onClick={() => {
                    if (org && pendingOrg !== org) {
                      const targetOrg = org
                      setPendingOrg(targetOrg)
                      // Guard call-site UI state on mountedRef: these run
                      // through useSafeSubmit, so treat the callbacks as
                      // possibly firing after unmount and skip stale setState.
                      void runFix(() =>
                        mutation.mutateAsync(targetOrg, {
                          onSuccess: (result) => {
                            // Success view only; the cache reconcile is the
                            // hook's job (and runs even if we've unmounted).
                            if (
                              mountedRef.current &&
                              isFixResolvedClean(result)
                            ) {
                              setFixedCleanOrg(targetOrg)
                            }
                          },
                          onSettled: () => {
                            if (mountedRef.current) setPendingOrg(undefined)
                          },
                        }),
                      )
                    }
                  }}
                >
                  {pendingOrg === org
                    ? t("skeletonDrift.updating")
                    : t("skeletonDrift.action")}
                </Button>
              </>
            )}
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
