import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Activity, ExternalLink, PauseCircle, PlayCircle } from "lucide-react"

import { Badge, MonoLtr, Spinner } from "@/components/ui"
import { ConfirmModal } from "@/components/modals"
import { CalloutDiv } from "@/lib/motionComponents"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import { CONFIG_REPO } from "@/util/configRepo"
import { githubOrgActionsSettingsUrl } from "@/util/orgUrl"
import useGetOrgActionsMode from "@/hooks/useGetOrgActionsMode"
import useGetOrgActionsUsage from "@/hooks/useGetOrgActionsUsage"
import { useSetOrgActionsMode } from "@/hooks/mutations/useSetOrgActionsMode"
import SettingsSection from "./SettingsSection"

const ACTIONS_ANCHOR = "github-actions"

// This-month Actions usage (minutes + $), shown when billing is readable. A
// small advisory row, not a gate — renders nothing when usage is unavailable.
const ActionsUsageRow = ({ org }: { org: string }) => {
  const { t } = useTranslation()
  const { data: usage, isLoading } = useGetOrgActionsUsage(org)

  if (isLoading || !usage) return null

  return (
    <div className="flex items-start gap-2 text-sm text-base-content/70">
      <Activity className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>
        {t("orgSettings.actions.usageThisMonth", {
          minutes: usage.minutes.toLocaleString(),
          amount: usage.netAmountUsd.toFixed(2),
        })}
      </span>
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
          <ActionsUsageRow org={org} />

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

          {/* Make the exact org setting we apply legible, not implied. */}
          {!unknown && (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-base-content/60">
              <span>{t("orgSettings.actions.appliedLabel")}</span>
              <MonoLtr className="rounded bg-base-200 px-1.5 py-0.5 text-[11px]">
                {paused
                  ? `enabled_repositories = selected (${CONFIG_REPO})`
                  : disabled
                    ? "enabled_repositories = none"
                    : "enabled_repositories = all"}
              </MonoLtr>
            </p>
          )}

          {mutation.isPending && (
            <div className="flex items-center gap-2 text-sm text-base-content/70">
              <Spinner /> {t("orgSettings.actions.applying")}
            </div>
          )}

          {paused && !mutation.isPending && (
            <CalloutDiv className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-base-content/80">
              <PauseCircle
                className="mt-0.5 size-4 shrink-0 text-warning"
                aria-hidden="true"
              />
              <span>{t("orgSettings.actions.pausedNotice")}</span>
            </CalloutDiv>
          )}

          {!paused && !disabled && !unknown && !mutation.isPending && (
            <div className="flex items-start gap-2 text-sm text-base-content/60">
              <PlayCircle
                className="mt-0.5 size-4 shrink-0 text-success"
                aria-hidden="true"
              />
              <span>{t("orgSettings.actions.activeNotice")}</span>
            </div>
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
