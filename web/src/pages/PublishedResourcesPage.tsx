import { useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { useParams } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Globe,
  Info,
  Loader2,
  ShieldAlert,
} from "lucide-react"
import { motion } from "motion/react"
import { useTranslation } from "react-i18next"
import { enterExit, staggerTransition } from "@/lib/motion"

import PageShell from "@/components/PageShell"
import PageHeader, { OrgLink } from "@/components/PageHeader"
import { Button } from "@/components/ui"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import RequireTeacher from "@/components/RequireTeacher"
import useGetClasses from "@/hooks/useGetClasses"
import useGetClassroom from "@/hooks/useGetClassroom"
import usePagesAssignments from "@/hooks/usePagesAssignments"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import { classroomPagesSegment } from "@/util/secret"
import { githubOrgUrl } from "@/util/orgUrl"
import { CONFIG_REPO } from "@/util/configRepo"

// Pages base for an org's classroom50 config repo. `classroom50` is the fixed
// repo name, not the org name. Single-sourced so every row derives from it.
function pagesBaseUrl(org: string) {
  return `https://${org}.github.io/${CONFIG_REPO}`
}

// "engine" = generic, org-agnostic bootstrap code (identical for every org);
// "data" = org-specific content (classrooms, assignments, autograders).
type ResourceKind = "engine" | "data"

type Resource = {
  url: string
  // What the file is, in teacher-facing terms.
  label: string
  // Why it's published / who reads it.
  description: string
  kind: ResourceKind
  // Some artifacts exist only once a teacher configures them (e.g. a classroom
  // default autograder), so a 404 is expected, not a problem.
  optional?: boolean
}

const KIND_BADGE: Record<
  ResourceKind,
  { labelKey: string; className: string }
> = {
  engine: {
    labelKey: "published.kind.engine",
    className: "badge-ghost",
  },
  data: {
    labelKey: "published.kind.data",
    className: "badge-primary badge-soft",
  },
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
        <Check aria-hidden="true" className="size-3.5 text-success" />
      ) : (
        <Copy aria-hidden="true" className="size-3.5" />
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
        <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
        {t("published.status.checking")}
      </span>
    )
  }

  if (status === "public") {
    return (
      <span ref={ref} className="badge badge-success badge-soft badge-sm gap-1">
        <Globe aria-hidden="true" className="size-3" />
        {t("published.status.public")}
      </span>
    )
  }

  if (status === "missing") {
    return (
      <span
        ref={ref}
        className="badge badge-ghost badge-sm"
        title={t("published.status.notPublishedTitle")}
      >
        {t("published.status.notPublished")}
      </span>
    )
  }

  return (
    <span
      ref={ref}
      className="badge badge-warning badge-soft badge-sm"
      title={t("published.status.unreachableTitle")}
    >
      {t("published.status.unreachable")}
    </span>
  )
}

function ResourceRow({ resource }: { resource: Resource }) {
  const { t } = useTranslation()
  const badge = KIND_BADGE[resource.kind]
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-base-200 bg-base-100 p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-base-content">
            {resource.label}
          </span>
          <span className={`badge badge-sm ${badge.className}`}>
            {t(badge.labelKey)}
          </span>
          {resource.optional && (
            <span className="badge badge-ghost badge-sm">
              {t("published.optional")}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-base-content/70">
          {resource.description}
        </p>
        <code className="mt-2 block truncate text-xs text-base-content/70">
          {resource.url}
        </code>
      </div>
      <div className="flex shrink-0 items-center gap-1 sm:flex-col sm:items-end">
        <StatusBadge url={resource.url} />
        <div className="flex items-center gap-1">
          <CopyButton value={resource.url} />
          <a
            href={resource.url}
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost btn-xs"
            aria-label={t("published.openUrl")}
            title={t("published.openUrl")}
          >
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </a>
        </div>
      </div>
    </div>
  )
}

// Per-classroom artifacts. Reads published assignments.json to enumerate the
// exact per-assignment bundles/shims so the list reflects reality. A classroom
// that hasn't published yet still shows its index/manifest rows (as "Not
// published").
function ClassroomResources({
  org,
  classroom,
  index = 0,
}: {
  org: string
  classroom: string
  index?: number
}) {
  const { t } = useTranslation()
  const base = pagesBaseUrl(org)
  const { data: classroomData } = useGetClassroom(org, classroom)
  const secret = classroomData?.secret
  const { data: assignments } = usePagesAssignments(org, classroom, secret)
  const [open, setOpen] = useState(true)

  // When protected, everything is served under the capability-URL segment; else
  // the plain classroom path. Same segment builder the Pages URL helpers use.
  const classroomBase = `${base}/${classroomPagesSegment(classroom, secret)}`

  const resources = useMemo<Resource[]>(() => {
    const rows: Resource[] = [
      {
        url: `${classroomBase}/assignments.json`,
        label: t("published.resources.assignmentsManifest.label"),
        description: t("published.resources.assignmentsManifest.description"),
        kind: "data",
      },
      {
        url: `${classroomBase}/autograder.py`,
        label: t("published.resources.classroomAutograder.label"),
        description: t("published.resources.classroomAutograder.description"),
        kind: "data",
        optional: true,
      },
    ]

    for (const a of assignments ?? []) {
      rows.push({
        url: `${classroomBase}/autograders/${a.slug}.tar.gz`,
        label: t("published.resources.autograderBundle.label", {
          name: a.name || a.slug,
        }),
        description: t("published.resources.autograderBundle.description"),
        kind: "data",
      })
      // Only assignments using a non-default named autograder publish a
      // workflow shim; the default uses the embedded shim instead.
      if (a.autograder && a.autograder !== "default") {
        rows.push({
          url: `${classroomBase}/autograders/${a.autograder}.yaml`,
          label: t("published.resources.autograderShim.label", {
            name: a.autograder,
          }),
          description: t("published.resources.autograderShim.description"),
          kind: "data",
          optional: true,
        })
      }
    }

    return rows
  }, [assignments, classroomBase, t])

  return (
    <motion.div
      className="rounded-2xl border border-base-200 bg-base-100"
      variants={enterExit}
      initial="initial"
      animate="animate"
      transition={staggerTransition(index)}
    >
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-semibold">{classroom}</h3>
            {secret ? (
              <span className="badge badge-warning badge-soft badge-sm gap-1">
                <ShieldAlert aria-hidden="true" className="size-3" />
                {t("published.unlisted")}
              </span>
            ) : (
              <span className="badge badge-ghost badge-sm">
                {t("published.publicPath")}
              </span>
            )}
          </div>
          <p className="text-xs text-base-content/70">
            {t("published.resourceCount", { count: resources.length })}
            {secret ? t("published.servedUnlistedSuffix") : ""}
          </p>
        </div>
        <ChevronDown
          aria-hidden="true"
          className={`size-5 shrink-0 text-base-content/70 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-base-200 p-5">
          {secret && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-base-content/70">
              <ShieldAlert
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-warning"
              />
              <span>{t("published.unlistedWarning")}</span>
            </div>
          )}
          {resources.map((r) => (
            <ResourceRow key={r.url} resource={r} />
          ))}
        </div>
      )}
    </motion.div>
  )
}

export const PublishedResourcesPane = ({ org }: { org: string }) => {
  const { t } = useTranslation()
  const base = pagesBaseUrl(org)
  const { classes } = useGetClasses(org)

  // Org-level resources are classroom-independent: the public index and the two
  // generic engine scripts served at the Pages site root.
  const orgResources: Resource[] = [
    {
      url: `${base}/classrooms-index.json`,
      label: t("published.resources.classroomsIndex.label"),
      description: t("published.resources.classroomsIndex.description"),
      kind: "data",
    },
    {
      url: `${base}/runner.py`,
      label: t("published.resources.runner.label"),
      description: t("published.resources.runner.description"),
      kind: "engine",
    },
    {
      url: `${base}/ensure_feedback_pr.py`,
      label: t("published.resources.feedbackPr.label"),
      description: t("published.resources.feedbackPr.description"),
      kind: "engine",
    },
  ]

  return (
    <div className="mt-8 flex flex-col gap-8">
      <div className="flex items-start gap-3 rounded-xl border border-info/30 bg-info/10 p-4 text-sm">
        <Info aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-info" />
        <div>
          <p className="font-semibold text-base-content">
            {t("published.banner.title")}
          </p>
          <p className="mt-1 text-base-content/70">
            {t("published.banner.body")}
          </p>
        </div>
      </div>

      <section>
        <div className="flex items-center gap-2">
          <Globe aria-hidden="true" className="size-5 text-base-content/70" />
          <h2 className="text-lg font-bold">{t("published.orgLevel")}</h2>
        </div>
        <p className="mt-1 text-sm text-base-content/70">
          {t("published.orgLevelServedPrefix")}{" "}
          <code className="text-xs">{base}/</code>.
        </p>
        <div className="mt-4 flex flex-col gap-3">
          {orgResources.map((r) => (
            <ResourceRow key={r.url} resource={r} />
          ))}
        </div>
      </section>

      <section>
        <div className="flex items-center gap-2">
          <ShieldAlert
            aria-hidden="true"
            className="size-5 text-base-content/70"
          />
          <h2 className="text-lg font-bold">{t("published.perClassroom")}</h2>
        </div>
        <p className="mt-1 text-sm text-base-content/70">
          {t("published.perClassroomDescription")}
        </p>
        {classes.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-base-300 bg-base-100 p-6 text-center text-sm text-base-content/70">
            {t("published.noClassrooms")}
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            {classes.map((cl, i) => (
              <ClassroomResources
                key={cl.path}
                org={org}
                classroom={cl.path}
                index={i}
              />
            ))}
          </div>
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
    <PageShell page="classes" selected="published">
      <RequireTeacher>
        <PageHeader
          title={t("published.pageHeading")}
          subtitle={
            <>
              {t("published.pageSubheadingPrefix")}{" "}
              <OrgLink
                org={org}
                href={githubOrgUrl(org ?? "")}
                title={t("common.openOrgOnGitHub", { org })}
              />
              {t("published.pageSubheadingSuffix")}
            </>
          }
        />
        {org && <PublishedResourcesPane org={org} />}
      </RequireTeacher>
    </PageShell>
  )
}

export default PublishedResourcesPage
