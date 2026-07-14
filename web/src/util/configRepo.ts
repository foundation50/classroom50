// The org's private config-repo name. A byte-mirror of the CLI's
// cli/shared/contract (ConfigRepoName) and the schema — a cross-tool contract
// with no compile-time link across Go and TypeScript, so keep it in lockstep.
// Single-sourced here (a pure, dependency-free module) so both the GitHub data
// layer and the pure util/ URL builders can import it downward without pulling
// in the org-checks graph.
export const CONFIG_REPO = "classroom50"

// The branch Classroom 50 standardizes/recommends and falls back to. Named so a
// future where GitHub's default isn't "main" is a one-line change. NOT a
// template/source repo's branch (that's read from the template).
export const DEFAULT_BRANCH = "main"
