// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). Phase 2+3 combined: review the
// read-only preflight, tune the class name/short-name/term/suffix, and — after
// an explicit confirmation modal — run the import IN PLACE. The Import button
// stays put and shows a loading state while the migration runs; per-item cards
// update live and a truthful summary replaces the button on completion.

import { useMemo, useState } from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Trans, useTranslation } from "react-i18next"
import { AlertTriangle, CheckCircle, ExternalLink } from "lucide-react"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubOAuthGrantUrl, githubOrgOAuthPolicyUrl } from "@/auth/constants"
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
import {
  localizedMessageOf,
  resolveLocalizedMessage,
} from "@/types/localizedMessage"
import { useGitHubViewer } from "@/hooks/useGitHubResources"
import { useMigrateClassroom } from "@/hooks/mutations/useMigrateClassroom"
import { buildPreflight } from "@/migration/preflight"
import type {
  ClassroomWithOrg,
  MigrationItemStatus,
  MigrationPreflight,
} from "@/migration/types"
import { MigrationItemCard, type ItemVisualStatus } from "./migrationItemCard"

export const ConfirmStep = ({
  source,
  targetOrg,
  onBack,
  onComplete,
}: {
  source: ClassroomWithOrg
  targetOrg: string
  onBack: () => void
  // Fired once the import succeeds (drives the wizard's final-step checkmark).
  onComplete: () => void
}) => {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const { data: viewer } = useGitHubViewer()
  const mutation = useMigrateClassroom(targetOrg)

  // Prefer a translatable { key, params } payload the migration layer attached
  // over a raw English Error.message (which is a diagnostic fallback only).
  const renderError = (err: unknown, fallbackKey: string): string => {
    const localized = localizedMessageOf(err)
    if (localized) return resolveLocalizedMessage(t, localized)
    return err instanceof Error ? err.message : t(fallbackKey)
  }

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
  // Live per-item status while the import runs (keyed by slug).
  const [statuses, setStatuses] = useState<Record<string, MigrationItemStatus>>(
    {},
  )

  const running = mutation.isPending
  const done = mutation.isSuccess
  const result = mutation.data

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
    // Once the import is underway, finished, OR failed, freeze the preview — no
    // more refetches. On mutation error `running` flips back to false, so
    // without the `!mutation.isError` guard the query would re-enable and swap
    // out the plan the failed run used while its error banner and per-item
    // statuses are still shown, letting a retry run an unconfirmed plan.
    enabled: !running && !done && !mutation.isError,
  })

  // True while the debounce timer hasn't caught up to the latest input.
  const pendingEdit =
    debouncedShortName !== shortName || debouncedSuffix !== templateSuffix

  const blocked = (plan?.blockers.length ?? 0) > 0

  const orgAccessBlocker = plan?.blockers.find(
    (b) => b.kind === "source_org_access",
  )

  // The effective plan reflects the teacher's selection: any importable/reusable
  // item they unchecked becomes a skip (with a "deselected" reason). Skip items
  // are untouched. Memoized so name/term typing and the live per-item status
  // stream (neither of which feeds it) don't rebuild it every render.
  const effectivePlan: MigrationPreflight | undefined = useMemo(() => {
    if (!plan) return undefined
    const counts = { import: 0, reuse: 0, skip: 0 }
    const items = plan.items.map((item) => {
      const deselect =
        item.action !== "skip" && deselected.has(item.assignment.id)
      if (deselect) {
        counts.skip += 1
        return {
          ...item,
          action: "skip" as const,
          reason: { key: "migration.reason.deselected" },
        }
      }
      counts[item.action] += 1
      return item
    })
    return {
      ...plan,
      name: name?.trim() ? name.trim() : plan.name,
      term: term !== undefined ? term.trim() : plan.term,
      items,
      counts,
    }
  }, [plan, name, term, deselected])

  const selectedCount =
    (effectivePlan?.counts.import ?? 0) + (effectivePlan?.counts.reuse ?? 0)
  const canImport =
    Boolean(effectivePlan) &&
    !blocked &&
    !isLoading &&
    !isFetching &&
    !pendingEdit &&
    !running &&
    !done &&
    selectedCount > 0

  // Fire the migration from the confirmation modal. Streams per-item status into
  // `statuses`; on success signals the wizard so the final step checks off.
  const startImport = () => {
    if (!effectivePlan) return
    setShowConfirm(false)
    // Seed statuses so cards flip to pending/skipped immediately.
    setStatuses(
      Object.fromEntries(
        effectivePlan.items.map((i) => [
          i.assignment.slug,
          {
            slug: i.assignment.slug,
            targetName: i.targetName,
            status: i.action === "skip" ? "skipped" : "pending",
            reason: i.reason,
          } satisfies MigrationItemStatus,
        ]),
      ),
    )
    mutation.mutate(
      {
        plan: effectivePlan,
        options: {
          creator: viewer?.login,
          onItem: (s) => setStatuses((prev) => ({ ...prev, [s.slug]: s })),
        },
      },
      { onSuccess: () => onComplete() },
    )
  }

  const hadSkips = (result?.skipped.length ?? 0) > 0
  // Once the run starts, inputs and selection are frozen.
  const controlsDisabled = running || done

  // Hard prerequisite failed: dedicated grant-access screen, no preview.
  if (orgAccessBlocker) {
    const accessOrg = orgAccessBlocker.params?.org ?? source.orgLogin
    return (
      <Card>
        <Card.Body>
          <div className="flex items-start justify-between gap-4">
            <Card.Title>{t("migration.access.title")}</Card.Title>
            <Button
              variant="ghost"
              size="sm"
              onClick={onBack}
              className="shrink-0"
            >
              {t("migration.confirm.back")}
            </Button>
          </div>

          <Alert tone="error" className="mt-3 items-start">
            <AlertTriangle aria-hidden="true" className="size-5 shrink-0" />
            <div>
              <p className="font-medium">
                {t("migration.access.headline", { org: accessOrg })}
              </p>
              <p className="mt-1 text-sm">
                {t("migration.access.explain", { org: accessOrg })}
              </p>
            </div>
          </Alert>

          <ol className="mt-5 grid gap-4">
            <li className="rounded-xl border border-base-300 bg-base-100 p-4">
              <div className="flex items-start gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                  1
                </span>
                <div className="min-w-0">
                  <p className="font-medium">
                    {t("migration.access.step1Title")}
                  </p>
                  <p className="mt-1 text-sm text-base-content/70">
                    {t("migration.access.step1Body", { org: accessOrg })}
                  </p>
                  <a
                    href={githubOAuthGrantUrl()}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-primary btn-sm mt-3"
                  >
                    {t("migration.access.step1Button")}
                    <ExternalLink aria-hidden="true" className="size-4" />
                  </a>
                </div>
              </div>
            </li>

            <li className="rounded-xl border border-base-300 bg-base-100 p-4">
              <div className="flex items-start gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-base-300 text-sm font-semibold text-base-content/70">
                  2
                </span>
                <div className="min-w-0">
                  <p className="font-medium">
                    {t("migration.access.step2Title")}
                  </p>
                  <p className="mt-1 text-sm text-base-content/70">
                    {t("migration.access.step2Body", { org: accessOrg })}
                  </p>
                  <a
                    href={githubOrgOAuthPolicyUrl(accessOrg)}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-ghost btn-sm mt-3"
                  >
                    {t("migration.access.step2Button", { org: accessOrg })}
                    <ExternalLink aria-hidden="true" className="size-4" />
                  </a>
                </div>
              </div>
            </li>
          </ol>

          <div className="mt-5 flex items-center gap-3">
            <Button
              variant="primary"
              onClick={() => refetch()}
              loading={isFetching}
              loadingLabel={t("migration.access.rechecking")}
              disabled={isFetching}
            >
              {t("migration.access.recheck")}
            </Button>
            <span className="text-sm text-base-content/60">
              {t("migration.access.recheckHint")}
            </span>
          </div>
        </Card.Body>
      </Card>
    )
  }

  return (
    <Card>
      <Card.Body>
        <div className="flex items-start justify-between gap-4">
          <Card.Title>{t("migration.confirm.title")}</Card.Title>
          {!done && (
            <Button
              variant="primary"
              size="sm"
              onClick={onBack}
              disabled={controlsDisabled}
              className="shrink-0"
            >
              {t("migration.confirm.back")}
            </Button>
          )}
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

        {isLoading && !plan && (
          <div className="mt-6 flex items-center gap-2 text-base-content/70">
            <Spinner size="sm" />
            {t("migration.confirm.loading")}
          </div>
        )}

        {isError && !plan && (
          <Alert tone="error" className="mt-4 items-start">
            <span className="text-sm">
              {renderError(error, "migration.confirm.preflightError")}
            </span>
            <Button variant="ghost" size="sm" onClick={() => refetch()}>
              {t("migration.select.retry")}
            </Button>
          </Alert>
        )}

        {effectivePlan && (
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
                    value={name ?? effectivePlan.name}
                    placeholder={effectivePlan.name}
                    disabled={controlsDisabled}
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
                      value={shortName ?? effectivePlan.shortName}
                      placeholder={effectivePlan.shortName}
                      disabled={controlsDisabled}
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
                      value={term ?? effectivePlan.term}
                      placeholder={t("migration.confirm.termPlaceholder")}
                      disabled={controlsDisabled}
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
                      disabled={controlsDisabled}
                      onChange={(e) => setTemplateSuffix(e.target.value)}
                    />
                  )}
                </FormField>
              </div>
            </div>

            {mutation.isError && (
              <Alert tone="error" className="mt-4 items-start">
                <div>
                  <p className="font-medium">{t("migration.execute.error")}</p>
                  <p className="mt-1 text-sm">
                    {renderError(mutation.error, "migration.execute.error")}
                  </p>
                </div>
              </Alert>
            )}

            {/* Non-org-access blockers (e.g. the class name already exists). */}
            {!controlsDisabled &&
              effectivePlan.blockers.map((b) => (
                <Alert key={b.kind} tone="error" className="mt-4">
                  {t(`migration.blocker.${b.kind}`, b.params)}
                </Alert>
              ))}

            {(isFetching || pendingEdit) && !controlsDisabled && (
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
              {effectivePlan.items.map((item) => {
                // Before the run: checkboxes on importable/reusable items. During
                // and after: read live status, no toggles.
                const live = statuses[item.assignment.slug]
                const selectable = !controlsDisabled && item.action !== "skip"
                const selected =
                  item.action !== "skip" && !deselected.has(item.assignment.id)
                const status = (live?.status ?? item.action) as ItemVisualStatus
                return (
                  <li key={item.assignment.id}>
                    <MigrationItemCard
                      assignment={item.assignment}
                      status={status}
                      reason={live?.reason ?? item.reason}
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

            {!blocked && !controlsDisabled && selectedCount === 0 && (
              <Alert tone="info" className="mt-4">
                {t("migration.confirm.noneSelected")}
              </Alert>
            )}

            {/* Result summary replaces the Import button on completion. */}
            {done && result && (
              <Alert
                tone={hadSkips ? "warning" : "success"}
                className="mt-6 items-start"
              >
                {!hadSkips && (
                  <CheckCircle aria-hidden="true" className="size-5 shrink-0" />
                )}
                <div>
                  <p className="font-medium">
                    {hadSkips
                      ? t("migration.execute.summaryPartial")
                      : t("migration.execute.summaryComplete")}
                  </p>
                  <p className="mt-1 text-sm">
                    {t("migration.execute.summaryCounts", {
                      generated: result.generated,
                      reused: result.reused,
                      skipped: result.skipped.length,
                    })}
                  </p>
                  {hadSkips && (
                    <ul className="mt-2 list-disc ps-5 text-sm">
                      {result.skipped.map((s) => (
                        <li key={s.slug}>
                          <span className="font-mono">{s.slug}</span>
                          {s.reason
                            ? ` — ${t(s.reason.key, s.reason.params)}`
                            : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Alert>
            )}

            {done && result ? (
              <Card.Actions className="mt-4 justify-end">
                <Link
                  to="/$org/$classroom"
                  params={{ org: targetOrg, classroom: result.shortName }}
                  className="btn btn-primary"
                >
                  {t("migration.execute.viewClass")}
                </Link>
              </Card.Actions>
            ) : (
              !blocked && (
                <Button
                  variant="primary"
                  className="mt-6 w-full"
                  disabled={!canImport}
                  loading={running}
                  loadingLabel={t("migration.confirm.importing")}
                  onClick={() => setShowConfirm(true)}
                >
                  {t("migration.confirm.importButton", {
                    count: selectedCount,
                  })}
                </Button>
              )
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
          <Button variant="primary" disabled={!canImport} onClick={startImport}>
            {t("migration.confirm.modalConfirm")}
          </Button>
        </div>
      </Modal>
    </Card>
  )
}

export default ConfirmStep
