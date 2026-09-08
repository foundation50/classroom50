import { useMemo, useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useCanAttemptTemplateGrant } from "@/context/githubOrgRole/useIsOrgOwner"
import { invalidateAssignments } from "@/github-core/queries"
import {
  copyAssignmentWithConflictRetry,
  type CopyAssignmentInput,
} from "@/domain/assignments"
import { planBulkReuseSlugs } from "@/util/bulkReuseSlugs"
import type { Assignment } from "@/types/classroom"

type UseReuseAssignmentParams = {
  org: string
  // Where the copy lands (a sibling classroom for push, the current one for
  // pull). Its assignments.json is invalidated on success.
  targetClassroom: string
  // The source assignment, or null until one is chosen (pull selects it).
  source: Assignment | null
  // Existing slugs in the target, for the auto-suffix + collision check.
  takenSlugs: string[]
  // Pre-rename slugs (Assignment.renamed_from) reserved in the target; the
  // auto-suffix dodges them and a manual match is blocked.
  reservedSlugs: string[]
  // Blocks submit while the target's assignments load, so a collision can't be
  // missed against an empty taken-set.
  takenLoading: boolean
  // Modal owns the <dialog> ref and passes the closer in, so this hook never
  // touches a ref during render.
  closeDialog: () => void
}

// Shared reuse machinery for both modals: the derived slug (auto-suffixed
// default + optimistic case-insensitive collision check) and the copy mutation
// with its success/grant-warning handling. Ref-free — each modal owns its own
// <dialog> and direction-specific selectors.
export function useReuseAssignment({
  org,
  targetClassroom,
  source,
  takenSlugs,
  reservedSlugs,
  takenLoading,
  closeDialog,
}: UseReuseAssignmentParams) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  // Attempt the owner-only template read-grant unless the org role is a
  // CONFIRMED non-owner (see useCanAttemptTemplateGrant).
  const canGrantTemplateAccess = useCanAttemptTemplateGrant()

  const [slugInput, setSlugInput] = useState("")
  const [slugTouched, setSlugTouched] = useState(false)
  const [warning, setWarning] = useState<string | null>(null)

  // One source through the shared planner (util/bulkReuseSlugs). Derived, not
  // state, so it stays correct as the target's assignments load; the write path
  // re-checks authoritatively.
  const plan = useMemo(
    () =>
      planBulkReuseSlugs({
        sources: source ? [source] : [],
        targetClassroom,
        takenSlugs,
        reservedSlugs,
        edits: source && slugTouched ? { [source.slug]: slugInput } : {},
      }),
    [
      source,
      targetClassroom,
      takenSlugs,
      reservedSlugs,
      slugTouched,
      slugInput,
    ],
  )
  const row = plan.rows[0]
  const slugBudget = plan.budget

  // Default until the teacher edits; `normalizedSlug` is what gets saved.
  const displayedSlug = row?.value ?? ""
  const normalizedSlug = row?.targetSlug ?? ""
  const slugOverBudget = row?.issue === "overBudget"
  const slugTaken = row?.issue === "taken"
  // A renamed assignment's old slug is reserved: a new assignment there would
  // sever GitHub's redirects for its renamed student repos.
  const slugReserved = row?.issue === "reserved"

  // Synchronous re-entrancy guard: reuse.isPending updates a tick late, so a
  // rapid double-click could start two overlapping copy commits.
  const submittingRef = useRef(false)

  const reuse = useMutation({
    meta: { keepTabOpen: true },
    mutationFn: (input: CopyAssignmentInput) =>
      copyAssignmentWithConflictRetry(client, input),
    onSuccess: (result) => {
      invalidateAssignments(queryClient, org, targetClassroom)
      // A template-grant failure doesn't fail the copy — surface it and keep
      // the modal open; otherwise close.
      if (result.templateGrantWarning) {
        setWarning(result.templateGrantWarning)
      } else {
        closeDialog()
      }
    },
    onSettled: () => {
      submittingRef.current = false
    },
  })

  // Re-arm the auto-suffix default (e.g., after switching target/source); the
  // next render derives a fresh default from the new taken-set.
  const resetSlug = () => {
    setSlugInput("")
    setSlugTouched(false)
    setWarning(null)
  }

  const canSubmit =
    Boolean(source) &&
    Boolean(targetClassroom) &&
    Boolean(normalizedSlug) &&
    !slugTaken &&
    !slugReserved &&
    !slugOverBudget &&
    !takenLoading &&
    !reuse.isPending

  const submit = () => {
    if (!source || !canSubmit || submittingRef.current) return
    submittingRef.current = true
    setWarning(null)
    reuse.mutate({
      org,
      source,
      targetClassroom,
      targetSlug: normalizedSlug,
      canGrantTemplateAccess,
    })
  }

  const errorMessage =
    reuse.isError && reuse.error instanceof Error
      ? reuse.error.message
      : reuse.isError
        ? "Something went wrong copying the assignment."
        : null

  return {
    displayedSlug,
    normalizedSlug,
    slugTouched,
    slugTaken,
    slugReserved,
    slugOverBudget,
    slugBudget,
    warning,
    errorMessage,
    isPending: reuse.isPending,
    canSubmit,
    onSlugChange: (value: string) => {
      setSlugInput(value)
      setSlugTouched(true)
    },
    onSlugBlur: () => {
      setSlugInput(normalizedSlug)
      setSlugTouched(true)
    },
    resetSlug,
    submit,
  }
}
