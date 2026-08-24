import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { Trans, useTranslation } from "react-i18next"
import { AlertIcon } from "@/components/ui/icons"

import { ConfirmModal } from "@/components/modals"
import { Button, HelpTooltip, MonoLtr, cx } from "@/components/ui"
import {
  formatTeardownResult,
  TeardownAbortError,
  TeardownMarkerError,
  TeardownScopeError,
  type TeardownPlan,
} from "@/domain/teardown"
import {
  localizedMessageOf,
  resolveLocalizedMessage,
} from "@/types/localizedMessage"
import { usePlanTeardown } from "@/hooks/mutations/usePlanTeardown"
import { useExecuteTeardown } from "@/hooks/mutations/useExecuteTeardown"
import { sectionHighlightClass } from "@/hooks/useHashSectionHighlight"
import {
  useHasDeleteRepoScope,
  useCanElevateInApp,
} from "@/context/github/GitHubProvider"
import { ElevatedAccessModal } from "@/auth/ElevatedAccessModal"
import SettingsSection from "./SettingsSection"
import { CalloutDiv, CalloutText } from "@/lib/motionComponents"
import { logger } from "@/lib/logger"

const log = logger.scope("orgSettings:TeardownSection")

// DOM anchor for this section, used as its SettingsSection id + hash deep-link.
const DANGER_ZONE_ANCHOR = "danger-zone"

// Teardown / org reset: deletes ALL repos in the org (mirroring the CLI's
// `gh teacher teardown`), marker-gated and behind a typed-org-name confirmation.
// Owner-gated by the page's <RequireRole allow="owner"> (RequireOwner renders
// children only for a resolved owner, with its own spinner/retry surface), so no
// inline owner re-check is needed here.
const TeardownSection = ({
  org,
  highlighted,
}: {
  org: string
  highlighted?: boolean
}) => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const hasDeleteRepo = useHasDeleteRepoScope()
  const canElevateInApp = useCanElevateInApp()
  const [elevateOpen, setElevateOpen] = useState(false)

  const [open, setOpen] = useState(false)
  const [plan, setPlan] = useState<TeardownPlan | null>(null)
  // `canElevate` rides with the message so the callout can only offer elevation
  // for the wall elevation actually fixes; the two are always written together.
  const [error, setError] = useState<{
    message: string
    canElevate: boolean
  } | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const openMutation = usePlanTeardown(org)
  const openTeardown = () =>
    openMutation.mutate(undefined, {
      onSuccess: (p) => {
        setPlan(p)
        setError(null)
        setOpen(true)
      },
      onError: (err) => {
        log.warn("teardown plan failed", { org, err })
        setError({
          message:
            err instanceof TeardownMarkerError
              ? err.message
              : t("orgSettings.teardown.prepareError"),
          canElevate: false,
        })
      },
    })

  const runMutation = useExecuteTeardown(plan)

  return (
    <SettingsSection
      tone="danger"
      id={DANGER_ZONE_ANCHOR}
      className={sectionHighlightClass(highlighted ?? false)}
      title={t("orgSettings.teardown.title")}
      titleAdornment={
        <AlertIcon aria-hidden="true" className="size-4 text-error" />
      }
      description={
        <Trans
          i18nKey="orgSettings.teardown.description"
          components={{
            strong: <strong />,
            repo: <MonoLtr />,
          }}
        />
      }
    >
      {error && (
        <CalloutDiv className="flex flex-col items-start gap-2 rounded-field border border-error/30 bg-error/10 p-3 text-sm text-error">
          <span>{error.message}</span>
          {error.canElevate &&
            (canElevateInApp ? (
              // The message names elevation as the remedy, so make it reachable.
              <Button
                variant="warning"
                size="sm"
                onClick={() => setElevateOpen(true)}
              >
                {t("orgSettings.teardown.grantButton")}
              </Button>
            ) : (
              // A PAT's permissions are fixed at creation, so the only fix is a
              // replacement token — the elevation flow would swap their session.
              <span>{t("orgSettings.teardown.needsDeleteScopePat")}</span>
            ))}
        </CalloutDiv>
      )}
      {done && (
        <CalloutText className="text-sm text-success">{done}</CalloutText>
      )}

      {hasDeleteRepo ? (
        <Button
          variant="error"
          size="sm"
          className={error || done ? "mt-4" : ""}
          disabled={openMutation.isPending}
          onClick={() => {
            if (!openMutation.isPending) openTeardown()
          }}
        >
          {openMutation.isPending
            ? t("orgSettings.teardown.preparing")
            : t("orgSettings.teardown.button")}
        </Button>
      ) : (
        // Offer the elevation up front rather than after a failed attempt (#655).
        <div
          className={cx(
            "flex flex-wrap items-center gap-2",
            error || done ? "mt-4" : "",
          )}
        >
          <span className="inline-flex items-center gap-1 text-sm text-base-content/70">
            {t("orgSettings.teardown.insufficientPermission")}
            <HelpTooltip
              position="top"
              help={
                canElevateInApp
                  ? t("orgSettings.teardown.insufficientPermissionHelp")
                  : t("orgSettings.teardown.insufficientPermissionHelpPat")
              }
            />
          </span>
          {canElevateInApp ? (
            <Button
              variant="warning"
              size="sm"
              onClick={() => setElevateOpen(true)}
            >
              {t("orgSettings.teardown.grantButton")}
            </Button>
          ) : (
            <span className="text-sm text-base-content/70">
              {t("orgSettings.teardown.needsDeleteScopePat")}
            </span>
          )}
        </div>
      )}

      <ElevatedAccessModal
        open={elevateOpen}
        onClose={() => setElevateOpen(false)}
      />

      <ConfirmModal
        open={open}
        dangerous
        needsConfirm
        confirmText={t("orgSettings.teardown.confirmText", { org })}
        confirmLabel={t("orgSettings.teardown.confirmLabel")}
        title={t("orgSettings.teardown.confirmTitle")}
        description={
          <div className="space-y-2 text-sm">
            <p>
              <Trans
                i18nKey="orgSettings.teardown.confirmBody"
                count={plan?.repoNames.length ?? 0}
                values={{ org }}
                components={{
                  count: <strong />,
                  org: <MonoLtr />,
                  repo: <MonoLtr />,
                }}
              />{" "}
              {plan && plan.teams.length > 0 ? (
                <>
                  <Trans
                    i18nKey="orgSettings.teardown.confirmBodyTeams"
                    count={plan.teams.length}
                    components={{ count: <strong /> }}
                  />{" "}
                </>
              ) : null}
              {t("orgSettings.teardown.confirmBodyCannotUndo")}
            </p>
            {plan && plan.repoNames.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-semibold text-base-content/70">
                  {t("orgSettings.teardown.repositoriesHeading")}
                </p>
                <ul className="max-h-40 overflow-auto rounded border border-base-300 bg-base-100 p-2 font-mono text-xs">
                  {plan.repoNames.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </div>
            )}
            {plan && plan.teams.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-semibold text-base-content/70">
                  {t("orgSettings.teardown.classroomTeamsHeading")}
                </p>
                <ul className="max-h-40 overflow-auto rounded border border-base-300 bg-base-100 p-2 font-mono text-xs">
                  {plan.teams.map((team) => (
                    <li key={team.slug}>{team.slug}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        }
        onConfirm={async () => {
          // Let a failure REJECT so ConfirmModal's catch keeps the modal open
          // with the error inline (its submittingRef guards double submits).
          // Scope/rate-limit errors carry user-facing messages; anything else is
          // normalized. The success UI (close, done banner, clean-run redirect)
          // lives in the mutate callback so it skips when unmounted; the hook's
          // onSuccess owns the org-list invalidation.
          try {
            await runMutation.mutateAsync(undefined, {
              onSuccess: (result) => {
                setOpen(false)
                if (!result) {
                  setDone(null)
                } else {
                  setDone(
                    formatTeardownResult(
                      result,
                      `https://github.com/orgs/${org}/teams`,
                    ),
                  )
                }
                // Redirect home only on a fully-clean run. executeTeardown
                // RESOLVES on partial failure (marker retained, re-runnable); on
                // that path the `done` banner carries the re-run remedy, so stay
                // to show it.
                const cleanRun =
                  !!result &&
                  result.markerDeleted &&
                  result.failed.length === 0 &&
                  result.teamsFailed.length === 0
                if (cleanRun) {
                  void navigate({ to: "/" })
                }
              },
            })
          } catch (err) {
            // Backstop: the up-front gate should have caught the scope case, but
            // a token that lost the scope mid-session still 403s.
            const localized = localizedMessageOf(err)
            if (localized) {
              const message = resolveLocalizedMessage(t, localized)
              // Hoist the message out of the confirmation whenever it is the only
              // record of real data loss, or whenever elevation is the remedy the
              // message names. The modal's inline error dies with the modal, and
              // stacking the elevation dialog over it would hide it (that
              // dialog's first button navigates the page away).
              const isScopeWall = err instanceof TeardownScopeError
              const lostData =
                err instanceof TeardownAbortError && err.deleted.length > 0
              if (isScopeWall || lostData) {
                setOpen(false)
                setError({ message, canElevate: isScopeWall })
                return
              }
              throw new Error(message, { cause: err })
            }
            throw new Error(t("orgSettings.teardown.executeError"), {
              cause: err,
            })
          }
        }}
        onClose={() => setOpen(false)}
      />
    </SettingsSection>
  )
}

export default TeardownSection
