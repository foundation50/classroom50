import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  CheckCircle2,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  TriangleAlert,
  XCircle,
} from "lucide-react"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys } from "@/hooks/github/queries"
import { renameConfigRepoToMain } from "@/hooks/github/mutations"
import { Button, Spinner } from "@/components/ui"
import { ConfirmModal } from "@/components/modals"
import PlanBadge from "@/components/PlanBadge"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import useGetOrgAudit from "@/hooks/useGetOrgAudit"
import { useIsOrgOwner } from "@/context/orgRole/useIsOrgOwner"
import useGetOrgPlanDetails from "@/hooks/useGetOrgPlanDetails"
import type {
  AuditVerdict,
  ConcernCheck,
  ConcernId,
  OrgAuditReport,
  OrgRecommendation,
} from "@/orgPolicy/audit"
import { REPAIRABLE_CONCERNS, repairConcern } from "@/orgPolicy/repair"
import type { RepairResult } from "@/orgPolicy/repair"
import { mergeUnresolved, readUnresolved } from "@/orgPolicy/unresolvedStore"
import type { CheckState } from "@/hooks/github/orgChecks"
import SettingsSection from "./SettingsSection"
import { UnenforcedDefaultsList } from "./UnenforcedDefaultsList"
import {
  toUnenforcedItems,
  type UnenforcedDefaultItem,
} from "./orgDefaultsStepData"
import { CalloutDiv } from "@/lib/motionComponents"

// Org policy audit pane: surfaces every policy concern with its live drift
// verdict, the unenforced member-default fields (each with a manual fix), and
// the API-less manual steps. Each drifted, API-repairable concern gets an
// owner-gated "Fix it"; Re-run Setup is the "repair everything" alternative.
// Mirrors the service-token pane's banner shape.

const VERDICT_BANNER: Record<
  AuditVerdict,
  {
    className: string
    Icon: typeof CheckCircle2
    iconClassName: string
    titleKey: string
  }
> = {
  ok: {
    className: "border-success/30 bg-success/10",
    Icon: CheckCircle2,
    iconClassName: "text-success",
    titleKey: "orgSettings.audit.verdictOk",
  },
  fail: {
    className: "border-error/30 bg-error/10",
    Icon: XCircle,
    iconClassName: "text-error",
    titleKey: "orgSettings.audit.verdictFail",
  },
}

const CONCERN_STATE_LABEL: Record<CheckState, string> = {
  enforced: "orgSettings.audit.stateEnforced",
  unenforced: "orgSettings.audit.stateUnenforced",
  unreadable: "orgSettings.audit.stateUnreadable",
}

const CONCERN_STATE_BADGE: Record<CheckState, string> = {
  enforced: "badge-success",
  unenforced: "badge-error",
  unreadable: "badge-neutral badge-ghost",
}

// What a Fix-it result means for the pane, derived purely from the RepairResult
// so the transient-vs-persist decision is unit-testable without a render.
// `pinnedFields` are what gets written to the per-org store (transient failures
// are deliberately excluded); `transientNotice` drives the retry hint.
export type RepairOutcome = {
  pinnedFields: string[]
  unresolvedConcern: string | null
  transientNotice: boolean
}

export function classifyRepairOutcome(result: RepairResult): RepairOutcome {
  const transient = result.unresolved?.transient === true
  return {
    pinnedFields: result.unfixableFields,
    // A transient failure is retryable — never recorded as a manual-setup concern.
    unresolvedConcern:
      result.unresolved && !transient ? result.unresolved.message : null,
    transientNotice: transient,
  }
}

export function ConcernRow({
  concern,
  canFix,
  fixing,
  onFix,
  driftedDetails,
  unresolvedMessage,
}: {
  concern: ConcernCheck
  canFix: boolean
  fixing: boolean
  onFix: (id: ConcernId) => void
  driftedDetails?: UnenforcedDefaultItem[]
  // When set, a prior Fix-it attempt didn't complete — carries the
  // attempted-action message. We suppress "Fix it" and show a cause-neutral
  // "needs manual setup" state instead.
  unresolvedMessage?: string
}) {
  const { t } = useTranslation()
  const isDrifted = concern.verdict.state === "unenforced"
  // Hide "Fix it" when every drifted member-default is enterprise-pinned — the
  // API write can't change them, so the button would do nothing.
  const allPinned =
    driftedDetails !== undefined &&
    driftedDetails.length > 0 &&
    driftedDetails.every((d) => d.pinned)
  const showFix =
    isDrifted &&
    canFix &&
    REPAIRABLE_CONCERNS.has(concern.id) &&
    !allPinned &&
    unresolvedMessage === undefined

  return (
    <div className="rounded-lg border border-base-300 bg-base-100 p-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{concern.title}</div>
          {concern.verdict.detail && (
            <p className="mt-0.5 text-xs text-base-content/70">
              {concern.verdict.detail}
            </p>
          )}
          {unresolvedMessage !== undefined && (
            <p className="mt-1 text-xs text-base-content/70">
              {t("orgSettings.audit.couldntAutoConfigure")}
            </p>
          )}
          <a
            href={concern.settingsUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-xs text-base-content/70 hover:text-primary"
          >
            {t("orgSettings.audit.viewOnGitHub")}
            <ExternalLink aria-hidden="true" className="size-3" />
          </a>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {showFix && (
            <Button
              variant="primary"
              size="xs"
              loading={fixing}
              disabled={fixing}
              onClick={() => onFix(concern.id)}
            >
              {fixing ? null : t("orgSettings.audit.fixIt")}
            </Button>
          )}
          {unresolvedMessage !== undefined && (
            <span className="badge badge-warning badge-soft">
              {t("orgSettings.audit.needsManualSetup")}
            </span>
          )}
          <span
            className={`badge ${CONCERN_STATE_BADGE[concern.verdict.state]}`}
          >
            {t(CONCERN_STATE_LABEL[concern.verdict.state])}
          </span>
        </div>
      </div>

      {isDrifted && driftedDetails && driftedDetails.length > 0 && (
        <div className="mt-3 border-t border-base-200 pt-3">
          <p className="text-xs font-medium text-base-content/70">
            {t("orgSettings.audit.settingsNeedFixing", {
              count: driftedDetails.length,
            })}{" "}
            {t("orgSettings.audit.changeThemOn", {
              count: driftedDetails.length,
            })}{" "}
            <a
              href={concern.settingsUrl}
              target="_blank"
              rel="noreferrer"
              className="link inline-flex items-center gap-0.5"
            >
              {t("orgSettings.audit.gitHub")}
              <ExternalLink aria-hidden="true" className="size-3" />
            </a>
            {showFix ? t("orgSettings.audit.orUseFixIt") : ""}:
          </p>
          <UnenforcedDefaultsList items={driftedDetails} />
        </div>
      )}
    </div>
  )
}

function RecommendationRow({
  rec,
  canFix,
  fixing,
  onRenameConfigRepo,
}: {
  rec: OrgRecommendation
  canFix: boolean
  fixing: boolean
  onRenameConfigRepo: () => void
}) {
  const { t } = useTranslation()
  const isConfigRepo = rec.id === "configRepoDefaultBranch"
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-warning/40 bg-warning/5 p-3">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-base-content/80">
          <TriangleAlert
            aria-hidden="true"
            className="size-4 shrink-0 text-warning"
          />
          {rec.title}
        </div>
        <p className="mt-0.5 text-xs text-base-content/70">
          {isConfigRepo
            ? t("orgSettings.audit.configBranchRec", { current: rec.detail })
            : t("orgSettings.audit.defaultBranchRec", { current: rec.detail })}
        </p>
        <a
          href={rec.settingsUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-flex items-center gap-1 text-xs text-base-content/70 hover:text-primary"
        >
          {t("orgSettings.audit.viewOnGitHub")}
          <ExternalLink aria-hidden="true" className="size-3" />
        </a>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {isConfigRepo && canFix && (
          <Button
            variant="primary"
            size="xs"
            loading={fixing}
            disabled={fixing}
            onClick={onRenameConfigRepo}
          >
            {fixing ? null : t("orgSettings.audit.renameToMain")}
          </Button>
        )}
        <span className="badge badge-warning badge-soft">
          {t("orgSettings.audit.recommended")}
        </span>
      </div>
    </div>
  )
}

function AuditBody({
  report,
  canFix,
  fixingId,
  fixingConfigBranch,
  enterprisePinned,
  unresolvedConcerns,
  onFix,
  onRenameConfigRepo,
}: {
  report: OrgAuditReport
  canFix: boolean
  fixingId: ConcernId | null
  fixingConfigBranch: boolean
  enterprisePinned: Set<string>
  unresolvedConcerns: Map<ConcernId, string>
  onFix: (id: ConcernId) => void
  onRenameConfigRepo: () => void
}) {
  const { t } = useTranslation()
  const banner = VERDICT_BANNER[report.verdict]
  const { Icon } = banner
  const [showPermissions, setShowPermissions] = useState(false)

  return (
    <>
      <CalloutDiv
        className={[
          "mt-4 flex items-start gap-3 rounded-xl border p-4 text-sm",
          banner.className,
        ].join(" ")}
      >
        <Icon className={`mt-0.5 size-5 shrink-0 ${banner.iconClassName}`} />
        <div className="min-w-0">
          <p className="font-semibold text-base-content">
            {t(banner.titleKey)}
          </p>
          {!report.readOk && (
            <p className="mt-1 text-base-content/70">
              {t("orgSettings.audit.readError")}
            </p>
          )}
          {report.readOk && report.verdict !== "ok" && (
            <p className="mt-1 text-base-content/70">
              {canFix
                ? t("orgSettings.audit.driftCanFix")
                : t("orgSettings.audit.driftCannotFix")}
            </p>
          )}
        </div>
      </CalloutDiv>

      {report.recommendations.length > 0 && (
        <div className="mt-4">
          <div className="grid gap-2">
            {report.recommendations.map((rec) => (
              <RecommendationRow
                key={rec.id}
                rec={rec}
                canFix={canFix}
                fixing={fixingConfigBranch}
                onRenameConfigRepo={onRenameConfigRepo}
              />
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-2">
        {report.concerns.map((c) => (
          <ConcernRow
            key={c.id}
            concern={c}
            canFix={canFix}
            fixing={fixingId === c.id}
            onFix={onFix}
            unresolvedMessage={unresolvedConcerns.get(c.id)}
            driftedDetails={
              c.id === "orgDefaults"
                ? toUnenforcedItems(report.unenforcedDefaults, enterprisePinned)
                : undefined
            }
          />
        ))}
      </div>

      {report.manualUnreadable.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold">
            {t("orgSettings.audit.confirmByHand")}
          </h3>
          <p className="mt-1 text-xs text-base-content/70">
            {t("orgSettings.audit.confirmByHandBody")}
          </p>
          <div className="mt-2 grid gap-2">
            {report.manualUnreadable.map((step) => (
              <div
                key={step.setting}
                className="flex items-start justify-between gap-4 rounded-lg border border-warning/40 bg-warning/5 p-3"
              >
                <div className="min-w-0">
                  <div className="text-sm text-base-content/80">
                    {step.setting}
                  </div>
                  <a
                    href={step.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-xs text-base-content/70 hover:text-primary"
                  >
                    {t("orgSettings.audit.viewOnGitHub")}
                    <ExternalLink aria-hidden="true" className="size-3" />
                  </a>
                </div>
                <span className="badge badge-warning badge-soft shrink-0">
                  {t("orgSettings.audit.confirmManually")}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {report.defaultVerdicts.length > 0 && (
        <div className="mt-6">
          <button
            type="button"
            className="flex items-center gap-1 text-sm font-semibold hover:text-primary"
            aria-expanded={showPermissions}
            onClick={() => setShowPermissions((open) => !open)}
          >
            {showPermissions ? (
              <ChevronUp aria-hidden="true" className="size-4" />
            ) : (
              <ChevronRight aria-hidden="true" className="size-4" />
            )}
            {t("orgSettings.audit.memberPermsToggle")}
          </button>
          {showPermissions && (
            <>
              <p className="mt-1 text-xs text-base-content/70">
                {t("orgSettings.audit.memberPermsHint")}
              </p>
              <ul className="mt-2 space-y-1 text-sm">
                {report.defaultVerdicts.map((v) => (
                  <li
                    key={v.setting.field}
                    className="flex items-start justify-between gap-3"
                  >
                    <span className="text-base-content/70">
                      {v.setting.desc}
                      {!v.enforced && v.setting.manualFix && (
                        <span className="text-base-content/70">
                          {" "}
                          — {v.setting.manualFix}
                        </span>
                      )}
                    </span>
                    {v.enforced ? (
                      <CheckCircle2
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0 text-success"
                      />
                    ) : (
                      <TriangleAlert
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0 text-warning"
                      />
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </>
  )
}

const OrgPolicyAuditPane = ({ org }: { org: string }) => {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const runFix = useSafeSubmit()
  const { data: planDetails } = useGetOrgPlanDetails(org)
  // Owner gate; redundant with the page's RequireOwner (see TeardownSection).
  const { isOwner } = useIsOrgOwner()

  // Fields a Fix it / re-run wrote that didn't stick on read-back; we stop
  // offering a Fix it for them since it can't work. (See OrgDefaultsStepData.)
  // Seeded from storage; the `key={org}` remount re-reads on org switch.
  const [enterprisePinned, setEnterprisePinned] = useState<Set<string>>(
    () => readUnresolved(org).fields,
  )
  // Concern-level outcomes: a branchProtection/rulesets Fix-it that didn't
  // complete. Maps concern id -> the attempted-action message we show. Storage
  // keeps ids only, so a restored entry has an empty message and falls back to
  // the generic couldntAutoConfigure copy.
  const [unresolvedConcerns, setUnresolvedConcerns] = useState<
    Map<ConcernId, string>
  >(() => {
    const stored = readUnresolved(org).concerns
    const map = new Map<ConcernId, string>()
    for (const id of stored) map.set(id as ConcernId, "")
    return map
  })
  // A transient failure (rate limit / repo still initializing) — surfaced as a
  // retry notice rather than a permanent manual-setup flip.
  const [transientNotice, setTransientNotice] = useState(false)

  const {
    data: report,
    isLoading,
    isError,
  } = useGetOrgAudit(org, planDetails?.plan?.name)

  const fixMutation = useMutation({
    mutationFn: (id: ConcernId) =>
      repairConcern(client, org, id, planDetails?.plan?.name),
    onSuccess: (result, id) => {
      const outcome = classifyRepairOutcome(result)
      setTransientNotice(outcome.transientNotice)
      if (outcome.pinnedFields.length > 0) {
        setEnterprisePinned((prev) => {
          const next = new Set(prev)
          for (const f of outcome.pinnedFields) next.add(f)
          return next
        })
        mergeUnresolved(org, { fields: outcome.pinnedFields })
      }
      if (outcome.unresolvedConcern !== null) {
        const message = outcome.unresolvedConcern
        setUnresolvedConcerns((prev) => {
          const next = new Map(prev)
          next.set(id, message)
          return next
        })
        mergeUnresolved(org, { concerns: [id] })
      }
      void queryClient.invalidateQueries({
        queryKey: githubKeys.orgAuditPrefix(org),
      })
    },
  })
  // The concern currently being repaired, so only its button shows a spinner.
  const fixingId = fixMutation.isPending
    ? (fixMutation.variables ?? null)
    : null

  // Renaming the config repo to `main` is a separate flow: it's a recommendation
  // (not a concern) and destructive to already-accepted student shims, so it's
  // gated behind a confirm modal rather than an inline Fix-it.
  const [confirmRename, setConfirmRename] = useState(false)
  const renameMutation = useMutation({
    mutationFn: () => renameConfigRepoToMain(client, org),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.orgAuditPrefix(org),
      })
    },
  })

  return (
    <SettingsSection
      title={t("orgSettings.audit.title")}
      titleAdornment={
        <PlanBadge
          name={planDetails?.plan?.name}
          title={t("orgSettings.audit.planBadgeTitle")}
        />
      }
      description={t("orgSettings.audit.description")}
      action={
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void queryClient.invalidateQueries({
              queryKey: githubKeys.orgAuditPrefix(org),
            })
          }}
        >
          {t("orgSettings.audit.recheck")}
        </Button>
      }
    >
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-base-content/70">
          <Spinner size="sm" />
          {t("orgSettings.audit.auditing")}
        </div>
      )}

      {isError && (
        <div className="flex items-start gap-2 rounded-lg border border-error/30 bg-error/10 p-3 text-sm text-error">
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0"
          />
          <span>{t("orgSettings.audit.auditError")}</span>
        </div>
      )}

      {fixMutation.isError && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-error/30 bg-error/10 p-3 text-sm text-error">
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0"
          />
          <span>{t("orgSettings.audit.fixError")}</span>
        </div>
      )}

      {transientNotice && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0"
          />
          <span>{t("orgSettings.audit.fixTransient")}</span>
        </div>
      )}

      {report && (
        <AuditBody
          report={report}
          canFix={Boolean(isOwner)}
          fixingId={fixingId}
          fixingConfigBranch={renameMutation.isPending}
          enterprisePinned={enterprisePinned}
          unresolvedConcerns={unresolvedConcerns}
          onFix={(id) => {
            if (!fixMutation.isPending)
              void runFix(() => fixMutation.mutateAsync(id))
          }}
          onRenameConfigRepo={() => setConfirmRename(true)}
        />
      )}

      <ConfirmModal
        open={confirmRename}
        title={t("orgSettings.audit.renameModalTitle")}
        description={t("orgSettings.audit.renameModalBody")}
        confirmLabel={t("orgSettings.audit.renameToMain")}
        dangerous
        needsConfirm={false}
        onConfirm={() => renameMutation.mutateAsync().then(() => undefined)}
        onClose={() => setConfirmRename(false)}
      />
    </SettingsSection>
  )
}

export default OrgPolicyAuditPane
