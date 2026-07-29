// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). Phase 3: run the migration with live
// per-item progress and a truthful summary (partial is never shown as full).

import { useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { CheckCircle } from "lucide-react"

import { Alert, Card, Spinner } from "@/components/ui"
import { useGitHubViewer } from "@/hooks/useGitHubResources"
import { useMigrateClassroom } from "@/hooks/mutations/useMigrateClassroom"
import type {
  MigrationItemStatus,
  MigrationPreflight,
  MigrationResult,
} from "@/migration/types"
import { MigrationItemCard, type ItemVisualStatus } from "./migrationItemCard"

export const ExecuteStep = ({
  plan,
  targetOrg,
  onDone,
}: {
  plan: MigrationPreflight
  targetOrg: string
  onDone?: (result: MigrationResult) => void
}) => {
  const { t } = useTranslation()
  const { data: viewer } = useGitHubViewer()
  const mutation = useMigrateClassroom(targetOrg)

  // Per-item live status, seeded from the plan (all pending except pre-known skips).
  const [statuses, setStatuses] = useState<Record<string, MigrationItemStatus>>(
    () =>
      Object.fromEntries(
        plan.items.map((i) => [
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

  // Kick the migration exactly once on mount.
  const startedRef = useRef(false)
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    mutation.mutate(
      {
        plan,
        options: {
          creator: viewer?.login,
          onItem: (s) => setStatuses((prev) => ({ ...prev, [s.slug]: s })),
        },
      },
      { onSuccess: (result) => onDone?.(result) },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const result = mutation.data
  const done = mutation.isSuccess
  const hadSkips = (result?.skipped.length ?? 0) > 0

  return (
    <Card>
      <Card.Body>
        <Card.Title>
          {done
            ? t("migration.execute.doneTitle")
            : mutation.isError
              ? t("migration.execute.failedTitle")
              : t("migration.execute.runningTitle")}
        </Card.Title>

        {!done && !mutation.isError && (
          <div className="flex items-center gap-2 text-base-content/70">
            <Spinner size="sm" />
            {t("migration.execute.runningBody")}
          </div>
        )}

        {mutation.isError && (
          <Alert tone="error" className="mt-2 items-start">
            <div>
              <p className="font-medium">{t("migration.execute.error")}</p>
              <p className="mt-1 text-sm">
                {mutation.error instanceof Error
                  ? mutation.error.message
                  : String(mutation.error)}
              </p>
            </div>
          </Alert>
        )}

        <ul className="mt-4 grid gap-2">
          {plan.items.map((item) => {
            const s = statuses[item.assignment.slug]
            return (
              <li key={item.assignment.id}>
                <MigrationItemCard
                  assignment={item.assignment}
                  status={(s?.status ?? "pending") as ItemVisualStatus}
                  reason={s?.reason}
                  targetName={item.targetName}
                  targetOrg={targetOrg}
                  targetBranch={item.branch}
                  templateLess={item.templateLess}
                />
              </li>
            )
          })}
        </ul>

        {done && result && (
          <>
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

            <Card.Actions className="mt-4 justify-end">
              <Link
                to="/$org/$classroom"
                params={{ org: targetOrg, classroom: result.shortName }}
                className="btn btn-primary"
              >
                {t("migration.execute.viewClass")}
              </Link>
            </Card.Actions>
          </>
        )}
      </Card.Body>
    </Card>
  )
}

export default ExecuteStep
