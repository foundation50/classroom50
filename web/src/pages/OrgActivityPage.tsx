import { useTranslation } from "react-i18next"
import { useParams } from "@tanstack/react-router"
import {
  Activity,
  AlertTriangle,
  Check,
  ClipboardCopy,
  Zap,
} from "lucide-react"

import { Button, Card } from "@/components/ui"
import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import { EmptyState } from "@/components/list"
import RequireTeacher from "@/components/RequireTeacher"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import { useActivity } from "@/lib/activity/useActivity"
import type { ActivityEntry } from "@/lib/activity/activityStore"
import { buildDiagnostics } from "@/lib/diagnostics/snapshot"

// Session-only activity view: the meaningful failures and actions this browser
// tab has observed (failed mutations, shown error toasts, uncaught errors,
// dispatched workflows). Ephemeral by design — nothing is persisted beyond
// sessionStorage — so it's a live troubleshooting aid, not an audit trail.
const OrgActivityPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.activity"))
  const { org } = useParams({ strict: false })
  const { entries, clear } = useActivity(org)

  const diagnostics = buildDiagnostics({ org })
  const { copied, copy } = useCopyToClipboard(diagnostics)

  return (
    <PageShell page="classes" selected="activity">
      <RequireTeacher allow="owner">
        <PageHeader
          title={t("orgActivity.heading")}
          subtitle={t("orgActivity.subtitle")}
        />

        <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => void copy()}>
            {copied ? (
              <Check aria-hidden="true" className="size-4" />
            ) : (
              <ClipboardCopy aria-hidden="true" className="size-4" />
            )}
            {copied
              ? t("orgActivity.copied")
              : t("orgActivity.copyDiagnostics")}
          </Button>
          {entries.length > 0 && (
            <Button variant="ghost" size="sm" onClick={clear}>
              {t("orgActivity.clear")}
            </Button>
          )}
        </div>

        {entries.length === 0 ? (
          <EmptyState
            className="mt-4 rounded-2xl border border-dashed border-base-300 bg-base-100 p-8 text-center"
            icon={
              <Activity
                aria-hidden="true"
                className="mx-auto mb-3 size-8 text-base-content/40"
              />
            }
            title={t("orgActivity.empty.title")}
            body={t("orgActivity.empty.body")}
          />
        ) : (
          <Card className="mt-4 w-full overflow-hidden">
            <ul className="divide-y divide-base-300">
              {entries.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} />
              ))}
            </ul>
          </Card>
        )}
      </RequireTeacher>
    </PageShell>
  )
}

const ActivityRow = ({ entry }: { entry: ActivityEntry }) => {
  const isError = entry.kind === "error"
  const meta = [
    entry.status !== undefined ? `HTTP ${entry.status}` : null,
    entry.requestId ? `req ${entry.requestId}` : null,
    entry.ssoRequired ? "SSO required" : null,
    entry.scopeGap ? "scope gap" : null,
  ].filter((x): x is string => x !== null)

  return (
    <li className="flex items-start gap-3 px-6 py-4">
      <span
        className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg ${
          isError ? "bg-error/10 text-error" : "bg-info/10 text-info"
        }`}
      >
        {isError ? (
          <AlertTriangle aria-hidden="true" className="size-4" />
        ) : (
          <Zap aria-hidden="true" className="size-4" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium break-words text-base-content">
          {entry.label}
        </p>
        {entry.endpoint && (
          <p className="mt-0.5 truncate font-mono text-xs text-base-content/60">
            {entry.endpoint}
          </p>
        )}
        {!entry.endpoint && entry.source && (
          <p className="mt-0.5 truncate font-mono text-xs text-base-content/60">
            {entry.source}
          </p>
        )}
        {meta.length > 0 && (
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-base-content/60">
            {meta.map((m) => (
              <span key={m}>{m}</span>
            ))}
          </p>
        )}
      </div>
      <time
        className="mt-0.5 shrink-0 text-xs text-base-content/50 tabular-nums"
        dateTime={new Date(entry.at).toISOString()}
      >
        {new Date(entry.at).toLocaleTimeString()}
      </time>
    </li>
  )
}

export default OrgActivityPage
