import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { Loader2, ShieldCheck, UserPlus, X } from "lucide-react"
import { GitHubLink } from "@/components/GitHubLink"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { useToast } from "@/context/notifications/NotificationProvider"
import {
  githubKeys,
  teamMembersQuery,
  getUserQuery,
} from "@/hooks/github/queries"
import {
  addUserToTeam,
  ensureClassroomRoleTeam,
  removeUserFromTeam,
  staffTeamName,
  grantTeamConfigRepoWrite,
} from "@/hooks/github/mutations"
import {
  normalizeGithubUsername,
  syncRosterFromTeam,
} from "@/api/mutations/students"
import { rosterPath } from "@/util/rosterPath"
import { GitHubAPIError } from "@/hooks/github/errors"
import { STAFF_ROLES, type StaffRole } from "@/types/classroom"
import type { GitHubUser } from "@/hooks/github/types"
import type { GitHubClient } from "@/hooks/github/client"
import type { QueryClient } from "@tanstack/react-query"
import { logger } from "@/lib/logger"
import { Button, Card, FormField, Input, Select } from "@/components/ui"

// i18n key for each role's singular label. A map (not inline t()) so it works in
// module scope; components translate via t(ROLE_LABEL_KEY[role]).
const ROLE_LABEL_KEY: Record<StaffRole, string> = {
  instructor: "classes.staff.roleInstructor",
  ta: "classes.staff.roleTa",
}

const log = logger.scope("classroom:staff")

// Best-effort roster.csv convergence after a staff membership change: the roster
// records a `role` per member (team is the authority), so adding/removing staff
// should proactively sync roster.csv rather than waiting for the next roster
// open. Failure is non-fatal — the roster page auto-syncs on open — so this
// never blocks or surfaces an error on the staff action itself.
async function syncRosterAfterStaffChange(
  client: GitHubClient,
  queryClient: QueryClient,
  org: string,
  classroom: string,
): Promise<void> {
  try {
    await syncRosterFromTeam(client, { org, classroom })
    await queryClient.invalidateQueries({
      queryKey: githubKeys.csvFile(org, "classroom50", rosterPath(classroom)),
    })
  } catch (err) {
    // Best-effort; the roster page's auto-sync converges it on next open. Log
    // so a persistently failing convergence is diagnosable.
    log.debug("roster sync after staff change failed (non-fatal)", {
      org,
      classroom,
      err,
    })
  }
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
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { notify } = useToast()
  const { user } = useGithubAuth()
  const [username, setUsername] = useState("")
  const [role, setRole] = useState<StaffRole>("ta")

  const addMutation = useMutation({
    mutationFn: async (input: { username: string; role: StaffRole }) => {
      const trimmed = normalizeGithubUsername(input.username)
      if (!trimmed) throw new Error(t("classes.staff.enterUsername"))
      // Verify the account exists for a clear error (vs. a confusing team 422).
      await queryClient.ensureQueryData(getUserQuery(client, trimmed))
      // Ensure-as-preflight: create the team if missing + (re)grant config write.
      const team = await ensureClassroomRoleTeam(
        client,
        org,
        classroom,
        input.role,
      )
      await grantTeamConfigRepoWrite(client, org, team.slug)
      // GitHub auto-adds the team CREATOR as maintainer. If this action just
      // created the team, remove the acting user unless they're the target — so
      // adding a TA doesn't also make the instructor a TA.
      if (
        team.created &&
        user?.login &&
        user.login.toLowerCase() !== trimmed.toLowerCase()
      ) {
        try {
          await removeUserFromTeam(client, {
            org,
            teamSlug: team.slug,
            username: user.login,
          })
        } catch {
          // Best-effort; the actor can remove themselves via this same UI.
        }
      }
      await addUserToTeam(client, {
        org,
        teamSlug: team.slug,
        username: trimmed,
        role: "member",
      })
      return { trimmed, role: input.role }
    },
    onSuccess: ({ trimmed, role: addedRole }) => {
      setUsername("")
      queryClient.invalidateQueries({
        queryKey: githubKeys.teamMembers(
          org,
          staffTeamName(classroom, addedRole),
        ),
      })
      // Record the new staffer's role in roster.csv now (best-effort).
      void syncRosterAfterStaffChange(client, queryClient, org, classroom)
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
  })

  return (
    <form
      className="flex flex-wrap items-end gap-2 mb-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (disabled) return
        addMutation.mutate({ username, role })
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
    () => staffTeamName(classroom, role),
    [classroom, role],
  )
  const membersQuery = useQuery(teamMembersQuery(client, org, teamSlug))
  const members = membersQuery.data ?? []

  const rolePlural =
    role === "instructor"
      ? t("classes.staff.roleInstructorPlural")
      : t("classes.staff.roleTaPlural")

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <h4 className="font-bold">{rolePlural}</h4>
        <span className="badge badge-sm badge-ghost">{members.length}</span>
      </div>
      {membersQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-base-content/70">
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />{" "}
          {t("common.loading")}
        </div>
      ) : members.length === 0 ? (
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
  const teamSlug = staffTeamName(classroom, role)

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
        <span
          className={`badge badge-xs shrink-0 ${
            role === "instructor" ? "badge-primary" : "badge-secondary"
          } badge-soft`}
        >
          {roleLabel}
        </span>
      </a>
      <Button
        variant="ghost"
        size="xs"
        className="text-error"
        title={t("classes.staff.removeRole", { role: roleLabel })}
        disabled={disabled || removeMutation.isPending}
        onClick={() => removeMutation.mutate()}
      >
        {removeMutation.isPending ? (
          <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
        ) : (
          <X aria-hidden="true" className="size-3.5" />
        )}
      </Button>
    </li>
  )
}

export default ClassroomStaffSection
