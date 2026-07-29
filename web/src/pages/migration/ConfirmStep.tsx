// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). Phase 2: the safety gate. Show
// exactly what will happen (read-only preflight), let the teacher tune the
// short-name/term/suffix (re-running preflight), and require typing the short
// name to confirm before the irreversible write.

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { AlertTriangle, ArrowRight } from "lucide-react"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { Alert, Button, Card, FormField, Input, rtlFlip } from "@/components/ui"
import { buildPreflight } from "@/migration/preflight"
import type { ClassroomWithOrg, MigrationPreflight } from "@/migration/types"
import { MigrationItemCard } from "./migrationItemCard"

export const ConfirmStep = ({
  source,
  targetOrg,
  onBack,
  onConfirm,
}: {
  source: ClassroomWithOrg
  targetOrg: string
  onBack: () => void
  onConfirm: (plan: MigrationPreflight) => void
}) => {
  const { t } = useTranslation()
  const client = useGitHubClient()

  // Tunables that re-run preflight when they settle.
  const [shortName, setShortName] = useState<string | undefined>(undefined)
  const [term, setTerm] = useState("")
  const [templateSuffix, setTemplateSuffix] = useState("")
  const [confirmText, setConfirmText] = useState("")

  const {
    data: plan,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: [
      "migration",
      "preflight",
      source.id,
      targetOrg,
      shortName ?? "",
      term,
      templateSuffix,
    ],
    queryFn: () =>
      buildPreflight(client, {
        source: String(source.id),
        targetOrg,
        shortName,
        term,
        templateSuffix,
      }),
    staleTime: 0,
    retry: false,
  })

  const blocked = (plan?.blockers.length ?? 0) > 0
  const confirmValue = plan?.shortName ?? ""
  const confirmed = confirmText.trim() === confirmValue && confirmValue !== ""
  const canImport = Boolean(plan) && !blocked && confirmed && !isLoading

  return (
    <Card>
      <Card.Body>
        <Card.Title>{t("migration.confirm.title")}</Card.Title>
        <p className="text-base-content/70">{t("migration.confirm.body")}</p>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded-lg border border-base-300 bg-base-200 px-2 py-1">
            <span className="text-base-content/50">
              {t("migration.confirm.sourceLabel")}{" "}
            </span>
            <span className="font-medium">{source.name}</span>
            <span className="text-base-content/50"> ({source.orgLogin})</span>
          </span>
          <ArrowRight
            aria-hidden="true"
            className={`size-4 text-base-content/40 ${rtlFlip}`}
          />
          <span className="rounded-lg border border-base-300 bg-base-200 px-2 py-1">
            <span className="text-base-content/50">
              {t("migration.confirm.targetLabel")}{" "}
            </span>
            <span className="font-medium">{targetOrg}</span>
          </span>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <FormField
            label={t("migration.confirm.shortName")}
            htmlFor="mig-short"
            help={t("migration.confirm.shortNameHelp")}
          >
            {({ id }) => (
              <Input
                id={id}
                value={shortName ?? plan?.shortName ?? ""}
                placeholder={plan?.shortName ?? ""}
                onChange={(e) => setShortName(e.target.value)}
              />
            )}
          </FormField>
          <FormField
            label={t("migration.confirm.term")}
            htmlFor="mig-term"
            help={t("migration.confirm.termHelp")}
          >
            {({ id }) => (
              <Input
                id={id}
                value={term}
                placeholder={t("migration.confirm.termPlaceholder")}
                onChange={(e) => setTerm(e.target.value)}
              />
            )}
          </FormField>
          <FormField
            label={t("migration.confirm.suffix")}
            htmlFor="mig-suffix"
            help={t("migration.confirm.suffixHelp")}
          >
            {({ id }) => (
              <Input
                id={id}
                value={templateSuffix}
                placeholder={t("migration.confirm.suffixPlaceholder")}
                onChange={(e) => setTemplateSuffix(e.target.value)}
              />
            )}
          </FormField>
        </div>

        {isError && (
          <Alert tone="error" className="mt-4 items-start">
            <span className="text-sm">
              {error instanceof Error
                ? error.message
                : t("migration.confirm.preflightError")}
            </span>
            <Button variant="ghost" size="sm" onClick={() => refetch()}>
              {t("migration.select.retry")}
            </Button>
          </Alert>
        )}

        {plan && (
          <>
            {plan.blockers.map((b) => (
              <Alert key={b.kind} tone="error" className="mt-4">
                {t(`migration.blocker.${b.kind}`, b.params)}
              </Alert>
            ))}

            <div className="mt-4 flex flex-wrap gap-3 text-sm text-base-content/70">
              <span>
                {t("migration.confirm.countImport", { n: plan.counts.import })}
              </span>
              <span>
                {t("migration.confirm.countReuse", { n: plan.counts.reuse })}
              </span>
              <span>
                {t("migration.confirm.countSkip", { n: plan.counts.skip })}
              </span>
            </div>

            <ul className="mt-3 grid gap-2">
              {plan.items.map((item) => {
                const starterRepo = item.assignment.starter_code_repository
                return (
                  <li key={item.assignment.id}>
                    <MigrationItemCard
                      title={item.assignment.title}
                      slug={item.assignment.slug}
                      targetName={item.targetName}
                      targetOrg={targetOrg}
                      status={item.action}
                      reason={item.reason}
                      sourceRepo={starterRepo?.full_name}
                      sourcePrivate={starterRepo?.private}
                    />
                  </li>
                )
              })}
            </ul>

            {!blocked && (
              <Alert tone="warning" className="mt-6 items-start">
                <AlertTriangle aria-hidden="true" className="size-5 shrink-0" />
                <div>
                  <p className="font-medium">
                    {t("migration.confirm.warningTitle")}
                  </p>
                  <p className="mt-1 text-sm">
                    {t("migration.confirm.warningBody", {
                      count: plan.counts.import,
                      org: targetOrg,
                    })}
                  </p>
                </div>
              </Alert>
            )}

            {!blocked && (
              <div className="mt-4">
                <FormField
                  label={t("migration.confirm.typeToConfirm", {
                    shortName: plan.shortName,
                  })}
                  htmlFor="mig-confirm"
                >
                  {({ id }) => (
                    <Input
                      id={id}
                      className="font-mono"
                      value={confirmText}
                      placeholder={plan.shortName}
                      onChange={(e) => setConfirmText(e.target.value)}
                    />
                  )}
                </FormField>
              </div>
            )}
          </>
        )}

        <Card.Actions className="mt-6 justify-between">
          <Button variant="ghost" onClick={onBack}>
            {t("migration.confirm.back")}
          </Button>
          <Button
            variant="primary"
            disabled={!canImport}
            onClick={() => plan && onConfirm(plan)}
          >
            {t("migration.confirm.importButton")}
          </Button>
        </Card.Actions>
      </Card.Body>
    </Card>
  )
}

export default ConfirmStep
