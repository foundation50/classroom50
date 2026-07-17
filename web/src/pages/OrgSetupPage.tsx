import { useParams } from "@tanstack/react-router"
import { ArrowLeft, ArrowRight, CheckCircle2 } from "lucide-react"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import { useTranslation } from "react-i18next"

import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import { Spinner } from "@/components/Spinner"
import { Alert, Button, Card, RouterButton, rtlFlip } from "@/components/ui"
import { QueryErrorAlert } from "@/components/QueryErrorAlert"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { useIsOrgOwner } from "@/context/githubOrgRole/useIsOrgOwner"
import useGetOrgPlanDetails from "@/hooks/useGetOrgPlanDetails"
import { useState } from "react"
import { type InitStepId, type InitStepUpdate } from "@/github-core/mutations"
import useRunOrgSetup from "@/hooks/mutations/useRunOrgSetup"
import useGetServiceTokenStatus from "@/hooks/useGetServiceTokenStatus"
import {
  useOrgClassroom50Status,
  orgClassroom50StatusKey,
} from "@/hooks/useOrgClassroom50Status"
import { OrgSettingsPane } from "./OrgSettingsPage"
import { EnterDiv } from "@/lib/motionComponents"
import {
  SkeletonOverwriteModal,
  useSkeletonOverwriteConfirm,
} from "@/components/skeletonOverwrite/skeletonOverwriteUi"
import {
  InitStepBoard,
  applyStepUpdate,
  initialInitSteps,
} from "./orgSettings/initStepBoard"

const OrgSteps = ({
  steps,
  mutation,
  configReady = false,
  org = "",
  stage = 1,
  onGoToServiceToken = () => {},
  onLeaveServiceToken = () => {},
  onManageToken = () => {},
}: {
  steps: Record<InitStepId, InitStepUpdate>
  mutation: { isPending: boolean; mutateAsync: () => Promise<unknown> }
  configReady?: boolean
  org?: string
  stage?: number
  onGoToServiceToken?: () => void
  onLeaveServiceToken?: () => void
  onManageToken?: () => void
}) => {
  const { t } = useTranslation()
  const runSetup = useSafeSubmit()
  return (
    <Card>
      <Card.Body className="gap-5">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center">
          <ul className="steps steps-horizontal col-start-2 justify-self-center">
            <li
              className={`step ${stage === 1 ? "step-info" : "step-success"}`}
            ></li>
            <li
              className={`step ${stage === 2 ? "step-info" : stage === 3 ? "step-success" : "[--step-bg:var(--color-base-300)]"}`}
            ></li>
            <li
              className={`step ${stage === 3 ? "step-primary" : "[--step-bg:var(--color-base-300)]"}`}
            ></li>
          </ul>
          <Card.Actions className="col-start-3 justify-self-end">
            {stage === 1 &&
              (!configReady ? (
                <Button
                  variant="primary"
                  className="ms-auto"
                  loading={mutation.isPending}
                  loadingLabel={t("setup.runSetup")}
                  disabled={mutation.isPending}
                  onClick={() => void runSetup(() => mutation.mutateAsync())}
                >
                  {mutation.isPending ? null : t("setup.runSetup")}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  className="ms-auto"
                  onClick={onGoToServiceToken}
                >
                  {t("setup.nextServiceToken")}
                  <ArrowRight
                    aria-hidden="true"
                    className={`size-4 ${rtlFlip}`}
                  />
                </Button>
              ))}
            {stage === 2 && (
              <Button variant="ghost" onClick={onLeaveServiceToken}>
                <ArrowLeft aria-hidden="true" className={`size-4 ${rtlFlip}`} />
                {t("setup.back")}
              </Button>
            )}
          </Card.Actions>
        </div>

        {stage === 1 ? (
          <div className="grid gap-4">
            {configReady && (
              <EnterDiv className="alert alert-success">
                <CheckCircle2 aria-hidden="true" className="size-5 shrink-0" />
                <div>{t("setup.setupComplete")}</div>
              </EnterDiv>
            )}
            <InitStepBoard steps={steps} org={org} />
          </div>
        ) : stage === 2 ? (
          <div className="px-20">
            <OrgSettingsPane />
          </div>
        ) : (
          <EnterDiv className="flex flex-col items-center gap-4 py-8 text-center">
            <div className="flex size-16 items-center justify-center rounded-full bg-success/10 text-success">
              <CheckCircle2 aria-hidden="true" className="size-9" />
            </div>
            <div>
              <h2 className="text-xl font-bold">{t("setup.allSetTitle")}</h2>
              <p className="mx-auto mt-1 max-w-md text-sm text-base-content/70">
                {t("setup.allSetBody")}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <RouterButton variant="primary" to="/$org" params={{ org }}>
                <span className="truncate">
                  {t("setup.goToOrg", {
                    org: org || t("setup.yourOrganization"),
                  })}
                </span>
                <ArrowRight
                  aria-hidden="true"
                  className={`size-4 shrink-0 ${rtlFlip}`}
                />
              </RouterButton>
              <Button variant="ghost" onClick={onManageToken}>
                {t("setup.manageServiceToken")}
              </Button>
            </div>
          </EnterDiv>
        )}
      </Card.Body>
    </Card>
  )
}

const NotAdminAlert = () => {
  const { t } = useTranslation()
  return <Alert tone="error">{t("setup.notAdmin")}</Alert>
}

const NotTeamOrEnterpriseNotice = () => {
  const { t } = useTranslation()
  return <Alert tone="error">{t("setup.notTeamOrEnterprise")}</Alert>
}

// Derive the wizard stage from what exists on GitHub (config repo + service
// token), matching the app's "behavior is derived from what exists" model. The
// stage is NOT local state: it survives reload/remount because it's read from
// GitHub. Backward navigation is the only local intent (see backOverride).
const STAGE_SETUP = 1
const STAGE_SERVICE_TOKEN = 2
const STAGE_DONE = 3

const OrgSetupPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.setup"))

  const { org } = useParams({ strict: false })
  const [steps, setSteps] =
    useState<Record<InitStepId, InitStepUpdate>>(initialInitSteps)
  const { data: orgPlanDetails, isLoading: isLoadingPlanDetails } =
    useGetOrgPlanDetails(org)

  // Match OrgSettingsPane's `org ?? ""` so react-query dedupes on one key
  // instead of forming a second cache entry.
  const orgKey = org ?? ""
  const repoStatusQuery = useOrgClassroom50Status(org)
  const tokenStatusQuery = useGetServiceTokenStatus(orgKey)

  const configReady = repoStatusQuery.data === "ready"
  const tokenPresent = tokenStatusQuery.data?.status === "present"

  // The derived FLOOR (survives reload/remount): a present token means the
  // whole setup is done. A ready config alone does NOT force stage 2 — the
  // teacher stays on step 1 to review the per-step board and advances with the
  // explicit "Next" button (configReady just swaps "Run setup" for "Next").
  const derivedStage = tokenPresent ? STAGE_DONE : STAGE_SETUP

  // Forward intent only ever raises the stage (never traps the user below a
  // derived advance). Backward intent (Back button, Manage-token) may drop
  // below the derived floor; a fresh derived advance clears it.
  const [forwardIntent, setForwardIntent] = useState(STAGE_SETUP)
  const [backOverride, setBackOverride] = useState<number | null>(null)

  const effectiveStage = backOverride ?? Math.max(derivedStage, forwardIntent)

  // A settled indeterminate probe is a 403/permission or transient error, NOT a
  // real "missing" — surfacing stage 1 "Run setup" here would invite a needless
  // skeleton-overwriting re-run, so show a retry surface instead. Both probes
  // now rethrow non-definitive errors, so react-query surfaces isError; the
  // token probe also resolves an explicit status:"unknown" for a 403. Gate the
  // isError branches on data being absent: a *background* refetch that fails
  // while prior data is still cached (a transient blip after a setup re-run, or
  // an optimistically-seeded token) must keep the derived stage, not eject the
  // user off a valid step. undefined data mid-flight is the loading case.
  const statusIndeterminate =
    (!repoStatusQuery.isLoading &&
      repoStatusQuery.isError &&
      repoStatusQuery.data === undefined) ||
    (!tokenStatusQuery.isLoading &&
      tokenStatusQuery.isError &&
      tokenStatusQuery.data === undefined) ||
    (!tokenStatusQuery.isLoading && tokenStatusQuery.data?.status === "unknown")
  const statusLoading = repoStatusQuery.isLoading || tokenStatusQuery.isLoading

  // Skeleton-overwrite confirmation, mirroring RerunOrgSetup. /setup has no
  // re-entry guard, so a re-run on an already-set-up org can hit drifted,
  // hand-edited skeleton files — prompt before overwriting rather than
  // clobbering silently.
  const { overwritePaths, resolveOverwrite, confirmSkeletonOverwrite } =
    useSkeletonOverwriteConfirm()

  const mutation = useRunOrgSetup({
    org,
    plan: orgPlanDetails?.plan?.name,
    onStepUpdate: (update) => {
      setSteps((steps) => applyStepUpdate(steps, update))
    },
    confirmSkeletonOverwrite,
    // Unmount-safe: the org-list refetch runs in the hook's onSuccess (init is
    // long-running and the user can navigate away). Always invalidate — even on
    // a status-"error" outcome — matching the prior unconditional invalidate.
    // Also refetch the config-repo probe so the derived stage advances to 2.
    invalidate: (queryClient) => {
      void queryClient.invalidateQueries({ queryKey: ["orgs"] })
      void queryClient.invalidateQueries({
        queryKey: orgClassroom50StatusKey(org),
      })
    },
  })

  // Reset the board before the init call (must run before mutateAsync), then
  // run setup. The board reset stays here (skipped on unmount); the cache
  // invalidation lives in the hook so it survives an unmount.
  const runSetupFlow = () => {
    // Reset the board before a (re-)run so a prior run's per-step results —
    // including the orgDefaults unenforced-settings list — can't linger on an
    // error path that emits no fresh data. Mirrors RerunOrgSetup.
    setSteps(initialInitSteps)
    return mutation.mutateAsync(undefined, {
      onSuccess: (data) => {
        // Don't advance if a prerequisite step failed; initClassroom50 resolves
        // with status "error" rather than throwing.
        if (data && data.status === "error") {
          return
        }
        // Stay on step 1 after setup so the teacher can review per-step
        // results; the derived stage (configReady) surfaces the "Next" button.
        void repoStatusQuery.refetch()
      },
    })
  }

  // Owner gate via the shared fail-closed verdict. /setup is NOT behind
  // RequireOwner, so this page owns the pending/error/deny branches: hold a
  // spinner while unresolved, offer a retry on a settled transient error, and
  // only assert "not an admin" on a definitive non-owner (never mid-load).
  const { isOwner, isPending: ownerPending, isError, retry } = useIsOrgOwner()
  const isTeamOrEnterprise =
    orgPlanDetails?.plan?.name === "team" ||
    orgPlanDetails?.plan?.name === "enterprise"

  const retryStatus = () => {
    void repoStatusQuery.refetch()
    void tokenStatusQuery.refetch()
  }

  return (
    <PageShell page="classes" selected="assignments">
      <PageHeader
        title={t("setup.pageHeading")}
        subtitle={t("setup.pageSubheading")}
      />
      {!isLoadingPlanDetails && !isTeamOrEnterprise && (
        <NotTeamOrEnterpriseNotice />
      )}
      {ownerPending && <Spinner label={t("setup.loadingSetup")} />}
      {isError && (
        <QueryErrorAlert
          message={t("error.roleResolveFailed")}
          onRetry={retry}
        />
      )}
      {!ownerPending && !isError && !isOwner && <NotAdminAlert />}
      {!ownerPending &&
        !isError &&
        isOwner &&
        (statusLoading ? (
          <Spinner label={t("setup.loadingSetup")} />
        ) : statusIndeterminate ? (
          <QueryErrorAlert
            message={t("setup.statusIndeterminate")}
            onRetry={retryStatus}
          />
        ) : (
          <OrgSteps
            steps={steps}
            mutation={{
              isPending: mutation.isPending,
              mutateAsync: runSetupFlow,
            }}
            configReady={configReady}
            org={org}
            stage={effectiveStage}
            onGoToServiceToken={() => {
              setBackOverride(null)
              setForwardIntent(STAGE_SERVICE_TOKEN)
            }}
            // Leaving the token step returns to the derived floor: stage 1 when
            // no token is set (the review board), or stage 3 when a token is
            // present (the "Manage service token" round-trip from the finish
            // screen). Reset both overrides so max(derivedStage, forwardIntent)
            // governs — otherwise the stale forwardIntent would pin stage 2.
            onLeaveServiceToken={() => {
              setBackOverride(null)
              setForwardIntent(STAGE_SETUP)
            }}
            onManageToken={() => setBackOverride(STAGE_SERVICE_TOKEN)}
          />
        ))}

      <SkeletonOverwriteModal
        paths={overwritePaths}
        onConfirm={() => resolveOverwrite(true)}
        onClose={() => resolveOverwrite(false)}
      />
    </PageShell>
  )
}

export default OrgSetupPage
