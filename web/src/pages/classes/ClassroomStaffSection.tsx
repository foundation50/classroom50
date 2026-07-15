import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { Loader2, Send, ShieldCheck, UserPlus, X, XCircle } from "lucide-react"
import { GitHubLink } from "@/components/GitHubLink"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useToast } from "@/context/notifications/NotificationProvider"
import { ConfirmModal } from "@/components/modals"
import {
  githubKeys,
  teamMembersQuery,
  teamInvitationsQuery,
  getUser,
} from "@/github-core/queries"
import { classroomTeamSlug } from "@/util/teamSlug"
import {
  removeUserFromTeam,
  resendOrgInvitation,
  cancelOrgInvitation,
} from "@/github-core/mutations"
import { resolveTeamIdForRoleRead } from "@/domain/students"
import { orgRoleForRole } from "@/util/teamRoster"
import {
  useAddStaffMember,
  syncRosterAfterStaffChange,
} from "@/hooks/mutations/useAddStaffMember"
import { GitHubAPIError } from "@/github-core/errors"
import { STAFF_ROLES, type StaffRole } from "@/types/classroom"
import type { GitHubUser, GitHubOrgInvitation } from "@/github-core/types"
import { Button, Badge, Card, FormField, Input, Select } from "@/components/ui"

// i18n key for each role's singular label. A map (not inline t()) so it works in
// module scope; components translate via t(ROLE_LABEL_KEY[role]).
const ROLE_LABEL_KEY: Record<StaffRole, string> = {
  instructor: "classes.staff.roleInstructor",
  ta: "classes.staff.roleTa",
}

// Manage a classroom's staff (instructor / TA), backed by the per-classroom
// GitHub teams `classroom50-<classroom>-<role>`. The route already gates; the
// actions assume instructor/owner.
const ClassroomStaffSection = ({
  org,
  classroom,
  disabled = false,
}: {
  org: string
  classroom: string
  // Archived classroom => read-only (mirrors the settings form's fieldset).
  disabled?: boolean
}) => {
  const { t } = useTranslation()
  return (
    <Card bordered={false} className="w-full mt-8">
      <Card.Body>
        <div className="flex items-center gap-3 pb-1">
          <div className="flex items-center gap-2">
            <ShieldCheck
              aria-hidden="true"
              className="size-5 text-base-content/70"
            />
            <h3 className="text-lg font-bold">{t("classes.staff.heading")}</h3>
          </div>
          <GitHubLink
            href={`https://github.com/orgs/${org}/teams`}
            label={t("classes.staff.githubTeams")}
            title={t("classes.staff.githubTeamsTitle")}
            className="shrink-0"
          />
        </div>
        <p className="text-sm text-base-content/70 pb-4">
          {t("classes.staff.description")}
        </p>

        <AddStaff org={org} classroom={classroom} disabled={disabled} />

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 mt-2">
          {STAFF_ROLES.map((role) => (
            <StaffRoleList
              key={role}
              org={org}
              classroom={classroom}
              role={role}
              disabled={disabled}
            />
          ))}
        </div>
      </Card.Body>
    </Card>
  )
}

// Add a GitHub user to a role team. Ensures the team exists first (self-healing
// preflight: a classroom missing a staff team is created here) and grants it
// config-repo write, then adds the user.
const AddStaff = ({
  org,
  classroom,
  disabled,
}: {
  org: string
  classroom: string
  disabled: boolean
}) => {
  const { t } = useTranslation()
  const { notify } = useToast()
  const [username, setUsername] = useState("")
  const [role, setRole] = useState<StaffRole>("ta")

  const addMutation = useAddStaffMember(org, classroom, {
    enterUsername: t("classes.staff.enterUsername"),
  })

  return (
    <form
      className="flex flex-wrap items-end gap-2 mb-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (disabled) return
        addMutation.mutate(
          { username, role },
          {
            onSuccess: ({ trimmed, role: addedRole }) => {
              setUsername("")
              notify({
                tone: "success",
                durationMs: 5000,
                message: t("toasts.staffAdded", {
                  username: trimmed,
                  role: t(ROLE_LABEL_KEY[addedRole]),
                }),
              })
            },
            onError: (err) => {
              const message =
                err instanceof GitHubAPIError && err.status === 404
                  ? t("classes.staff.noSuchUser")
                  : err instanceof Error
                    ? err.message
                    : t("classes.somethingWentWrong")
              notify({
                tone: "error",
                message: t("classes.staff.addFailed", { message }),
              })
            },
          },
        )
      }}
    >
      <div className="grow min-w-[12rem]">
        <FormField
          label={t("classes.staff.githubUsername")}
          htmlFor="staff-username"
        >
          {({ id }) => (
            <Input
              id={id}
              autoComplete="off"
              spellCheck={false}
              placeholder={t("classes.staff.usernamePlaceholder")}
              value={username}
              disabled={disabled || addMutation.isPending}
              onChange={(e) => setUsername(e.target.value)}
            />
          )}
        </FormField>
      </div>
      <div>
        <FormField label={t("classes.staff.role")} htmlFor="staff-role">
          {({ id }) => (
            <Select
              id={id}
              value={role}
              disabled={disabled || addMutation.isPending}
              onChange={(e) => setRole(e.target.value as StaffRole)}
            >
              {STAFF_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(ROLE_LABEL_KEY[r])}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </div>
      <Button
        type="submit"
        variant="primary"
        disabled={disabled || addMutation.isPending || !username.trim()}
      >
        {addMutation.isPending ? (
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        ) : (
          <UserPlus aria-hidden="true" className="size-4" />
        )}
        {t("classes.staff.add")}
      </Button>
    </form>
  )
}

const StaffRoleList = ({
  org,
  classroom,
  role,
  disabled,
}: {
  org: string
  classroom: string
  role: StaffRole
  disabled: boolean
}) => {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const teamSlug = useMemo(
    () => classroomTeamSlug(classroom, role),
    [classroom, role],
  )
  const membersQuery = useQuery(teamMembersQuery(client, org, teamSlug))
  const members = membersQuery.data ?? []
  // Pending staff invitations for this team (owner-only; 403 -> [], 404 -> []).
  const invitesQuery = useQuery(teamInvitationsQuery(client, org, teamSlug))
  const pendingInvites = invitesQuery.data ?? []

  const rolePlural =
    role === "instructor"
      ? t("classes.staff.roleInstructorPlural")
      : t("classes.staff.roleTaPlural")

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <h4 className="font-bold">{rolePlural}</h4>
        <Badge ghost>{members.length}</Badge>
      </div>
      {membersQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-base-content/70">
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />{" "}
          {t("common.loading")}
        </div>
      ) : members.length === 0 && pendingInvites.length === 0 ? (
        <p className="text-sm text-base-content/70">
          {t("classes.staff.noneYet", { role: rolePlural.toLowerCase() })}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {members.map((member) => (
            <StaffMemberRow
              key={member.id}
              org={org}
              classroom={classroom}
              role={role}
              member={member}
              disabled={disabled}
            />
          ))}
          {pendingInvites.map((invite) => (
            <PendingStaffRow
              key={`invite-${invite.id}`}
              org={org}
              classroom={classroom}
              role={role}
              invite={invite}
              disabled={disabled}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

const StaffMemberRow = ({
  org,
  classroom,
  role,
  member,
  disabled,
}: {
  org: string
  classroom: string
  role: StaffRole
  member: GitHubUser
  disabled: boolean
}) => {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { notify } = useToast()
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const teamSlug = classroomTeamSlug(classroom, role)

  const roleLabel = t(ROLE_LABEL_KEY[role])
  const rolePlural =
    role === "instructor"
      ? t("classes.staff.roleInstructorPlural")
      : t("classes.staff.roleTaPlural")

  const removeMutation = useMutation({
    mutationFn: () =>
      removeUserFromTeam(client, { org, teamSlug, username: member.login }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: githubKeys.teamMembers(org, teamSlug),
      })
      queryClient.invalidateQueries({
        queryKey: githubKeys.teamInvitations(org, teamSlug),
      })
      // Clear the removed staffer's stale role from roster.csv now
      // (best-effort) so the roster stops showing them with a role.
      void syncRosterAfterStaffChange(client, queryClient, org, classroom)
      notify({
        tone: "success",
        durationMs: 4000,
        message: t("classes.staff.removedToast", {
          login: member.login,
          role: rolePlural,
        }),
      })
    },
    onError: (err) => {
      notify({
        tone: "error",
        message: t("classes.staff.removeFailed", {
          login: member.login,
          error:
            err instanceof Error
              ? err.message
              : t("classes.somethingWentWrong"),
        }),
      })
    },
  })

  return (
    <li className="flex items-center justify-between gap-2 rounded-md border border-base-200 px-2 py-1.5">
      <a
        href={member.html_url}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-2 min-w-0 hover:underline"
      >
        <img
          src={member.avatar_url}
          alt=""
          className="size-6 rounded-full shrink-0"
        />
        <span className="truncate text-sm">@{member.login}</span>
        <Badge
          size="xs"
          tone={role === "instructor" ? "primary" : "secondary"}
          className="shrink-0"
        >
          {roleLabel}
        </Badge>
      </a>
      <Button
        variant="ghost"
        size="xs"
        className="text-error"
        title={t("classes.staff.removeRole", { role: roleLabel })}
        disabled={disabled || removeMutation.isPending}
        onClick={() => setConfirmingRemove(true)}
      >
        {removeMutation.isPending ? (
          <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
        ) : (
          <X aria-hidden="true" className="size-3.5" />
        )}
      </Button>
      <ConfirmModal
        open={confirmingRemove}
        dangerous
        needsConfirm={false}
        title={t("classes.staff.confirmRemoveTitle", {
          login: member.login,
          role: roleLabel,
        })}
        description={t("classes.staff.confirmRemoveBody", {
          login: member.login,
          role: roleLabel,
        })}
        confirmLabel={t("classes.staff.removeRole", { role: roleLabel })}
        onConfirm={async () => {
          setConfirmingRemove(false)
          await removeMutation.mutateAsync()
        }}
        onClose={() => setConfirmingRemove(false)}
      />
    </li>
  )
}

// A pending staff invitation (owner-only). Resend recreates the org invite
// carrying the staff team; cancel deletes it. An email-only invite (no login)
// can't be resolved to a numeric invitee id, so it's cancel-only.
const PendingStaffRow = ({
  org,
  classroom,
  role,
  invite,
  disabled,
}: {
  org: string
  classroom: string
  role: StaffRole
  invite: GitHubOrgInvitation
  disabled: boolean
}) => {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { notify } = useToast()
  const teamSlug = classroomTeamSlug(classroom, role)
  const who = invite.login || invite.email || String(invite.id)

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: githubKeys.teamInvitations(org, teamSlug),
    })
    queryClient.invalidateQueries({
      queryKey: githubKeys.teamMembers(org, teamSlug),
    })
  }

  const resendMutation = useMutation({
    mutationFn: async () => {
      if (!invite.login) throw new Error(t("classes.staff.resendEmailOnly"))
      // Resolve the invitee's immutable id (org invites don't carry it) and the
      // role's team, so the re-sent invite lands them on the staff team.
      const inviteeId = (await getUser(client, invite.login)).id
      const teamId = await resolveTeamIdForRoleRead(
        client,
        org,
        classroom,
        role,
      )
      await resendOrgInvitation(client, {
        org,
        username: invite.login,
        inviteeId,
        invitationId: invite.id,
        teamIds: teamId ? [teamId] : undefined,
        // Preserve the original org role: an instructor invite is org OWNER.
        role: orgRoleForRole(role),
      })
    },
    onSuccess: () => {
      invalidate()
      notify({
        tone: "success",
        durationMs: 4000,
        message: t("classes.staff.resentToast", { who }),
      })
    },
    onError: (err) =>
      notify({
        tone: "error",
        message: t("classes.staff.resendFailed", {
          who,
          error:
            err instanceof Error
              ? err.message
              : t("classes.somethingWentWrong"),
        }),
      }),
  })

  const cancelMutation = useMutation({
    mutationFn: () =>
      cancelOrgInvitation(client, { org, invitationId: invite.id }),
    onSuccess: () => {
      invalidate()
      notify({
        tone: "success",
        durationMs: 4000,
        message: t("classes.staff.cancelledToast", { who }),
      })
    },
    onError: (err) =>
      notify({
        tone: "error",
        message: t("classes.staff.cancelFailed", {
          who,
          error:
            err instanceof Error
              ? err.message
              : t("classes.somethingWentWrong"),
        }),
      }),
  })

  const busy = resendMutation.isPending || cancelMutation.isPending

  return (
    <li className="flex items-center justify-between gap-2 rounded-md border border-dashed border-base-300 px-2 py-1.5">
      <span className="flex min-w-0 items-center gap-2 text-sm">
        <span className="truncate">
          {invite.login ? `@${invite.login}` : invite.email}
        </span>
        <Badge size="xs" ghost className="shrink-0">
          {t("classes.staff.pendingBadge")}
        </Badge>
      </span>
      <div className="flex shrink-0 items-center gap-1">
        {invite.login ? (
          <Button
            variant="ghost"
            size="xs"
            title={t("classes.staff.resend")}
            disabled={disabled || busy}
            onClick={() => resendMutation.mutate()}
          >
            {resendMutation.isPending ? (
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
            ) : (
              <Send aria-hidden="true" className="size-3.5" />
            )}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="xs"
          className="text-error"
          title={t("classes.staff.cancelInvite")}
          disabled={disabled || busy}
          onClick={() => cancelMutation.mutate()}
        >
          {cancelMutation.isPending ? (
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
          ) : (
            <XCircle aria-hidden="true" className="size-3.5" />
          )}
        </Button>
      </div>
    </li>
  )
}

export default ClassroomStaffSection
