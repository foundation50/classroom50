// The org's private config-repo name. A byte-mirror of the CLI's
// cli/shared/contract (ConfigRepoName) and the schema — a cross-tool contract
// with no compile-time link across Go and TypeScript, so keep it in lockstep.
// Single-sourced here (a pure, dependency-free module) so both the GitHub data
// layer and the pure util/ URL builders can import it downward without pulling
// in the org-checks graph.
export const CONFIG_REPO = "classroom50"

// The default branch Classroom 50 standardizes on and recommends: the config
// repo is normalized to it, new repos are recommended to use it, and it's the
// last-resort fallback for any Classroom-50-created/managed repo whose live
// `default_branch` and requested branch are both unavailable. Named so a future
// world where GitHub's default is no longer "main" is a one-line change. NOT the
// branch of a template/source repo (that's read from the template).
export const DEFAULT_BRANCH = "main"
