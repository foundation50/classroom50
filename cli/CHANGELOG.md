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

## [1.16.1](https://github.com/foundation50/classroom50/compare/cli-v1.16.0...cli-v1.16.1) (2026-07-27)


### Bug Fixes

* close the roster.csv formula-guard, padded-id, and i18n gaps ([#417](https://github.com/foundation50/classroom50/issues/417)) ([3aa8e22](https://github.com/foundation50/classroom50/commit/3aa8e22996cdab1fd2e1dd4256f432af45ba897c))
* name the real cause when an org blocks student repo creation ([#418](https://github.com/foundation50/classroom50/issues/418)) ([789b65c](https://github.com/foundation50/classroom50/commit/789b65c4ebdb65539d6f69d7389aaf75bbe4db5c))
* reject a malformed github_id in both the web app and the CLI ([#411](https://github.com/foundation50/classroom50/issues/411)) ([f2576d8](https://github.com/foundation50/classroom50/commit/f2576d89b9c1da97f845238b6f929ab76b434f5e))

## [1.16.0](https://github.com/foundation50/classroom50/compare/cli-v1.15.0...cli-v1.16.0) (2026-07-25)


### Miscellaneous Chores

* **cli:** Synchronize classroom50 versions

## [1.15.0](https://github.com/foundation50/classroom50/compare/cli-v1.14.0...cli-v1.15.0) (2026-07-24)


### Features

* collect and show accepted staff submissions ([#393](https://github.com/foundation50/classroom50/issues/393)) ([675e117](https://github.com/foundation50/classroom50/commit/675e117a6ce0ee8692edc21e0963ff1a7d29a8d5))

## [1.14.0](https://github.com/foundation50/classroom50/compare/cli-v1.13.0...cli-v1.14.0) (2026-07-23)


### Features

* **gh-teacher:** add additional details to autograded logs.  ([#353](https://github.com/foundation50/classroom50/issues/353)) ([254381e](https://github.com/foundation50/classroom50/commit/254381e9fae3dcc8f63b4f0c43e6c4ad3b695aa1))


### Bug Fixes

* **cli:** skip managed toolchain setup on self-hosted autograde runners ([#370](https://github.com/foundation50/classroom50/issues/370)) ([d1cf8b0](https://github.com/foundation50/classroom50/commit/d1cf8b05e6b4cf95fdffb050fa0c78b413f808c8))

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
