import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"

import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import { Button } from "@/components/ui"
import { type InitStepId, type InitStepUpdate } from "@/github-core/mutations"
import { recordBudgetNoticeFromStep } from "@/orgPolicy/budgetNoticeStore"
import { githubKeys } from "@/github-core/queries"
import useRunOrgSetup from "@/hooks/mutations/useRunOrgSetup"
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
} from "@/components/skeletonOverwrite/skeletonOverwriteUi"

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

// DOM anchor for this section, used as its SettingsSection id.
const RERUN_ORG_SETUP_ANCHOR = "rerun-org-setup"

// Re-run the org setup from Org Settings: re-invokes the idempotent
// initClassroom50 to re-apply lockdown, rulesets, and repo settings. Owner-gated
// by the page's <RequireRole allow="owner"> (see TeardownSection); shows the
// wizard's badge board. The "repair everything" path complementing the
// per-concern audit (U5/U6).
const RerunOrgSetup = ({ org }: { org: string }) => {
  const { t } = useTranslation()
  const runRerun = useSafeSubmit()

  const { data: planDetails } = useGetOrgPlanDetails(org)

  const [steps, setSteps] =
    useState<Record<InitStepId, InitStepUpdate>>(initialInitSteps)
  const [started, setStarted] = useState(false)
  const [failed, setFailed] = useState(false)
  const [done, setDone] = useState(false)

  // Skeleton-overwrite confirmation. initClassroom50 calls
  // confirmSkeletonOverwrite mid-run with the drifted files; the hook opens the
  // modal and parks the run until the teacher confirms or cancels.
  const {
    overwritePaths,
    resolveOverwrite,
    confirmSkeletonOverwrite,
    mountedRef,
  } = useSkeletonOverwriteConfirm()

  // After a run, surface whether any step warned so the board's per-step
  // messages have a headline.
  const warningCount = started
    ? INIT_STEP_ORDER.filter((id) => steps[id].status === "warning").length
    : 0

  const mutation = useRunOrgSetup({
    org,
    plan: planDetails?.plan?.name,
    onStepUpdate: (update) => {
      // init fires onStepUpdate across ~10 sequential steps; the user can
      // navigate away mid-run. The work isn't cancelable (no AbortSignal), so
      // the mounted guard just stops setState churn.
      if (!mountedRef.current) return
      recordBudgetNoticeFromStep(org, update.id, update.data)
      setSteps((prev) => applyStepUpdate(prev, update))
    },
    confirmSkeletonOverwrite,
    // Unmount-safe: runs in the hook's onSuccess so a mid-run navigation can't
    // drop the post-setup refetch. Only on a non-error outcome (init resolves
    // with status "error" on a prerequisite failure).
    invalidate: (queryClient, result) => {
      if (result && result.status === "error") return
      void queryClient.invalidateQueries({
        queryKey: githubKeys.orgAuditPrefix(org),
      })
      void queryClient.invalidateQueries({ queryKey: ["orgs"] })
    },
  })

  // Reset the board before the init call (must run before mutateAsync), then
  // run setup. The step-machine setState (done/failed) stays here via the
  // per-call onSuccess (correctly skipped on unmount); the cache invalidation
  // lives in the hook so it survives an unmount.
  const runRerunFlow = () => {
    setStarted(true)
    setFailed(false)
    setDone(false)
    setSteps(initialInitSteps)
    return mutation.mutateAsync(undefined, {
      onSuccess: (data) => {
        if (!mountedRef.current) return
        setDone(true)
        // init resolves (not throws) with status "error" on a prerequisite
        // failure; surface it instead of treating it as success. (The cache
        // invalidation is the hook's job — see `invalidate` above.)
        if (data && data.status === "error") {
          setFailed(true)
        }
      },
    })
  }

  return (
    <SettingsSection
      id={RERUN_ORG_SETUP_ANCHOR}
      title={t("orgSettings.rerun.title")}
      description={t("orgSettings.rerun.description")}
      action={
        <Button
          variant="primary"
          size="sm"
          loading={mutation.isPending}
          loadingLabel={t("orgSettings.rerun.running")}
          disabled={mutation.isPending}
          onClick={() => {
            if (!mutation.isPending) void runRerun(() => runRerunFlow())
          }}
        >
          {mutation.isPending
            ? t("orgSettings.rerun.running")
            : t("orgSettings.rerun.button")}
        </Button>
      }
    >
      {started && (
        <div>
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

export default RerunOrgSetup
