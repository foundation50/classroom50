import { useState, type ReactNode } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import {
  initClassroom50,
  type InitStepId,
  type InitStepUpdate,
} from "@/hooks/github/mutations"
import { githubKeys } from "@/hooks/github/queries"
import useGetOrgMembership from "@/hooks/useGetOrgMembership"
import useGetOrgPlanDetails from "@/hooks/useGetOrgPlanDetails"
import {
  INIT_STEP_ORDER,
  InitStepBoard,
  applyStepUpdate,
  initialInitSteps,
} from "./initStepBoard"
import SettingsSection from "./SettingsSection"
import { CalloutDiv } from "@/lib/motionComponents"
import {
  SkeletonOverwriteModal,
  useSkeletonOverwriteConfirm,
} from "./skeletonOverwriteUi"

const BANNER_TONE = {
  error: "border-error/30 bg-error/10 text-error",
  warning: "border-warning/30 bg-warning/10 text-base-content/80",
  success: "border-success/30 bg-success/10 text-success",
} as const

// A small status callout shared by the re-run summary states so the
// error/warning/success boxes stay visually consistent.
const SummaryBanner = ({
  tone,
  className,
  children,
}: {
  tone: keyof typeof BANNER_TONE
  className?: string
  children: ReactNode
}) => (
  <CalloutDiv
    className={`rounded-lg border p-3 text-sm ${BANNER_TONE[tone]} ${className ?? ""}`}
  >
    {children}
  </CalloutDiv>
)

// DOM anchor shared with SkeletonDriftBanner so its "Update workflows" action
// scrolls straight to this section.
export const RERUN_ONBOARDING_ANCHOR = "rerun-onboarding"

// Re-run onboarding from Org Settings: re-invokes the idempotent
// initClassroom50 to re-apply the full lockdown, rulesets, and repo settings.
// Owner-gated; shows the same badge board the wizard uses. This is the
// "repair everything" path that complements the per-concern audit (U5/U6).
const RerunOnboarding = ({ org }: { org: string }) => {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const runRerun = useSafeSubmit()

  const { data: membership } = useGetOrgMembership(org)
  const { data: planDetails } = useGetOrgPlanDetails(org)
  const isOwner = membership?.role === "admin"

  const [steps, setSteps] =
    useState<Record<InitStepId, InitStepUpdate>>(initialInitSteps)
  const [started, setStarted] = useState(false)
  const [failed, setFailed] = useState(false)
  const [done, setDone] = useState(false)

  // Skeleton-overwrite confirmation. initClassroom50 calls confirmSkeletonOverwrite
  // mid-run with the drifted files about to be overwritten; the hook opens the
  // modal and parks the run until the teacher confirms or cancels.
  const {
    overwritePaths,
    resolveOverwrite,
    confirmSkeletonOverwrite,
    mountedRef,
  } = useSkeletonOverwriteConfirm()

  // After a completed run, surface whether any step finished with a warning so
  // the per-step messages on the board have a headline to explain them.
  const warningCount = started
    ? INIT_STEP_ORDER.filter((id) => steps[id].status === "warning").length
    : 0

  const mutation = useMutation({
    mutationFn: async () => {
      setStarted(true)
      setFailed(false)
      setDone(false)
      setSteps(initialInitSteps)
      return initClassroom50({
        client,
        org,
        plan: planDetails?.plan?.name,
        onStepUpdate: (update) => {
          // init fires onStepUpdate across ~10 sequential steps; the user can
          // navigate away mid-run. The work isn't cancelable (no AbortSignal),
          // so the mounted guard just stops the setState churn.
          if (!mountedRef.current) return
          setSteps((prev) => applyStepUpdate(prev, update))
        },
        confirmSkeletonOverwrite,
      })
    },
    onSuccess: (data) => {
      if (!mountedRef.current) return
      setDone(true)
      // init resolves (not throws) with status "error" on a prerequisite
      // failure; surface it instead of treating it as a clean success.
      if (data && data.status === "error") {
        setFailed(true)
        return
      }
      void queryClient.invalidateQueries({
        queryKey: githubKeys.orgAuditPrefix(org),
      })
      void queryClient.invalidateQueries({ queryKey: ["orgs"] })
    },
  })

  return (
    <SettingsSection
      id={RERUN_ONBOARDING_ANCHOR}
      title={t("orgSettings.rerun.title")}
      description={t("orgSettings.rerun.description")}
      action={
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!isOwner || mutation.isPending}
          title={
            isOwner ? undefined : t("orgSettings.rerun.requiresOwnerTitle")
          }
          onClick={() => {
            if (!mutation.isPending) void runRerun(() => mutation.mutateAsync())
          }}
        >
          {mutation.isPending ? (
            <>
              <span
                className="loading loading-spinner loading-sm"
                aria-hidden="true"
              />
              {t("orgSettings.rerun.running")}
            </>
          ) : (
            t("orgSettings.rerun.button")
          )}
        </button>
      }
    >
      {!isOwner && (
        <SummaryBanner tone="warning">
          {t("orgSettings.rerun.requiresOwnerNote")}
        </SummaryBanner>
      )}

      {started && (
        <div className={!isOwner ? "mt-4" : undefined}>
          <InitStepBoard steps={steps} org={org} />
          {failed && (
            <SummaryBanner tone="error" className="mt-3">
              {t("orgSettings.rerun.failed")}
            </SummaryBanner>
          )}
          {done && !failed && warningCount > 0 && (
            <SummaryBanner tone="warning" className="mt-3">
              {t("orgSettings.rerun.finishedWithWarnings", {
                count: warningCount,
              })}
            </SummaryBanner>
          )}
          {done && !failed && warningCount === 0 && (
            <SummaryBanner tone="success" className="mt-3">
              {t("orgSettings.rerun.success")}
            </SummaryBanner>
          )}
        </div>
      )}

      <SkeletonOverwriteModal
        paths={overwritePaths}
        onConfirm={() => resolveOverwrite(true)}
        onClose={() => resolveOverwrite(false)}
      />
    </SettingsSection>
  )
}

export default RerunOnboarding
