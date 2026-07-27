// The frozen Feedback-PR base branch. A leaf module because both the data layer
// (github-core/rulesets, which locks the branch) and the accept flow (domain/
// assignments/feedbackPr, which creates it) need the same name — two copies
// could silently leave the base unprotected while still opening the PR.
//
// Kept byte-identical with the CLI's cli/shared/contract (FeedbackBaseBranch)
// and the runner's ensure_feedback_pr.py (BASE_BRANCH), with no compile-time
// link across the three: the runner adopts the accept-time PR purely by
// base+head, so this name decides whether teachers see ONE coherent Feedback PR
// or two competing ones.
export const FEEDBACK_BASE_BRANCH = "feedback"
