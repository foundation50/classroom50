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
import {
  Alert,
  Button,
  Card,
  FormField,
  Input,
  Spinner,
  rtlFlip,
} from "@/components/ui"
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
  const [name, setName] = useState<string | undefined>(undefined)
  const [shortName, setShortName] = useState<string | undefined>(undefined)
  const [term, setTerm] = useState("")
  const [templateSuffix, setTemplateSuffix] = useState("")
  const [confirmText, setConfirmText] = useState("")
  // Assignment ids the teacher unchecked (importable items default to checked).
  const [deselected, setDeselected] = useState<Set<number>>(new Set())

  const toggleItem = (assignmentId: number) =>
    setDeselected((prev) => {
      const next = new Set(prev)
      if (next.has(assignmentId)) next.delete(assignmentId)
      else next.add(assignmentId)
      return next
    })

  const {
    data: plan,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: [
      "migration",
      "preflight",
      source.id,
      targetOrg,
      name ?? "",
      shortName ?? "",
      term,
      templateSuffix,
    ],
    queryFn: () =>
      buildPreflight(client, {
        source: String(source.id),
        targetOrg,
        name,
        shortName,
        term,
        templateSuffix,
      }),
    staleTime: 0,
    retry: false,
  })

  const blocked = (plan?.blockers.length ?? 0) > 0

  // The effective plan reflects the teacher's selection: any importable/reusable
  // item they unchecked becomes a skip (with a "deselected" reason) so execute
  // skips it and the counts + summary stay truthful. Skip items are untouched.
  const effectivePlan: MigrationPreflight | undefined = plan
    ? {
        ...plan,
        items: plan.items.map((item) =>
          item.action !== "skip" && deselected.has(item.assignment.id)
            ? {
                ...item,
                action: "skip" as const,
                reason: { key: "migration.reason.deselected" },
              }
            : item,
        ),
        counts: {
          import: plan.items.filter(
            (i) => i.action === "import" && !deselected.has(i.assignment.id),
          ).length,
          reuse: plan.items.filter(
            (i) => i.action === "reuse" && !deselected.has(i.assignment.id),
          ).length,
          skip: plan.items.filter(
            (i) => i.action === "skip" || deselected.has(i.assignment.id),
          ).length,
        },
      }
    : undefined

  const selectedCount =
    (effectivePlan?.counts.import ?? 0) + (effectivePlan?.counts.reuse ?? 0)
  const confirmValue = plan?.shortName ?? ""
  const confirmed = confirmText.trim() === confirmValue && confirmValue !== ""
  const canImport =
    Boolean(effectivePlan) &&
    !blocked &&
    confirmed &&
    !isLoading &&
    selectedCount > 0

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

        {/* Initial load: don't show empty inputs that populate later — show a
            loading state until the first preflight resolves. */}
        {isLoading && !plan && (
          <div className="mt-6 flex items-center gap-2 text-base-content/70">
            <Spinner size="sm" />
            {t("migration.confirm.loading")}
          </div>
        )}

        {isError && !plan && (
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
            <div className="mt-4 grid gap-4">
              <FormField
                label={t("migration.confirm.name")}
                htmlFor="mig-name"
                help={t("migration.confirm.nameHelp")}
              >
                {({ id }) => (
                  <Input
                    id={id}
                    value={name ?? plan.name}
                    placeholder={plan.name}
                    onChange={(e) => setName(e.target.value)}
                  />
                )}
              </FormField>

              <div className="grid gap-4 sm:grid-cols-3">
                <FormField
                  label={t("migration.confirm.shortName")}
                  htmlFor="mig-short"
                  help={t("migration.confirm.shortNameHelp")}
                >
                  {({ id }) => (
                    <Input
                      id={id}
                      value={shortName ?? plan.shortName}
                      placeholder={plan.shortName}
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

            {plan.blockers.map((b) => (
              <Alert key={b.kind} tone="error" className="mt-4">
                {t(`migration.blocker.${b.kind}`, b.params)}
              </Alert>
            ))}

            <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-base-content/70">
              <span>
                {t("migration.confirm.countImport", {
                  n: effectivePlan?.counts.import ?? 0,
                })}
              </span>
              <span>
                {t("migration.confirm.countReuse", {
                  n: effectivePlan?.counts.reuse ?? 0,
                })}
              </span>
              <span>
                {t("migration.confirm.countSkip", {
                  n: effectivePlan?.counts.skip ?? 0,
                })}
              </span>
              {isFetching && (
                <span className="flex items-center gap-1 text-base-content/50">
                  <Spinner size="xs" />
                  {t("migration.confirm.updating")}
                </span>
              )}
            </div>

            {/* Two-column labels above the source -> target rows. */}
            <div className="mt-3 hidden grid-cols-[1fr_auto_1fr] gap-3 px-1 text-xs font-medium uppercase tracking-wide text-base-content/50 sm:grid">
              <span>{t("migration.confirm.columnSource")}</span>
              <span aria-hidden="true" />
              <span>{t("migration.confirm.columnTarget")}</span>
            </div>

            <ul className="mt-1 grid gap-2">
              {plan.items.map((item) => {
                // Hard skips (invalid source, collision) can't be imported, so
                // they show no checkbox. Import/reuse items are selectable and
                // default to checked.
                const selectable = item.action !== "skip"
                const selected =
                  selectable && !deselected.has(item.assignment.id)
                return (
                  <li key={item.assignment.id}>
                    <MigrationItemCard
                      assignment={item.assignment}
                      status={item.action}
                      reason={item.reason}
                      targetName={item.targetName}
                      targetOrg={targetOrg}
                      targetBranch={item.branch}
                      templateLess={item.templateLess}
                      selectable={selectable}
                      selected={selected}
                      onToggle={() => toggleItem(item.assignment.id)}
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
                      count: selectedCount,
                      org: targetOrg,
                    })}
                  </p>
                </div>
              </Alert>
            )}

            {!blocked && selectedCount === 0 && (
              <Alert tone="info" className="mt-4">
                {t("migration.confirm.noneSelected")}
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
            onClick={() => effectivePlan && onConfirm(effectivePlan)}
          >
            {t("migration.confirm.importButton")}
          </Button>
        </Card.Actions>
      </Card.Body>
    </Card>
  )
}

export default ConfirmStep
