import { useEffect, useState } from "react"
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

// How long the green "up to date" confirmation lingers before the banner
// auto-dismisses after a successful in-place fix.
const SUCCESS_LINGER_MS = 2000

export type DriftBannerView = "warning" | "success" | "hidden"

// State the banner view depends on — structural so the tri-state decision stays
// a pure, testable function (mirrors resolveSkeletonDrift).
export type DriftBannerInput = {
  hasOrg: boolean
  hasDrift: boolean
  // The org the user just ran a fix for, if any. Gates the success view so a
  // first-load clean org never flashes a check the user didn't ask for.
  fixedThisOrg: boolean
  dismissed: boolean
  isPending: boolean
  // True while the post-fix re-check is in flight; gates out the window between
  // the invalidate and the refetch resolving so we don't flash green early.
  isFetching: boolean
}

// Tri-state view verdict:
// - success: the user fixed this org and a settled re-check found no drift.
// - warning: drift remains (including after a declined/failed fix or on first
//   load), and the banner isn't dismissed.
// - hidden: everything else.
// Success is checked first so a just-fixed clean org shows the check rather than
// nothing; a fix that left drift falls through to warning.
export function resolveDriftBannerView(
  input: DriftBannerInput,
): DriftBannerView {
  const { hasOrg, hasDrift, fixedThisOrg, dismissed, isPending, isFetching } =
    input
  if (!hasOrg || dismissed) return "hidden"
  if (fixedThisOrg && !hasDrift && !isPending && !isFetching) return "success"
  if (hasDrift) return "warning"
  return "hidden"
}

// Global warning banner for an org owner when the `classroom50` config repo's
// scaffolded workflows have drifted from the bundled skeleton (e.g. after an
// action-pin bump). Self-service: the owner refreshes the drifted files inline
// (confirming the overwrite), and once a re-check finds no drift we flash a
// green check and auto-dismiss.
//
// Dismiss is per-session and per-org: the banner mounts once in the stable
// _authed layout and never remounts on org navigation, so dismissal is tracked
// by org — dismissing org A must not suppress org B. Reappears on reload.
export function SkeletonDriftBanner() {
  // Loose param read: org-less routes (the org picker) yield undefined and the
  // owner-gated hook stays disabled.
  const { org } = useParams({ strict: false })
  const { hasDrift, isFetching } = useSkeletonDrift(org)
  const [dismissedOrg, setDismissedOrg] = useState<string>()
  const { t } = useTranslation()

  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const runFix = useSafeSubmit()

  // Set once the user runs a fix; gates the green success state so a first-load
  // clean org never flashes a check the user didn't ask for.
  const [fixedOrg, setFixedOrg] = useState<string>()

  const {
    overwritePaths,
    resolveOverwrite,
    confirmSkeletonOverwrite,
    mountedRef,
  } = useSkeletonOverwriteConfirm()

  const mutation = useMutation({
    mutationFn: () =>
      ensureSkeletonFiles(client, org as string, confirmSkeletonOverwrite),
    onSuccess: () => {
      if (!mountedRef.current) return
      setFixedOrg(org)
      // Re-check drift: an explicit invalidate ignores the hook's staleTime, so
      // the banner reflects the post-fix state instead of stale cache.
      void queryClient.invalidateQueries({
        queryKey: githubKeys.skeletonDrift(org ?? ""),
      })
    },
  })

  const view = resolveDriftBannerView({
    hasOrg: Boolean(org),
    hasDrift,
    fixedThisOrg: fixedOrg === org,
    dismissed: dismissedOrg === org,
    isPending: mutation.isPending,
    isFetching,
  })

  // Auto-dismiss after the success check has lingered.
  useEffect(() => {
    if (view !== "success") return
    const timer = setTimeout(() => {
      if (mountedRef.current) setDismissedOrg(org)
    }, SUCCESS_LINGER_MS)
    return () => clearTimeout(timer)
  }, [view, org, mountedRef])

  return (
    <>
      <AnimatePresence initial={false}>
        {view === "success" ? (
          <AppBanner
            key="skeleton-drift-success"
            tone="success"
            icon={<CheckCircle2 className="size-5" aria-hidden="true" />}
            title={t("skeletonDrift.success.title")}
          >
            <p className="text-base-content/70">
              {t("skeletonDrift.success.body")}
            </p>
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
