import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { Trans, useTranslation } from "react-i18next"
import { TriangleAlert } from "lucide-react"

import { ConfirmModal } from "@/components/modals"
import { Button, MonoLtr } from "@/components/ui"
import {
  formatTeardownResult,
  TeardownMarkerError,
  TeardownRateLimitError,
  TeardownScopeError,
  type TeardownPlan,
} from "@/domain/teardown"
import { usePlanTeardown } from "@/hooks/mutations/usePlanTeardown"
import { useExecuteTeardown } from "@/hooks/mutations/useExecuteTeardown"
import SettingsSection from "./SettingsSection"
import { CalloutDiv, CalloutText } from "@/lib/motionComponents"
import { logger } from "@/lib/logger"

const log = logger.scope("orgSettings:TeardownSection")

// Teardown / org reset: deletes ALL repos in the org (mirroring the CLI's
// `gh teacher teardown`), marker-gated and behind a typed-org-name confirmation.
// Owner-gated by the page's <RequireRole allow="owner"> (RequireOwner renders
// children only for a resolved owner, with its own spinner/retry surface), so no
// inline owner re-check is needed here.
const TeardownSection = ({ org }: { org: string }) => {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [open, setOpen] = useState(false)
  const [plan, setPlan] = useState<TeardownPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
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
        setError(
          err instanceof TeardownMarkerError
            ? err.message
            : t("orgSettings.teardown.prepareError"),
        )
      },
    })

  const runMutation = useExecuteTeardown(plan)

  return (
    <SettingsSection
      tone="danger"
      title={t("orgSettings.teardown.title")}
      titleAdornment={
        <TriangleAlert aria-hidden="true" className="size-5 text-error" />
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
        <CalloutDiv className="rounded-lg border border-error/30 bg-error/10 p-3 text-sm text-error">
          {error}
        </CalloutDiv>
      )}
      {done && (
        <CalloutText className="text-sm text-success">{done}</CalloutText>
      )}

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
            if (
              err instanceof TeardownScopeError ||
              err instanceof TeardownRateLimitError
            ) {
              throw err
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
