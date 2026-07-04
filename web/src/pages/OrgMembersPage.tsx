import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { Link, useParams } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import {
  AlertTriangle,
  ChevronRight,
  ExternalLink,
  Info,
  UserPlus,
  X,
} from "lucide-react"

import Drawer, {
  DrawerContent,
  DrawerSidebar,
  DrawerToggle,
} from "@/components/drawer"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import RequireTeacher from "@/components/RequireTeacher"
import Avatar from "@/components/avatar"
import GitHub from "@/assets/github.svg?react"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  useToast,
  type NotifyInput,
} from "@/context/notifications/NotificationProvider"
import { useGitHubViewer } from "@/hooks/github/hooks"
import { githubKeys, invalidateInviteQueries } from "@/hooks/github/queries"
import useOrgMembersOverview from "@/hooks/useOrgMembersOverview"
import type { OrgMemberRow } from "@/util/orgMembers"
import { isSameGitHubUser } from "@/util/students"
import { removeMemberFromOrg } from "@/pages/orgMembers/removeMemberFromOrg"
import { motion } from "motion/react"
import { enterExit } from "@/lib/motion"
import { ClickableRow } from "@/lib/motionComponents"
import { inviteMemberToOrg } from "@/pages/orgMembers/inviteMemberToOrg"
import type { GitHubClient } from "@/hooks/github/client"

// Shared invite flow for the inline button and the detail drawer. Errors are
// toasted here so both call sites only track their own in-flight flag.
const runInviteMember = async (
  client: GitHubClient,
  org: string,
  row: OrgMemberRow,
  notify: (input: NotifyInput) => void,
  onDone: () => void,
  t: TFunction,
) => {
  const label = row.username || row.email
  try {
    const result = await inviteMemberToOrg(client, { org, row })
    const who = result.currentUsername ? `@${result.currentUsername}` : label
    notify({
      tone: "success",
      durationMs: 6000,
      message: t("toasts.invited", { who, org }),
    })
    onDone()
  } catch (err) {
    notify({
      tone: "error",
      message: t("orgMembers.inviteFailed", {
        label,
        reason:
          err instanceof Error ? err.message : t("orgMembers.somethingWrong"),
      }),
    })
  }
}

// First initial of a row's best display string, for the avatar fallback.
const initialsFor = (row: OrgMemberRow) =>
  (row.name || row.username || row.email || "?")[0]?.toUpperCase() ?? "?"

// GitHub identity line: makes it explicit these are GitHub members by showing
// the @username and the immutable numeric GitHub id together.
const GitHubIdentity = ({ row }: { row: OrgMemberRow }) => {
  const { t } = useTranslation()
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-base-content/70">
      <GitHub aria-hidden="true" className="size-3.5 opacity-50" />
      {row.username ? (
        <span className="font-mono">@{row.username}</span>
      ) : (
        <span className="italic">{t("orgMembers.noGitHubUsername")}</span>
      )}
      {row.github_id ? (
        <span className="text-base-content/70">
          {t("orgMembers.idSuffix", { id: row.github_id })}
        </span>
      ) : null}
    </span>
  )
}

const ClassificationBadge = ({ row }: { row: OrgMemberRow }) => {
  const { t } = useTranslation()
  if (row.classification === "on-roster-not-member") {
    return (
      <span className="badge badge-sm badge-error badge-soft gap-1">
        <AlertTriangle aria-hidden="true" className="size-3" />{" "}
        {t("orgMembers.badgeNotMember")}
      </span>
    )
  }
  if (row.classification === "member-no-roster") {
    return (
      <span className="badge badge-sm badge-ghost gap-1">
        <Info aria-hidden="true" className="size-3" />{" "}
        {t("orgMembers.badgeNoClassroom")}
      </span>
    )
  }
  return (
    <span className="badge badge-sm badge-success badge-soft">
      {t("orgMembers.badgeMember")}
    </span>
  )
}

const MemberDetail = ({
  org,
  row,
  isSelf,
  onClose,
  onRemoved,
}: {
  org: string
  row: OrgMemberRow
  isSelf: boolean
  onClose: () => void
  onRemoved: () => void
}) => {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const { notify } = useToast()
  const [confirming, setConfirming] = useState(false)
  const [working, setWorking] = useState(false)
  const [inviting, setInviting] = useState(false)
  const label = row.username || row.email
  // Only non-archived classrooms are actually unenrolled (archived ones can't
  // be; removeMemberFromOrg skips them), so the confirm copy counts those.
  const activeClassrooms = row.classrooms.filter((c) => !c.archived)

  const handleInvite = async () => {
    if (inviting) return
    setInviting(true)
    try {
      await runInviteMember(client, org, row, notify, onRemoved, t)
    } finally {
      setInviting(false)
    }
  }

  const handleRemove = async () => {
    if (working) return
    setWorking(true)
    try {
      const result = await removeMemberFromOrg(client, { org, row }, t)
      if (result.warnings.length > 0) {
        notify({
          tone: "warning",
          durationMs: 8000,
          message: result.warnings.join(" "),
        })
      } else {
        notify({
          tone: "success",
          durationMs: 6000,
          message: result.unenrolledClassrooms.length
            ? t("orgMembers.removedWithUnenroll", {
                label,
                org,
                count: result.unenrolledClassrooms.length,
              })
            : t("orgMembers.removed", { label, org }),
        })
      }
      onRemoved()
    } catch (err) {
      notify({
        tone: "error",
        message: t("orgMembers.removeFailed", {
          label,
          reason:
            err instanceof Error ? err.message : t("orgMembers.somethingWrong"),
        }),
      })
    } finally {
      setWorking(false)
      setConfirming(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="absolute inset-0 bg-black/30"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative z-10 flex h-full w-full max-w-md flex-col overflow-y-auto bg-base-100 shadow-xl">
        <div className="flex items-center justify-between border-b border-base-300 px-6 py-4">
          <h2 className="text-lg font-semibold">
            {t("orgMembers.detailTitle")}
          </h2>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-square"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-6 py-5">
          <Avatar
            name={row.name || label}
            github={row.username}
            initials={initialsFor(row)}
            subtitle={<GitHubIdentity row={row} />}
          />

          <div className="flex items-center gap-2">
            <ClassificationBadge row={row} />
            {row.email ? (
              <span className="text-sm text-base-content/70">{row.email}</span>
            ) : null}
          </div>

          <a
            href={`https://github.com/orgs/${org}/people${
              row.username ? `?query=${encodeURIComponent(row.username)}` : ""
            }`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-1 text-sm text-primary hover:underline"
          >
            <ExternalLink aria-hidden="true" className="size-3.5" />
            {t("orgMembers.manageOnGitHub")}
          </a>

          <div>
            <h3 className="mb-2 text-sm font-semibold">
              {t("orgMembers.classroomAccess")}
            </h3>
            {row.classrooms.length === 0 ? (
              <p className="text-sm text-base-content/70">
                {t("orgMembers.noRoster")}
              </p>
            ) : (
              <ul className="divide-y divide-base-300 rounded-box border border-base-300">
                {row.classrooms.map((access) => (
                  <Link
                    key={access.classroom}
                    to="/$org/$classroom"
                    params={{ org, classroom: access.classroom }}
                    onClick={onClose}
                    className="group/cls flex items-center justify-between px-3 py-2 text-sm first:rounded-t-box last:rounded-b-box cursor-pointer transition-[background-color,transform,box-shadow] duration-150 ease-out hover:bg-base-200 hover:-translate-y-px hover:shadow-sm motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:hover:shadow-none"
                  >
                    <span className="font-medium">
                      {access.classroom}
                      {access.archived ? (
                        <span className="badge badge-xs badge-ghost ml-2">
                          {t("orgMembers.archived")}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-2 text-base-content/70">
                      {access.section ? (
                        <span className="badge badge-xs badge-ghost">
                          {access.section}
                        </span>
                      ) : null}
                      <ChevronRight
                        aria-hidden="true"
                        className="size-4 text-base-content/30 transition-transform duration-150 group-hover/cls:translate-x-0.5 group-hover/cls:text-base-content/70"
                      />
                    </span>
                  </Link>
                ))}
              </ul>
            )}
          </div>

          {isSelf ? (
            <div className="rounded-box border border-base-300 bg-base-200/50 p-4 text-sm text-base-content/70">
              {t("orgMembers.selfNotice")}
            </div>
          ) : !row.isMember ? (
            row.github_id ? (
              <div className="rounded-box border border-warning/30 bg-warning/5 p-4 text-sm">
                <p className="text-base-content/80">
                  {t("orgMembers.notMemberPrefix", { label })}{" "}
                  <span className="font-semibold">
                    {t("orgMembers.notMemberEmphasis")}
                  </span>
                  {t("orgMembers.notMemberSuffix")}
                </p>
                <button
                  type="button"
                  className="btn btn-primary btn-sm mt-3"
                  disabled={inviting}
                  onClick={() => void handleInvite()}
                >
                  {inviting ? (
                    <>
                      <span
                        className="loading loading-spinner loading-xs"
                        aria-hidden="true"
                      />
                      {t("orgMembers.inviting")}
                    </>
                  ) : (
                    <>
                      <UserPlus aria-hidden="true" className="size-4" />
                      {t("orgMembers.inviteToOrg")}
                    </>
                  )}
                </button>
              </div>
            ) : (
              <div className="rounded-box border border-base-300 bg-base-200/50 p-4 text-sm text-base-content/70">
                {t("orgMembers.notMemberNoId")}
              </div>
            )
          ) : confirming ? (
            <div className="rounded-box border border-error/30 bg-error/5 p-4 text-sm">
              <p className="text-base-content/80">
                {activeClassrooms.length > 0 ? (
                  <>
                    {t("orgMembers.confirmUnenrollPrefix", { label })}{" "}
                    <span className="font-semibold">
                      {t("orgMembers.confirmClassroomCount", {
                        count: activeClassrooms.length,
                      })}
                    </span>{" "}
                    {t("orgMembers.confirmUnenrollMid", {
                      classrooms: activeClassrooms
                        .map((c) => c.classroom)
                        .join(", "),
                    })}{" "}
                    <span className="font-semibold">{org}</span>{" "}
                    {t("orgMembers.confirmUnenrollSuffix")}
                  </>
                ) : (
                  <>
                    {t("orgMembers.confirmRemovePrefix", { label })}{" "}
                    <span className="font-semibold">{org}</span>{" "}
                    {t("orgMembers.confirmRemoveSuffix")}
                  </>
                )}
              </p>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={working}
                  onClick={() => setConfirming(false)}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn-error btn-sm"
                  disabled={working}
                  onClick={() => void handleRemove()}
                >
                  {working ? (
                    <>
                      <span
                        className="loading loading-spinner loading-xs"
                        aria-hidden="true"
                      />
                      {t("orgMembers.removing")}
                    </>
                  ) : (
                    t("orgMembers.removeFromOrg")
                  )}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-error btn-outline btn-sm self-start"
              onClick={() => setConfirming(true)}
            >
              {t("orgMembers.removeFromOrg")}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

const OrgMembersPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.members"))
  const { org } = useParams({ strict: false })
  const client = useGitHubClient()
  const { notify } = useToast()
  const queryClient = useQueryClient()
  const { data: viewer } = useGitHubViewer()
  const { rows, isLoading, isError, notes } = useOrgMembersOverview(org)
  const [query, setQuery] = useState("")
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [invitingKey, setInvitingKey] = useState<string | null>(null)

  const refresh = (affected?: OrgMemberRow) => {
    if (!org) return
    queryClient.invalidateQueries({ queryKey: githubKeys.orgMembersAll(org) })
    invalidateInviteQueries(queryClient, org)
    // removeMemberFromOrg rewrites each affected classroom's students.csv, which
    // the aggregation reads via csvFileQuery; invalidate those (and the
    // classroom.json) so the page doesn't show a just-removed student as still
    // enrolled until the 5-minute staleTime elapses.
    for (const access of affected?.classrooms ?? []) {
      queryClient.invalidateQueries({
        queryKey: githubKeys.csvFile(
          org,
          "classroom50",
          `${access.classroom}/students.csv`,
        ),
      })
      queryClient.invalidateQueries({
        queryKey: githubKeys.jsonFile(
          org,
          "classroom50",
          `${access.classroom}/classroom.json`,
        ),
      })
    }
  }

  // Inline row invite for an on-roster non-member (mirrors the detail-drawer
  // action). Invites by github_id so a stale username doesn't matter.
  const handleQuickInvite = async (row: OrgMemberRow) => {
    if (!org || invitingKey) return
    setInvitingKey(row.key)
    try {
      await runInviteMember(client, org, row, notify, () => refresh(row), t)
    } finally {
      setInvitingKey(null)
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((row) =>
      [row.username, row.name, row.email].some((field) =>
        field.toLowerCase().includes(q),
      ),
    )
  }, [rows, query])

  const selected = useMemo(
    () => rows.find((row) => row.key === selectedKey) ?? null,
    [rows, selectedKey],
  )
  const discrepancyCount = useMemo(
    () =>
      rows.filter((row) => row.classification === "on-roster-not-member")
        .length,
    [rows],
  )

  const isSelf = (row: OrgMemberRow) =>
    isSameGitHubUser(viewer ?? null, {
      github_id: row.github_id,
      username: row.username,
    })

  return (
    <div className="min-h-screen">
      <Drawer>
        <DrawerToggle />
        <DrawerContent className="p-10 bg-base-200 xl:px-50">
          <RequireTeacher allow="owner">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                {t("orgMembers.heading")}
              </h1>
              <p className="mt-1 text-sm text-base-content/70">
                {t("orgMembers.subtitlePrefix")}{" "}
                <span className="font-mono font-semibold">{org}</span>{" "}
                {t("orgMembers.subtitleSuffix")}
              </p>
              <a
                href={`https://github.com/orgs/${org}/people`}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                <ExternalLink aria-hidden="true" className="size-3.5" />
                {t("orgMembers.manageMembersOnGitHub")}
              </a>
            </div>

            {notes.length > 0 ? (
              <div
                className="alert alert-warning alert-soft mt-6 text-sm"
                role="status"
              >
                <span>{notes.join(" ")}</span>
              </div>
            ) : null}

            {discrepancyCount > 0 ? (
              <div
                className="alert alert-error alert-soft mt-6 text-sm"
                role="status"
              >
                <AlertTriangle className="size-4" aria-hidden="true" />
                <span>
                  {t("orgMembers.discrepancy", { count: discrepancyCount })}
                </span>
              </div>
            ) : null}

            <div className="mt-6">
              <input
                type="search"
                className="input input-bordered w-full max-w-sm"
                placeholder={t("orgMembers.searchPlaceholder")}
                aria-label={t("orgMembers.searchLabel")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            <div className="mt-4 card card-border w-full overflow-hidden bg-base-100 shadow-sm">
              {isLoading ? (
                <div className="flex items-center justify-center gap-3 px-6 py-12 text-base-content/70">
                  <span
                    className="loading loading-spinner loading-md"
                    aria-hidden="true"
                  />
                  <span className="text-sm">{t("orgMembers.loading")}</span>
                </div>
              ) : isError ? (
                <div className="px-6 py-10 text-center text-sm text-error">
                  {t("orgMembers.loadError")}
                </div>
              ) : filtered.length === 0 ? (
                <div className="px-6 py-10 text-center text-sm text-base-content/70">
                  {t("orgMembers.noMatch")}
                </div>
              ) : (
                <motion.ul
                  className="divide-y divide-base-300"
                  variants={enterExit}
                  initial="initial"
                  animate="animate"
                >
                  {filtered.map((row) => (
                    <ClickableRow
                      key={row.key}
                      className="group/row flex cursor-pointer items-center justify-between gap-4 px-6 py-4 hover:bg-base-200"
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedKey(row.key)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          setSelectedKey(row.key)
                        }
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <Avatar
                          name={row.name || row.username || row.email}
                          github={row.username}
                          initials={initialsFor(row)}
                          subtitle={<GitHubIdentity row={row} />}
                        />
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        {row.classification === "on-roster-not-member" &&
                        row.github_id ? (
                          <button
                            type="button"
                            className="btn btn-xs btn-primary"
                            disabled={invitingKey === row.key}
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleQuickInvite(row)
                            }}
                          >
                            {invitingKey === row.key ? (
                              <span
                                className="loading loading-spinner loading-xs"
                                aria-hidden="true"
                              />
                            ) : (
                              <>
                                <UserPlus
                                  aria-hidden="true"
                                  className="size-3.5"
                                />
                                {t("orgMembers.invite")}
                              </>
                            )}
                          </button>
                        ) : null}
                        <span className="hidden text-xs text-base-content/70 sm:inline">
                          {t("orgMembers.classroomCount", {
                            count: row.classrooms.length,
                          })}
                        </span>
                        <ClassificationBadge row={row} />
                        <ChevronRight
                          aria-hidden="true"
                          className="size-4 text-base-content/30 transition-transform duration-150 group-hover/row:translate-x-0.5 group-hover/row:text-base-content/70"
                        />
                      </div>
                    </ClickableRow>
                  ))}
                </motion.ul>
              )}
            </div>
          </RequireTeacher>
        </DrawerContent>
        <DrawerSidebar page="classes" selected="members" />
      </Drawer>

      {selected && org ? (
        <MemberDetail
          org={org}
          row={selected}
          isSelf={isSelf(selected)}
          onClose={() => setSelectedKey(null)}
          onRemoved={() => {
            setSelectedKey(null)
            refresh(selected)
          }}
        />
      ) : null}
    </div>
  )
}

export default OrgMembersPage
