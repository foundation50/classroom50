import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { acceptAndVerifyOrgMembership } from "@/domain/users"
import { isOwnerGitHubOrgRole } from "@/util/roles"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useToast } from "@/context/notifications/NotificationProvider"
import type { Classroom50OrgSummary } from "@/github-core/queries"
import type { GitHubOrgMembership } from "@/github-core/types"
import useGetOrgs, {
  orgMembershipsQueryKey,
  usePendingOrgInvites,
} from "@/hooks/useGetOrgs"
import useOrgLastModified from "@/hooks/useOrgLastModified"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  ChevronDown,
  ExternalLink,
  Info,
  Lock,
  MailOpen,
  Plus,
  RefreshCw,
  ShieldCheck,
  User,
} from "lucide-react"
import { motion } from "motion/react"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { GitHubLink } from "@/components/GitHubLink"
import { Badge, Button, Card, Toolbar } from "@/components/ui"
import { EmptyState, NoSearchResults, ViewToggle } from "@/components/list"
import NewOrgModal from "@/components/modals/NewOrgModal"
import Spinner from "@/components/Spinner"
import { enterExit } from "@/lib/motion"
import { EnterDiv } from "@/lib/motionComponents"
import { orgListPrefs, type OrgSortKey } from "@/lib/orgListPrefs"
import { useListPrefsState } from "@/lib/listPrefs"
import { formatRelativeToNow } from "@/util/formatDate"

function MissingOrgNotice({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean
  onRefresh: () => void
}) {
  const { t } = useTranslation()
  return (
    <details className="group rounded-xl border border-info/20 bg-info/5">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm">
        <Info aria-hidden="true" className="size-4 shrink-0 text-info" />
        <span className="min-w-0 flex-1 truncate font-medium text-base-content">
          {t("orgs.missingNotice.title")}
        </span>
        <Button
          variant="ghost"
          size="xs"
          disabled={refreshing}
          onClick={(e) => {
            // The button lives inside <summary>; stop the click from toggling
            // the disclosure so refreshing doesn't also expand/collapse it.
            e.preventDefault()
            onRefresh()
          }}
        >
          <RefreshCw
            aria-hidden="true"
            className={["size-3.5", refreshing ? "animate-spin" : ""].join(" ")}
          />
          {refreshing
            ? t("orgs.missingNotice.refreshing")
            : t("orgs.missingNotice.refresh")}
        </Button>
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 text-base-content/50 transition-transform group-open:rotate-180"
        />
      </summary>

      <div className="border-t border-info/20 px-4 py-3">
        <p className="text-sm leading-6 text-base-content/70">
          {t("orgs.missingNotice.body")}
        </p>
        <a
          href="https://github.com/settings/connections/applications"
          target="_blank"
          rel="noreferrer"
          className="btn btn-info btn-sm mt-3"
        >
          {t("orgs.missingNotice.manageOauth")}
          <ExternalLink aria-hidden="true" className="size-4" />
        </a>
      </div>
    </details>
  )
}

// A single pending org invitation: org identity from the membership record
// (avatar/name/description) plus an inline accept-and-verify. Pending members
// can't read the classroom50 repo, so there's no status probe here — accepting
// moves the org into the active list, where the classroom50 summary is built.
function PendingInviteCard({ invite }: { invite: GitHubOrgMembership }) {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { notify } = useToast()
  const org = invite.organization
  const isOwner = isOwnerGitHubOrgRole(invite.role)

  const accept = useMutation({
    mutationFn: () => acceptAndVerifyOrgMembership(client, org.login),
    onSuccess: () => {
      notify({
        tone: "success",
        message: t("orgs.invites.accepted", { org: org.login }),
      })
      queryClient.invalidateQueries({ queryKey: orgMembershipsQueryKey })
      queryClient.invalidateQueries({ queryKey: ["orgs"] })
      navigate({ to: "/$org", params: { org: org.login } })
    },
    onError: () => {
      notify({
        tone: "error",
        message: t("orgs.invites.acceptError", { org: org.login }),
      })
    },
  })

  return (
    <Card
      as={EnterDiv}
      radius="xl"
      shadow={false}
      className="col-span-12 border-warning/40 bg-warning/5 md:col-span-6"
    >
      <Card.Body className="justify-between">
        <div className="flex gap-4">
          <img
            src={org.avatar_url}
            alt=""
            className="size-12 rounded-xl border border-base-300"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-bold">{org.login}</h2>
              <Badge tone="warning" size="sm">
                {t("orgs.invites.pendingBadge")}
              </Badge>
              {isOwner ? (
                <Badge tone="primary" size="sm" className="gap-1">
                  <ShieldCheck aria-hidden="true" className="size-3" />
                  {t("orgs.invites.roleAdmin")}
                </Badge>
              ) : (
                <Badge tone="neutral" size="sm" className="gap-1">
                  <User aria-hidden="true" className="size-3" />
                  {t("orgs.invites.roleMember")}
                </Badge>
              )}
            </div>
            {org.description && (
              <p className="mt-1 line-clamp-2 text-sm text-base-content/70">
                {org.description}
              </p>
            )}
            <p className="mt-1 text-xs text-base-content/50">
              {isOwner
                ? t("orgs.invites.roleAdminHint")
                : t("orgs.invites.roleMemberHint")}
            </p>
          </div>
        </div>

        <Card.Actions className="mt-5 items-center justify-end gap-2">
          <GitHubLink
            href={`https://github.com/orgs/${org.login}/invitation`}
            label={t("orgs.invites.viewOnGitHub")}
            title={t("orgs.invites.openInviteOnGitHub", { org: org.login })}
            className="shrink-0"
            showLogo={false}
          />
          <Button
            variant="primary"
            size="sm"
            loading={accept.isPending}
            loadingLabel={t("orgs.invites.accepting")}
            onClick={() => accept.mutate()}
          >
            {t("orgs.invites.acceptOpen")}
          </Button>
        </Card.Actions>
      </Card.Body>
    </Card>
  )
}

// Collapsed by default so a stack of invites doesn't dominate the home page;
// the summary announces the count and expands to the accept cards.
function PendingInvites({ invites }: { invites: GitHubOrgMembership[] }) {
  const { t } = useTranslation()
  if (invites.length === 0) return null
  return (
    <details className="group rounded-xl border border-warning/40 bg-warning/5">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm">
        <MailOpen aria-hidden="true" className="size-4 shrink-0 text-warning" />
        <span className="min-w-0 flex-1 truncate font-medium text-base-content">
          {t("orgs.invites.summary", { count: invites.length })}
        </span>
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 text-base-content/50 transition-transform group-open:rotate-180"
        />
      </summary>

      <div className="border-t border-warning/20 p-4">
        <div className="grid grid-cols-12 gap-4">
          {invites.map((invite) => (
            <PendingInviteCard key={invite.organization.id} invite={invite} />
          ))}
        </div>
      </div>
    </details>
  )
}

// Shared per-org affordances (whether the card/row can open, badges, actions),
// so the grid card and list row stay in sync.
function useOrgAffordances(summary: Classroom50OrgSummary) {
  const { org, membership, classroom50 } = summary
  const isReady = classroom50.status === "ready"
  const noAccess = classroom50.status === "no_access"
  const isAdmin = isOwnerGitHubOrgRole(membership.role)
  // useGetOrgs only surfaces active memberships, so every summary here is an
  // active member.
  const isActiveMember = membership.state === "active"

  return {
    org,
    noAccess,
    showNoAccessBadge: noAccess && isAdmin,
    // Teachers open ready orgs; students open any org they're an active member
    // of (their assignment repos live there even without classroom50 access).
    canOpen: isAdmin ? isReady : isActiveMember,
  }
}

function OrgActions({ summary }: { summary: Classroom50OrgSummary }) {
  const { t } = useTranslation()
  const { org, canOpen } = useOrgAffordances(summary)
  return (
    <>
      <GitHubLink
        href={`https://github.com/${org.login}`}
        label={t("orgs.card.viewOnGitHub")}
        title={t("orgs.card.openOnGitHub", { org: org.login })}
        className="shrink-0"
        showLogo={false}
      />
      {canOpen && (
        <Link
          to="/$org"
          params={{ org: org.login }}
          className="btn btn-primary btn-sm"
        >
          {t("orgs.card.open")}
        </Link>
      )}
    </>
  )
}

function NoAccessBadge() {
  const { t } = useTranslation()
  return (
    <span className="badge badge-neutral gap-1">
      <Lock aria-hidden="true" className="size-3" />
      {t("orgs.card.noAccessBadge_prefix")} <code>classroom50</code>{" "}
      {t("orgs.card.noAccessBadge_suffix")}
    </span>
  )
}

function OrgCard({
  summary,
  updatedAgo,
}: {
  summary: Classroom50OrgSummary
  updatedAgo?: string
}) {
  const { t } = useTranslation()
  const { org, showNoAccessBadge } = useOrgAffordances(summary)

  return (
    <Card
      as={EnterDiv}
      radius="xl"
      shadow={false}
      className="col-span-12 md:col-span-6"
    >
      <Card.Body className="justify-between">
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

            {updatedAgo && (
              <p className="mt-1 text-xs text-base-content/50">
                {t("orgs.card.updatedAgo", { when: updatedAgo })}
              </p>
            )}

            {showNoAccessBadge && (
              <div className="mt-3 flex flex-wrap gap-2">
                <NoAccessBadge />
              </div>
            )}
          </div>
        </div>

        <Card.Actions className="mt-5 items-center justify-end gap-2">
          <OrgActions summary={summary} />
        </Card.Actions>
      </Card.Body>
    </Card>
  )
}

function OrgRow({
  summary,
  updatedAgo,
}: {
  summary: Classroom50OrgSummary
  updatedAgo?: string
}) {
  const { t } = useTranslation()
  const { org, showNoAccessBadge } = useOrgAffordances(summary)

  return (
    <motion.div
      className="col-span-12 flex flex-col gap-3 rounded-xl border border-base-300 bg-base-100 p-4 sm:flex-row sm:items-center sm:justify-between"
      variants={enterExit}
      initial="initial"
      animate="animate"
    >
      <div className="flex min-w-0 items-center gap-3">
        <img
          src={org.avatar_url}
          alt=""
          className="size-9 shrink-0 rounded-lg border border-base-300"
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{org.login}</span>
            {showNoAccessBadge && (
              <span className="hidden sm:inline-flex">
                <NoAccessBadge />
              </span>
            )}
          </div>
          {org.description && (
            <p className="truncate text-sm text-base-content/60">
              {org.description}
            </p>
          )}
          {updatedAgo && (
            <p className="truncate text-xs text-base-content/50">
              {t("orgs.card.updatedAgo", { when: updatedAgo })}
            </p>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2">
        <OrgActions summary={summary} />
      </div>
    </motion.div>
  )
}

const SORT_OPTIONS: { key: OrgSortKey; labelKey: string }[] = [
  { key: "name-asc", labelKey: "orgs.toolbar.sort.nameAsc" },
  { key: "last-modified", labelKey: "orgs.toolbar.sort.lastModified" },
  { key: "status", labelKey: "orgs.toolbar.sort.status" },
]

// "ready" (teacher) before "no_access" (enrolled student) for the status sort.
const statusWeight = (summary: Classroom50OrgSummary) =>
  summary.classroom50.status === "ready" ? 0 : 1

const OrgsPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.organizations"))
  const queryClient = useQueryClient()
  const { data: orgs = [], isLoading, isFetching } = useGetOrgs()
  const { data: pendingInvites = [] } = usePendingOrgInvites()

  const { viewMode, sortKey, changeView, changeSort } =
    useListPrefsState(orgListPrefs)
  const [search, setSearch] = useState("")
  const [modalOpen, setModalOpen] = useState(false)

  // Confirmed Classroom 50 orgs the user can use: a teacher's ready org, or a
  // student's enrolled org (no_access confirmed via the public Pages index).
  const cl50Orgs = useMemo(
    () =>
      orgs.filter(
        (summary) =>
          summary.classroom50.status === "ready" ||
          summary.classroom50.status === "no_access",
      ),
    [orgs],
  )
  // Admin-owned orgs without Classroom 50 yet — offered through the modal.
  const needsSetupOrgs = useMemo(
    () =>
      orgs.filter((summary) => summary.classroom50.status === "needs_setup"),
    [orgs],
  )

  const query = search.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      query
        ? cl50Orgs.filter((summary) => {
            const { login, description } = summary.org
            return (
              login.toLowerCase().includes(query) ||
              (description ?? "").toLowerCase().includes(query)
            )
          })
        : cl50Orgs,
    [cl50Orgs, query],
  )

  // Last-modified data is fetched only when its sort is active, for the shown
  // set, so other views never fan out per-org.
  const lastModifiedActive = sortKey === "last-modified"
  const shownLogins = useMemo(
    () => filtered.map((summary) => summary.org.login),
    [filtered],
  )
  const lastModified = useOrgLastModified(shownLogins, lastModifiedActive)

  const sorted = useMemo(() => {
    const byName = (a: Classroom50OrgSummary, b: Classroom50OrgSummary) =>
      a.org.login.localeCompare(b.org.login)
    const list = [...filtered]
    switch (sortKey) {
      case "status":
        return list.sort(
          (a, b) => statusWeight(a) - statusWeight(b) || byName(a, b),
        )
      case "last-modified":
        // Known timestamps newest-first; pending/unknown pinned to the bottom
        // in stable Name order so rows don't reshuffle as queries resolve.
        return list.sort((a, b) => {
          const ta = lastModified[a.org.login]
          const tb = lastModified[b.org.login]
          if (ta && tb) return tb.localeCompare(ta)
          if (ta) return -1
          if (tb) return 1
          return byName(a, b)
        })
      case "name-asc":
      default:
        return list.sort(byName)
    }
  }, [filtered, sortKey, lastModified])

  const handleRefresh = () =>
    queryClient.invalidateQueries({ queryKey: ["orgs"] })

  const hasAnyOrgs = cl50Orgs.length > 0
  const hasInvites = pendingInvites.length > 0
  const hasContent = hasAnyOrgs || hasInvites
  const noSearchResults = hasAnyOrgs && sorted.length === 0

  return (
    <>
      <PageShell page="orgs">
        {isLoading ? (
          <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
            <Spinner size="lg" className="text-primary" />
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
          <>
            <PageHeader title={t("orgs.headingCl50")} />

            <MissingOrgNotice
              refreshing={isFetching}
              onRefresh={handleRefresh}
            />

            {hasInvites && <PendingInvites invites={pendingInvites} />}

            {hasContent && (
              <Toolbar className="flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <Toolbar.Search
                  inputSize="md"
                  className="w-full sm:max-w-xs"
                  iconClassName="text-base-content/50"
                  placeholder={t("orgs.toolbar.searchPlaceholder")}
                  ariaLabel={t("orgs.toolbar.searchLabel")}
                  value={search}
                  onChange={setSearch}
                />

                <div className="flex items-center gap-3">
                  <Toolbar.FilterSelect
                    className="w-auto"
                    aria-label={t("orgs.toolbar.sort.label")}
                    value={sortKey}
                    onChange={(e) => changeSort(e.target.value as OrgSortKey)}
                  >
                    {SORT_OPTIONS.map((opt) => (
                      <option key={opt.key} value={opt.key}>
                        {t(opt.labelKey)}
                      </option>
                    ))}
                  </Toolbar.FilterSelect>

                  <ViewToggle
                    viewMode={viewMode}
                    onChange={changeView}
                    groupLabel={t("orgs.toolbar.view.label")}
                    gridLabel={t("orgs.toolbar.view.gridLabel")}
                    listLabel={t("orgs.toolbar.view.listLabel")}
                  />

                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setModalOpen(true)}
                  >
                    {t("orgs.newOrg.button")}
                  </Button>
                </div>
              </Toolbar>
            )}

            {noSearchResults ? (
              <NoSearchResults
                title={t("orgs.noResults.title")}
                body={t("orgs.noResults.body", { query: search.trim() })}
                clearLabel={t("orgs.noResults.clear")}
                onClear={() => setSearch("")}
              />
            ) : sorted.length > 0 ? (
              <div className="grid grid-cols-12 gap-4">
                {sorted.map((summary) => {
                  const updatedIso = lastModifiedActive
                    ? lastModified[summary.org.login]
                    : undefined
                  const updatedAgo = updatedIso
                    ? formatRelativeToNow(new Date(updatedIso))
                    : undefined
                  return viewMode === "grid" ? (
                    <OrgCard
                      key={summary.org.id}
                      summary={summary}
                      updatedAgo={updatedAgo}
                    />
                  ) : (
                    <OrgRow
                      key={summary.org.id}
                      summary={summary}
                      updatedAgo={updatedAgo}
                    />
                  )
                })}
              </div>
            ) : needsSetupOrgs.length > 0 ? (
              <EmptyState
                title={t("orgs.setUpFirst.title")}
                body={t("orgs.setUpFirst.body")}
                action={
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setModalOpen(true)}
                  >
                    <Plus aria-hidden="true" className="size-4" />
                    {t("orgs.setUpFirst.cta")}
                  </Button>
                }
              />
            ) : hasInvites ? null : (
              <EmptyState
                title={t("orgs.emptyTitle")}
                body={t("orgs.emptyBody")}
              />
            )}
          </>
        )}
      </PageShell>

      <NewOrgModal
        open={modalOpen}
        needsSetupOrgs={needsSetupOrgs}
        onClose={() => setModalOpen(false)}
      />
    </>
  )
}

export default OrgsPage
