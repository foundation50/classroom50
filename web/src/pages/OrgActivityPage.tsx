import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useParams } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import Papa from "papaparse"
import { Activity } from "lucide-react"

import { Alert, Card, Spinner, Button } from "@/components/ui"
import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import { EmptyState } from "@/components/list"
import RequireTeacher from "@/components/RequireTeacher"
import { DiagnosticsDialog } from "@/components/DiagnosticsDialog"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import useGetOrgPlanDetails from "@/hooks/useGetOrgPlanDetails"
import { useOptionalGitHubClient } from "@/context/github/GitHubProvider"
import { configCommitsQuery } from "@/hooks/github/queries"
import {
  listWorkflowRunsPage,
  workflowRunsPageKey,
} from "@/hooks/github/activityRuns"
import { useActivity } from "@/lib/activity/useActivity"
import {
  commitToItem,
  matchesQuery,
  mergeTimeline,
  runToItem,
  sessionToItems,
  timelineToCsvRows,
} from "@/lib/activity/timeline"
import {
  ActivityToolbar,
  type ActivityFilterState,
} from "./orgActivity/ActivityToolbar"
import { TimelineRow } from "./orgActivity/TimelineRow"

// Workflow file -> i18n label key, reused from the actions banner. Module-level
// so the map isn't reallocated per render / per run item.
const WORKFLOW_LABEL_KEY: Record<string, string> = {
  "publish-pages.yaml": "actionsBanner.workflow.publishPages",
  "collect-scores.yaml": "actionsBanner.workflow.collectScores",
  "regrade.yaml": "actionsBanner.workflow.regrade",
}

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
  // Org plan for the diagnostics snapshot (owners only; undefined otherwise —
  // the snapshot then reports "unknown" with a reason). Same source the About
  // dialog threads in, so both snapshots agree.
  const { data: orgPlanDetails } = useGetOrgPlanDetails(org)
  // "Load older" grows the page window rather than paging, so a single query
  // holds the whole accumulated window (avoids infinite-query plumbing and the
  // append/replace bug of bumping `page`). Capped at GitHub's per_page max.
  const [perPage, setPerPage] = useState(30)
  const atMax = perPage >= 100
  const [query, setQuery] = useState("")
  const [filters, setFilters] = useState<ActivityFilterState>({
    sources: new Set(),
    types: new Set(),
  })
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)

  // Reuse the banner's i18n workflow labels; fall back to the run's own title.
  const runLabel = (file: string | undefined, fallback: string | undefined) => {
    if (file && WORKFLOW_LABEL_KEY[file]) return t(WORKFLOW_LABEL_KEY[file])
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
    const merged = mergeTimeline(
      [...sessionItems, ...commitItems, ...runItems],
      {
        sources: filters.sources,
        types: filters.types,
      },
    )
    return query.trim() ? merged.filter((i) => matchesQuery(i, query)) : merged
    // runLabel closes over t only; stable enough for this memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, commits.data, runs.data, filters, query])

  // Export the currently-shown (filtered + searched) timeline as a CSV download.
  const exportCsv = () => {
    const csv = Papa.unparse(timelineToCsvRows(items), { header: true })
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `${org ?? "org"}-activity.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  const loading = commits.isLoading || runs.isLoading
  const sourceError = commits.isError || runs.isError
  const hasActiveFilter =
    query.trim().length > 0 ||
    filters.sources.size > 0 ||
    filters.types.size > 0

  return (
    <PageShell page="classes" selected="activity">
      <RequireTeacher allow="owner">
        <PageHeader
          title={t("orgActivity.heading")}
          subtitle={t("orgActivity.subtitle")}
        />

        <ActivityToolbar
          query={query}
          onQueryChange={setQuery}
          filters={filters}
          onFiltersChange={setFilters}
          onExportCsv={exportCsv}
          onShowDiagnostics={() => setDiagnosticsOpen(true)}
          resultCount={items.length}
        />

        <DiagnosticsDialog
          open={diagnosticsOpen}
          onClose={() => setDiagnosticsOpen(false)}
          org={org}
          planName={orgPlanDetails?.plan?.name}
        />

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
              title={
                hasActiveFilter
                  ? t("orgActivity.noMatch.title")
                  : t("orgActivity.empty.title")
              }
              body={
                hasActiveFilter
                  ? t("orgActivity.noMatch.body")
                  : t("orgActivity.empty.body")
              }
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
            {/* "Load older" fetches more from the server; hide it while a search
                or filter is narrowing the view (more server data wouldn't
                obviously help, and the count would be confusing). */}
            {!atMax && !hasActiveFilter && (
              <div className="mt-4 flex justify-center">
                <Button
                  variant="ghost"
                  size="sm"
                  loading={commits.isFetching || runs.isFetching}
                  onClick={() => setPerPage((n) => Math.min(n + 30, 100))}
                >
                  {t("orgActivity.loadOlder")}
                </Button>
              </div>
            )}
          </>
        )}
      </RequireTeacher>
    </PageShell>
  )
}

export default OrgActivityPage
