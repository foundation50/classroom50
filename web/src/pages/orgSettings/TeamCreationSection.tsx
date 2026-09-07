import { useState } from "react"
import { useTranslation } from "react-i18next"

import { Badge, InlineSpinner, OutcomeAlert, Toggle } from "@/components/ui"
import type { AlertOutcome } from "@/components/ui"
import { LinkExternalIcon } from "@/components/ui/icons"
import { useToast } from "@/context/notifications/NotificationProvider"
import useGetOrgPlanDetails from "@/hooks/useGetOrgPlanDetails"
import useUpdateOrgTeamCreation from "@/hooks/mutations/useUpdateOrgTeamCreation"
import { sectionHighlightClass } from "@/hooks/useHashSectionHighlight"
import { memberPrivilegesUrl } from "@/orgPolicy/desiredState"
import { errorText } from "@/types/localizedMessage"
import SettingsSection from "./SettingsSection"

export const TEAM_CREATION_ANCHOR = "member-team-creation"

// The org's "Allow members to create teams" member privilege, surfaced in-app
// because student-formed group assignments depend on it: with team_formation:
// student the founding student creates the GitHub team at accept, so the org
// must let members create teams. Live-derived like the Actions kill switch —
// the toggle reflects GET /orgs/{org} with no stored state. Owner-gated by the
// page (RequireRole) like every neighboring section; GitHub omits the field
// for non-admin readers, so an unreadable value renders a notice instead of a
// toggle that lies.
const TeamCreationSection = ({
  org,
  highlighted,
}: {
  org: string
  highlighted?: boolean
}) => {
  const { t } = useTranslation()
  const { announce } = useToast()
  const { data: orgDetails, isLoading } = useGetOrgPlanDetails(org)
  const mutation = useUpdateOrgTeamCreation(org)
  const [outcome, setOutcome] = useState<AlertOutcome | null>(null)

  const live = orgDetails?.members_can_create_teams
  const unknown = !isLoading && live === undefined
  const enabled = live === true

  return (
    <SettingsSection
      id={TEAM_CREATION_ANCHOR}
      className={sectionHighlightClass(highlighted ?? false)}
      title={t("orgSettings.teamCreation.title")}
      description={t("orgSettings.teamCreation.description")}
      titleAdornment={
        isLoading || unknown ? undefined : (
          <Badge tone={enabled ? "success" : "warning"} size="sm">
            {enabled
              ? t("orgSettings.teamCreation.statusOn")
              : t("orgSettings.teamCreation.statusOff")}
          </Badge>
        )
      }
      action={
        <a
          href={memberPrivilegesUrl(org)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-base-content/70 hover:text-primary"
        >
          {t("orgSettings.teamCreation.openSettings")}
          <LinkExternalIcon aria-hidden="true" className="size-4" />
        </a>
      }
    >
      {isLoading ? (
        <div
          role="status"
          className="flex items-center gap-2 text-sm text-base-content/70"
        >
          <InlineSpinner size="md" /> {t("orgSettings.teamCreation.loading")}
        </div>
      ) : unknown ? (
        <div className="rounded-field border border-base-300 bg-base-100 p-3 text-sm text-base-content/70">
          {t("orgSettings.teamCreation.unknownNotice")}
        </div>
      ) : (
        <div className="space-y-4">
          <OutcomeAlert
            outcome={outcome}
            className="text-sm"
            onDismiss={() => setOutcome(null)}
          />

          <label
            htmlFor="member-team-creation-toggle"
            className="flex items-start gap-3"
          >
            <Toggle
              id="member-team-creation-toggle"
              className="mt-0.5"
              checked={enabled}
              disabled={mutation.isPending}
              aria-label={t("orgSettings.teamCreation.toggleLabel")}
              onChange={(e) => {
                if (mutation.isPending) return
                setOutcome(null)
                mutation.mutate(e.target.checked, {
                  onSuccess: (_updated, allow) => {
                    announce(
                      allow
                        ? t("orgSettings.teamCreation.enabledToast")
                        : t("orgSettings.teamCreation.disabledToast"),
                    )
                  },
                  onError: (err) => {
                    setOutcome({
                      tone: "error",
                      message: t("orgSettings.teamCreation.toggleFailed", {
                        message: errorText(t, err),
                      }),
                    })
                  },
                })
              }}
            />
            <span className="text-sm">
              <span className="font-semibold">
                {t("orgSettings.teamCreation.toggleLabel")}
              </span>
              <span className="block text-base-content/70">
                {t("orgSettings.teamCreation.toggleHint")}
              </span>
            </span>
          </label>

          {mutation.isPending && (
            <div
              role="status"
              className="flex items-center gap-2 text-sm text-base-content/70"
            >
              <InlineSpinner size="md" />{" "}
              {t("orgSettings.teamCreation.applying")}
            </div>
          )}

          {!enabled && !mutation.isPending && (
            <div className="rounded-field border border-warning/30 bg-warning/10 p-3 text-sm text-base-content/80">
              {t("orgSettings.teamCreation.offNotice")}
            </div>
          )}
        </div>
      )}
    </SettingsSection>
  )
}

export default TeamCreationSection
