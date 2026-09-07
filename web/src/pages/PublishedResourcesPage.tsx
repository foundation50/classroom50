import { useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { InlineSpinner } from "@/components/Spinner"
import { useParams } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  FileDirectoryFillIcon,
  FileIcon,
  GlobeIcon,
  LinkExternalIcon,
  ShieldXIcon,
  rtlFlip,
} from "@/components/ui/icons"
import { Trans, useTranslation } from "react-i18next"

import PageShell from "@/components/PageShell"
import PageHeader, { OrgLink } from "@/components/PageHeader"
import {
  Badge,
  Button,
  Collapse,
  HelpTooltip,
  InlineMessage,
  MonoLtr,
  Heading,
  cx,
} from "@/components/ui"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import RequireRole from "@/components/RequireRole"
import useGetClasses from "@/hooks/useGetClasses"
import useGetClassroom from "@/hooks/useGetClassroom"
import usePagesAssignments from "@/hooks/usePagesAssignments"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import { classroomPagesSegment } from "@/util/secret"
import { githubOrgUrl } from "@/util/orgUrl"
import { defaultPagesBaseUrl } from "@/github-core/queries"

type Resource = {
  url: string
  // Path shown in the file list, relative to the base the page establishes
  // up top (the repo-browser idiom: the base appears once, rows stay short).
  path: string
  // What the file is, in teacher-facing terms.
  label: string
  // Why it's published / who reads it. Shown in a help tooltip, not inline.
  description: string
  // Some artifacts exist only once a teacher configures them (e.g., a classroom
  // default autograder), so a 404 is expected, not a problem.
  optional?: boolean
}

// Live reachability probe for a published URL. Anonymous GET (exactly how
// students and the autograder fetch it) so the teacher sees the public view.
// Bounded so a hung github.io host can't stall the page.
function useResourceStatus(url: string, enabled: boolean) {
  return useQuery({
    queryKey: ["published-resource", url],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<"public" | "missing" | "unreachable"> => {
      try {
        const res = await fetch(url, {
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        })
        if (res.status === 404) return "missing"
        if (!res.ok) return "unreachable"
        return "public"
      } catch {
        return "unreachable"
      }
    },
  })
}

// Whether `ref` has entered the viewport at least once. Defers the
// reachability probe until the row is visible, so a teacher with many
// classrooms/assignments doesn't fire dozens of simultaneous anonymous
// github.io requests on mount (edge rate-limits would show as false
// "Unreachable"). Stays true once seen, so it doesn't flip to "Checking".
function useInView<T extends Element>(ref: RefObject<T | null>): boolean {
  // Fail open when IntersectionObserver is unavailable (jsdom/older browsers):
  // start visible so the probe still runs rather than hanging on "Checking".
  const [inView, setInView] = useState(
    () => typeof IntersectionObserver === "undefined",
  )
  useEffect(() => {
    const el = ref.current
    if (!el || inView) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true)
          observer.disconnect()
        }
      },
      { rootMargin: "200px" },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, inView])
  return inView
}

function CopyButton({ value }: { value: string }) {
  const { t } = useTranslation()
  const { copied, copy } = useCopyToClipboard(value, 1200)
  return (
    <Button
      variant="ghost"
      size="xs"
      aria-label={t("published.copyUrl")}
      title={t("published.copyUrl")}
      onClick={copy}
    >
      {copied ? (
        <CheckIcon aria-hidden="true" className="size-4 text-success" />
      ) : (
        <CopyIcon aria-hidden="true" className="size-4" />
      )}
    </Button>
  )
}

function StatusBadge({ url }: { url: string }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLSpanElement>(null)
  const inView = useInView(ref)
  const { data: status, isLoading } = useResourceStatus(url, inView)

  // Before the row scrolls into view the probe is disabled (status undefined,
  // isLoading false); show pending rather than a premature "Unreachable".
  if (!inView || isLoading) {
    return (
      <span
        ref={ref}
        className="inline-flex items-center gap-1 text-xs text-base-content/70"
      >
        <InlineSpinner />
        {t("published.status.checking")}
      </span>
    )
  }

  if (status === "public") {
    return (
      <Badge tone="success" className="gap-1">
        <GlobeIcon aria-hidden="true" className="size-3" />
        {t("published.status.public")}
      </Badge>
    )
  }

  if (status === "missing") {
    return (
      <Badge ghost title={t("published.status.notPublishedTitle")}>
        {t("published.status.notPublished")}
      </Badge>
    )
  }

  return (
    <Badge tone="warning" title={t("published.status.unreachableTitle")}>
      {t("published.status.unreachable")}
    </Badge>
  )
}

// One file per row, repo-browser style: the mono path is the primary text
// (the base URL is shown once at the top of the page), the friendly label is
// the muted second line, and the "what is this" prose stays behind a help
// tooltip so the list reads like a file listing.
function FileRow({
  resource,
  nested = false,
}: {
  resource: Resource
  nested?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div
      className={cx(
        "flex flex-col gap-2 py-2.5 pe-4 sm:flex-row sm:items-center sm:justify-between",
        nested ? "ps-10" : "ps-4",
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <FileIcon
          aria-hidden="true"
          className="mt-1 size-4 shrink-0 text-base-content/50"
        />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <MonoLtr className="truncate text-sm text-base-content">
              {resource.path}
            </MonoLtr>
            {resource.optional && (
              <Badge ghost size="xs">
                {t("published.optional")}
              </Badge>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1 text-xs text-base-content/70">
            <span className="truncate">{resource.label}</span>
            <HelpTooltip help={resource.description} />
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 ps-7 sm:ps-0">
        <StatusBadge url={resource.url} />
        <div className="flex items-center gap-1">
          <CopyButton value={resource.url} />
          <Button
            as="a"
            variant="ghost"
            size="xs"
            href={resource.url}
            target="_blank"
            rel="noreferrer"
            aria-label={t("published.openUrl")}
            title={t("published.openUrl")}
          >
            <LinkExternalIcon aria-hidden="true" className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

// A classroom rendered as a folder row in the unified file list. Reads
// published assignments.json to enumerate the exact per-assignment
// bundles/shims so the list reflects reality. A classroom that hasn't
// published yet still shows its index/manifest rows (as "Not published").
function ClassroomFolder({
  org,
  classroom,
}: {
  org: string
  classroom: string
}) {
  const { t } = useTranslation()
  const { data: classroomData, isLoading: classroomLoading } = useGetClassroom(
    org,
    classroom,
  )
  const secret = classroomData?.secret
  // Classroom-scoped rows live at the custom Pages base when the classroom
  // declares one (github.io only redirects there, and CORS-fails in a
  // browser); the site-root files above stay on the github.io default, which
  // is where the engine files are canonically addressed.
  const base = classroomData?.pages_base_url || defaultPagesBaseUrl(org)
  // Gate on the classroom read: fetching before the secret resolves would hit
  // the unprotected path and 404 a protected classroom. The same read carries
  // pages_base_url, so the reachability probe checks the real host too.
  const { data: assignments, isPending: assignmentsPending } =
    usePagesAssignments(org, classroom, secret, {
      enabled: !classroomLoading,
      pagesBaseUrl: classroomData?.pages_base_url,
    })
  const [open, setOpen] = useState(false)

  // Hold skeletons until both reads settle so the resource rows and the "N
  // files" count don't pop in one by one as each query resolves.
  const loading = classroomLoading || assignmentsPending

  // When protected, everything is served under the capability-URL segment; else
  // the plain classroom path. Same segment builder the Pages URL helpers use.
  const segment = classroomPagesSegment(classroom, secret)

  const resources = useMemo<Resource[]>(() => {
    const file = (path: string): { url: string; path: string } => ({
      url: `${base}/${segment}/${path}`,
      path: `${segment}/${path}`,
    })
    const rows: Resource[] = [
      {
        ...file("assignments.json"),
        label: t("published.resources.assignmentsManifest.label"),
        description: t("published.resources.assignmentsManifest.description"),
      },
      {
        ...file("autograder.py"),
        label: t("published.resources.classroomAutograder.label"),
        description: t("published.resources.classroomAutograder.description"),
        optional: true,
      },
    ]

    for (const a of assignments ?? []) {
      rows.push({
        ...file(`autograders/${a.slug}.tar.gz`),
        label: t("published.resources.autograderBundle.label", {
          name: a.name || a.slug,
        }),
        description: t("published.resources.autograderBundle.description"),
      })
      // Only assignments using a non-default named autograder publish a
      // workflow shim; the default uses the embedded shim instead.
      if (a.autograder && a.autograder !== "default") {
        rows.push({
          ...file(`autograders/${a.autograder}.yaml`),
          label: t("published.resources.autograderShim.label", {
            name: a.autograder,
          }),
          description: t("published.resources.autograderShim.description"),
          optional: true,
        })
      }
    }

    return rows
  }, [assignments, base, segment, t])

  return (
    <div aria-busy={loading || undefined}>
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-2.5 text-start hover:bg-base-300/40"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cx(
            "size-4 shrink-0 text-base-content/50 transition-transform",
            rtlFlip,
            open && "rotate-90",
          )}
        />
        <FileDirectoryFillIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-base-content/50"
        />
        <span className="truncate text-sm font-semibold">
          {classroomData?.name || classroom}
        </span>
        {classroomData?.name && classroomData.name !== classroom && (
          <MonoLtr className="hidden truncate text-xs text-base-content/60 sm:inline">
            {classroom}
          </MonoLtr>
        )}
        {loading ? (
          <span
            aria-hidden="true"
            className="skeleton skeleton-shimmer h-5 w-16 shrink-0 rounded-full"
          />
        ) : secret ? (
          <Badge tone="warning" size="xs" className="shrink-0 gap-1">
            <ShieldXIcon aria-hidden="true" className="size-3" />
            {t("published.unlisted")}
          </Badge>
        ) : (
          <Badge tone="info" size="xs" className="shrink-0 gap-1">
            <GlobeIcon aria-hidden="true" className="size-3" />
            {t("published.public")}
          </Badge>
        )}
        <span className="ms-auto shrink-0 text-xs text-base-content/70">
          {loading ? (
            <span
              aria-hidden="true"
              className="skeleton skeleton-shimmer inline-block h-3 w-12 align-middle"
            />
          ) : (
            t("published.fileCount", { count: resources.length })
          )}
        </span>
      </button>
      <Collapse open={open}>
        <div className="border-t border-base-300">
          {loading ? (
            <div className="flex flex-col gap-3 p-4" aria-hidden="true">
              {Array.from({ length: 2 }).map((_, i) => (
                <div
                  key={i}
                  className="skeleton skeleton-shimmer h-12 rounded-box"
                />
              ))}
            </div>
          ) : (
            <>
              {secret && (
                <InlineMessage tone="warning" className="px-4 pt-3">
                  {t("published.unlistedNote")}
                </InlineMessage>
              )}
              {classroomData?.pages_base_url && (
                <p className="px-4 pt-3 text-xs text-base-content/70">
                  <Trans
                    i18nKey="published.customBase"
                    values={{ base }}
                    components={{ path: <MonoLtr /> }}
                  />
                </p>
              )}
              <div className="divide-y divide-base-300">
                {resources.map((r) => (
                  <FileRow key={r.url} resource={r} nested />
                ))}
              </div>
            </>
          )}
        </div>
      </Collapse>
    </div>
  )
}

export const PublishedResourcesPane = ({ org }: { org: string }) => {
  const { t } = useTranslation()
  const base = defaultPagesBaseUrl(org)
  const { classes, isLoading: classesLoading } = useGetClasses(org)

  // Site-root files are classroom-independent: the public index and the two
  // generic engine scripts served at the Pages site root.
  const rootResources: Resource[] = [
    {
      url: `${base}/classrooms-index.json`,
      path: "classrooms-index.json",
      label: t("published.resources.classroomsIndex.label"),
      description: t("published.resources.classroomsIndex.description"),
    },
    {
      url: `${base}/runner.py`,
      path: "runner.py",
      label: t("published.resources.runner.label"),
      description: t("published.resources.runner.description"),
    },
    {
      url: `${base}/ensure_feedback_pr.py`,
      path: "ensure_feedback_pr.py",
      label: t("published.resources.feedbackPr.label"),
      description: t("published.resources.feedbackPr.description"),
    },
  ]

  return (
    <div className="mt-8 flex flex-col gap-4">
      {/* The one mental model the page needs: your org serves a single public
          Pages site. The base URL appears here once; every row below shows
          only its path relative to this base. */}
      <section className="rounded-box border border-base-300 bg-base-200 px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="min-w-0">
            <Heading as="h2">{t("published.siteTitle")}</Heading>
            <MonoLtr className="mt-1 block truncate text-sm">{base}</MonoLtr>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <CopyButton value={base} />
            <Button
              as="a"
              variant="ghost"
              size="xs"
              href={base}
              target="_blank"
              rel="noreferrer"
              aria-label={t("published.openUrl")}
              title={t("published.openUrl")}
            >
              <LinkExternalIcon aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </div>
        <p className="mt-2 text-sm text-base-content/70">
          {t("published.publicNote")}
        </p>
      </section>

      <section className="divide-y divide-base-300 rounded-box border border-base-300 bg-base-100">
        {rootResources.map((r) => (
          <FileRow key={r.url} resource={r} />
        ))}
        {/* Hold the skeleton while the class list loads — the empty-while-
            loading array is indistinguishable from a genuinely empty org, so
            rendering on it flashes the "no classrooms" empty state. */}
        {classesLoading ? (
          <div className="flex flex-col gap-3 p-4" aria-busy="true">
            {Array.from({ length: 2 }).map((_, i) => (
              <div
                key={i}
                aria-hidden="true"
                className="skeleton skeleton-shimmer h-10 rounded-box"
              />
            ))}
          </div>
        ) : classes.length === 0 ? (
          <p className="px-4 py-4 text-sm text-base-content/70">
            {t("published.noClassrooms")}
          </p>
        ) : (
          classes.map((cl) => (
            <ClassroomFolder key={cl.path} org={org} classroom={cl.path} />
          ))
        )}
      </section>
    </div>
  )
}

const PublishedResourcesPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.publishedResources"))
  const { org } = useParams({ strict: false })

  return (
    <PageShell>
      <RequireRole>
        <PageHeader
          title={t("published.pageHeading")}
          subtitle={
            <Trans
              i18nKey="published.pageSubheading"
              values={{ org: org ?? "" }}
              components={{
                orgLink: (
                  <OrgLink
                    org={org}
                    href={githubOrgUrl(org ?? "")}
                    title={t("common.openOrgOnGitHub", { org })}
                  />
                ),
              }}
            />
          }
        />
        {org && <PublishedResourcesPane org={org} />}
      </RequireRole>
    </PageShell>
  )
}

export default PublishedResourcesPage
