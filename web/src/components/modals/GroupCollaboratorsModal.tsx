import { useEffect, useId, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { Plus, Trash2, UsersRound } from "lucide-react"

import GitHub from "@/assets/github.svg?react"
import { Spinner } from "@/components/Spinner"
import {
  Alert,
  AnimatedAlert,
  Badge,
  Button,
  Input,
  Modal,
} from "@/components/ui"
import { useGithubAuth } from "@/auth/useGithubAuth"
import useGetRepo from "@/hooks/useGetRepo"
import useGetRepoCollaborators from "@/hooks/useGetRepoCollaborators"
import useAddRepoCollaborator from "@/hooks/mutations/useAddRepoCollaborator"
import useRemoveRepoCollaborator from "@/hooks/mutations/useRemoveRepoCollaborator"
import { getName } from "@/util/students"
import { GitHubAPIError } from "@/github-core/errors"
import type { Student } from "@/types/classroom"
import { GROUP_SIZE_MIN } from "@/types/classroom"

const normalizeUsername = (username: string) =>
  username.trim().replace(/^@/, "").toLowerCase()

// The usernames whose settled promise rejected, by index into the input list.
const rejectedItems = <T,>(
  results: PromiseSettledResult<unknown>[],
  items: T[],
): T[] =>
  results.flatMap((result, i) =>
    result.status === "rejected" ? [items[i]] : [],
  )

// Map a rejected add/remove to a human-readable reason. Collapsing every status
// into "bad username" would hide real causes like a 429 or a 403.
const describeFailure = (reason: unknown, t: TFunction): string | null => {
  if (reason instanceof GitHubAPIError) {
    if (reason.isRateLimited)
      return t("components.modals.groupCollaborators.failure.rateLimited")
    if (reason.status === 403)
      return t("components.modals.groupCollaborators.failure.forbidden")
    if (reason.status === 404)
      return t("components.modals.groupCollaborators.failure.notFound")
    if (reason.status === 422)
      return t("components.modals.groupCollaborators.failure.conflict")
    return reason.message
  }
  return reason instanceof Error ? reason.message : null
}

// Two-line identity when we have a roster name (name + @handle), else just the
// @handle. Shared by owner, member, and marked-for-removal rows.
const CollaboratorIdentity = ({
  login,
  students,
}: {
  login: string
  students: Student[]
}) => {
  const name = getName(login, students)
  return name ? (
    <>
      <span className="block truncate text-sm font-medium">{name}</span>
      <span className="block truncate font-mono text-xs text-base-content/70">
        @{login}
      </span>
    </>
  ) : (
    <span className="block truncate font-mono text-sm">@{login}</span>
  )
}

type GroupCollaboratorsModalProps = {
  open: boolean
  onClose: () => void
  org: string
  repoName: string
  // The founder, from the repo-name `owner` segment — never inferred from admin
  // permissions, since org owners hold admin on every repo.
  ownerLogin: string
  repoUrl?: string
  assignmentName?: string
  maxGroupSize?: number
  // Optional roster, to show full names alongside GitHub handles.
  students?: Student[]
}

export function GroupCollaboratorsModal({
  open,
  onClose,
  org,
  repoName,
  ownerLogin,
  repoUrl,
  assignmentName,
  maxGroupSize,
  students = [],
}: GroupCollaboratorsModalProps) {
  const titleId = useId()
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Synchronous re-entrancy guard: isSaving (mutation.isPending) updates a tick
  // late, so a rapid double-click could start two overlapping saves.
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

  const [draftCollaborators, setDraftCollaborators] = useState<string[]>([])
  const [newCollaborator, setNewCollaborator] = useState("")
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [invalidCollaborators, setInvalidCollaborators] = useState<Set<string>>(
    () => new Set(),
  )

  // max_group_size includes the owner, so the addable count is one less. Fall
  // back to the schema minimum so an unknown size never locks to owner-only.
  const maxCollaborators = Math.max((maxGroupSize ?? GROUP_SIZE_MIN) - 1, 0)

  const ownerLoginResolved = normalizeUsername(ownerLogin)

  // Manage access = founder, or admin on this repo. We read the viewer's
  // effective permission from the repo object (which includes inherited
  // org-owner admin) rather than the affiliation=direct collaborator list, which
  // omits inherited access and would lock out org-owner teachers.
  const { data: repo } = useGetRepo(org, repoName, { enabled: open })
  const viewerLogin = user?.login ? normalizeUsername(user.login) : null
  const canManage = Boolean(
    viewerLogin &&
    (viewerLogin === ownerLoginResolved || repo?.permissions?.admin === true),
  )

  // Direct collaborators except the founder.
  const initialCollaborators = useMemo(
    () =>
      collaborators
        ?.map((c) => normalizeUsername(c.login))
        .filter((login) => login && login !== ownerLoginResolved) ?? [],
    [collaborators, ownerLoginResolved],
  )

  // Seed the draft once per open and per repo change (the teacher table reuses
  // one modal across groups). Keying on open+repoName — not the collaborators
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
    setDraftCollaborators(initialCollaborators)
  }, [open, repoName, loadingCollaborators, initialCollaborators])

  useEffect(() => {
    if (!open) {
      setNewCollaborator("")
      setSubmitError(null)
      setSaved(false)
      setInvalidCollaborators(new Set())
    }
  }, [open])

  useEffect(
    () => () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    },
    [],
  )

  const clearInvalidCollaborator = (username: string) => {
    const normalized = normalizeUsername(username)
    setInvalidCollaborators((current) => {
      if (!current.has(normalized)) return current
      const next = new Set(current)
      next.delete(normalized)
      return next
    })
  }

  const addPendingUsername = () => {
    const username = normalizeUsername(newCollaborator)
    if (!username) return

    if (draftCollaborators.map(normalizeUsername).includes(username)) {
      setNewCollaborator("")
      return
    }

    clearInvalidCollaborator(username)
    setDraftCollaborators((current) => [...current, username])
    setNewCollaborator("")
  }

  const tooMany = draftCollaborators.length > maxCollaborators
  const isFull = draftCollaborators.length >= maxCollaborators
  const hasDuplicates =
    new Set(draftCollaborators.map(normalizeUsername)).size !==
    draftCollaborators.length

  const isSaving =
    addCollaboratorMutation.isPending || removeCollaboratorMutation.isPending

  // Dropped from the draft but still a live collaborator: removed only on Save,
  // restorable via undo until then.
  const draftSet = useMemo(
    () => new Set(draftCollaborators.map(normalizeUsername)),
    [draftCollaborators],
  )
  const markedForRemoval = useMemo(
    () => initialCollaborators.filter((login) => !draftSet.has(login)),
    [initialCollaborators, draftSet],
  )
  const hasChanges =
    markedForRemoval.length > 0 ||
    draftCollaborators.some(
      (login) => !initialCollaborators.includes(normalizeUsername(login)),
    )

  const removeFromDraft = (username: string) => {
    clearInvalidCollaborator(username)
    setDraftCollaborators((current) =>
      current.filter(
        (entry) => normalizeUsername(entry) !== normalizeUsername(username),
      ),
    )
  }

  const restoreToDraft = (username: string) => {
    clearInvalidCollaborator(username)
    setDraftCollaborators((current) =>
      current.map(normalizeUsername).includes(normalizeUsername(username))
        ? current
        : [...current, username],
    )
  }

  const discardChanges = () => {
    setInvalidCollaborators(new Set())
    setSubmitError(null)
    setNewCollaborator("")
    setDraftCollaborators(initialCollaborators)
  }

  const handleSave = async () => {
    if (tooMany || hasDuplicates || isSaving || savingRef.current) return
    savingRef.current = true

    try {
      setSubmitError(null)
      setInvalidCollaborators(new Set())
      setSaved(false)

      const next = draftCollaborators.map(normalizeUsername).filter(Boolean)
      const previous = new Set(initialCollaborators)
      const nextSet = new Set(next)

      const toAdd = [...nextSet].filter((username) => !previous.has(username))
      const toRemove = [...previous].filter(
        (username) => !nextSet.has(username),
      )

      // Remove before add so a swap at max group size frees a slot first.
      const removeResults = await Promise.allSettled(
        toRemove.map(async (username) => {
          await removeCollaboratorMutation.mutateAsync({
            org,
            repo: repoName,
            username,
          })
          return username
        }),
      )

      const failedRemoves = rejectedItems(removeResults, toRemove)

      // A failed remove keeps its slot, so cap adds at remaining capacity —
      // else a swap at max size would push GitHub to max+1.
      const succeededRemoves = toRemove.length - failedRemoves.length
      const liveCount = initialCollaborators.length - succeededRemoves
      const capacity = Math.max(maxCollaborators - liveCount, 0)
      const addable = toAdd.slice(0, capacity)
      const blockedByCapacity = toAdd.slice(capacity)

      const addResults = await Promise.allSettled(
        addable.map(async (username) => {
          await addCollaboratorMutation.mutateAsync({
            org,
            repo: repoName,
            username,
            permission: "push",
          })
          return username
        }),
      )

      const failedAdds = [
        ...rejectedItems(addResults, addable),
        ...blockedByCapacity,
      ]

      if (failedAdds.length || failedRemoves.length) {
        // Highlight everything still needing action: failed/blocked adds and
        // failed removes.
        setInvalidCollaborators(
          new Set([...failedAdds, ...failedRemoves].map(normalizeUsername)),
        )

        const firstReason =
          [...addResults, ...removeResults].find(
            (r) => r.status === "rejected",
          ) ?? null
        const detail =
          firstReason && firstReason.status === "rejected"
            ? describeFailure(firstReason.reason, t)
            : null
        const suffix = detail ? ` ${detail}` : ""

        // Name what changed so a partial apply isn't read as a full save.
        const removedNote = succeededRemoves
          ? ` ${t("components.modals.groupCollaborators.removedNote", { count: succeededRemoves })}`
          : ""

        if (failedAdds.length && failedRemoves.length) {
          setSubmitError(
            t("components.modals.groupCollaborators.error.addAndRemove", {
              removedNote,
              suffix,
            }),
          )
        } else if (failedAdds.length) {
          setSubmitError(
            t("components.modals.groupCollaborators.error.add", {
              removedNote,
              suffix,
            }),
          )
        } else {
          setSubmitError(
            t("components.modals.groupCollaborators.error.remove", {
              removedNote,
              suffix,
            }),
          )
        }

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

  // Prefer the roster/collaborator casing of the owner login for display.
  const ownerDisplayLogin =
    collaborators?.find(
      (c) => normalizeUsername(c.login) === ownerLoginResolved,
    )?.login ?? ownerLogin

  const personCount = draftCollaborators.length + (ownerDisplayLogin ? 1 : 0)

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={isSaving}
      size="xl"
      aria-labelledby={titleId}
    >
      <div className="flex items-start gap-4">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <UsersRound className="size-5" aria-hidden="true" />
        </div>

        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-lg font-bold">
            {assignmentName || t("components.modals.groupCollaborators.title")}
          </h3>
          {repoName && (
            <a
              className="link mt-1 inline-flex items-center gap-1.5 text-sm"
              href={repoUrl || `https://github.com/${org}/${repoName}`}
              target="_blank"
              rel="noreferrer"
            >
              <GitHub aria-hidden="true" className="size-4" />
              {t("components.modals.groupCollaborators.viewRepository")}
            </a>
          )}
        </div>
      </div>

      {loadingCollaborators ? (
        <div className="flex py-10">
          <Spinner
            className="m-auto"
            label={t("components.modals.groupCollaborators.loading")}
          />
        </div>
      ) : (
        <>
          <AnimatedAlert tone="success" show={saved} className="mt-4 text-sm">
            {t("components.modals.groupCollaborators.saved")}
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
              {t("components.modals.groupCollaborators.onlyOwner_prefix")}
              {ownerDisplayLogin ? (
                <>
                  {" "}
                  (<span className="font-mono">{ownerDisplayLogin}</span>)
                </>
              ) : null}{" "}
              {t("components.modals.groupCollaborators.onlyOwner_suffix")}
            </Alert>
          )}

          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between gap-4">
              <span className="text-sm font-medium">
                {t("components.modals.groupCollaborators.groupMembers")}
              </span>
              <span className="text-xs text-base-content/70">
                {t("components.modals.groupCollaborators.personCount", {
                  count: personCount,
                })}
              </span>
            </div>

            {/* One bordered list for owner + members + pending removals, so it
                  reads as a single roster rather than stacked cards. */}
            <ul className="divide-y divide-base-200 rounded-2xl border border-base-200">
              {ownerDisplayLogin && (
                <li className="flex items-center gap-3 px-4 py-2.5">
                  <GitHub
                    aria-hidden="true"
                    className="size-5 shrink-0 text-base-content/70"
                  />
                  <span className="min-w-0 flex-1 leading-tight">
                    <CollaboratorIdentity
                      login={ownerDisplayLogin}
                      students={students}
                    />
                  </span>
                  <Badge tone="primary">
                    {t("components.modals.groupCollaborators.ownerBadge")}
                  </Badge>
                </li>
              )}

              {draftCollaborators.map((username) => {
                const normalized = normalizeUsername(username)
                const isInvalid = invalidCollaborators.has(normalized)

                return (
                  <li
                    key={username}
                    className={[
                      "flex items-center gap-3 px-4 py-2.5",
                      isInvalid ? "bg-error/5" : "",
                    ].join(" ")}
                  >
                    <GitHub
                      aria-hidden="true"
                      className={[
                        "size-5 shrink-0",
                        isInvalid ? "text-error" : "text-base-content/70",
                      ].join(" ")}
                    />
                    <span className="min-w-0 flex-1 leading-tight">
                      <CollaboratorIdentity
                        login={username}
                        students={students}
                      />
                      {isInvalid && (
                        <span className="mt-0.5 block text-xs text-error">
                          {t("components.modals.groupCollaborators.couldntAdd")}
                        </span>
                      )}
                    </span>
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="sm"
                        shape="square"
                        className="text-base-content/70 hover:text-error"
                        aria-label={t(
                          "components.modals.groupCollaborators.removeUser",
                          { username },
                        )}
                        onClick={() => removeFromDraft(username)}
                      >
                        <Trash2 aria-hidden="true" className="size-4" />
                      </Button>
                    )}
                  </li>
                )
              })}

              {markedForRemoval.map((username) => {
                const failedToRemove = invalidCollaborators.has(
                  normalizeUsername(username),
                )
                return (
                  <li
                    key={`remove-${username}`}
                    className="flex items-center gap-3 bg-error/5 px-4 py-2.5"
                  >
                    <GitHub
                      aria-hidden="true"
                      className="size-5 shrink-0 text-error/50"
                    />
                    <span className="min-w-0 flex-1 leading-tight text-error line-through opacity-70">
                      <CollaboratorIdentity
                        login={username}
                        students={students}
                      />
                    </span>
                    <span className="text-xs font-medium text-error/70">
                      {failedToRemove
                        ? t(
                            "components.modals.groupCollaborators.couldntRemove",
                          )
                        : t("components.modals.groupCollaborators.removing")}
                    </span>
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-error"
                        onClick={() => restoreToDraft(username)}
                      >
                        {t("components.modals.groupCollaborators.undo")}
                      </Button>
                    )}
                  </li>
                )
              })}

              {draftCollaborators.length === 0 &&
                markedForRemoval.length === 0 && (
                  <li className="px-4 py-6 text-center text-sm text-base-content/70">
                    {t("components.modals.groupCollaborators.noCollaborators")}
                  </li>
                )}
            </ul>

            {tooMany && (
              <p className="mt-2 text-sm text-error">
                {t("components.modals.groupCollaborators.tooMany", {
                  max: maxGroupSize ?? 1,
                })}
              </p>
            )}
            {hasDuplicates && (
              <p className="mt-2 text-sm text-error">
                {t("components.modals.groupCollaborators.mustBeUnique")}
              </p>
            )}

            {canManage && !isFull && (
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
                      addPendingUsername()
                    }
                  }}
                />
                <Button variant="outline" onClick={addPendingUsername}>
                  <Plus aria-hidden="true" className="size-4" />
                  {t("components.modals.groupCollaborators.add")}
                </Button>
              </div>
            )}

            {canManage && isFull && (
              <p className="mt-3 text-xs text-base-content/70">
                {t("components.modals.groupCollaborators.groupFull")}
              </p>
            )}
          </div>
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
            disabled={
              loadingCollaborators ||
              isSaving ||
              tooMany ||
              hasDuplicates ||
              !hasChanges
            }
            loading={isSaving}
            loadingLabel={t(
              "components.modals.groupCollaborators.saveCollaborators",
            )}
            onClick={() => void handleSave()}
          >
            {t("components.modals.groupCollaborators.saveCollaborators")}
          </Button>
        )}
      </div>
    </Modal>
  )
}
