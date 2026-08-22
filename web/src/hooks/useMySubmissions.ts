import useGetMyTaggedSubmissions from "@/hooks/useGetMyTaggedSubmissions"
import useGetMyPushSubmissions from "@/hooks/useGetMyPushSubmissions"
import useGetSubmissionReleases from "@/hooks/useGetSubmissionReleases"
import type { DetectedSubmission } from "@/domain/assignments/submissionDetection"
import type { GitHubCommit, GitHubRelease } from "@/github-core/types"
import type { SubmissionMode } from "@/types/classroom"

// One reader for the student's own submissions, so the submission view stops
// orchestrating three hooks + inline mode-gating by hand. All reads are scoped
// to the student's single repo (`<classroom>-<assignment>-<login>`):
//   - releases: the graded submit/* releases (both modes — they carry grades).
//   - tags:     tag/tag-group detections (tag mode only).
//   - pushes:   the default branch's submission commits (every-push only).
// The inactive mode's read is disabled (undefined args), so it costs nothing.
// `isError` folds the ACTIVE-mode submission-list read so a transient/permission
// failure surfaces rather than rendering a misleading "0 submissions".
export function useMySubmissions(
  org: string | undefined,
  classroom: string | undefined,
  assignment: string | undefined,
  username: string | undefined,
  options: { mode: SubmissionMode | undefined; submissionTags?: string[] },
): {
  releases: GitHubRelease[] | undefined
  tags: DetectedSubmission[]
  pushes: GitHubCommit[]
  releasesLoading: boolean
  releasesError: boolean
  releasesErrorObj: unknown
  // The active-mode submission-list read errored (tags in tag mode, pushes in
  // every-push). Callers fold this into their error branch.
  submissionListError: boolean
  // The active-mode submission-list read is still in flight. Callers fold this
  // into their loading gate so the page renders once, settled — not a
  // "0 submissions" first paint that flips when the list lands.
  submissionListLoading: boolean
} {
  const isTagMode = options.mode === "tag"

  const {
    data: releases,
    isLoading: releasesLoading,
    isError: releasesError,
    error: releasesErrorObj,
  } = useGetSubmissionReleases(org, classroom, assignment, username)

  const {
    data: tags,
    isError: tagsError,
    isLoading: tagsLoading,
  } = useGetMyTaggedSubmissions(
    isTagMode ? org : undefined,
    isTagMode ? classroom : undefined,
    isTagMode ? assignment : undefined,
    isTagMode ? username : undefined,
    options.submissionTags,
  )

  const {
    data: pushes,
    isError: pushesError,
    isLoading: pushesLoading,
  } = useGetMyPushSubmissions(
    isTagMode ? undefined : org,
    isTagMode ? undefined : classroom,
    isTagMode ? undefined : assignment,
    isTagMode ? undefined : username,
  )

  return {
    releases,
    tags: tags ?? [],
    pushes: pushes ?? [],
    releasesLoading,
    releasesError,
    releasesErrorObj,
    submissionListError: isTagMode ? tagsError : pushesError,
    submissionListLoading: isTagMode ? tagsLoading : pushesLoading,
  }
}

export default useMySubmissions
