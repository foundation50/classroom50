import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ExternalLink } from "lucide-react"

import { Badge, Spinner } from "@/components/ui"
import { ConfirmModal } from "@/components/modals"
import { CalloutDiv } from "@/lib/motionComponents"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import { githubOrgActionsSettingsUrl } from "@/util/orgUrl"
import { orgBudgetsUrl } from "@/orgPolicy/budget"
import { includedActionsMinutes } from "@/github-core/queries"
import useGetOrgActionsMode from "@/hooks/useGetOrgActionsMode"
import useGetOrgActionsUsage from "@/hooks/useGetOrgActionsUsage"
import useGetOrgActionsBudget from "@/hooks/useGetOrgActionsBudget"
import useGetOrgPlanDetails from "@/hooks/useGetOrgPlanDetails"
import { useSetOrgActionsMode } from "@/hooks/mutations/useSetOrgActionsMode"
import SettingsSection from "./SettingsSection"

const ACTIONS_ANCHOR = "github-actions"

// This-month Actions usage visualized against the plan's included-minutes quota,
// plus the org's spending-budget status. All advisory: each piece renders only
// when its data is readable (billing/plan are owner-only and enhanced-billing
// gated), so a billing-blind org still shows the kill switch with nothing here.
const ActionsUsagePanel = ({ org }: { org: string }) => {
  const { t } = useTranslation()
  const { data: usage } = useGetOrgActionsUsage(org)
  const { data: budget } = useGetOrgActionsBudget(org)
  const { data: orgDetails } = useGetOrgPlanDetails(org)

  const included = includedActionsMinutes(orgDetails?.plan?.name)
  const used = usage?.minutes ?? 0
  // Clamp the bar at 100% but keep the real numbers in the label.
  const pct =
    included && included > 0 ? Math.min(100, (used / included) * 100) : 0
  const overQuota = included !== null && used > included
  // Blue by default; yellow past 50%; red past 75%.
  const barTone =
    pct >= 75
      ? "progress-error"
      : pct >= 50
        ? "progress-warning"
        : "progress-primary"

  if (!usage && !budget) return null

  return (
    <div className="space-y-3 rounded-lg border border-base-300 bg-base-200/40 p-3">
      {usage && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="font-medium">
              {t("orgSettings.actions.usageTitle")}
            </span>
            <span className="text-base-content/70">
              {included !== null
                ? t("orgSettings.actions.usageOfIncluded", {
                    used: used.toLocaleString(),
                    included: included.toLocaleString(),
                  })
                : t("orgSettings.actions.usageMinutes", {
                    minutes: used.toLocaleString(),
                  })}
            </span>
          </div>

          {included !== null && (
            <progress
              className={"progress w-full " + barTone}
              value={pct}
              max={100}
              aria-label={t("orgSettings.actions.usageTitle")}
            />
          )}

          <p className="text-xs text-base-content/60">
            {t("orgSettings.actions.usageCost", {
              amount: usage.netAmountUsd.toFixed(2),
            })}
            {overQuota
              ? " " +
                t("orgSettings.actions.usageOverQuota", {
                  over: (used - (included ?? 0)).toLocaleString(),
                })
              : ""}
          </p>
        </div>
      )}

      {budget && (
        <p className="flex flex-wrap items-center gap-1.5 border-t border-base-300 pt-2 text-xs text-base-content/70">
          <span>
            {budget.tier === "missing"
              ? t("orgSettings.actions.budgetNone")
              : budget.amount === 0
                ? t("orgSettings.actions.budgetHardStop")
                : t("orgSettings.actions.budgetAmount", {
                    amount: budget.amount,
                  })}
          </span>
          <a
            href={orgBudgetsUrl(org)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 text-base-content/60 hover:text-primary"
          >
            {t("orgSettings.actions.budgetManage")}
            <ExternalLink aria-hidden="true" className="size-3" />
          </a>
        </p>
      )}
    </div>
  )
}

// GitHub Actions kill switch. Pausing restricts org Actions to the config repo
// only, which blocks every student repo's autograde shim from running (and the
// paid minutes it would bill) while the config repo's own workflows keep
// running. A live-derived toggle: it reflects whatever the org policy reports,
// with no separate stored state.
const OrgActionsSection = ({ org }: { org: string }) => {
  const { t } = useTranslation()
  const { notify } = useToast()
  const runToggle = useSafeSubmit()
  const [confirmPause, setConfirmPause] = useState(false)

  const { data: mode, isLoading } = useGetOrgActionsMode(org)
  const mutation = useSetOrgActionsMode(org)

  const paused = mode === "paused"
  const disabled = mode === "disabled"
  const unknown = mode === "unknown"
  // The toggle can't be operated when we can't read the policy (unknown) or
  // when Actions are off org-wide (disabled) — neither is a pause we own.
  const toggleDisabled = mutation.isPending || unknown || disabled

  const applyMode = (next: "paused" | "active") =>
    mutation.mutateAsync(next, {
      onSuccess: (result) => {
        notify({
          tone: result.status === "complete" ? "success" : "warning",
          message: result.message,
        })
      },
      onError: (err) => {
        notify({
          tone: "error",
          message: t("orgSettings.actions.toggleFailed", {
            message: err instanceof Error ? err.message : String(err),
          }),
        })
      },
    })

  return (
    <SettingsSection
      id={ACTIONS_ANCHOR}
      title={t("orgSettings.actions.title")}
      description={t("orgSettings.actions.description")}
      titleAdornment={
        isLoading ? undefined : (
          <Badge
            tone={paused ? "warning" : disabled ? "neutral" : "success"}
            size="sm"
          >
            {paused
              ? t("orgSettings.actions.statusPaused")
              : disabled
                ? t("orgSettings.actions.statusDisabled")
                : t("orgSettings.actions.statusActive")}
          </Badge>
        )
      }
      action={
        <a
          href={githubOrgActionsSettingsUrl(org)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-base-content/70 hover:text-primary"
        >
          {t("orgSettings.actions.openSettings")}
          <ExternalLink aria-hidden="true" className="size-3" />
        </a>
      }
    >
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-base-content/70">
          <Spinner /> {t("orgSettings.actions.loading")}
        </div>
      ) : (
        <div className="space-y-4">
          <ActionsUsagePanel org={org} />

          <label
            htmlFor="autograde-pause-toggle"
            className="flex items-start gap-3"
          >
            <input
              id="autograde-pause-toggle"
              type="checkbox"
              className="toggle toggle-warning mt-0.5"
              checked={paused}
              disabled={toggleDisabled}
              aria-label={t("orgSettings.actions.toggleLabel")}
              onChange={(e) => {
                const wantPause = e.target.checked
                if (toggleDisabled) return
                if (wantPause) {
                  setConfirmPause(true)
                  return
                }
                void runToggle(() => applyMode("active"))
              }}
            />
            <span className="text-sm">
              <span className="font-semibold">
                {t("orgSettings.actions.toggleLabel")}
              </span>
              <span className="block text-base-content/70">
                {t("orgSettings.actions.toggleHint")}
              </span>
            </span>
          </label>

          {mutation.isPending && (
            <div className="flex items-center gap-2 text-sm text-base-content/70">
              <Spinner /> {t("orgSettings.actions.applying")}
            </div>
          )}

          {paused && !mutation.isPending && (
            <CalloutDiv className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-base-content/80">
              {t("orgSettings.actions.pausedNotice")}
            </CalloutDiv>
          )}

          {disabled && !mutation.isPending && (
            <div className="rounded-lg border border-base-300 bg-base-200/50 p-3 text-sm text-base-content/70">
              {t("orgSettings.actions.disabledNotice")}
            </div>
          )}

          {unknown && (
            <div className="rounded-lg border border-base-300 bg-base-200/50 p-3 text-sm text-base-content/70">
              {t("orgSettings.actions.unknownNotice")}
            </div>
          )}
        </div>
      )}

      <ConfirmModal
        open={confirmPause}
        dangerous={false}
        needsConfirm={false}
        title={t("orgSettings.actions.confirmTitle")}
        description={t("orgSettings.actions.confirmBody")}
        confirmLabel={t("orgSettings.actions.confirmButton")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => applyMode("paused").then(() => undefined)}
        onClose={() => setConfirmPause(false)}
      />
    </SettingsSection>
  )
}

export default OrgActionsSection
