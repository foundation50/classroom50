# gh-student

A `gh` CLI extension targeted at students. Written in Go using [`go-gh`](https://github.com/cli/go-gh) and [`cobra`](https://github.com/spf13/cobra).

End-user documentation lives in the wiki — install, walkthrough, and full command reference:

- [Installation](https://github.com/foundation50/classroom50/wiki/Installation)
- [CLI Student Guide](https://github.com/foundation50/classroom50/wiki/CLI-Student-Guide)
- [`gh student` command reference](https://github.com/foundation50/classroom50/wiki/gh-student)

**Document new features on the wiki** (source: [`wiki/`](../../wiki/)), not in this README. This file is for contributors building and testing the extension locally.

## Local development

First-time setup:

```
cd cli/gh-student
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

If that exits 0, CI will pass. `golangci-lint fmt` applies both `gofmt` and `goimports` (configured in [`.golangci.yaml`](.golangci.yaml)) so import grouping stays consistent across files. The same checks run in [`gh-student-ci.yaml`](../../.github/workflows/gh-student-ci.yaml).

VSCode users: install the [Go extension](https://marketplace.visualstudio.com/items?itemName=golang.Go) and add this to `.vscode/settings.json` for format-and-lint on save:

```json
{
  "go.lintTool": "golangci-lint",
  "go.lintOnSave": "package",
  "go.formatTool": "gofmt"
}
```

## Layout

`main.go` defines the cobra root command and registers subcommands. The CLI was
extracted from a flat `package main` into `internal/<domain>/` packages, mirroring
`cli/gh-teacher` (the two are separate Go modules, so seams are paralleled, not
shared).

**Command packages** (each exposes an exported constructor — `NewCmd()` for a
single-command package, or `New<Name>Cmd()` for the auth group — registered by
`main.go`):

- `internal/auth` — `login` / `logout` / `whoami` (thin wrappers over the shared `ghauth` + the `githubapi` seam).
- `internal/submitcmd` — `submit`.
- `internal/invitecmd` — `invite` (+ the group-membership size-cap helpers).

**Substrate seams** (the shared behavior the commands build on):

- `internal/githubapi` — the **only** importer of `go-gh/v2/pkg/api`. Exposes the transport-verb `Client` interface (`Get`/`Post`/`Patch`/`RequestWithContext`), `RequireAuthClient`/`RequiredScopes`, the `HTTPError` alias, and thin wrappers over the `cli/shared` ops that need the concrete client (`CurrentUser`/`SetCollaborator`/`WaitForStableBranch`/`UploadBlobs`/`CommitWithFreshRepoRetry`). `internal/githubtest` is the white-box test client.
- `internal/classroomcfg` — the `.classroom50.yaml` contract (`Config`/`Source`/`MetadataPath`/`AutogradeWorkflowPath`) plus the accept-side write path (`DropFiles`/`CommitFiles`/`WaitForStableBranch`, `ReadConfig`, `Render`, `EscapeContentPath`, `IsHTTPNotFound`). `CommitFiles` runs through `gittree.CommitWithFreshRepoRetry`, retrying on a freshly-templated repo's git-data lag.
- `internal/assignments` — the **token-less** GitHub Pages read path (plain `net/http`, no go-gh): `FetchEntry`/`FetchAutograderWorkflow`, the `Entry`/`TemplateRef`/`AutogradeWorkflow` types, and the typed `NotFoundError`/`IsNotFound` so callers can surface "ask your teacher to run `gh teacher assignment add ...`" via `errors.As`. Malformed YAML is rejected at fetch time so a broken shim never lands in a student repo.
- `internal/identity` — the submit-commit git author/committer identity (`GitIdentity`/`Fetch`).
- `internal/reponame` — the canonical `<classroom>-<assignment>-<username>` repo-name formula (`Name`/`Prefix`), the cross-binary contract shared with gh-teacher's `download.go` and `runner.py`.
- `internal/localgit` — `CurrentGitRoot`, the local-git-tree nested-clone guard.
- `internal/ui` — the human-channel renderer (always stderr): TTY-gated color, the `Warn`/`Detail` helpers, and the long-running `Spinner` (a thin constructor over the shared `ghui` spinner). Color/TTY policy is delegated to `ghui` so it stays identical to gh-teacher and the shared spinner. Machine-stable output stays on stdout; this package never touches it.

**`accept.go` stays in `package main` at the module root** — it embeds the universal autograder shim (`//go:embed embed/autograde-shim.yaml`), and `//go:embed` cannot reference a directory outside the embedding file's own (`package main` is also unimportable from `internal/*`). So the accept command, which embeds and writes that shim, is the principled terminus of the extraction, not unfinished work. Moving the embed tree into `internal/*` is a deliberate non-goal — see [the captured learning](../../docs/solutions/architecture-patterns/embed-terminus-and-build-as-oracle-in-go-package-extraction.md). `accept.go` consumes the seams above like every other command.

Submit is intentionally minimal: when the assignment has a template it refreshes the template repo's `.gitignore` and `.github/` (both optional, fetched from the template ref recorded in `.classroom50.yaml`); for a template-less assignment there's no `source` block, so that refresh is skipped. It then commits + pushes to `main`. The autograde shim itself is set once at accept time and never refreshed — actual grading logic lives in the teacher's config repo and is fetched from the teacher's Pages site at workflow runtime. The runner workflow auto-tags the pushed commit and publishes a release at the submit tag.

## Distribution

Currently install-from-source only. Cross-platform binary releases via [`cli/gh-extension-precompile`](https://github.com/cli/gh-extension-precompile) are deferred until this extension lives in its own repository (`gh extension install <owner>/<repo>` resolves the binary by repo name, which only matches once `gh-student` is the repo).
