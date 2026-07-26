import { useQuery } from "@tanstack/react-query"

import { useOptionalGitHubClient } from "@/context/github/GitHubProvider"
import { useIsOrgOwner } from "@/context/githubOrgRole/useIsOrgOwner"
import { githubKeys } from "@/github-core/queries"
import { getOrgActionsMode } from "@/github-core/mutations"

export type FeedbackPrWarning =
  | { show: false }
  // Which state blocked it decides the copy: a pause is one toggle away from
  // resuming, while org-wide disabled Actions need a different remedy.
  | { show: true; reason: "paused" | "disabled" }

// The assignment's own opt-in. Both flags gate the warning: an assignment that
// never wanted the Feedback PR, or an empty repo that structurally cannot have
// one, is not affected by the org's Actions policy.
export type FeedbackPrSubject = {
  feedback_pr?: boolean
  empty_repo?: boolean
}

// Whether to warn a teacher that the Feedback PR won't open, because org-wide
// autograding is paused (or Actions are off entirely).
//
// The PR is created by the autograde runner inside the student repo, not by this
// app, so anything that stops the student repo's workflow also silently stops
// the Feedback PR. Pausing restricts org Actions to the config repo, which
// blocks every student shim.
//
// Fails open: warn only on an explicit paused/disabled. `getOrgActionsMode`
// swallows a read failure to "unknown", and a teacher who cannot read the policy
// cannot be told anything useful about it — so unknown, in-flight, and
// non-owner viewers are all silent.
//
// Reach is org owners only, by construction: /orgs/{org}/actions/permissions is
// admin-only. Classroom roles are team-derived and independent of org admin
// standing, so a non-owner teacher or head-TA gets silence here.
//
// Uses the OPTIONAL client rather than useGetOrgActionsMode: this hook mounts
// inside the assignment form, which also renders in contexts with no GitHub auth
// (and with no org at all), where the strict accessor throws. An advisory
// warning must never be able to break the form it annotates.
const useFeedbackPrWarning = (
  org: string | undefined,
  subject: FeedbackPrSubject,
): FeedbackPrWarning => {
  const client = useOptionalGitHubClient()
  const { isOwner } = useIsOrgOwner()
  const wantsFeedbackPr = subject.feedback_pr === true && !subject.empty_repo
  const shouldRead =
    Boolean(org) && Boolean(client) && isOwner && wantsFeedbackPr

  const { data: mode, isPending } = useQuery({
    queryKey: githubKeys.orgActionsMode(org ?? ""),
    queryFn: () => getOrgActionsMode(client!, org!),
    enabled: shouldRead,
    staleTime: 60 * 1000,
  })

  // Guard before reading `mode` rather than trusting the disabled query to leave
  // it undefined: a warm cache entry from an earlier owner session would
  // otherwise leak a verdict to a viewer we just decided has no signal.
  if (!shouldRead || isPending) return { show: false }
  if (mode === "paused") return { show: true, reason: "paused" }
  if (mode === "disabled") return { show: true, reason: "disabled" }
  return { show: false }
}

export default useFeedbackPrWarning
