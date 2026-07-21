import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import {
  ExternalLink,
  Loader2,
  Send,
  ShieldCheck,
  UserPlus,
  X,
  XCircle,
} from "lucide-react"
import { GitHubLink } from "@/components/GitHubLink"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useClassroomRoleContext } from "@/context/classroomRole/ClassroomRoleProvider"
import { can, isTeacherRole } from "@/authz"
import { ConfirmModal } from "@/components/modals"
import { teamMembersQuery, teamInvitationsQuery } from "@/github-core/queries"
import { classroomTeamSlug } from "@/util/teamSlug"
import { useGitHubViewer } from "@/hooks/useGitHubResources"
import { isSameGitHubUser } from "@/util/students"
import { useAddStaffMember } from "@/hooks/mutations/useAddStaffMember"
import useRemoveStaffMember from "@/hooks/mutations/useRemoveStaffMember"
import useResendStaffInvite from "@/hooks/mutations/useResendStaffInvite"
import useCancelStaffInvite from "@/hooks/mutations/useCancelStaffInvite"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import { GitHubAPIError } from "@/github-core/errors"
import { STAFF_ROLES, type StaffRole } from "@/types/classroom"
import { ROLE_BADGE_TONE } from "@/util/classroomRoleUI"
import type { GitHubUser, GitHubOrgInvitation } from "@/github-core/types"
import { Button, Badge, Card, FormField, Input, Select } from "@/components/ui"

// i18n key for each role's singular label. A map (not inline t()) so it works in
// module scope; components translate via t(ROLE_LABEL_KEY[role]). `teacher` and
// its legacy `instructor` alias share the label key.
const ROLE_LABEL_KEY: Record<StaffRole, string> = {
  teacher: "classes.staff.roleTeacher",
  instructor: "classes.staff.roleTeacher",
  hta: "classes.staff.roleHeadTa",
  ta: "classes.staff.roleTa",
}

// i18n key for each role's plural label (section headings). Keyed by role so a
// new staff role renders correctly rather than defaulting to the TA branch.
const ROLE_PLURAL_KEY: Record<StaffRole, string> = {
  teacher: "classes.staff.roleTeacherPlural",
  instructor: "classes.staff.roleTeacherPlural",
  hta: "classes.staff.roleHeadTaPlural",
  ta: "classes.staff.roleTaPlural",
}

// Short access hint per role, shown under each section heading so a teacher
// sees at a glance what the role grants (write vs read-only, org owner or not).
const ROLE_ACCESS_KEY: Record<StaffRole, string> = {
  teacher: "classes.staff.accessTeacher",
  instructor: "classes.staff.accessTeacher",
  hta: "classes.staff.accessHeadTa",
  ta: "classes.staff.accessTa",
}

// Manage a classroom's staff (teacher / head TA / TA), backed by the
// per-classroom GitHub teams `classroom50-<classroom>-<role>`. The route gates
// to teachers, but this section also asserts can("editClassroomSettings")
// in-component so it fails closed if ever mounted outside RequireRole (the
// underlying team/invite ops are owner-only at GitHub — the true enforcer).
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
  const { role } = useClassroomRoleContext()
  // Defense-in-depth: only a classroom teacher may mutate staff. Fold into the
  // read-only `disabled` state so every action (add/remove/role/resend/cancel)
  // fails closed rather than relying solely on the route guard.
  const canManageStaff = can("editClassroomSettings", { classroomRole: role })
  const actionsDisabled = disabled || !canManageStaff
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

        <AddStaff org={org} classroom={classroom} disabled={actionsDisabled} />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 mt-2">
          {STAFF_ROLES.map((role) => (
            <StaffRoleList
              key={role}
              org={org}
              classroom={classroom}
              role={role}
              disabled={actionsDisabled}
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

  const rolePlural = t(ROLE_PLURAL_KEY[role])
  const isLoading = membersQuery.isLoading

  return (
    <div className="flex flex-col rounded-box border border-base-200 bg-base-100">
      <div className="flex flex-col gap-0.5 border-b border-base-200 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <a
            href={`https://github.com/orgs/${org}/teams/${teamSlug}`}
            target="_blank"
            rel="noreferrer"
            title={t("classes.staff.viewTeamTitle", { role: rolePlural })}
            className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            <Badge
              size="sm"
              tone={ROLE_BADGE_TONE[role]}
              className="gap-1 hover:brightness-95"
            >
              {rolePlural}
              <ExternalLink aria-hidden="true" className="size-3 opacity-70" />
            </Badge>
          </a>
          <Badge ghost size="sm">
            {members.length}
          </Badge>
          {pendingInvites.length > 0 ? (
            <span className="ms-auto text-xs text-warning">
              {t("classes.staff.pendingCount", {
                count: pendingInvites.length,
              })}
            </span>
          ) : null}
        </div>
        <p className="text-xs text-base-content/60">
          {t(ROLE_ACCESS_KEY[role])}
        </p>
      </div>
      <div className="p-2">
        {isLoading ? (
          <div className="flex items-center gap-2 px-1 py-1 text-sm text-base-content/70">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            {t("common.loading")}
          </div>
        ) : members.length === 0 && pendingInvites.length === 0 ? (
          <p className="px-1 py-1 text-sm text-base-content/50">
            {t("classes.staff.noneYet", { role: rolePlural.toLowerCase() })}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
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
  const { notify } = useToast()
  const { data: viewer } = useGitHubViewer()
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const teamSlug = classroomTeamSlug(classroom, role)

  const roleLabel = t(ROLE_LABEL_KEY[role])
  const rolePlural = t(ROLE_PLURAL_KEY[role])

  const removeMutation = useRemoveStaffMember(org, classroom, teamSlug, role)

  // A teacher can't remove THEMSELVES from the teacher team — it would revoke
  // their own owner-level access to the classroom (the mutation refuses it too;
  // this hides the action so there's no dead button). Mirrors the roster's
  // self-demote block and the org Members self-remove guard.
  const isSelf = isSameGitHubUser(viewer ?? null, { username: member.login })
  const selfTeacherRemoveBlocked = isSelf && isTeacherRole(role)

  return (
    <li className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-base-200/60">
      <a
        href={member.html_url}
        target="_blank"
        rel="noreferrer"
        className="flex min-w-0 grow items-center gap-2 hover:underline"
      >
        <img
          src={member.avatar_url}
          alt=""
          className="size-6 rounded-full shrink-0"
        />
        <span className="truncate text-sm">@{member.login}</span>
      </a>
      <div className="flex shrink-0 items-center">
        {selfTeacherRemoveBlocked ? (
          <span
            className="rounded px-1.5 py-0.5 text-xs text-base-content/50"
            title={t("classes.staff.removeSelfTeacherBlocked")}
          >
            {t("classes.staff.you")}
          </span>
        ) : (
          <Button
            variant="ghost"
            size="xs"
            shape="square"
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
        )}
      </div>
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
          await removeMutation.mutateAsync(member.login, {
            onSuccess: () => {
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
  const { notify } = useToast()
  const teamSlug = classroomTeamSlug(classroom, role)
  const who = invite.login || invite.email || String(invite.id)

  const resendMutation = useResendStaffInvite(org, classroom, role, teamSlug)
  const cancelMutation = useCancelStaffInvite(org, teamSlug)

  // One latch per row so a same-tick double-click, or resend racing cancel on
  // the same invite, can't start two overlapping writes before isPending flips.
  const submit = useSafeSubmit()

  const busy = resendMutation.isPending || cancelMutation.isPending

  return (
    <li className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-base-200/60">
      <span className="flex min-w-0 grow items-center gap-2 text-sm">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-base-200 text-base-content/50">
          <Send aria-hidden="true" className="size-3" />
        </span>
        <span className="truncate">
          {invite.login ? `@${invite.login}` : invite.email}
        </span>
        <Badge size="xs" tone="warning" ghost className="shrink-0">
          {t("classes.staff.pendingBadge")}
        </Badge>
      </span>
      <div className="flex shrink-0 items-center">
        {invite.login ? (
          <Button
            variant="ghost"
            size="xs"
            shape="square"
            title={t("classes.staff.resend")}
            disabled={disabled || busy}
            onClick={() =>
              void submit(() =>
                resendMutation.mutateAsync(
                  {
                    login: invite.login,
                    invitationId: invite.id,
                    emailOnlyMessage: t("classes.staff.resendEmailOnly"),
                  },
                  {
                    onSuccess: () =>
                      notify({
                        tone: "success",
                        durationMs: 4000,
                        message: t("classes.staff.resentToast", { who }),
                      }),
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
                  },
                ),
              )
            }
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
          shape="square"
          className="text-error"
          title={t("classes.staff.cancelInvite")}
          disabled={disabled || busy}
          onClick={() =>
            void submit(() =>
              cancelMutation.mutateAsync(invite.id, {
                onSuccess: () =>
                  notify({
                    tone: "success",
                    durationMs: 4000,
                    message: t("classes.staff.cancelledToast", { who }),
                  }),
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
              }),
            )
          }
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
