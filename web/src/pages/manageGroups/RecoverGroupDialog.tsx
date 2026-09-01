import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"

import {
  Alert,
  Badge,
  Button,
  Checkbox,
  FormField,
  Heading,
  InlineSpinner,
  Input,
  Modal,
  ModalIcon,
  Select,
} from "@/components/ui"
import { PeopleIcon, PlusIcon, XIcon } from "@/components/ui/icons"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { errorText } from "@/types/localizedMessage"
import type { TeamFormation } from "@/types/classroom"
import useGetStudents from "@/hooks/useGetStudents"
import { useTeamRoster } from "@/hooks/useTeamRoster"
import useGroupTeams from "@/hooks/useGroupTeams"
import useGroupTeamMembers from "@/hooks/useGroupTeamMembers"
import useRecoverGroupTeam from "@/hooks/mutations/useRecoverGroupTeam"
import { useSyncTeamsSnapshot } from "@/hooks/mutations/useSaveTeamsSnapshot"
import {
  suggestMembersFromCommits,
  unassignedRosterStudents,
} from "@/domain/teams/groupTeams"
import type {
  RecoverGroupTeamMember,
  RecoverGroupTeamWarning,
} from "@/domain/teams/groupTeams"
import { parseGroupRepoCounter, studentRepoName } from "@/util/studentRepo"
import { describeTeamWriteError } from "./ManageGroupDialog"
import type { GroupPickerStudent } from "./ManageGroupDialog"

// The missing-team RECOVERY dialog, sibling of ManageGroupDialog: a team-mode
// group repo survives but its GitHub team was deleted, so grading can't
// credit members until the team is recreated at the repo's EXACT counter.
// Members are seeded from the repo's commit history (roster-intersected,
// pre-checked) plus the roster picker, with an optional maintainer over the
// chosen members. Applying runs the domain's recovery sequence (create silent
// -> adds -> repo attach -> teacher drop -> notifications on) and shows the
// collected warnings on completion, mirroring CopyGroupsModal's applying UX.
// Callers mount it per open (remount-per-open keeps the draft fresh) and
// unmount it on close.
export function RecoverGroupDialog({
  org,
  classroom,
  assignment,
  owner,
  formation,
  maxGroupSize,
  onClose,
}: {
  org: string
  classroom: string
  assignment: string
  // The row's owner segment ("group-<n>", lowercased) — the surviving repo's
  // counter, which pins the recreated team's name.
  owner: string
  formation: TeamFormation
  maxGroupSize?: number
  onClose: () => void
}) {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const { user } = useGithubAuth()
  const creatorLogin = user?.login ?? ""

  const repo = studentRepoName(classroom, assignment, owner)
  const n = parseGroupRepoCounter(repo, classroom, assignment)
  // The repo name pins the counter; privacy follows the assignment's
  // formation like createGroupTeam (student browsable, teacher hidden).
  const privacy = formation === "student" ? "closed" : "secret"

  // Roster (names + the roster gate) and the existing teams' member union,
  // for the "already on a group" exclusion — same plumbing as
  // ManageGroupDialog so both dialogs offer the same picker pool.
  const { students: csvStudents } = useGetStudents(org, classroom)
  const roster = useTeamRoster(org, classroom, csvStudents)
  const enrolled = useMemo(
    () =>
      roster.rows.filter(
        (row) => row.state === "enrolled" && row.username.trim() !== "",
      ),
    [roster.rows],
  )
  const rosterLogins = useMemo(
    () => new Set(enrolled.map((row) => row.username.trim().toLowerCase())),
    [enrolled],
  )
  const fullNameByLogin = useMemo(() => {
    const map = new Map<string, string>()
    for (const row of enrolled) {
      const name = `${row.first_name} ${row.last_name}`.trim()
      if (name) map.set(row.username.trim().toLowerCase(), name)
    }
    return map
  }, [enrolled])

  const teamsQuery = useGroupTeams(org, classroom, assignment)
  const teams = useMemo(() => teamsQuery.data ?? [], [teamsQuery.data])
  const slugs = useMemo(() => teams.map((team) => team.slug), [teams])
  const { logins: assignedLogins } = useGroupTeamMembers(org, slugs)

  const availableStudents: GroupPickerStudent[] = useMemo(
    () =>
      unassignedRosterStudents(enrolled, assignedLogins).map((row) => {
        const name = `${row.first_name} ${row.last_name}`.trim()
        return {
          key: row.key,
          username: row.username,
          label: name ? `${name} (${row.username})` : row.username,
        }
      }),
    [enrolled, assignedLogins],
  )

  // Members suggested from the repo's commit history, once the roster is
  // known (the domain read intersects with it). Keyed on the roster set so a
  // late roster load re-suggests rather than pinning an empty intersection.
  const rosterKey = useMemo(
    () => [...rosterLogins].toSorted().join(","),
    [rosterLogins],
  )
  const suggestionsQuery = useQuery({
    queryKey: ["recover-group-suggestions", org, repo, rosterKey] as const,
    queryFn: () =>
      suggestMembersFromCommits(client, org, repo, { rosterLogins }),
    enabled: Boolean(org && repo) && !roster.isLoading,
    staleTime: 60 * 1000,
  })
  const suggestionsLoading = roster.isLoading || suggestionsQuery.isLoading
  // A suggested committer already on another of this assignment's teams can't
  // be added (one student, one group), so the suggestion is dropped too.
  const suggestions = useMemo(
    () =>
      (suggestionsQuery.data ?? []).filter(
        (login) => !assignedLogins.has(login.toLowerCase()),
      ),
    [suggestionsQuery.data, assignedLogins],
  )

  const [nameDraft, setNameDraft] = useState("")
  // Suggestions are PRE-CHECKED; unchecking is the recorded state so a late
  // suggestion load can't clobber a teacher's choices.
  const [unchecked, setUnchecked] = useState<Set<string>>(() => new Set())
  const [additions, setAdditions] = useState<string[]>([])
  const [picked, setPicked] = useState("")
  const [maintainer, setMaintainer] = useState("")
  const [saving, setSaving] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  // Non-null once the team was recreated but some steps failed: the dialog
  // stays open so the teacher reads what to finish by hand.
  const [warnings, setWarnings] = useState<string[] | null>(null)
  const done = warnings !== null

  const chosen = useMemo(
    () => [
      ...suggestions.filter((login) => !unchecked.has(login.toLowerCase())),
      ...additions,
    ],
    [suggestions, unchecked, additions],
  )
  const chosenSet = useMemo(
    () => new Set(chosen.map((login) => login.toLowerCase())),
    [chosen],
  )
  const pickerStudents = availableStudents.filter(
    (student) => !chosenSet.has(student.username.trim().toLowerCase()),
  )
  const atCapacity = maxGroupSize !== undefined && chosen.length >= maxGroupSize
  const overCapacity =
    maxGroupSize !== undefined && chosen.length > maxGroupSize

  // The maintainer pick survives only while its login stays chosen.
  const effectiveMaintainer = chosenSet.has(maintainer.toLowerCase())
    ? maintainer
    : ""

  const toggleSuggestion = (login: string) => {
    setUnchecked((current) => {
      const next = new Set(current)
      const lower = login.toLowerCase()
      if (next.has(lower)) next.delete(lower)
      else next.add(lower)
      return next
    })
  }
  const addPicked = () => {
    if (!picked) return
    setAdditions((current) => [...current, picked])
    setPicked("")
  }
  const removeAddition = (login: string) => {
    setAdditions((current) =>
      current.filter((entry) => entry.toLowerCase() !== login.toLowerCase()),
    )
  }

  const syncSnapshot = useSyncTeamsSnapshot({ org, classroom, assignment })
  const recover = useRecoverGroupTeam({ org, classroom, assignment })

  const warningText = (warning: RecoverGroupTeamWarning): string => {
    const error = errorText(t, warning.error)
    switch (warning.step) {
      case "addMember":
        return t("manageGroups.recover.warnAddMember", {
          username: warning.username ?? "",
          error,
        })
      case "attachRepo":
        return t("manageGroups.recover.warnAttachRepo", { error })
      case "teacherDrop":
        return t("manageGroups.recover.warnTeacherDrop", { error })
      case "notifications":
        return t("manageGroups.recover.warnNotifications", { error })
    }
  }

  const handleRecreate = async () => {
    if (saving || done || n === null || !creatorLogin || overCapacity) return
    setSaving(true)
    setSubmitError(null)
    try {
      const members: RecoverGroupTeamMember[] = chosen.map((login) => ({
        username: login,
        role:
          effectiveMaintainer &&
          login.toLowerCase() === effectiveMaintainer.toLowerCase()
            ? "maintainer"
            : "member",
      }))
      const result = await recover.mutateAsync({
        n,
        displayName: nameDraft.trim() || undefined,
        privacy,
        members,
        repo,
        creatorLogin,
      })
      // One snapshot resync after the whole recovery, best-effort like every
      // teacher-side mutation (the drift badge catches a failed sync).
      try {
        await syncSnapshot.mutateAsync({ formation })
      } catch {
        // The drift badge surfaces a stale snapshot.
      }
      if (result.warnings.length === 0) {
        onClose()
        return
      }
      setWarnings(result.warnings.map(warningText))
    } catch (err) {
      setSubmitError(
        describeTeamWriteError(err, "create", t, errorText(t, err)),
      )
    } finally {
      setSaving(false)
    }
  }

  const displayName = t("manageGroups.defaultName", { n: n ?? 0 })
  const saveDisabled =
    saving || n === null || !creatorLogin || overCapacity || suggestionsLoading

  return (
    <Modal
      open
      onClose={onClose}
      closeDisabled={saving}
      size="lg"
      title={t("manageGroups.recover.title", { name: displayName })}
      headerVisual={
        <ModalIcon tone="error">
          <PeopleIcon aria-hidden="true" className="size-4" />
        </ModalIcon>
      }
      footer={
        <>
          {saving && (
            <span
              className="me-auto text-sm text-base-content/70"
              role="status"
            >
              {t("manageGroups.recover.applying")}
            </span>
          )}
          {done ? (
            <Button variant="primary" onClick={onClose}>
              {t("common.close")}
            </Button>
          ) : (
            <>
              <Button variant="ghost" disabled={saving} onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={saveDisabled}
                loading={saving}
                loadingLabel={t("manageGroups.recover.submitButton")}
                onClick={() => void handleRecreate()}
              >
                {t("manageGroups.recover.submitButton")}
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="mt-4 flex flex-col gap-5">
        {submitError ? (
          <Alert tone="error" className="text-sm">
            {submitError}
          </Alert>
        ) : null}
        {done ? (
          <Alert tone="warning" className="text-sm">
            <div>
              <p>{t("manageGroups.recover.warningsIntro")}</p>
              <ul className="mt-1 list-disc ps-5">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          </Alert>
        ) : null}

        <p className="text-sm text-base-content/70">
          {t("manageGroups.recover.intro")}
        </p>

        <FormField
          label={t("manageGroups.createNameLabel")}
          hint={t("manageGroups.createNameHint")}
        >
          {({ id, describedById }) => (
            <Input
              id={id}
              aria-describedby={describedById}
              value={nameDraft}
              maxLength={80}
              placeholder={displayName}
              disabled={saving || done}
              onChange={(e) => setNameDraft(e.target.value)}
            />
          )}
        </FormField>

        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Heading as="h4" variant="title-small">
              {t("manageGroups.manage.membersHeading")}
            </Heading>
            <Badge ghost size="sm">
              {maxGroupSize !== undefined
                ? t("manageGroups.memberCountOfMax", {
                    count: chosen.length,
                    max: maxGroupSize,
                  })
                : t("manageGroups.memberCount", { count: chosen.length })}
            </Badge>
          </div>

          <p className="text-xs text-base-content/70">
            {t("manageGroups.recover.suggestedHint")}
          </p>

          {suggestionsLoading ? (
            <p className="text-sm text-base-content/70">
              <span role="status" className="inline-flex items-center gap-2">
                <InlineSpinner />
                {t("manageGroups.recover.suggestionsLoading")}
              </span>
            </p>
          ) : (
            <ul className="divide-y divide-base-200 rounded-box border border-base-200">
              {suggestions.map((login) => {
                const fullName = fullNameByLogin.get(login.toLowerCase())
                return (
                  <li key={login} className="px-4 py-2">
                    <label className="flex cursor-pointer items-center gap-3">
                      <Checkbox
                        tone="primary"
                        checked={!unchecked.has(login.toLowerCase())}
                        disabled={saving || done}
                        onChange={() => toggleSuggestion(login)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {fullName ?? login}
                        </span>
                        {fullName && (
                          <span className="block truncate text-xs text-base-content/70">
                            {login}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                )
              })}

              {additions.map((login) => {
                const fullName = fullNameByLogin.get(login.toLowerCase())
                return (
                  <li
                    key={`add-${login}`}
                    className="flex items-center gap-3 px-4 py-2"
                  >
                    <span
                      aria-hidden="true"
                      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-success/10 text-xs text-success"
                    >
                      <PlusIcon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {fullName ?? login}
                      </span>
                      {fullName && (
                        <span className="block truncate text-xs text-base-content/70">
                          {login}
                        </span>
                      )}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      shape="square"
                      className="text-error/70 hover:text-error"
                      disabled={saving || done}
                      aria-label={t("manageGroups.removeAriaLabel", {
                        username: login,
                      })}
                      onClick={() => removeAddition(login)}
                    >
                      <XIcon aria-hidden="true" className="size-4" />
                    </Button>
                  </li>
                )
              })}

              {suggestions.length === 0 && additions.length === 0 && (
                <li className="px-4 py-3 text-sm text-base-content/70">
                  {t("manageGroups.recover.noSuggestions")}
                </li>
              )}
            </ul>
          )}

          {overCapacity ? (
            <p className="text-xs text-error">
              {t("manageGroups.recover.overCapacity", {
                members: chosen.length,
                max: maxGroupSize ?? 0,
              })}
            </p>
          ) : atCapacity ? (
            <p className="text-xs text-base-content/70">
              {t("manageGroups.groupFull", { max: maxGroupSize ?? 0 })}
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <Select
                selectSize="sm"
                className="max-w-xs flex-1"
                value={picked}
                disabled={saving || done}
                aria-label={t("manageGroups.addMemberAriaLabel", {
                  name: displayName,
                })}
                onChange={(e) => setPicked(e.target.value)}
              >
                <option value="">
                  {t("manageGroups.addMemberPlaceholder")}
                </option>
                {pickerStudents.map((student) => (
                  <option key={student.key} value={student.username}>
                    {student.label}
                  </option>
                ))}
              </Select>
              <Button
                variant="outline"
                size="sm"
                disabled={saving || done || !picked}
                onClick={addPicked}
              >
                <PlusIcon aria-hidden="true" className="size-4" />
                {t("manageGroups.addMemberButton")}
              </Button>
            </div>
          )}
        </section>

        <FormField
          label={t("manageGroups.recover.maintainerLabel")}
          hint={t("manageGroups.recover.maintainerHint")}
        >
          {({ id, describedById }) => (
            <Select
              id={id}
              aria-describedby={describedById}
              className="w-auto"
              value={effectiveMaintainer}
              disabled={saving || done || chosen.length === 0}
              onChange={(e) => setMaintainer(e.target.value)}
            >
              <option value="">
                {t("manageGroups.recover.maintainerNone")}
              </option>
              {chosen.map((login) => {
                const fullName = fullNameByLogin.get(login.toLowerCase())
                return (
                  <option key={login} value={login}>
                    {fullName ? `${fullName} (${login})` : login}
                  </option>
                )
              })}
            </Select>
          )}
        </FormField>
      </div>
    </Modal>
  )
}

export default RecoverGroupDialog
