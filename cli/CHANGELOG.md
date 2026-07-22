# Changelog

All notable changes to the Classroom 50 CLI extensions (`gh-teacher`,
`gh-student`) are documented here. The web app (classroom50.org) has its own
release track and is not covered by this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are automated with
[release-please](https://github.com/googleapis/release-please): feature PRs
merge into `main` and release-please maintains a release PR that bumps this file
from [Conventional Commits](https://www.conventionalcommits.org/) (`feat:` ->
minor, `fix:` -> patch, `feat!:`/`fix!:` -> major). Merging that release PR tags
`cli-vX.Y.Z`, which the existing CLI release workflow consumes to build and
publish the extensions (see `.github/workflows/cli-release.yaml`). You no longer
tag by hand; write Conventional Commit messages and release-please compiles the
notes.

## [1.13.0](https://github.com/foundation50/classroom50/compare/cli-v1.12.0...cli-v1.13.0) (2026-07-22)


### Features

* add submission release assets ([#363](https://github.com/foundation50/classroom50/issues/363)) ([3a69695](https://github.com/foundation50/classroom50/commit/3a69695ab407cb204ff6e7170aa943b272ae7838))

## [1.12.0](https://github.com/foundation50/classroom50/compare/cli-v1.11.0...cli-v1.12.0) (2026-07-21)


### Features

* add Head TA (HTA) role ([#344](https://github.com/foundation50/classroom50/issues/344)) ([b6a7deb](https://github.com/foundation50/classroom50/commit/b6a7debaba1f829759f546690fc0600ff50e47f1))
* **ci:** add release-please automation for cli releases ([#341](https://github.com/foundation50/classroom50/issues/341)) ([b5a3b94](https://github.com/foundation50/classroom50/commit/b5a3b944da0e8746be50d95f21d77feeee11db1b)), closes [#143](https://github.com/foundation50/classroom50/issues/143)
* enforce a $0 Actions budget cap as org policy ([#356](https://github.com/foundation50/classroom50/issues/356)) ([3cb60e4](https://github.com/foundation50/classroom50/commit/3cb60e4653cf14b80cd3c46961b9f271a4562235))
* **web:** capability-gate RBAC so TAs/Head TAs can't invoke owner-only or write ops ([#346](https://github.com/foundation50/classroom50/issues/346)) ([4335378](https://github.com/foundation50/classroom50/commit/433537843d3f78f441b74e7eedbf9fdd8df6fcca))

## 1.11.0

Automated releases start here. CLI versions through `cli-v1.11.0` were cut by
hand (tags aligned to the matching web release commit) before this track
existed, so they are not itemized above; see the git history and the per-tag
Releases on the `gh-teacher` / `gh-student` repos for those. release-please
compiles every entry from this point forward.
