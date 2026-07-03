# Contributing to Classroom 50

Thanks for your interest in improving Classroom 50, the open-source
[GitHub Classroom](https://classroom.github.com/) alternative from the
[Fifty Foundation](https://fifty.foundation/). Contributions of all sizes are
welcome — bug reports, docs, and code.

To contribute, you're welcome to:

- [Start a discussion](https://github.com/foundation50/classroom50/discussions/new/choose)
  if you have a question, idea, or other discussion topic.
- [Create a new issue](https://github.com/foundation50/classroom50/issues/new/choose) if you
  have a bug report or feature request.
- [Submit a pull request](https://github.com/foundation50/classroom50/pulls) if
  you'd like to contribute code, documentation, or other changes.

Please remove tokens, secrets, and private student data from any discussion and issue posts.

## Ground rules

- **No backend.** Classroom 50 is 100% client-side. All state lives in GitHub
  repos and in JSON/CSV/YAML config files — there is no server. Behavior is
  derived from what exists (for example, a student has "accepted" an assignment
  when their assignment repo exists). Please don't add server-side state.
- **Be kind.** Assume good faith and keep discussion focused on the work.

## Project layout

Classroom 50 is a monorepo of independently built but co-shipped pieces:

| Folder         | Stack                     | Role                                                       |
| -------------- | ------------------------- | ---------------------------------------------------------- |
| `cli/gh-teacher/` | Go (`gh` extension)    | Instructor CLI: org setup, classrooms, roster, autograding |
| `cli/gh-student/` | Go (`gh` extension)    | Student CLI: accept, submit                                |
| `cli/shared/`  | Go module                 | Shared contract constants and GitHub/Git/UI helpers        |
| `web/`         | React + TypeScript + Vite | Teacher web app deployed to classroom50.org                |
| `schemas/`     | JSON Schema               | Source-of-truth schemas for the cross-tool contracts       |
| `templates/`   | —                         | Example assignment templates teachers can copy             |

## Build and test

Please build, test, and lint the module you touched before opening a PR.

CLI modules (Go) — run in the module directory (`cli/gh-teacher`,
`cli/gh-student`, or `cli/shared`):

```
go build ./...
go test ./...
golangci-lint run
```

Set `GH_DEBUG=api` to log every underlying GitHub API request/response while
debugging the CLIs.

Web app:

```
cd web
npm run check   # tsc -b + eslint + prettier + vitest
npm run dev     # local dev server
```

Skeleton scripts (Python):

```
python3 -m pytest cli/gh-teacher/skeleton_tests -q
```

## Cross-tool contracts

Some names, paths, and schemas are shared across more than one tool (the web
app and the CLIs), so they can only change by coordinating across all tools.
`schemas/*.schema.json` is the source of truth, and the Go, Python, and
TypeScript sides hand-mirror it. When you touch one of these contracts:

- Update the schema **and** every mirror in the same change.
- Keep the parity tests green.
- Evolve schemas **additively**: readers should tolerate _and_ preserve unknown
  fields on a read-modify-write, because documents may have been written by an
  older release. Don't drop fields you don't recognize.

## Documentation

Document CLI commands and flags in the
[wiki](https://github.com/foundation50/classroom50/wiki), not in per-tool
READMEs.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
  and PR titles, e.g. `feat(web): ...`, `fix(gh-teacher): ...`,
  `docs: ...`.
- Keep PRs focused; link the issue they address.
- The pull request template includes a checklist — please fill it out.

## Releasing the CLIs (maintainers)

The two `gh` extensions (`gh-teacher`, `gh-student`) are released together from
this monorepo by the [`cli-release`](.github/workflows/cli-release.yaml)
workflow. It cross-compiles both extensions and publishes per-platform binaries
as GitHub Releases on the standalone mirror repos
[`foundation50/gh-teacher`](https://github.com/foundation50/gh-teacher) and
[`foundation50/gh-student`](https://github.com/foundation50/gh-student), where
`gh extension install` looks for them.

To cut a release, push a `cli-v*` tag on this repo:

```sh
git tag cli-v1.2.0        # a tag with a pre-release suffix (cli-v1.2.0-rc.1)
git push origin cli-v1.2.0 # publishes as a GitHub pre-release
```

`VERSION` is the tag with the `cli-` prefix stripped (`cli-v1.2.0` -> `v1.2.0`),
and it must be a `vMAJOR.MINOR.PATCH[-prerelease]` string. The workflow:

- injects the version, short commit, and build date into each binary via
  `-ldflags "-X main.version=… -X main.commit=… -X main.date=…"`, so
  `gh teacher --version` / `gh student --version` report the release (a local
  `go build` still reports `dev`);
- names assets canonically as `gh-<name>_<os>-<arch>[.exe]` (the version lives
  in the release tag, not the filename);
- publishes to both mirror repos as the same `VERSION` tag, marking any version
  with a `-` suffix as a pre-release.

Requirements (repo Settings, one-time): the `CLI_RELEASE_PAT` secret
(`contents: write` on both mirror repos) and the `cli-release` environment with
required reviewers. The workflow header documents these in full.

You can also trigger a run manually from the Actions tab
(`workflow_dispatch`) — useful for re-running a failed publish or forcing
provenance attestation on a private repo.

## Releasing the web app (maintainers)

The web app uses a **single-trunk** model. `main` is the default and
integration branch: feature PRs merge into `main` (squash), and every merge
continuously deploys to
[preview.classroom50.org](https://preview.classroom50.org) via
[`web-deploy-preview`](.github/workflows/web-deploy-preview.yaml). There is no
separate long-lived `preview` branch to promote from.

Releases to production (classroom50.org) are automated with
[release-please](https://github.com/googleapis/release-please)
([`web-release-please`](.github/workflows/web-release-please.yaml),
[`release-please-config.json`](release-please-config.json)). You do not tag or
edit the changelog by hand:

1. Merge feature PRs into `main` as usual (each deploys to preview).
   release-please reads the [Conventional Commits](https://www.conventionalcommits.org/)
   since the last release and maintains a **release PR** on `main` that bumps
   `web/package.json` and [`web/CHANGELOG.md`](web/CHANGELOG.md) (`feat:` ->
   minor, `fix:` -> patch, `feat!:`/`fix!:` -> major).
2. When ready to release, merge that release PR. release-please then tags the
   commit `web-vX.Y.Z` (namespaced apart from the CLI's `cli-v*` tags) and
   publishes the GitHub Release from the changelog.
3. The same workflow builds the tagged commit and deploys it to
   **classroom50.org** — gated on the release actually being created, so a plain
   merge to `main` only touches preview, never production. The version is
   stamped into the build via `VITE_APP_VERSION` and the running app reports it.

To force a specific version (e.g. a first `1.0.0` or a jump), land a commit on
`main` whose body contains `Release-As: X.Y.Z`.

[`web-deploy`](.github/workflows/web-deploy.yaml) is retained only as a manual
escape hatch (`workflow_dispatch` with an optional `ref`) to re-publish a chosen
tag/branch/SHA to production without cutting a release.

Requirement (repo/org Settings, one-time): enable "Allow GitHub Actions to
create and approve pull requests" so release-please can open its release PR with
the default `GITHUB_TOKEN`.

## License

By contributing, you agree that your contributions will be licensed under the
[GNU General Public License v3.0](LICENSE).
