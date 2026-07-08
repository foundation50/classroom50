import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useParams } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Activity, Check, ClipboardCopy } from "lucide-react"

import { Alert, Button, Card, Spinner } from "@/components/ui"
import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import { EmptyState } from "@/components/list"
import RequireTeacher from "@/components/RequireTeacher"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import { useOptionalGitHubClient } from "@/context/github/GitHubProvider"
import { configCommitsQuery } from "@/hooks/github/queries"
import {
  listWorkflowRunsPage,
  workflowRunsPageKey,
} from "@/hooks/github/activityRuns"
import { useActivity } from "@/lib/activity/useActivity"
import {
  commitToItem,
  mergeTimeline,
  runToItem,
  sessionToItems,
} from "@/lib/activity/timeline"
import { buildDiagnostics } from "@/lib/diagnostics/snapshot"
import {
  ActivityFilters,
  type ActivityFilterState,
} from "./orgActivity/ActivityFilters"
import { TimelineRow } from "./orgActivity/TimelineRow"

// Unified, owner-only org Activity view. Merges three sources into one filterable,
// newest-first timeline:
//   - session activity (ephemeral, this-tab errors/actions)
//   - config-repo commit history ({org}/classroom50 = the audit log)
//   - Actions workflow-run history (collect-scores / regrade / publish-pages)
// Persistent sources are React Query-backed and paged independently ("Load
// older"); the session source is the existing in-memory store. They meet only
// as TimelineItem[].
const OrgActivityPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.activity"))
  const { org } = useParams({ strict: false })
  const client = useOptionalGitHubClient()

  const { entries } = useActivity(org)
  // "Load older" grows the page window rather than paging, so a single query
  // holds the whole accumulated window (avoids infinite-query plumbing and the
  // append/replace bug of bumping `page`). Capped at GitHub's per_page max.
  const [perPage, setPerPage] = useState(30)
  const atMax = perPage >= 100
  const [filters, setFilters] = useState<ActivityFilterState>({
    sources: new Set(),
    types: new Set(),
  })

  // Reuse the banner's i18n workflow labels; fall back to the run's own title.
  const runLabel = (file: string | undefined, fallback: string | undefined) => {
    const key: Record<string, string> = {
      "publish-pages.yaml": "actionsBanner.workflow.publishPages",
      "collect-scores.yaml": "actionsBanner.workflow.collectScores",
      "regrade.yaml": "actionsBanner.workflow.regrade",
    }
    if (file && key[file]) return t(key[file])
    return fallback ?? t("actionsBanner.workflow.generic")
  }

  // One accumulated window per persistent source, keyed by the window size so
  // growing it refetches. Fixed page=1; perPage grows on "Load older".
  const commits = useQuery({
    ...configCommitsQuery(client!, org, perPage),
    enabled: Boolean(client && org),
  })
  const runs = useQuery({
    queryKey: workflowRunsPageKey(org ?? "", perPage),
    queryFn: ({ signal }) =>
      listWorkflowRunsPage(client!, org!, 1, perPage, signal),
    enabled: Boolean(client && org),
    staleTime: 60 * 1000,
    retry: false,
  })

  const items = useMemo(() => {
    const sessionItems = sessionToItems(entries)
    const commitItems = (commits.data ?? []).map(commitToItem)
    const runItems = (runs.data ?? []).map((r) => runToItem(r, runLabel))
    return mergeTimeline([...sessionItems, ...commitItems, ...runItems], {
      sources: filters.sources,
      types: filters.types,
    })
    // runLabel closes over t only; stable enough for this memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, commits.data, runs.data, filters])

  const diagnostics = buildDiagnostics({ org })
  const { copied, copy } = useCopyToClipboard(diagnostics)

  const loading = commits.isLoading || runs.isLoading
  const sourceError = commits.isError || runs.isError

  return (
    <PageShell page="classes" selected="activity">
      <RequireTeacher allow="owner">
        <PageHeader
          title={t("orgActivity.heading")}
          subtitle={t("orgActivity.subtitle")}
        />

        <div className="mt-6 flex flex-wrap items-start justify-between gap-3">
          <ActivityFilters state={filters} onChange={setFilters} />
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
        </div>

        {sourceError && (
          <Alert tone="warning" className="mt-4 text-sm" role="status">
            <span>{t("orgActivity.partialError")}</span>
          </Alert>
        )}

        {items.length === 0 ? (
          loading ? (
            <div className="mt-4 flex items-center justify-center gap-3 px-6 py-12 text-base-content/70">
              <Spinner size="md" />
              <span className="text-sm">{t("orgActivity.loading")}</span>
            </div>
          ) : (
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
          )
        ) : (
          <>
            <Card className="mt-4 w-full overflow-hidden">
              <ul className="divide-y divide-base-300">
                {items.map((item) => (
                  <TimelineRow key={item.id} item={item} />
                ))}
              </ul>
            </Card>
            <div className="mt-4 flex justify-center">
              {!atMax && (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={commits.isFetching || runs.isFetching}
                  onClick={() => setPerPage((n) => Math.min(n + 30, 100))}
                >
                  {t("orgActivity.loadOlder")}
                </Button>
              )}
            </div>
          </>
        )}
      </RequireTeacher>
    </PageShell>
  )
}

export default OrgActivityPage
