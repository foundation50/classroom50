# gh-teacher

A `gh` CLI extension targeted at instructors. Written in Go using [`go-gh`](https://github.com/cli/go-gh) and [`cobra`](https://github.com/spf13/cobra).

End-user documentation lives in the wiki — install, walkthrough, and full command reference:

- [Installation](https://github.com/foundation50/classroom50/wiki/Installation)
- [CLI Teacher Guide](https://github.com/foundation50/classroom50/wiki/CLI-Teacher-Guide)
- [`gh teacher` command reference](https://github.com/foundation50/classroom50/wiki/gh-teacher)

**Document new features on the wiki** (source: [`wiki/`](../../wiki/)), not in this README. This file is for contributors building and testing the extension locally.

## Local development

First-time setup:

```
cd cli/gh-teacher
go mod tidy
```

Build and register as a `gh` extension from your local checkout:

```
go build .
gh extension install .
```

Re-run `go build .` after code changes; `gh extension install .` only needs to run once.

To debug REST calls, set `GH_DEBUG=api` (honored by `go-gh`) to log every request and response.

## Local checks

Install Go and `golangci-lint` once:

```
brew install go golangci-lint
```

Run all CI checks locally before pushing:

```
golangci-lint fmt && go mod tidy && golangci-lint run && go build ./... && go test ./...
```

If that exits 0, CI will pass. `golangci-lint fmt` applies both `gofmt` and `goimports` (configured in [`.golangci.yaml`](.golangci.yaml)) so import grouping stays consistent across files. The same checks run in [`gh-teacher-ci.yaml`](../../.github/workflows/gh-teacher-ci.yaml).

VSCode users: install the [Go extension](https://marketplace.visualstudio.com/items?itemName=golang.Go) and add this to `.vscode/settings.json` for format-and-lint on save:

```json
{
  "go.lintTool": "golangci-lint",
  "go.lintOnSave": "package",
  "go.formatTool": "gofmt"
}
```

## Layout

`main.go` defines the cobra root command and registers subcommands. Two patterns coexist during the in-progress domain extraction (Phase C):

- **In-package commands** still live in their own file at the package root (`init.go`, `autograder_cmd.go`, …) exposing a `<name>Cmd()` factory function. These are the residue pinned to a `//go:embed` asset (the `skeleton/` tree for init, `embed/autograder.py` for the autograder command) or fused to the init summary type, so they can't move to `internal/*` without relocating the embedded asset (a deliberate non-goal). To add one, copy an existing file and follow the pattern: factory returns `*cobra.Command`, write to `cmd.OutOrStdout()`, wrap errors with `fmt.Errorf("ctx: %w", err)`.
- **Extracted commands** live in their own `internal/<domain>` package and expose an exported constructor: `NewCmd()` for a single-command package (e.g. `internal/remove`), or `New<Name>Cmd()` per command for a multi-command package (e.g. `internal/auth` exposes `NewWhoamiCmd`/`NewLoginCmd`/`NewLogoutCmd`). `main.go` imports the package and registers `<domain>.NewCmd()`.

New commands should prefer the extracted form. Currently extracted: `internal/auth` (whoami/login/logout), `internal/remove`, `internal/roster` (list/add/remove/import), `internal/member` (list), `internal/invite`, `internal/teardown`, `internal/classroom` (add/list/edit/remove + migrate), `internal/download`, `internal/audit` (read-only member-privilege lockdown audit), `internal/assignmentcmd` (add/list/remove + the `assignment test` subgroup). Note `internal/assignmentcmd` is the command shell and is distinct from `internal/assignment`, the pure data layer it consumes. Shared rendering lives in `internal/ui` (the `ui.UI` renderer + the `ui.Status` outcome enum used by init/audit; init keeps a `preflightStatus = ui.Status` alias so its `--json` `status` field is unchanged). The org-member-defaults lockdown model — the least-privilege setting set, plan-aware filtering, live-org classification, and the manual-hardening checklist — lives in `internal/orgpolicy` (`orgpolicy.MemberDefaultSettings` / `ClassifyDefaults` / `ManualHardeningSteps`), the seam shared by `init` (apply + verify) and `audit` (read-only report) so the two can't drift in what "locked-down" means; the org read/write stays with each caller (init's `verifyOrgDefaults`, audit's `readOrgMemberSettings`). The org-plan lookup both use to scope those settings is `githubapi.OrgPlan` (init's `checkOrgAccess` wraps it with preflight framing; `audit` calls it directly), keeping `internal/orgpolicy` a pure stdlib-only model seam.

### GitHub API seam (`internal/githubapi`)

All GitHub REST access goes through `internal/githubapi`, the **only** package permitted to import [`go-gh`](https://github.com/cli/go-gh)'s `pkg/api` (the test-client helper `internal/githubtest` is the one other exception, since it constructs real clients for white-box tests). Domain code depends on the transport-verb `githubapi.Client` interface (`Get` / `Post` / `Request`), never on the concrete `*api.RESTClient`. Generic pagination (`githubapi.PaginateAll`/`GetPage`) and the shared-module operations that need the concrete client (`CommitWithRebase`, `SetCollaborator`, `WaitForStableBranch`, …) plus the typed org read `OrgPlan` are wrapped here too. This boundary is **enforced in CI** by the "Single go-gh importer guard" step in [`gh-teacher-ci.yaml`](../../.github/workflows/gh-teacher-ci.yaml) — a non-test file outside `internal/githubapi/` that imports `go-gh/v2/pkg/api` fails the build. It is a lint/CI invariant, not a compiler-enforced boundary (sibling `internal/*` packages can import each other freely).

Cross-cutting CLI helpers that are not GitHub-API logic live in `internal/cliutil` (`RequireAuthClient` is in `githubapi` since it builds a client; `IsHTTPStatus` is in `cliutil`). The shared JSON encoder behind every `--json` view and every config-repo file written to disk lives in `internal/output` as `output.JSONPretty` (2-space indent, no HTML escaping, trailing newline — a byte contract pinned by `internal/output/output_test.go`).

### Identifier validation (`internal/validate`)

Pure identifier validators live in `internal/validate`: `validate.ShortName(name, label)` enforces `validate.ShortNamePattern` (lowercase alnum + hyphens) consistently for classroom short-names, assignment slugs, and autograder names; `validate.OrgName` and `validate.OrgClassroom` validate command arguments up front; `validate.ScopeListContains` checks token scopes. These are the traversal/format guards callers MUST apply before a value flows into a `url.PathEscape`'d API path.

### Config-repo substrate (`internal/configrepo`)

`internal/configrepo` is the read substrate for each org's `<org>/classroom50` config repo. It holds: the contents/tree **read** plumbing (`ReadFileContents`, `ContentsExists`, `ListDirContents`, `ListSubtreeBlobPaths`, `CommitTreeSHA`); branch/loader helpers (`ResolveConfigRepoBranch`, `LoadRoster`, `LoadClassroom`); the `roster.csv` data layer (`ParseRoster`/`EncodeRoster`/`UpsertRosterRow`/`RemoveRosterRow` + the CSV-injection defang); the persisted record types (`ClassroomJSON`, `TeamRef`, `MigratedFromRef`, `RosterRow`, `ConfigRepo`); and the team service (`EnsureClassroomTeam`, `ResolveClassroomTeam`, `AddTeamMembership`, `GrantTeamRepoRead`, …). The config-repo **write** plumbing lives in its write-side sibling `internal/configwrite` (see below), kept separate so neither package imports the other.

### Config-repo write seam (`internal/configwrite`)

`internal/configwrite` is the write-side sibling of `internal/configrepo`: the optimistic-update-with-rebase Tree-commit helpers every teacher-side mutation of `<org>/classroom50` goes through — `CommitTree` (upsert-only), `CommitTreeChange` (deletion-aware core), and the `CommitChange` alias for `gittree.Change`. It also holds the workflow-scope classifier wired into that rebase loop: `ClassifyWorkflowScope404` maps a Tree-write 404 to `ErrMissingWorkflowScope` when the token's `X-OAuth-Scopes` header shows the `workflow` scope is absent (an absent header is treated as fresh-repo lag, not a scope failure — the fine-grained-PAT fail-open). The classifier is injected by `CommitTreeChange` and also by `init_skeleton.go`'s `CreateTree` options; both injectors are write-side, so the classifier lives here. It depends only on `internal/githubapi`, `internal/validate`, the shared `gittree` package, and stdlib. Any command that edits a tracked file in the config repo goes through `configwrite.CommitTree`.

### Org-membership service (`internal/membership`)

`internal/membership` is the org-level membership service shared by the `invite`, `roster`, and `member` commands: `LookupUser`, `InviteOrgByID`, `MembershipState`, the `OrgMembershipKnownError` type, `ClassifyOrgInviteError`, and the 403/scope classifier family (`ClassifyOrgForbidden` / `HasOrgAdminScope` / `ErrMissingOrgAdminScope`). It is a primitives surface, not a fused service: each command needs a different subset, so the roster-specific ensure-membership composition (`inviteIfNotMember`) lives in `internal/roster` as command glue (it composes these primitives), and the other consumers (`invite`, `member`) use their own subsets.

**Membership boundary vs `internal/configrepo`:** if an operation is keyed by config-repo data (`classroom.json`, the roster file) it stays in `configrepo` — that is membership-as-config, e.g. `AddTeamMembership`/`RemoveTeamMembership` acting on the classroom team slug recorded in `classroom.json`. If it is pure GitHub org-membership independent of stored config — inviting a user to the org, looking a user up, reading org membership state — it lives in `membership`.

### Assignment data layer (`internal/assignment`)

`internal/assignment` is the data layer for a single `assignments.json` entry: it parses, validates, and re-encodes the manifest (`ParseAssignments`/`EncodeAssignments`/`UpsertAssignment`/`FindAssignment`/`RemoveAssignment` + the `AssignmentsJSON`/`AssignmentEntry`/`DueMeta`/`TemplateRef`/`MigratedFromRef` types), the embedded declarative-test specs (`TestSpec`, `ValidateTests`, `ParseTestsFile`), and the embedded runtime/container block (`RuntimeRef`/`ContainerSpec`, `ParseRuntimeFile`, `ValidateRuntime`/`ValidateContainer`). It is pure data/validation with no GitHub I/O — it depends only on `internal/output`, `internal/validate`, the shared `contract` package, and stdlib. The assignment **commands** now live in `internal/assignmentcmd` (the command shell — distinct from this data layer), the embed-pinned autograder command (`autograder_cmd.go`) stays at root, and the embed-independent autograder-shim helpers live in `internal/autograder` (the write path itself is `configwrite.CommitTree` — see the "Config-repo write seam" section). Its cohesion principle: everything required to parse/validate/re-encode one assignment entry including its `tests[]` and `runtime{}` sub-objects — not a catch-all for assignment-adjacent code. **Security invariant:** `assignments.json` is untrusted, hand-editable input, so the runtime/container anti-injection guards (the `runs-on` label injection regex, the macOS/Windows-with-container rejection, and the apt/image/secret-ref/container-user regexes) are validated on the *parse* path (`ParseAssignments` → `ValidateExistingEntry` → `ValidateRuntime`), not only at write time; the exported validators are that trust boundary. (`runs-on` itself carries no value allow-list — any label, including self-hosted, is accepted; see the [Autograders](https://github.com/foundation50/classroom50/wiki/Autograders) wiki page.)

The `init` bootstrap command lives alongside `init_repo.go` and `init_skeleton.go` (pinned to the package root by `//go:embed skeleton`). The service-token substrate seam — provisioning, validating, and reading the `CLASSROOM50_SERVICE_TOKEN` repo secret, plus the `rotate-service-token` command (`servicetoken.NewRotateCmd`) — lives in `internal/servicetoken`; init's `provisionServiceToken` orchestration step stays in `package main` (it writes `*initSummary`) and calls into the seam. The skeleton embedded into each org's `classroom50` repo at init time lives under `skeleton/` (Go sources read it via `//go:embed`).

The runner-side bootstrap (`.github/scripts/runner.py`), the score collector (`.github/scripts/collect_scores.py`), the declarative-test materializer (`.github/scripts/materialize_tests.py`), and the Feedback-PR maintainer (`.github/scripts/ensure_feedback_pr.py`) live under `skeleton/dotgithub/scripts/` and ship under `.github/scripts/` in each org's `classroom50` repo (nested under `.github/` so the directory name can't collide with a classroom slug). The runner is fetched from Pages by the autograde-runner reusable workflow at workflow runtime on every submission (the student-repo shim only `uses:` the runner workflow — it never performs Pages fetches itself). The runner resolves the entrypoint: per-assignment `<classroom>/autograders/<slug>/autograder.py` if present in the bundle, otherwise the classroom default at `<classroom>/autograder.py`, otherwise a vacuous-pass synthesis. The autograder workflow shim itself is embedded in `gh-student` (`cli/gh-student/embed/autograde-shim.yaml`) and dropped into each student repo at accept time.

The diagnostic-stub `autograder.py` ships separately at `embed/autograder.py` and is `//go:embed`-ed into the gh-teacher binary by `autograder_cmd.go`. It's written to `<classroom>/autograder.py` only when `gh teacher autograder set-default <org> <classroom>` runs without `--from`. Init does not scaffold any autograder.

Tests for the embedded Python files (`collect_scores.py`, `runner.py`, `materialize_tests.py`, `ensure_feedback_pr.py`, and `embed/autograder.py`) live under `skeleton_tests/` (collector, materializer, feedback-PR, artifact schemas) and `autograders_tests/` (runner + diagnostic-stub autograder + declarative grader). They run in CI via [`skeleton-scripts-ci.yaml`](../../.github/workflows/skeleton-scripts-ci.yaml); execute locally with `python3 -m pytest skeleton_tests/ autograders_tests/`.

Commands that mutate tracked files in `<org>/classroom50` (`internal/classroom`, `internal/roster`, `internal/assignmentcmd`) share these helpers:

- Identifier validation now lives in `internal/validate` (`validate.ShortName`/`OrgName`/`OrgClassroom`); the config-repo read substrate and the `roster.csv` data layer live in `internal/configrepo` (see above). (The `*api.HTTPError` → `StatusCode` predicate lives in `internal/cliutil` as `cliutil.IsHTTPStatus`.)
- The config-repo write loop lives in `internal/configwrite` (see the "Config-repo write seam" section above): `configwrite.CommitTree`/`CommitTreeChange` are thin wrappers over the shared optimistic-update-with-rebase loop, reached through the API seam (`githubapi.CommitWithRebase`, itself over `cli/shared/gittree`). They read the current branch tip, call a `build` callback to produce the new path → content map (or upserts+deletes), and PATCH the ref with a fast-forward check; on a non-fast-forward (concurrent writer won the race) they re-invoke `build` against the fresh tip (up to 5 attempts with backoff), and inject `configwrite.ClassifyWorkflowScope404` so a `.github/workflows` write without the `workflow` scope fails fast. Used by `classroom add` too, so even the four-file scaffold lands through the same race-safe path. Any new command that edits a tracked file should go through `configwrite.CommitTree`.
- The roster `roster.csv` data layer (RFC 4180 parse/encode plus case-insensitive upsert/remove, covered by `internal/configrepo/students_csv_test.go`) now lives in `internal/configrepo`.
- The assignment manifest data layer (typed `assignments.json` parse/encode + case-sensitive upsert/remove, the declarative-test specs, and the runtime/container validators) now lives in `internal/assignment` (see above). The `AssignmentEntry.Autograder` field the student CLI's Pages fetch consumes still normalizes empty → `"default"` on parse; `expectEOF` enforces trailing-content rejection on every JSON read path. Covered by `internal/assignment/*_test.go`. The config-repo-relative manifest path is `assignment.AssignmentsFilePath`; the config-repo *read* of the manifest is `configrepo.LoadAssignments` (alongside `LoadRoster`/`LoadClassroom`), keeping `internal/assignment` itself free of config-repo I/O.
- The autograder-shim helpers — the `autograder` name validator (shares `validate.ShortNamePattern` with classroom/slug because the value flows into the same paths) plus the contents-API existence probe and the in-repo path shape (`gh teacher assignment add --autograder` uses these at write time) — now live in the `internal/autograder` substrate seam as `autograder.ValidateName` / `autograder.Exists` / `autograder.FilePath`. They reference none of the embedded autograder asset, so they extract freely (unblocking the assignment command) while the embed-pinned `gh teacher autograder` command surface stays at root. The autograder shim itself is embedded in `gh-student` (`cli/gh-student/embed/autograde-shim.yaml`); the runner-side bootstrap lives in the skeleton (`skeleton/dotgithub/scripts/runner.py`); the diagnostic-stub `autograder.py` lives in `embed/` and ships inside the gh-teacher binary. Covered by `internal/autograder/autograder_test.go`.
- `autograder_cmd.go` + `autograder_crud.go` — implement the `gh teacher autograder` command group: `set-default <org> <classroom> [--from <path|->]` (writes the proposed body, or the embedded diagnostic stub when `--from` is omitted, to `<classroom>/autograder.py` via `configwrite.CommitTree`), plus the read/manage subcommands `show`, `list`, and `remove`. All validate the classroom exists in the config repo first. Covered by `autograder_cmd_test.go` and `autograder_crud_test.go`.

The `download` command (`internal/download`) is a read-only consumer of the same files. Default mode reads the classroom GitHub team's members (the source of truth for enrollment) + `assignments.json` (the `assignments.json` read is `configrepo.LoadAssignments`, which parses via the `internal/assignment` data layer; the config-repo-relative path is `assignment.AssignmentsFilePath`) and `scores.json` (the gradebook schema — `scores.File` / `scores.AssignmentBucket` / `scores.SchemaV1` — lives in `internal/scores`, the substrate seam shared by `classroom` (which scaffolds an empty well-formed `scores.json`) and `download` (which parses the populated one); download's local `parseScores` enforces the schema sentinel, with the root `assignments` an assignment-slug-keyed map of `{type, entries[]}` buckets, each entry a tolerant `map[string]any`; `parseScores` accepts only the canonical object shape and hard-fails on legacy shapes -- no migration), then walks the team members x assignment to clone matching student repos and refresh each one's `result.json` (latest submission) and `results.json` (every submission, newest first) from that repo's submit-tag releases. `roster.csv` is read only as optional display metadata (name/section/email) for the `scores.csv` join — a missing or unreadable roster yields blank metadata, never a skipped student. It also writes a `scores.csv` with one line per submission per credited student. `--by-pattern` skips the config-repo lookup and falls back to a prefix-match over `GET /orgs/{org}/repos`. The release-asset fetcher (`downloadAssetBytes`) builds its own `http.Client` outside `go-gh` so it can set `Accept: application/octet-stream` and strip `Authorization` on the cross-host redirect to storage. Covered by `internal/download/download_test.go`, including a two-server httptest that pins the redirect-stripping behavior.

The unfiltered org-repo walk (`GET /orgs/{org}/repos`, page-capped) shared by `download` (`--by-pattern`) and `teardown` (wildcard nuke) lives in `internal/orgrepos` as `orgrepos.ListNames` — a thin `githubapi.PaginateAll` wrapper over the org-repos endpoint that returns every repo name and lets each caller map/filter itself. Covered by `internal/orgrepos/orgrepos_test.go` (paging + the safety-cap error).

## Distribution

Currently install-from-source only. Cross-platform binary releases via [`cli/gh-extension-precompile`](https://github.com/cli/gh-extension-precompile) are deferred until this extension lives in its own repository (`gh extension install <owner>/<repo>` resolves the binary by repo name, which only matches once `gh-teacher` is the repo).
