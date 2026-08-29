import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { isOwnerGitHubOrgRole } from "@/authz"
import { useAcceptOrgInvite } from "@/hooks/mutations/useAcceptOrgInvite"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useHiddenOrgs } from "@/context/hiddenOrgs/HiddenOrgsProvider"
import type { Classroom50OrgSummary } from "@/github-core/queries"
import { invalidateViewerOrgs } from "@/github-core/queries"
import type { GitHubOrgMembership } from "@/github-core/types"
import useGetOrgs, { usePendingOrgInvites } from "@/hooks/useGetOrgs"
import useOrgDisplayName from "@/hooks/useOrgDisplayName"
import useOrgLastModified from "@/hooks/useOrgLastModified"
import {
  useOrgServiceTokenHealth,
  isOwnedReadyOrg,
  type OrgTokenHealthEntry,
} from "@/hooks/useOrgServiceTokenHealth"
import { needsAttention } from "@/util/serviceTokenHealth"
import {
  TokenHealthChip,
  tokenChipVisible,
} from "@/components/status/TokenHealthChip"
import { useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  ChevronDownIcon,
  EyeClosedIcon,
  InfoIcon,
  KebabHorizontalIcon,
  KeyIcon,
  LockIcon,
  PersonIcon,
  PlusIcon,
  ReadIcon,
  ShieldCheckIcon,
} from "@/components/ui/icons"
import OrgDetailsModal from "@/components/modals/OrgDetailsModal"
import { AnimatePresence, motion } from "motion/react"
import { useMemo, useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import { GitHubLink } from "@/components/GitHubLink"
import {
  Alert,
  Badge,
  Button,
  Card,
  DropdownMenu,
  RouterButton,
  Toolbar,
  cx,
  Heading,
} from "@/components/ui"
import {
  CardGridSkeleton,
  EmptyState,
  NoSearchResults,
  SkeletonRegion,
  ToolbarSkeleton,
  ViewToggle,
} from "@/components/list"
import NewOrgModal from "@/components/modals/NewOrgModal"
import { EnterDiv, PresenceCardDiv } from "@/lib/motionComponents"
import { listStagger } from "@/lib/motion"
import { orgListPrefs, type OrgSortKey } from "@/lib/orgListPrefs"
import { useListPrefsState } from "@/lib/listPrefs"
import { formatRelativeToNow } from "@/util/formatDate"

// A single pending org invitation: org identity from the membership record
// (avatar/name/description) plus an inline accept-and-verify. Pending members
// can't read the classroom50 repo, so there's no status probe here — accepting
// moves the org into the active list, where the classroom50 summary is built.
function PendingInviteCard({ invite }: { invite: GitHubOrgMembership }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { notify } = useToast()
  const org = invite.organization
  const isOwner = isOwnerGitHubOrgRole(invite.role)

  const accept = useAcceptOrgInvite(org.login)

  return (
    <Card
      as={EnterDiv}
      shadow={false}
      className="col-span-12 border-warning/40 bg-warning/5 md:col-span-6"
    >
      <Card.Body className="justify-between">
        <div className="flex gap-4">
          <img
            src={org.avatar_url}
            alt=""
            className="size-12 rounded-box border border-base-300"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Heading as="h2" className="truncate">
                {org.login}
              </Heading>
              <Badge tone="warning" size="sm">
                {t("orgs.invites.pendingBadge")}
              </Badge>
              {isOwner ? (
                <Badge tone="primary" size="sm" className="gap-1">
                  <ShieldCheckIcon aria-hidden="true" className="size-3" />
                  {t("orgs.invites.roleAdmin")}
                </Badge>
              ) : (
                <Badge tone="neutral" size="sm" className="gap-1">
                  <PersonIcon aria-hidden="true" className="size-3" />
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
            onClick={() =>
              accept.mutate(undefined, {
                onSuccess: () => {
                  notify({
                    tone: "success",
                    message: t("orgs.invites.accepted", { org: org.login }),
                  })
                  navigate({ to: "/$org", params: { org: org.login } })
                },
                onError: () => {
                  notify({
                    tone: "error",
                    message: t("orgs.invites.acceptError", { org: org.login }),
                  })
                },
              })
            }
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
    <details className="group rounded-box border border-warning/40 bg-warning/5">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm">
        <ReadIcon aria-hidden="true" className="size-4 shrink-0 text-warning" />
        <span className="min-w-0 flex-1 truncate font-medium text-base-content">
          {t("orgs.invites.summary", { count: invites.length })}
        </span>
        <ChevronDownIcon
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
    // Only an owner of a Classroom 50-ready org can set/rotate the service
    // token, so only they get the "Manage token" affordance.
    canManageToken: isAdmin && isReady,
  }
}

function HideOrgMenu({
  summary,
  className,
}: {
  summary: Classroom50OrgSummary
  className?: string
}) {
  const { t } = useTranslation()
  const { org, canManageToken } = useOrgAffordances(summary)
  const { hide, unhide } = useHiddenOrgs()
  const { notify } = useToast()
  const [detailsOpen, setDetailsOpen] = useState(false)

  const handleHide = () => {
    hide(org.login)
    notify({
      tone: "info",
      key: `org-hidden-${org.login}`,
      durationMs: 6000,
      message: t("orgs.card.hidden", { org: org.login }),
      action: {
        label: t("orgs.card.undoHide"),
        onClick: () => unhide(org.login),
      },
    })
  }

  // daisyUI keeps a focus-driven dropdown open until blur; blur the active item
  // so the menu closes when opening the modal.
  const closeMenu = () => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
  }

  return (
    <>
      <div className={cx("dropdown dropdown-end", className)}>
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          aria-label={t("orgs.card.moreActions", { org: org.login })}
        >
          <KebabHorizontalIcon aria-hidden="true" className="size-4" />
        </Button>
        <DropdownMenu className="w-48">
          {canManageToken && (
            <li>
              <Link
                to="/$org/settings"
                params={{ org: org.login }}
                hash="service-token"
                onClick={closeMenu}
              >
                <KeyIcon aria-hidden="true" className="size-4" />
                {t("orgs.card.manageToken")}
              </Link>
            </li>
          )}
          <li>
            <button
              type="button"
              onClick={() => {
                closeMenu()
                setDetailsOpen(true)
              }}
            >
              <InfoIcon aria-hidden="true" className="size-4" />
              {t("orgs.card.details")}
            </button>
          </li>
          <li>
            <button type="button" onClick={handleHide}>
              <EyeClosedIcon aria-hidden="true" className="size-4" />
              {t("orgs.card.hide")}
            </button>
          </li>
        </DropdownMenu>
      </div>

      <OrgDetailsModal
        summary={summary}
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
      />
    </>
  )
}

function OrgActions({ summary }: { summary: Classroom50OrgSummary }) {
  const { t } = useTranslation()
  const { org, canOpen } = useOrgAffordances(summary)

  if (!canOpen) return null
  return (
    <RouterButton
      to="/$org"
      params={{ org: org.login }}
      aria-label={t("orgs.card.openAria", { org: org.login })}
      variant="primary"
      size="sm"
    >
      {t("orgs.card.open")}
    </RouterButton>
  )
}

function NoAccessBadge() {
  return (
    // badge-neutral is deliberately not a Badge tone (Badge's neutral is the
    // uncolored chip), so this lock chip keeps its inline recipe.
    <span className="badge badge-neutral gap-1">
      <LockIcon aria-hidden="true" className="size-3" />
      <Trans
        i18nKey="orgs.card.noAccessBadge"
        components={{ code: <code dir="ltr" /> }}
      />
    </span>
  )
}

function OrgCard({
  summary,
  updatedAgo,
  tokenHealth,
}: {
  summary: Classroom50OrgSummary
  updatedAgo?: string
  tokenHealth?: OrgTokenHealthEntry
}) {
  const { t } = useTranslation()
  const { org, showNoAccessBadge } = useOrgAffordances(summary)
  const displayName = useOrgDisplayName(org.login)
  const heading = displayName ?? org.login
  const showTokenChip = tokenHealth ? tokenChipVisible(tokenHealth) : false

  return (
    <Card
      as={PresenceCardDiv}
      shadow={false}
      className="col-span-12 md:col-span-6"
    >
      <Card.Body className="relative justify-between">
        <HideOrgMenu summary={summary} className="absolute end-2 top-2" />
        <div className="flex gap-4 pe-8">
          <img
            src={org.avatar_url}
            alt=""
            className="size-12 rounded-box border border-base-300"
          />

          <div className="min-w-0 flex-1">
            <Heading as="h2" className="truncate">
              {heading}
            </Heading>

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

            {(showNoAccessBadge || showTokenChip) && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {showNoAccessBadge && <NoAccessBadge />}
                {showTokenChip && tokenHealth && (
                  <TokenHealthChip
                    org={org.login}
                    health={tokenHealth.health}
                    loading={tokenHealth.loading}
                  />
                )}
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
  tokenHealth,
}: {
  summary: Classroom50OrgSummary
  updatedAgo?: string
  tokenHealth?: OrgTokenHealthEntry
}) {
  const { t } = useTranslation()
  const { org, showNoAccessBadge } = useOrgAffordances(summary)
  const displayName = useOrgDisplayName(org.login)
  const heading = displayName ?? org.login
  const showTokenChip = tokenHealth ? tokenChipVisible(tokenHealth) : false

  return (
    <PresenceCardDiv className="col-span-12 flex flex-col gap-3 rounded-box border border-base-300 bg-base-200 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <img
          src={org.avatar_url}
          alt=""
          className="size-9 shrink-0 rounded-field border border-base-300"
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{heading}</span>
            {showNoAccessBadge && (
              <span className="hidden sm:inline-flex">
                <NoAccessBadge />
              </span>
            )}
            {showTokenChip && tokenHealth && (
              <span className="hidden sm:inline-flex">
                <TokenHealthChip
                  org={org.login}
                  health={tokenHealth.health}
                  loading={tokenHealth.loading}
                />
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
        <HideOrgMenu summary={summary} />
      </div>
    </PresenceCardDiv>
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
  const {
    data: orgs = [],
    isLoading,
    isFetching,
    isError,
    refetch,
  } = useGetOrgs()
  const { data: pendingInvites = [] } = usePendingOrgInvites()

  const { viewMode, sortKey, changeView, changeSort } =
    useListPrefsState(orgListPrefs)
  const { hidden } = useHiddenOrgs()
  const [search, setSearch] = useState("")
  const [modalOpen, setModalOpen] = useState(false)

  // Confirmed Classroom 50 orgs the user can use: a teacher's ready org, or a
  // student's enrolled org (no_access confirmed via the public Pages index).
  // Orgs the user hid from the home page are dropped here (unhide from Settings).
  const cl50Orgs = useMemo(
    () =>
      orgs.filter(
        (summary) =>
          (summary.classroom50.status === "ready" ||
            summary.classroom50.status === "no_access") &&
          !hidden.has(summary.org.login),
      ),
    [orgs, hidden],
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

  // Each shown org's classroom50 config-repo pushed_at, for the "Updated …"
  // line on every card and the last-modified sort. Fetched for the shown set on
  // every home view (a deliberate per-card fan-out, shared with the repo cache),
  // not just when the last-modified sort is active.
  const shownLogins = useMemo(
    () => filtered.map((summary) => summary.org.login),
    [filtered],
  )
  const lastModified = useOrgLastModified(shownLogins, true)

  // Cross-org service-token health, only for orgs the viewer owns and that are
  // Classroom 50-ready (student/member orgs would 403 on the owner-only secret
  // read). Reuses the per-org token/collect caches shared with the single-org
  // panes. Drives the per-card chip and the "N of M need attention" summary.
  const ownedReadyLogins = useMemo(
    () => filtered.filter(isOwnedReadyOrg).map((summary) => summary.org.login),
    [filtered],
  )
  const { byOrg: tokenHealthByOrg } = useOrgServiceTokenHealth(
    ownedReadyLogins,
    true,
  )
  const attentionCount = useMemo(
    () =>
      ownedReadyLogins.filter((login) => {
        const entry = tokenHealthByOrg[login]
        return entry && !entry.loading && needsAttention(entry.health)
      }).length,
    [ownedReadyLogins, tokenHealthByOrg],
  )

  const sorted = useMemo(() => {
    const byName = (a: Classroom50OrgSummary, b: Classroom50OrgSummary) =>
      a.org.login.localeCompare(b.org.login)
    switch (sortKey) {
      case "status":
        return filtered.toSorted(
          (a, b) => statusWeight(a) - statusWeight(b) || byName(a, b),
        )
      case "last-modified":
        // Known timestamps newest-first; pending/unknown pinned to the bottom
        // in stable Name order so rows don't reshuffle as queries resolve.
        return filtered.toSorted((a, b) => {
          const ta = lastModified[a.org.login]
          const tb = lastModified[b.org.login]
          if (ta && tb) return tb.localeCompare(ta)
          if (ta) return -1
          if (tb) return 1
          return byName(a, b)
        })
      case "name-asc":
      default:
        return filtered.toSorted(byName)
    }
  }, [filtered, sortKey, lastModified])

  const handleRefresh = () => invalidateViewerOrgs(queryClient)

  const hasAnyOrgs = cl50Orgs.length > 0
  const hasInvites = pendingInvites.length > 0
  const hasContent = hasAnyOrgs || hasInvites
  const noSearchResults = hasAnyOrgs && sorted.length === 0

  return (
    <>
      <PageShell>
        {isLoading ? (
          <>
            <PageHeader title={t("orgs.headingCl50")} />
            <SkeletonRegion
              label={t("orgs.loadingTitle")}
              className="space-y-4"
            >
              <ToolbarSkeleton controls={3} />
              <CardGridSkeleton
                cards={4}
                cardClassName="col-span-12 h-36 md:col-span-6"
              />
            </SkeletonRegion>
          </>
        ) : isError ? (
          // Never render the "no organizations yet — ask your teacher" empty
          // state on a failed read: it misdiagnoses a load failure as a
          // roster problem.
          <>
            <PageHeader title={t("orgs.headingCl50")} />
            <Alert tone="error" className="items-start">
              <span className="text-sm">{t("orgs.loadError")}</span>
              <Button variant="ghost" size="sm" onClick={() => refetch()}>
                {t("orgs.retry")}
              </Button>
            </Alert>
          </>
        ) : (
          <>
            <PageHeader title={t("orgs.headingCl50")} />

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

            {attentionCount > 0 && (
              <Alert tone="warning" role="status" className="text-sm">
                <span>
                  {t("serviceTokenHealth.summary", {
                    count: attentionCount,
                  })}
                </span>
              </Alert>
            )}

            {noSearchResults ? (
              <NoSearchResults
                title={t("orgs.noResults.title")}
                body={t("orgs.noResults.body", { query: search.trim() })}
                clearLabel={t("orgs.noResults.clear")}
                onClear={() => setSearch("")}
              />
            ) : sorted.length > 0 ? (
              <motion.div
                className="grid grid-cols-12 gap-4"
                variants={listStagger}
                initial="initial"
                animate="animate"
              >
                <AnimatePresence mode="popLayout">
                  {sorted.map((summary) => {
                    const updatedIso = lastModified[summary.org.login]
                    const updatedAgo = updatedIso
                      ? formatRelativeToNow(new Date(updatedIso))
                      : undefined
                    return viewMode === "grid" ? (
                      <OrgCard
                        key={summary.org.id}
                        summary={summary}
                        updatedAgo={updatedAgo}
                        tokenHealth={tokenHealthByOrg[summary.org.login]}
                      />
                    ) : (
                      <OrgRow
                        key={summary.org.id}
                        summary={summary}
                        updatedAgo={updatedAgo}
                        tokenHealth={tokenHealthByOrg[summary.org.login]}
                      />
                    )
                  })}
                </AnimatePresence>
              </motion.div>
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
                    <PlusIcon aria-hidden="true" className="size-4" />
                    {t("orgs.setUpFirst.cta")}
                  </Button>
                }
              />
            ) : hasInvites ? null : (
              <EmptyState
                title={t("orgs.emptyTitle")}
                body={t("orgs.emptyBody")}
                action={
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setModalOpen(true)}
                  >
                    <PlusIcon aria-hidden="true" className="size-4" />
                    {t("orgs.setUpFirst.cta")}
                  </Button>
                }
              />
            )}
          </>
        )}
      </PageShell>

      <NewOrgModal
        open={modalOpen}
        needsSetupOrgs={needsSetupOrgs}
        refreshing={isFetching}
        onRefresh={handleRefresh}
        onClose={() => setModalOpen(false)}
      />
    </>
  )
}

export default OrgsPage
