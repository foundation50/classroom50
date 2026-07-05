import Drawer, {
  DrawerContent,
  DrawerSidebar,
  DrawerToggle,
} from "@/components/drawer"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import type { Classroom50OrgSummary } from "@/hooks/github/queries"
import useGetOrgs from "@/hooks/useGetOrgs"
import useNeedsSetupPlans from "@/hooks/useNeedsSetupPlans"
import { useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ExternalLink, Info, Lock, RefreshCw } from "lucide-react"
import { motion } from "motion/react"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { GitHubLink } from "@/components/GitHubLink"
import PlanBadge from "@/components/PlanBadge"
import { enterExit, staggerTransition } from "@/lib/motion"
import { classifyPlan, planSortWeight } from "@/lib/orgPlan"

function MissingOrgNotice({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean
  onRefresh: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="rounded-2xl border border-info/20 bg-info/5 p-5 shadow-sm">
      <div className="flex gap-4">
        <div className="mt-1 flex size-10 shrink-0 items-center justify-center rounded-full bg-info/10 text-info">
          <Info aria-hidden="true" className="size-5" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-base-content">
                {t("orgs.missingNotice.title")}
              </h2>

              <p className="mt-1 text-sm leading-6 text-base-content/70">
                {t("orgs.missingNotice.body")}
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <a
              href="https://github.com/settings/connections/applications"
              target="_blank"
              rel="noreferrer"
              className="btn btn-info btn-sm"
            >
              {t("orgs.missingNotice.manageOauth")}
              <ExternalLink aria-hidden="true" className="size-4" />
            </a>

            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={refreshing}
              onClick={onRefresh}
            >
              <RefreshCw
                aria-hidden="true"
                className={["size-4", refreshing ? "animate-spin" : ""].join(
                  " ",
                )}
              />
              {refreshing
                ? t("orgs.missingNotice.refreshing")
                : t("orgs.missingNotice.refresh")}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function OrgCard({
  summary,
  index = 0,
  planName,
}: {
  summary: Classroom50OrgSummary
  index?: number
  planName?: string
}) {
  const { t } = useTranslation()
  const { org, membership, classroom50 } = summary

  const isReady = classroom50.status === "ready"
  const needsSetup = classroom50.status === "needs_setup"
  const noAccess = classroom50.status === "no_access"
  const isAdmin = membership.role === "admin"
  const isActiveMember = membership.state === "active"

  // Show a plan badge whenever GitHub returned a plan name (owners of
  // Team/Enterprise/Free orgs). Unknown (non-owner, no plan visible) stays
  // badge-less.
  const showPlanBadge = classifyPlan(planName) !== "unknown"

  // No-access-as-admin is the only role-derived badge we keep: a concrete "you
  // can't read classroom50 here" state, not an inferred Teacher/Student label
  // (which is just GitHub org-admin status and misleads students).
  const showNoAccessBadge = noAccess && isAdmin

  // A student is an active member who can't read the classroom50 config repo
  // (no_access). Normal, not a dead end: they can still open the org to reach
  // their assignment repos. A teacher (admin) opens any ready org; the
  // service-token/policy preflight runs inside the org (ClassesPage), not here
  // — checking every org would fan out too many GitHub API calls.
  const canOpen = isAdmin ? isReady : isActiveMember

  return (
    <motion.div
      className="card bg-base-100 rounded-xl col-span-12 border border-base-300 md:col-span-6"
      variants={enterExit}
      initial="initial"
      animate="animate"
      transition={staggerTransition(index)}
    >
      <div className="card-body justify-between">
        <div className="flex gap-4">
          <img
            src={org.avatar_url}
            alt=""
            className="size-12 rounded-xl border border-base-300"
          />

          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-bold">{org.login}</h2>

            {org.description && (
              <p className="mt-1 line-clamp-2 text-sm text-base-content/70">
                {org.description}
              </p>
            )}

            {showNoAccessBadge && (
              <div className="mt-3 flex flex-wrap gap-2">
                <span className="badge badge-neutral gap-1">
                  <Lock aria-hidden="true" className="size-3" />
                  {t("orgs.card.noAccessBadge_prefix")} <code>classroom50</code>{" "}
                  {t("orgs.card.noAccessBadge_suffix")}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="card-actions mt-5 items-center justify-between">
          <div className="flex items-center gap-3">
            {showPlanBadge && (
              <PlanBadge
                name={planName}
                title={
                  classifyPlan(planName) === "free"
                    ? t("orgs.card.planTitleFree")
                    : t("orgs.card.planTitlePaid")
                }
              />
            )}

            <GitHubLink
              href={`https://github.com/${org.login}`}
              label={t("orgs.card.viewOnGitHub")}
              title={t("orgs.card.openOnGitHub", { org: org.login })}
              className="shrink-0"
              showLogo={false}
            />
          </div>

          <div className="flex items-center gap-2">
            {canOpen && (
              <Link
                to="/$org"
                params={{ org: org.login }}
                className="btn btn-primary btn-sm"
              >
                {t("orgs.card.open")}
              </Link>
            )}

            {needsSetup && (
              <Link
                to="/$org/setup"
                params={{ org: org.login }}
                className="btn btn-warning btn-sm"
              >
                {t("orgs.card.setUp")}
              </Link>
            )}

            {noAccess && !isActiveMember && (
              <button className="btn btn-disabled btn-sm">
                {t("orgs.card.askTeacher")}
              </button>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  )
}

const OrgsPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.organizations"))
  const queryClient = useQueryClient()
  const { data: orgs = [], isLoading, isFetching } = useGetOrgs()
  const [showUnsupported, setShowUnsupported] = useState(false)

  // Confirmed Classroom 50 orgs the user can use: a teacher's ready org, or a
  // student's enrolled org (no_access but the public Pages index confirmed it).
  const cl50Orgs = orgs?.filter(
    (summary) =>
      summary.classroom50.status === "ready" ||
      summary.classroom50.status === "no_access",
  )
  // Orgs where the user is an admin who hasn't set up Classroom 50 yet —
  // offered in "Set Up". Unrelated (not_classroom50) and indeterminate
  // (unknown) orgs are filtered out.
  const nonCl50Orgs = orgs?.filter(
    (summary) => summary.classroom50.status === "needs_setup",
  )

  // Plan is fetched only for the needs-setup subset (all admin-owned, so plan
  // is visible) to drive the badge, sort, and free-org filter — without the
  // per-org fan-out on the whole list.
  const needsSetupLogins = useMemo(
    () => nonCl50Orgs.map((summary) => summary.org.login),
    [nonCl50Orgs],
  )
  const plans = useNeedsSetupPlans(needsSetupLogins)

  // Bubble Team/Enterprise (supported) to top, then unknown, then free. Stable
  // sort keeps GitHub's order within each bucket.
  const sortedNonCl50Orgs = useMemo(
    () =>
      [...nonCl50Orgs].sort((a, b) => {
        const wa = planSortWeight(classifyPlan(plans[a.org.login]))
        const wb = planSortWeight(classifyPlan(plans[b.org.login]))
        return wa - wb
      }),
    [nonCl50Orgs, plans],
  )

  // Free-plan orgs can't be set up, so hide them by default. Unknown plan
  // (guarded anyway) is always shown so a usable org is never hidden.
  const visibleNonCl50Orgs = showUnsupported
    ? sortedNonCl50Orgs
    : sortedNonCl50Orgs.filter(
        (summary) => classifyPlan(plans[summary.org.login]) !== "free",
      )
  const hiddenFreeCount = sortedNonCl50Orgs.length - visibleNonCl50Orgs.length

  const handleRefresh = () =>
    queryClient.invalidateQueries({ queryKey: ["orgs"] })

  return (
    <div className="min-h-screen">
      <Drawer>
        <DrawerToggle />
        <DrawerContent className="p-10 bg-base-200 2xl:px-50">
          {isLoading ? (
            <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
              <span
                className="loading loading-spinner loading-lg text-primary"
                aria-hidden="true"
              />
              <div>
                <p className="text-base font-semibold">
                  {t("orgs.loadingTitle")}
                </p>
                <p className="mt-1 text-sm text-base-content/70">
                  {t("orgs.loadingSubtitle")}
                </p>
              </div>
            </div>
          ) : (
            <div className="mb-8">
              <div className="flex flex-col gap-6 p-6">
                <div className="w-full space-y-4">
                  <h1 className="text-2xl font-bold tracking-tight">
                    {t("orgs.headingCl50")}
                  </h1>
                  <MissingOrgNotice
                    refreshing={isFetching}
                    onRefresh={handleRefresh}
                  />
                  <div className="grid grid-cols-12 gap-4">
                    {cl50Orgs?.map((summary, i) => (
                      <OrgCard
                        key={summary.org.id}
                        summary={summary}
                        index={i}
                      />
                    ))}
                  </div>
                  {cl50Orgs?.length === 0 && (
                    <div className="rounded-2xl border border-dashed border-base-300 bg-base-100 p-8 text-center">
                      <h2 className="text-lg font-semibold">
                        {t("orgs.emptyTitle")}
                      </h2>
                      <p className="mx-auto mt-1 max-w-md text-sm text-base-content/70">
                        {t("orgs.emptyBody")}
                      </p>
                    </div>
                  )}
                </div>
                {nonCl50Orgs.length > 0 && <div className="divider" />}
                {nonCl50Orgs.length > 0 && (
                  <div className="w-full space-y-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <h1 className="text-2xl font-bold tracking-tight">
                        {t("orgs.headingSetUp")}
                      </h1>
                      {(hiddenFreeCount > 0 || showUnsupported) && (
                        <label className="label cursor-pointer gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="toggle toggle-sm"
                            checked={showUnsupported}
                            onChange={(e) =>
                              setShowUnsupported(e.target.checked)
                            }
                            aria-label={t("orgs.showUnsupported")}
                          />
                          <span className="label-text">
                            {t("orgs.showUnsupported")}
                            {hiddenFreeCount > 0 && !showUnsupported && (
                              <span aria-hidden="true">
                                {" "}
                                ({hiddenFreeCount})
                              </span>
                            )}
                          </span>
                        </label>
                      )}
                    </div>
                    <div className="grid grid-cols-12 gap-4">
                      {visibleNonCl50Orgs.map((summary, i) => (
                        <OrgCard
                          key={summary.org.id}
                          summary={summary}
                          index={i}
                          planName={plans[summary.org.login]}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </DrawerContent>
        <DrawerSidebar page="orgs" />
      </Drawer>
    </div>
  )
}

export default OrgsPage
