// The org's private config-repo name. A byte-mirror of the CLI's
// cli/shared/contract (ConfigRepoName) and the schema — a cross-tool contract
// with no compile-time link across Go and TypeScript, so keep it in lockstep.
// Single-sourced here (a pure, dependency-free module) so both the GitHub data
// layer and the pure util/ URL builders can import it downward without pulling
// in the org-checks graph.
export const CONFIG_REPO = "classroom50"
