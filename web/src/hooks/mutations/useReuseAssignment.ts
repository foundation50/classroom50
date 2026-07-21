import { useMemo, useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useCanAttemptTemplateGrant } from "@/context/githubOrgRole/useIsOrgOwner"
import { githubKeys } from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"
import {
  copyAssignmentWithConflictRetry,
  nextAvailableSlug,
  type CopyAssignmentInput,
} from "@/domain/assignments"
import { slugify } from "@/util/slug"
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

  // Auto-suffixed default ("hw1" -> "hw1-2" if taken). Derived, not state, so it
  // stays correct as the target's assignments load.
  const autoSlug = useMemo(
    () => (source ? nextAvailableSlug(slugify(source.slug), takenSlugs) : ""),
    [source, takenSlugs],
  )

  // Default until the teacher edits; `normalizedSlug` is what gets saved.
  const displayedSlug = slugTouched ? slugInput : autoSlug
  const normalizedSlug = slugify(displayedSlug)

  // Optimistic, case-insensitive check; the write path re-checks authoritatively.
  const slugTaken = useMemo(() => {
    if (!normalizedSlug) return false
    const lower = normalizedSlug.toLowerCase()
    return takenSlugs.some((s) => s.trim().toLowerCase() === lower)
  }, [normalizedSlug, takenSlugs])

  // Synchronous re-entrancy guard: reuse.isPending updates a tick late, so a
  // rapid double-click could start two overlapping copy commits.
  const submittingRef = useRef(false)

  const reuse = useMutation({
    mutationFn: (input: CopyAssignmentInput) =>
      copyAssignmentWithConflictRetry(client, input),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.jsonFile(
          org,
          CONFIG_REPO,
          `${targetClassroom}/assignments.json`,
        ),
      })
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

  // Re-arm the auto-suffix default (e.g. after switching target/source); the
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
