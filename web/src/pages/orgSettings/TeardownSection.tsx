import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { TriangleAlert } from "lucide-react"

import { ConfirmModal } from "@/components/modals"
import { Button } from "@/components/ui"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import useGetOrgMembership from "@/hooks/useGetOrgMembership"
import {
  executeTeardown,
  formatTeardownResult,
  planTeardown,
  TeardownMarkerError,
  TeardownRateLimitError,
  TeardownScopeError,
  type TeardownPlan,
} from "@/api/mutations/teardown"
import SettingsSection from "./SettingsSection"
import { CalloutDiv, CalloutText } from "@/lib/motionComponents"
import { logger } from "@/lib/logger"

const log = logger.scope("orgSettings:TeardownSection")

// Teardown / org reset: deletes ALL repos in the org (mirroring the CLI's
// `gh teacher teardown`), marker-gated and behind a typed-org-name confirmation.
// Owner-gated; destructive and irreversible.
const TeardownSection = ({ org }: { org: string }) => {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const { data: membership } = useGetOrgMembership(org)
  const isOwner = membership?.role === "admin"

  const [open, setOpen] = useState(false)
  const [plan, setPlan] = useState<TeardownPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const openMutation = useMutation({
    mutationFn: () => planTeardown(client, org),
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

  const runMutation = useMutation({
    mutationFn: async () => {
      if (!plan) return
      const result = await executeTeardown(client, plan)
      return result
    },
    onSuccess: (result) => {
      setOpen(false)
      if (!result) {
        setDone(null)
      } else {
        setDone(
          formatTeardownResult(result, `https://github.com/orgs/${org}/teams`),
        )
      }
      void queryClient.invalidateQueries({ queryKey: ["orgs"] })
      // Redirect home only on a fully-clean run. executeTeardown RESOLVES on
      // partial failure (marker retained, re-runnable); on that path the `done`
      // banner carries the re-run remedy, so stay to show it.
      const cleanRun =
        !!result &&
        result.markerDeleted &&
        result.failed.length === 0 &&
        result.teamsFailed.length === 0
      if (cleanRun) {
        void navigate({ to: "/" })
      }
    },
    onError: (err) => {
      // onConfirm rethrows so ConfirmModal owns failure display; here we only
      // refresh the org view, since a scope/rate-limit failure may have already
      // deleted some repos.
      if (err instanceof TeardownRateLimitError) {
        void queryClient.invalidateQueries({ queryKey: ["orgs"] })
      }
    },
  })

  return (
    <SettingsSection
      tone="danger"
      title={t("orgSettings.teardown.title")}
      titleAdornment={
        <TriangleAlert aria-hidden="true" className="size-5 text-error" />
      }
      description={
        <>
          {t("orgSettings.teardown.description_prefix")}{" "}
          <strong>{t("orgSettings.teardown.description_every")}</strong>{" "}
          {t("orgSettings.teardown.description_mid")} <code>classroom50</code>{" "}
          {t("orgSettings.teardown.description_suffix")}
        </>
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
        disabled={!isOwner || openMutation.isPending}
        title={
          isOwner ? undefined : t("orgSettings.teardown.requiresOwnerTitle")
        }
        onClick={() => {
          if (!openMutation.isPending) openMutation.mutate()
        }}
      >
        {openMutation.isPending
          ? t("orgSettings.teardown.preparing")
          : t("orgSettings.teardown.button")}
      </Button>

      {!isOwner && (
        <p className="mt-2 text-xs text-base-content/70">
          {t("orgSettings.teardown.requiresOwnerNote")}
        </p>
      )}

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
              {t("orgSettings.teardown.confirmBody_prefix")}{" "}
              <strong>{plan?.repoNames.length ?? 0}</strong>{" "}
              {t("orgSettings.teardown.confirmBody_reposIn")}{" "}
              <span className="font-mono">{org}</span>
              {t("orgSettings.teardown.confirmBody_including")}{" "}
              <code>classroom50</code>{" "}
              {t("orgSettings.teardown.confirmBody_deletedLast")}
              {plan && plan.teams.length > 0 ? (
                <>
                  {t("orgSettings.teardown.confirmBody_andRemove")}{" "}
                  <strong>{plan.teams.length}</strong>{" "}
                  {t("orgSettings.teardown.confirmBody_teams", {
                    count: plan.teams.length,
                  })}
                </>
              ) : null}
              {t("orgSettings.teardown.confirmBody_cannotUndo")}
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
          // normalized.
          try {
            await runMutation.mutateAsync()
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
