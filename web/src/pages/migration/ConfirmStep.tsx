// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). Phase 2: the safety gate. Show
// exactly what will happen (read-only preflight), let the teacher tune the
// short-name/term/suffix (re-running preflight), and require typing the short
// name to confirm before the irreversible write.

import { useState } from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Trans, useTranslation } from "react-i18next"
import { AlertTriangle } from "lucide-react"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  Alert,
  Button,
  Card,
  FormField,
  Input,
  Modal,
  Spinner,
} from "@/components/ui"
import { useDebouncedValue } from "@/hooks/useDebouncedValue"
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

  // Tunables. `shortName` and `templateSuffix` change the PLAN (target repo
  // names, collision checks), so they key the preflight query. `name` and
  // `term` are display-only — they don't affect any API call, so they're kept
  // out of the query key and applied to the effective plan, avoiding a full
  // preflight refetch on every keystroke.
  const [name, setName] = useState<string | undefined>(undefined)
  const [shortName, setShortName] = useState<string | undefined>(undefined)
  const [term, setTerm] = useState<string | undefined>(undefined)
  const [templateSuffix, setTemplateSuffix] = useState("")
  // Assignment ids the teacher unchecked (importable items default to checked).
  const [deselected, setDeselected] = useState<Set<number>>(new Set())
  // The irreversibility confirmation modal, opened by the Import button.
  const [showConfirm, setShowConfirm] = useState(false)

  const toggleItem = (assignmentId: number) =>
    setDeselected((prev) => {
      const next = new Set(prev)
      if (next.has(assignmentId)) next.delete(assignmentId)
      else next.add(assignmentId)
      return next
    })

  // Plan-affecting inputs are debounced so preflight re-runs once typing pauses,
  // not on every keystroke; keepPreviousData keeps the current preview rendered
  // during the background refetch (no reload flash — the "Updating…" hint shows).
  const debouncedShortName = useDebouncedValue(shortName, 500)
  const debouncedSuffix = useDebouncedValue(templateSuffix, 500)

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
      debouncedShortName ?? "",
      debouncedSuffix,
    ],
    queryFn: () =>
      buildPreflight(client, {
        source: String(source.id),
        targetOrg,
        shortName: debouncedShortName,
        templateSuffix: debouncedSuffix,
      }),
    placeholderData: keepPreviousData,
    staleTime: 0,
    retry: false,
  })

  // True while the debounce timer hasn't caught up to the latest input, so the
  // preview shown is for a stale short-name/suffix.
  const pendingEdit =
    debouncedShortName !== shortName || debouncedSuffix !== templateSuffix

  const blocked = (plan?.blockers.length ?? 0) > 0

  // The effective plan reflects the teacher's selection: any importable/reusable
  // item they unchecked becomes a skip (with a "deselected" reason) so execute
  // skips it and the counts + summary stay truthful. Skip items are untouched.
  const effectivePlan: MigrationPreflight | undefined = plan
    ? {
        ...plan,
        // Display-only overrides applied without refetching the preflight.
        name: name?.trim() ? name.trim() : plan.name,
        term: term !== undefined ? term.trim() : plan.term,
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
  const canImport =
    Boolean(effectivePlan) &&
    !blocked &&
    !isLoading &&
    !isFetching &&
    !pendingEdit &&
    selectedCount > 0

  return (
    <Card>
      <Card.Body>
        <div className="flex items-start justify-between gap-4">
          <Card.Title>{t("migration.confirm.title")}</Card.Title>
          <Button
            variant="primary"
            size="sm"
            onClick={onBack}
            className="shrink-0"
          >
            {t("migration.confirm.back")}
          </Button>
        </div>
        <p className="text-base-content/70">
          <Trans
            i18nKey={
              source.name && source.name !== source.orgLogin
                ? "migration.confirm.fromLine"
                : "migration.confirm.fromLineNoName"
            }
            values={{
              source: source.name || source.orgLogin,
              org: source.orgLogin,
            }}
            components={{
              b: <span className="font-medium text-base-content" />,
            }}
          />
        </p>

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
                      value={term ?? plan.term}
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

            {(isFetching || pendingEdit) && (
              <div className="mt-4 flex items-center gap-1 text-sm text-base-content/50">
                <Spinner size="xs" />
                {t("migration.confirm.updating")}
              </div>
            )}

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

            {!blocked && selectedCount === 0 && (
              <Alert tone="info" className="mt-4">
                {t("migration.confirm.noneSelected")}
              </Alert>
            )}

            {!blocked && (
              <Button
                variant="primary"
                className="mt-6 w-full"
                disabled={!canImport}
                onClick={() => setShowConfirm(true)}
              >
                {t("migration.confirm.importButton", {
                  count: selectedCount,
                })}
              </Button>
            )}
          </>
        )}
      </Card.Body>

      {/* Final irreversibility gate: the warning lives here, not inline. */}
      <Modal
        open={showConfirm}
        onClose={() => setShowConfirm(false)}
        size="md"
        aria-label={t("migration.confirm.modalTitle")}
      >
        <h3 className="flex items-center gap-2 text-lg font-bold">
          <AlertTriangle aria-hidden="true" className="size-5 text-warning" />
          {t("migration.confirm.modalTitle")}
        </h3>
        <p className="mt-2 text-sm text-base-content/80">
          {t("migration.confirm.modalSummary", {
            count: selectedCount,
            shortName: effectivePlan?.shortName ?? "",
            org: targetOrg,
          })}
        </p>
        {(effectivePlan?.counts.reuse ?? 0) > 0 && (
          <p className="mt-2 text-sm text-base-content/70">
            {t("migration.confirm.modalReuseNote", {
              count: effectivePlan!.counts.reuse,
            })}
          </p>
        )}
        {(effectivePlan?.counts.skip ?? 0) > 0 && (
          <p className="mt-2 text-sm text-base-content/70">
            {t("migration.confirm.modalSkipNote", {
              count: effectivePlan!.counts.skip,
            })}
          </p>
        )}
        <p className="mt-3 text-sm font-medium text-base-content/80">
          {t("migration.confirm.modalConfirmQuestion")}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setShowConfirm(false)}>
            {t("migration.confirm.modalCancel")}
          </Button>
          <Button
            variant="primary"
            disabled={!canImport}
            onClick={() => {
              setShowConfirm(false)
              if (effectivePlan) onConfirm(effectivePlan)
            }}
          >
            {t("migration.confirm.modalConfirm")}
          </Button>
        </div>
      </Modal>
    </Card>
  )
}

export default ConfirmStep
