import { useState } from "react"
import { useTranslation } from "react-i18next"
import { PauseCircle, PlayCircle } from "lucide-react"

import { Badge, Spinner } from "@/components/ui"
import { ConfirmModal } from "@/components/modals"
import { CalloutDiv } from "@/lib/motionComponents"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import useGetOrgActionsMode from "@/hooks/useGetOrgActionsMode"
import { useSetOrgActionsMode } from "@/hooks/mutations/useSetOrgActionsMode"
import SettingsSection from "./SettingsSection"

const ACTIONS_ANCHOR = "github-actions"

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
  const unknown = mode === "unknown"

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
          <Badge tone={paused ? "warning" : "success"} size="sm">
            {paused
              ? t("orgSettings.actions.statusPaused")
              : t("orgSettings.actions.statusActive")}
          </Badge>
        )
      }
    >
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-base-content/70">
          <Spinner /> {t("orgSettings.actions.loading")}
        </div>
      ) : (
        <div className="space-y-4">
          <label
            htmlFor="autograde-pause-toggle"
            className="flex items-start gap-3"
          >
            <input
              id="autograde-pause-toggle"
              type="checkbox"
              className="toggle toggle-warning mt-0.5"
              checked={paused}
              disabled={mutation.isPending || unknown}
              aria-label={t("orgSettings.actions.toggleLabel")}
              onChange={(e) => {
                const wantPause = e.target.checked
                if (mutation.isPending) return
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
            <CalloutDiv className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-base-content/80">
              <PauseCircle
                className="mt-0.5 size-4 shrink-0 text-warning"
                aria-hidden="true"
              />
              <span>{t("orgSettings.actions.pausedNotice")}</span>
            </CalloutDiv>
          )}

          {!paused && !unknown && !mutation.isPending && (
            <div className="flex items-start gap-2 text-sm text-base-content/60">
              <PlayCircle
                className="mt-0.5 size-4 shrink-0 text-success"
                aria-hidden="true"
              />
              <span>{t("orgSettings.actions.activeNotice")}</span>
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
