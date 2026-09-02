export const COLLECT_SCORES_WORKFLOW = "collect-scores.yaml"

// The regrade fan-out workflow in <org>/classroom50. Dispatched per assignment
// (optionally per repo owner); it re-runs each student repo's autograde
// workflow. Grading then happens asynchronously inside the student repos, so a
// follow-up collect-scores run refreshes the gradebook.
export const REGRADE_WORKFLOW = "regrade.yaml"

// The read-only service-token health check in <org>/classroom50. Dispatched
// with no inputs; it exercises every scope the token needs and reports each as
// a workflow annotation, which is how the settings page shows the result.
export const PROBE_TOKEN_WORKFLOW = "probe-token.yaml"
