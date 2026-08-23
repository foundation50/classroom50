import { useEffect, useId, useMemo, useRef, useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { Plus, Trash2, ShieldCheck } from "lucide-react"

import GitHub from "@/assets/github.svg?react"
import { Spinner } from "@/components/Spinner"
import {
  Alert,
  AnimatedAlert,
  Badge,
  Button,
  Input,
  Modal,
  Select,
} from "@/components/ui"
import { useGithubAuth } from "@/auth/useGithubAuth"
import useGetRepo from "@/hooks/useGetRepo"
import useGetRepoCollaborators from "@/hooks/useGetRepoCollaborators"
import useAddRepoCollaborator from "@/hooks/mutations/useAddRepoCollaborator"
import useRemoveRepoCollaborator from "@/hooks/mutations/useRemoveRepoCollaborator"
import {
  CollaboratorIdentity,
  describeGitHubApiFailure,
  normalizeUsername,
  permissionFromFlags,
  rejectedItems,
} from "@/components/modals/collaboratorHelpers"
import { permissionSatisfies } from "@/domain/assignments/permissions"
import { GitHubAPIError } from "@/github-core/errors"
import type { RepoPermission, Student } from "@/types/classroom"
import { REPO_PERMISSIONS } from "@/types/classroom"

// A collaborator PUT that returned 204 but whose read-back didn't land on the
// requested role — GitHub silently ignored the write (typically a downgrade it
// won't apply to a repo creator, leaving residual admin). Carried so handleSave
// can flag the row and explain the effective role that stuck.
class RepoAccessNotAppliedError extends Error {
  readonly login: string
  readonly requested: RepoPermission
  readonly effective: string | undefined
  constructor(
    login: string,
    requested: RepoPermission,
    effective: string | undefined,
  ) {
    super(`access for ${login} not applied (still ${effective ?? "unchanged"})`)
    this.name = "RepoAccessNotAppliedError"
    this.login = login
    this.requested = requested
    this.effective = effective
  }
}

// Map a rejected write to a human reason; reuses the groupCollaborators failure
// vocabulary so the two dialogs stay consistent.
const describeFailure = (reason: unknown, t: TFunction): string | null => {
  if (reason instanceof RepoAccessNotAppliedError) {
    return t("components.modals.repoAccess.notApplied", {
      effective: reason.effective ?? "unknown",
    })
  }
  const shared = describeGitHubApiFailure(reason, t)
  if (shared) return shared
  if (reason instanceof GitHubAPIError) {
    if (reason.status === 422)
      return t("components.modals.groupCollaborators.failure.conflict")
    return reason.message
  }
  return reason instanceof Error ? reason.message : null
}

// One row's draft state: its target role, and whether it's staged for removal.
type DraftEntry = {
  login: string
  permission: RepoPermission
  markedForRemoval: boolean
  // True for collaborators queued via the add box (not yet on the server).
  isNew: boolean
}

type RepoAccessModalProps = {
  open: boolean
  onClose: () => void
  org: string
  repoName: string
  // The enrolled student, from the repo-name `owner` segment (never inferred
  // from admin permissions, since org owners hold admin on every repo).
  ownerLogin: string
  repoUrl?: string
  assignmentName?: string
  // Optional roster, to show full names alongside GitHub handles.
  students?: Student[]
}

// Teacher-facing per-repo access editor: change the enrolled student's role and
// add/remove arbitrary collaborators on one assignment repo. Sibling of
// GroupCollaboratorsModal (which is founder-facing and size-capped); this one
// is gated on the viewer's repo-admin and carries a per-row permission picker.
export function RepoAccessModal({
  open,
  onClose,
  org,
  repoName,
  ownerLogin,
  repoUrl,
  assignmentName,
  students = [],
}: RepoAccessModalProps) {
  const titleId = useId()
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savingRef = useRef(false)
  const { user } = useGithubAuth()
  const { t } = useTranslation()

  const {
    data: collaborators,
    isLoading: loadingCollaborators,
    refetch: refetchCollaborators,
  } = useGetRepoCollaborators(org, repoName, { enabled: open })

  const addCollaboratorMutation = useAddRepoCollaborator()
  const removeCollaboratorMutation = useRemoveRepoCollaborator()

  const [draft, setDraft] = useState<DraftEntry[]>([])
  const [newCollaborator, setNewCollaborator] = useState("")
  const [newPermission, setNewPermission] = useState<RepoPermission>("push")
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [invalidLogins, setInvalidLogins] = useState<Set<string>>(
    () => new Set(),
  )

  const ownerLoginResolved = normalizeUsername(ownerLogin)

  // Manage access = repo admin (the viewer's effective permission, including
  // inherited org-owner admin). Read from the repo object, not the
  // affiliation=direct list, which omits inherited access.
  const { data: repo } = useGetRepo(org, repoName, { enabled: open })
  const viewerLogin = user?.login ? normalizeUsername(user.login) : null
  const canManage = Boolean(viewerLogin && repo?.permissions?.admin === true)

  // The server's current state, normalized. The owner sorts first.
  const initialEntries = useMemo<DraftEntry[]>(() => {
    const rows = (collaborators ?? []).map((c) => ({
      login: normalizeUsername(c.login),
      permission: permissionFromFlags(c.permissions),
      markedForRemoval: false,
      isNew: false,
    }))
    rows.sort((a, b) => {
      if (a.login === ownerLoginResolved) return -1
      if (b.login === ownerLoginResolved) return 1
      return a.login.localeCompare(b.login)
    })
    return rows
  }, [collaborators, ownerLoginResolved])

  const initialByLogin = useMemo(() => {
    const map = new Map<string, RepoPermission>()
    for (const e of initialEntries) map.set(e.login, e.permission)
    return map
  }, [initialEntries])

  // Seed the draft once per open and per repo change (the teacher table reuses
  // one modal across rows). Keying on open+repoName — not the collaborators
  // identity — stops a background refetch from clobbering unsaved edits.
  const seededKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!open) {
      seededKeyRef.current = null
      return
    }
    if (loadingCollaborators) return
    if (seededKeyRef.current === repoName) return
    seededKeyRef.current = repoName
    setDraft(initialEntries)
  }, [open, repoName, loadingCollaborators, initialEntries])

  useEffect(() => {
    if (!open) {
      setNewCollaborator("")
      setNewPermission("push")
      setSubmitError(null)
      setSaved(false)
      setInvalidLogins(new Set())
    }
  }, [open])

  useEffect(
    () => () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    },
    [],
  )

  const clearInvalid = (login: string) => {
    const normalized = normalizeUsername(login)
    setInvalidLogins((current) => {
      if (!current.has(normalized)) return current
      const next = new Set(current)
      next.delete(normalized)
      return next
    })
  }

  const setPermission = (login: string, permission: RepoPermission) => {
    setDraft((current) =>
      current.map((e) => (e.login === login ? { ...e, permission } : e)),
    )
  }

  const markRemoval = (login: string, removed: boolean) => {
    clearInvalid(login)
    setDraft((current) =>
      // A queued (new) row is dropped outright; a server row is struck through.
      removed
        ? current.flatMap((e) =>
            e.login === login
              ? e.isNew
                ? []
                : [{ ...e, markedForRemoval: true }]
              : [e],
          )
        : current.map((e) =>
            e.login === login ? { ...e, markedForRemoval: false } : e,
          ),
    )
  }

  const addPending = () => {
    const login = normalizeUsername(newCollaborator)
    if (!login) return
    const existing = draft.find((e) => e.login === login)
    if (existing) {
      // Re-adding a struck-through collaborator restores it at the new level.
      setDraft((current) =>
        current.map((e) =>
          e.login === login
            ? { ...e, markedForRemoval: false, permission: newPermission }
            : e,
        ),
      )
      setNewCollaborator("")
      return
    }
    clearInvalid(login)
    setDraft((current) => [
      ...current,
      {
        login,
        permission: newPermission,
        markedForRemoval: false,
        isNew: true,
      },
    ])
    setNewCollaborator("")
  }

  const isSaving =
    addCollaboratorMutation.isPending || removeCollaboratorMutation.isPending

  // A change is: a new/restored collaborator, a struck-through server row, or a
  // permission level that differs from the server's.
  const hasChanges = useMemo(
    () =>
      draft.some((e) => {
        if (e.isNew) return true
        if (e.markedForRemoval) return true
        return initialByLogin.get(e.login) !== e.permission
      }),
    [draft, initialByLogin],
  )

  const discardChanges = () => {
    setInvalidLogins(new Set())
    setSubmitError(null)
    setNewCollaborator("")
    setNewPermission("push")
    setDraft(initialEntries)
  }

  const handleSave = async () => {
    if (isSaving || savingRef.current) return
    savingRef.current = true
    try {
      setSubmitError(null)
      setInvalidLogins(new Set())
      setSaved(false)

      const toRemove = draft
        .filter((e) => e.markedForRemoval && !e.isNew)
        .map((e) => e.login)
      // Adds AND level changes are the same PUT upsert.
      const toUpsert = draft.filter(
        (e) =>
          !e.markedForRemoval &&
          (e.isNew || initialByLogin.get(e.login) !== e.permission),
      )

      const removeResults = await Promise.allSettled(
        toRemove.map(async (login) => {
          await removeCollaboratorMutation.mutateAsync({
            org,
            repo: repoName,
            username: login,
          })
          return login
        }),
      )

      const upsertResults = await Promise.allSettled(
        toUpsert.map(async (entry) => {
          const isEnrolledStudent = entry.login === ownerLoginResolved
          const { effective } = await addCollaboratorMutation.mutateAsync({
            org,
            repo: repoName,
            username: entry.login,
            permission: entry.permission,
            verify: true,
          })
          // The enrolled student is an org member, so GitHub honors the direct
          // grant exactly — a mismatch means the write was silently ignored
          // (e.g. a downgrade below a lingering creator/base admin), the exact
          // over-access an intended lockdown must catch. An arbitrary added
          // collaborator only needs the grant to take (>= is enough), so treat
          // that read-back with owner-style tolerance.
          if (
            effective &&
            !permissionSatisfies(
              effective.permission,
              effective.role_name,
              entry.permission,
              !isEnrolledStudent,
            )
          ) {
            throw new RepoAccessNotAppliedError(
              entry.login,
              entry.permission,
              effective.role_name || effective.permission,
            )
          }
          return entry.login
        }),
      )

      const failedRemoves = rejectedItems(removeResults, toRemove)
      const failedUpserts = rejectedItems(
        upsertResults,
        toUpsert.map((e) => e.login),
      )

      if (failedRemoves.length || failedUpserts.length) {
        setInvalidLogins(
          new Set([...failedRemoves, ...failedUpserts].map(normalizeUsername)),
        )
        const firstReason =
          [...upsertResults, ...removeResults].find(
            (r) => r.status === "rejected",
          ) ?? null
        const detail =
          firstReason && firstReason.status === "rejected"
            ? describeFailure(firstReason.reason, t)
            : null
        setSubmitError(
          t("components.modals.repoAccess.saveError", {
            suffix: detail ? ` ${detail}` : "",
          }),
        )
        await refetchCollaborators()
        return
      }

      await refetchCollaborators()
      setSaved(true)
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
      savedTimerRef.current = setTimeout(() => setSaved(false), 3000)
    } finally {
      savingRef.current = false
    }
  }

  const permissionLabel = (level: RepoPermission) =>
    t(`assignments.form.studentPermission.levels.${level}`)

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={isSaving}
      size="xl"
      aria-labelledby={titleId}
    >
      <div className="flex items-start gap-4">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-box bg-primary/10 text-primary">
          <ShieldCheck className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-lg font-bold">
            {t("components.modals.repoAccess.title")}
          </h3>
          {repoName && (
            <a
              className="link mt-1 inline-flex items-center gap-1.5 text-sm"
              href={repoUrl || `https://github.com/${org}/${repoName}`}
              target="_blank"
              rel="noreferrer"
            >
              <GitHub aria-hidden="true" className="size-4" />
              {assignmentName
                ? t("components.modals.repoAccess.viewRepoNamed", {
                    name: assignmentName,
                  })
                : t("components.modals.groupCollaborators.viewRepository")}
            </a>
          )}
        </div>
      </div>

      {loadingCollaborators ? (
        <div className="flex py-10">
          <Spinner
            className="m-auto"
            label={t("components.modals.repoAccess.loading")}
          />
        </div>
      ) : (
        <>
          <AnimatedAlert tone="success" show={saved} className="mt-4 text-sm">
            {t("components.modals.repoAccess.saved")}
          </AnimatedAlert>
          <AnimatedAlert
            tone="error"
            show={!!submitError}
            className="mt-4 text-sm"
          >
            {submitError}
          </AnimatedAlert>

          {!canManage && (
            <Alert tone="error" className="mt-4 text-sm">
              {t("components.modals.repoAccess.needsAdmin")}
            </Alert>
          )}

          <p className="mt-4 text-sm text-base-content/70">
            <Trans
              i18nKey="components.modals.repoAccess.adminWarning"
              components={{ b: <span className="font-semibold" /> }}
            />
          </p>

          <ul className="mt-3 divide-y divide-base-200 rounded-box border border-base-200">
            {draft.map((entry) => {
              const isOwner = entry.login === ownerLoginResolved
              const isInvalid = invalidLogins.has(entry.login)
              return (
                <li
                  key={entry.login}
                  className={[
                    "flex items-center gap-3 px-4 py-2.5",
                    isInvalid ? "bg-error/5" : "",
                    entry.markedForRemoval ? "bg-error/5" : "",
                  ].join(" ")}
                >
                  <GitHub
                    aria-hidden="true"
                    className={[
                      "size-5 shrink-0",
                      isInvalid ? "text-error" : "text-base-content/70",
                    ].join(" ")}
                  />
                  <span
                    className={[
                      "min-w-0 flex-1 leading-tight",
                      entry.markedForRemoval
                        ? "text-error line-through opacity-70"
                        : "",
                    ].join(" ")}
                  >
                    <CollaboratorIdentity
                      login={entry.login}
                      students={students}
                    />
                  </span>
                  {isOwner && (
                    <Badge tone="primary">
                      {t("components.modals.repoAccess.studentBadge")}
                    </Badge>
                  )}
                  {!entry.markedForRemoval && (
                    <Select
                      selectSize="sm"
                      className="w-auto"
                      disabled={!canManage}
                      aria-label={t("components.modals.repoAccess.roleFor", {
                        username: entry.login,
                      })}
                      value={entry.permission}
                      onChange={(e) =>
                        setPermission(
                          entry.login,
                          e.target.value as RepoPermission,
                        )
                      }
                    >
                      {REPO_PERMISSIONS.map((level) => (
                        <option key={level} value={level}>
                          {permissionLabel(level)}
                        </option>
                      ))}
                    </Select>
                  )}
                  {/* Removing the enrolled student would orphan them from
                      their own submission; only their role can change. */}
                  {canManage && !isOwner && !entry.markedForRemoval && (
                    <Button
                      variant="ghost"
                      size="sm"
                      shape="square"
                      className="text-base-content/70 hover:text-error"
                      aria-label={t("components.modals.repoAccess.removeUser", {
                        username: entry.login,
                      })}
                      onClick={() => markRemoval(entry.login, true)}
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                    </Button>
                  )}
                  {canManage && entry.markedForRemoval && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-error"
                      onClick={() => markRemoval(entry.login, false)}
                    >
                      {t("components.modals.groupCollaborators.undo")}
                    </Button>
                  )}
                </li>
              )
            })}

            {draft.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-base-content/70">
                {t("components.modals.groupCollaborators.noCollaborators")}
              </li>
            )}
          </ul>

          {canManage && (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <Input
                className="flex-1"
                placeholder={t(
                  "components.modals.groupCollaborators.addPlaceholder",
                )}
                aria-label={t(
                  "components.modals.groupCollaborators.addAriaLabel",
                )}
                value={newCollaborator}
                onChange={(e) => setNewCollaborator(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    addPending()
                  }
                }}
              />
              <Select
                selectSize="md"
                className="w-auto"
                aria-label={t("components.modals.repoAccess.newRole")}
                value={newPermission}
                onChange={(e) =>
                  setNewPermission(e.target.value as RepoPermission)
                }
              >
                {REPO_PERMISSIONS.map((level) => (
                  <option key={level} value={level}>
                    {permissionLabel(level)}
                  </option>
                ))}
              </Select>
              <Button variant="outline" onClick={addPending}>
                <Plus aria-hidden="true" className="size-4" />
                {t("components.modals.groupCollaborators.add")}
              </Button>
            </div>
          )}
        </>
      )}

      <div className="modal-action">
        <Button variant="ghost" disabled={isSaving} onClick={() => onClose()}>
          {t("common.cancel")}
        </Button>
        {canManage && hasChanges && (
          <Button variant="ghost" disabled={isSaving} onClick={discardChanges}>
            {t("components.modals.groupCollaborators.discardChanges")}
          </Button>
        )}
        {canManage && (
          <Button
            variant="primary"
            disabled={loadingCollaborators || isSaving || !hasChanges}
            loading={isSaving}
            loadingLabel={t("components.modals.repoAccess.save")}
            onClick={() => void handleSave()}
          >
            {t("components.modals.repoAccess.save")}
          </Button>
        )}
      </div>
    </Modal>
  )
}

export default RepoAccessModal
