import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import {
  Alert,
  Badge,
  Button,
  FormField,
  Heading,
  Modal,
  ModalIcon,
  Select,
} from "@/components/ui"
import { CopyIcon, PlusIcon, TrashIcon, XIcon } from "@/components/ui/icons"
import { Spinner } from "@/components/Spinner"
import { EmptyState } from "@/components/list"
import { errorText } from "@/types/localizedMessage"
import type { TeamFormation } from "@/types/classroom"
import useGroupTeams from "@/hooks/useGroupTeams"
import useGroupTeamMembers from "@/hooks/useGroupTeamMembers"
import useApplyGroupsPlan from "@/hooks/mutations/useApplyGroupsPlan"
import {
  buildCopyPlan,
  planIssues,
  usedLogins,
} from "@/domain/teams/copyGroupsPlan"
import type { PlannedGroup } from "@/domain/teams/copyGroupsPlan"
import type { GroupPickerStudent } from "./ManageGroupDialog"

// Another team-mode assignment of this classroom, offered as a copy source.
export type CopySourceOption = {
  slug: string
  name: string
}

// A member add that failed during the apply, resolved for display.
type MemberWarning = {
  groupName: string
  username: string
  detail: string
}

// The "Copy groups from another assignment" dialog: pick a source assignment,
// preview its live groups as a PLAN for the current assignment (names +
// members carried over, numbering indicative), edit the plan (remove/add
// members, drop groups), then create everything on save. Nothing is written
// while previewing; the page remounts the dialog per open so a stale plan
// never leaks into the next session.
export function CopyGroupsModal({
  open,
  onClose,
  org,
  classroom,
  assignmentSlug,
  formation,
  maxGroupSize,
  existingGroupCount,
  takenLogins,
  availableStudents,
  fullNameByLogin,
  rosterLogins,
  creatorLogin,
  sourceOptions,
}: {
  open: boolean
  onClose: () => void
  org: string
  classroom: string
  assignmentSlug: string
  formation: TeamFormation
  maxGroupSize?: number
  // How many groups the current assignment already has (counters continue).
  existingGroupCount: number
  // Lowercased logins already on one of the CURRENT assignment's teams.
  takenLogins: ReadonlySet<string>
  // Roster students on none of the current assignment's teams (picker pool).
  availableStudents: GroupPickerStudent[]
  // Lowercased login -> roster full name, for the member chips.
  fullNameByLogin: Map<string, string>
  rosterLogins: ReadonlySet<string>
  creatorLogin: string
  sourceOptions: CopySourceOption[]
}) {
  const { t } = useTranslation()

  const [sourceSlug, setSourceSlug] = useState("")
  const [plan, setPlan] = useState<PlannedGroup[] | null>(null)
  const [pickedByGroup, setPickedByGroup] = useState<Record<string, string>>({})
  const [progress, setProgress] = useState<{
    current: number
    total: number
  } | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [memberWarnings, setMemberWarnings] = useState<MemberWarning[]>([])

  // The SOURCE assignment's live teams + members, fanned out only once a
  // source is picked. Reads only — the preview writes nothing.
  const sourceTeamsQuery = useGroupTeams(org, classroom, sourceSlug, {
    enabled: open && sourceSlug !== "",
  })
  const sourceTeams = useMemo(
    () => sourceTeamsQuery.data ?? [],
    [sourceTeamsQuery.data],
  )
  const sourceSlugs = useMemo(
    () => sourceTeams.map((team) => team.slug),
    [sourceTeams],
  )
  const {
    membersBySlug: sourceMembersBySlug,
    isPending: sourceMembersPending,
  } = useGroupTeamMembers(org, open && sourceSlug ? sourceSlugs : [])

  const sourceLoading =
    sourceSlug !== "" && (sourceTeamsQuery.isLoading || sourceMembersPending)

  // Seed the plan once per source pick, after teams AND members resolve; edits
  // then live in local state so a background refetch can't clobber them.
  const seededFor = useRef<string | null>(null)
  useEffect(() => {
    if (!open || !sourceSlug || sourceLoading) return
    if (seededFor.current === sourceSlug) return
    seededFor.current = sourceSlug
    setPlan(buildCopyPlan(sourceTeams, sourceMembersBySlug))
  }, [open, sourceSlug, sourceLoading, sourceTeams, sourceMembersBySlug])

  const applyPlan = useApplyGroupsPlan({
    org,
    classroom,
    assignment: assignmentSlug,
  })
  const applying = progress !== null || applyPlan.isPending

  const issues = useMemo(
    () => planIssues(plan ?? [], { maxGroupSize, takenLogins }),
    [plan, maxGroupSize, takenLogins],
  )
  const issueByKey = useMemo(
    () => new Map(issues.map((issue) => [issue.key, issue])),
    [issues],
  )
  // One student, one group: the picker pool excludes every login already used
  // anywhere in the draft (availableStudents already excludes `takenLogins`).
  const pickerStudents = useMemo(() => {
    const used = usedLogins(plan ?? [])
    return availableStudents.filter(
      (student) => !used.has(student.username.trim().toLowerCase()),
    )
  }, [plan, availableStudents])

  const changeSource = (next: string) => {
    seededFor.current = null
    setSourceSlug(next)
    setPlan(null)
    setPickedByGroup({})
    setApplyError(null)
    setMemberWarnings([])
  }

  const groupDisplayName = (group: PlannedGroup, index: number) =>
    group.name ?? t("manageGroups.defaultName", { n: index + 1 })

  const removeMember = (key: string, username: string) => {
    setPlan(
      (current) =>
        current?.map((group) =>
          group.key === key
            ? {
                ...group,
                members: group.members.filter((login) => login !== username),
              }
            : group,
        ) ?? current,
    )
  }

  const addMember = (key: string) => {
    const picked = pickedByGroup[key]
    if (!picked) return
    setPlan(
      (current) =>
        current?.map((group) =>
          group.key === key
            ? { ...group, members: [...group.members, picked] }
            : group,
        ) ?? current,
    )
    setPickedByGroup((current) => ({ ...current, [key]: "" }))
  }

  const dropGroup = (key: string) => {
    setPlan(
      (current) => current?.filter((group) => group.key !== key) ?? current,
    )
  }

  const handleApply = async () => {
    if (!plan || plan.length === 0 || issues.length > 0 || applying) return
    if (!creatorLogin) return
    setApplyError(null)
    setMemberWarnings([])
    setProgress({ current: 1, total: plan.length })

    // Capture names before the plan shrinks, so warnings can name the group.
    const nameByKey = new Map(
      plan.map((group, index) => [group.key, groupDisplayName(group, index)]),
    )
    const total = plan.length

    try {
      const result = await applyPlan.mutateAsync({
        plan,
        formation,
        creatorLogin,
        maxGroupSize,
        rosterLogins,
        onProgress: setProgress,
      })

      const warnings = result.memberWarnings.map((warning) => ({
        groupName: nameByKey.get(warning.key) ?? warning.key,
        username: warning.username,
        detail: errorText(t, warning.error),
      }))

      if (result.createFailure) {
        // Honest partial apply: the created groups leave the plan, the failed
        // one and everything after stay so a retry picks up where this ended.
        const createdKeys = new Set(result.created.map((c) => c.key))
        setPlan(
          (current) =>
            current?.filter((group) => !createdKeys.has(group.key)) ?? current,
        )
        setApplyError(
          t("manageGroups.copy.createFailed", {
            created: result.created.length,
            total,
            name: nameByKey.get(result.createFailure.key) ?? "",
            error: errorText(t, result.createFailure.error),
          }),
        )
        setMemberWarnings(warnings)
        return
      }

      if (warnings.length > 0) {
        // Every group exists; stay open so the teacher reads what to fix.
        setPlan([])
        setMemberWarnings(warnings)
        return
      }

      onClose()
    } catch (err) {
      setApplyError(errorText(t, err))
    } finally {
      setProgress(null)
    }
  }

  const planCount = plan?.length ?? 0
  const saveDisabled =
    applying || planCount === 0 || issues.length > 0 || !creatorLogin

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={applying}
      size="2xl"
      title={t("manageGroups.copy.title")}
      headerVisual={
        <ModalIcon tone="primary">
          <CopyIcon aria-hidden="true" className="size-4" />
        </ModalIcon>
      }
      footer={
        <>
          {progress && (
            <span
              className="me-auto text-sm text-base-content/70"
              role="status"
            >
              {t("manageGroups.copy.progress", {
                current: progress.current,
                total: progress.total,
              })}
            </span>
          )}
          <Button variant="ghost" disabled={applying} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={saveDisabled}
            loading={applying}
            loadingLabel={t("manageGroups.copy.saveButtonEmpty")}
            onClick={() => void handleApply()}
          >
            {planCount > 0
              ? t("manageGroups.copy.saveButton", { count: planCount })
              : t("manageGroups.copy.saveButtonEmpty")}
          </Button>
        </>
      }
    >
      <div className="mt-4 flex flex-col gap-4">
        {applyError && (
          <Alert tone="error" className="text-sm">
            {applyError}
          </Alert>
        )}
        {memberWarnings.length > 0 && (
          <Alert tone="warning" className="text-sm">
            <div>
              <p>{t("manageGroups.copy.memberWarningsIntro")}</p>
              <ul className="mt-1 list-disc ps-5">
                {memberWarnings.map((warning) => (
                  <li key={`${warning.groupName}-${warning.username}`}>
                    {t("manageGroups.copy.memberWarningItem", {
                      name: warning.groupName,
                      username: warning.username,
                      error: warning.detail,
                    })}
                  </li>
                ))}
              </ul>
            </div>
          </Alert>
        )}

        {sourceOptions.length === 0 ? (
          <EmptyState
            icon={CopyIcon}
            title={t("manageGroups.copy.noSources")}
            titleAs="h4"
            body={t("manageGroups.copy.noSourcesBody")}
          />
        ) : (
          <>
            <FormField
              label={t("manageGroups.copy.sourceLabel")}
              hint={t("manageGroups.copy.sourceHint")}
            >
              {({ id, describedById }) => (
                <Select
                  id={id}
                  aria-describedby={describedById}
                  className="w-auto"
                  value={sourceSlug}
                  disabled={applying}
                  onChange={(e) => changeSource(e.target.value)}
                >
                  <option value="">
                    {t("manageGroups.copy.sourcePlaceholder")}
                  </option>
                  {sourceOptions.map((option) => (
                    <option key={option.slug} value={option.slug}>
                      {option.name}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>

            {sourceLoading ? (
              <div className="flex py-8">
                <Spinner
                  className="m-auto"
                  label={t("manageGroups.copy.loadingGroups")}
                />
              </div>
            ) : plan !== null ? (
              plan.length === 0 ? (
                <p className="text-sm text-base-content/70">
                  {t(
                    sourceTeams.length === 0
                      ? "manageGroups.copy.sourceEmpty"
                      : "manageGroups.copy.emptyPlan",
                  )}
                </p>
              ) : (
                <section className="flex flex-col gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <Heading as="h4" variant="title-small">
                        {t("manageGroups.copy.planHeading")}
                      </Heading>
                      <Badge ghost size="sm">
                        {plan.length}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-base-content/70">
                      {t("manageGroups.copy.numberingNote")}
                    </p>
                    {existingGroupCount > 0 && (
                      <p className="mt-1 text-xs text-base-content/70">
                        {t("manageGroups.copy.existingNote", {
                          count: existingGroupCount,
                        })}
                      </p>
                    )}
                  </div>

                  <ul className="flex flex-col gap-3">
                    {plan.map((group, index) => {
                      const name = groupDisplayName(group, index)
                      const issue = issueByKey.get(group.key)
                      const takenSet = new Set(
                        (issue?.takenMembers ?? []).map((login) =>
                          login.toLowerCase(),
                        ),
                      )
                      const atCap =
                        maxGroupSize !== undefined &&
                        group.members.length >= maxGroupSize
                      return (
                        <li
                          key={group.key}
                          className="flex flex-col gap-2 rounded-box border border-base-200 p-4"
                        >
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate font-semibold">
                              {name}
                            </span>
                            <span className="shrink-0 text-xs text-base-content/70">
                              {maxGroupSize !== undefined
                                ? t("manageGroups.memberCountOfMax", {
                                    count: group.members.length,
                                    max: maxGroupSize,
                                  })
                                : t("manageGroups.memberCount", {
                                    count: group.members.length,
                                  })}
                            </span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="shrink-0 text-error"
                              disabled={applying}
                              aria-label={t(
                                "manageGroups.copy.dropGroupAriaLabel",
                                { name },
                              )}
                              onClick={() => dropGroup(group.key)}
                            >
                              <TrashIcon
                                aria-hidden="true"
                                className="size-4"
                              />
                              {t("manageGroups.copy.dropGroupButton")}
                            </Button>
                          </div>

                          {group.members.length === 0 ? (
                            <p className="text-sm text-base-content/60">
                              {t("manageGroups.noMembers")}
                            </p>
                          ) : (
                            <div className="flex flex-wrap gap-1.5">
                              {group.members.map((username) => {
                                const fullName = fullNameByLogin.get(
                                  username.toLowerCase(),
                                )
                                const taken = takenSet.has(
                                  username.toLowerCase(),
                                )
                                return (
                                  <span
                                    key={username}
                                    className={
                                      taken
                                        ? "flex items-center gap-1 rounded-full border border-error/60 bg-error/5 py-0.5 pe-1 ps-3 text-sm text-error"
                                        : // Info (blue) tint so student chips read
                                          // as people at a glance, distinct from
                                          // the neutral surfaces around them.
                                          "flex items-center gap-1 rounded-full border border-info/40 bg-info/10 py-0.5 pe-1 ps-3 text-sm"
                                    }
                                  >
                                    {fullName
                                      ? `${fullName} (${username})`
                                      : username}
                                    <Button
                                      variant="ghost"
                                      size="xs"
                                      shape="circle"
                                      className="text-base-content/60 hover:text-error"
                                      disabled={applying}
                                      aria-label={t(
                                        "manageGroups.copy.removeMemberAriaLabel",
                                        { username },
                                      )}
                                      onClick={() =>
                                        removeMember(group.key, username)
                                      }
                                    >
                                      <XIcon
                                        aria-hidden="true"
                                        className="size-3"
                                      />
                                    </Button>
                                  </span>
                                )
                              })}
                            </div>
                          )}

                          {issue?.overCapacity && (
                            <p className="text-xs text-error">
                              {t("manageGroups.copy.overCapacity", {
                                members: issue.overCapacity.count,
                                max: issue.overCapacity.max,
                              })}
                            </p>
                          )}
                          {issue?.takenMembers && (
                            <p className="text-xs text-error">
                              {t("manageGroups.copy.takenMembers", {
                                logins: issue.takenMembers.join(", "),
                              })}
                            </p>
                          )}

                          {atCap ? (
                            <p className="text-xs text-base-content/70">
                              {t("manageGroups.groupFull", {
                                max: maxGroupSize ?? 0,
                              })}
                            </p>
                          ) : (
                            <div className="flex items-center gap-2">
                              <Select
                                selectSize="sm"
                                className="max-w-xs flex-1"
                                value={pickedByGroup[group.key] ?? ""}
                                disabled={applying}
                                aria-label={t(
                                  "manageGroups.copy.addMemberAriaLabel",
                                  { name },
                                )}
                                onChange={(e) =>
                                  setPickedByGroup((current) => ({
                                    ...current,
                                    [group.key]: e.target.value,
                                  }))
                                }
                              >
                                <option value="">
                                  {t("manageGroups.addMemberPlaceholder")}
                                </option>
                                {pickerStudents.map((student) => (
                                  <option
                                    key={student.key}
                                    value={student.username}
                                  >
                                    {student.label}
                                  </option>
                                ))}
                              </Select>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={applying || !pickedByGroup[group.key]}
                                onClick={() => addMember(group.key)}
                              >
                                <PlusIcon
                                  aria-hidden="true"
                                  className="size-4"
                                />
                                {t("manageGroups.addMemberButton")}
                              </Button>
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            ) : null}
          </>
        )}
      </div>
    </Modal>
  )
}

export default CopyGroupsModal
