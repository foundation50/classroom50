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

## [1.24.0](https://github.com/foundation50/classroom50/compare/cli-v1.23.0...cli-v1.24.0) (2026-08-02)


### Features

* **web:** per-assignment repository features (issues/wiki/projects/pull requests) ([#479](https://github.com/foundation50/classroom50/issues/479)) ([bd9725d](https://github.com/foundation50/classroom50/commit/bd9725de6c3fbc249dcaa2a4dded10908a9e97e7))

## [1.23.0](https://github.com/foundation50/classroom50/compare/cli-v1.22.0...cli-v1.23.0) (2026-08-02)


### ⚠ BREAKING CHANGES

* remove students.csv legacy roster support ([#474](https://github.com/foundation50/classroom50/issues/474))
* a classroom still on a -instructor team or with a teams.instructor ref is no longer accepted rather than silently normalized; a role=instructor CSV row imports as an unknown role (degrades to student).

### Features

* **cli:** surface roster role column and note dual staff/student roles ([#475](https://github.com/foundation50/classroom50/issues/475)) ([634cbb4](https://github.com/foundation50/classroom50/commit/634cbb4df50aa39b47e4403ff1180a98a5e8b2cc))
* remove legacy "instructor" staff-role alias ([#473](https://github.com/foundation50/classroom50/issues/473)) ([85164b9](https://github.com/foundation50/classroom50/commit/85164b9a7bb3791c72f652c3bbf42196928d7255))
* remove students.csv legacy roster support ([#474](https://github.com/foundation50/classroom50/issues/474)) ([b00ce2c](https://github.com/foundation50/classroom50/commit/b00ce2ce0df7f9e72fdb964646082461d28b17bc))


### Miscellaneous Chores

* release 1.23.0 ([#476](https://github.com/foundation50/classroom50/issues/476)) ([4a50632](https://github.com/foundation50/classroom50/commit/4a50632a2832fdfa5a5e3bc385712620a0d9e797))

## [1.22.0](https://github.com/foundation50/classroom50/compare/cli-v1.21.0...cli-v1.22.0) (2026-08-01)


### Features

* **cli:** skip autograde grade job when no autograder is configured ([#458](https://github.com/foundation50/classroom50/issues/458)) ([aa16f0a](https://github.com/foundation50/classroom50/commit/aa16f0a2fc3452282246e8d790f0f02a01e4fd18))
* configurable student assignment-repo access with per-repo and bulk controls ([#466](https://github.com/foundation50/classroom50/issues/466)) ([efb69f8](https://github.com/foundation50/classroom50/commit/efb69f8294512eadb7956bfff69e8e912bbd7ae5))


### Bug Fixes

* name the fork's upstream org for cross-org fork templates ([#468](https://github.com/foundation50/classroom50/issues/468)) ([#470](https://github.com/foundation50/classroom50/issues/470)) ([53785b8](https://github.com/foundation50/classroom50/commit/53785b807133023c418580f5b02fcd95a90b3c1f))

## [1.21.0](https://github.com/foundation50/classroom50/compare/cli-v1.20.0...cli-v1.21.0) (2026-07-29)


### Bug Fixes

* **cli:** correct help text listing --template as required and other stale flag references ([#452](https://github.com/foundation50/classroom50/issues/452)) ([98e5551](https://github.com/foundation50/classroom50/commit/98e555164899649e1e8f1ed023c807af36684412))

## [1.20.0](https://github.com/foundation50/classroom50/compare/cli-v1.19.0...cli-v1.20.0) (2026-07-29)


### Features

* **web:** manage service tokens across organizations ([#443](https://github.com/foundation50/classroom50/issues/443)) ([549d34a](https://github.com/foundation50/classroom50/commit/549d34aab497dc1a3050111f4bfbd8cbf974479d))

## [1.19.0](https://github.com/foundation50/classroom50/compare/cli-v1.18.1...cli-v1.19.0) (2026-07-28)


### Features

* add lockable assignments that block student access and revoke private-template read ([#441](https://github.com/foundation50/classroom50/issues/441)) ([127982b](https://github.com/foundation50/classroom50/commit/127982b9a518ee6b8a3c91fc4a6e1143f0f793c6))
* add per-assignment release date (available_from) and hide unreleased assignments from students ([#439](https://github.com/foundation50/classroom50/issues/439)) ([6cc15f0](https://github.com/foundation50/classroom50/commit/6cc15f07852545e0f50988ffa7386339a87dc99e))
* restrict assignment accept to enrolled classroom members ([#442](https://github.com/foundation50/classroom50/issues/442)) ([0e06012](https://github.com/foundation50/classroom50/commit/0e0601219e6006083da6a6767f8e6a520b85845c))

## [1.18.1](https://github.com/foundation50/classroom50/compare/cli-v1.18.0...cli-v1.18.1) (2026-07-28)


### Bug Fixes

* **web:** remediate brace-expansion DoS and refresh dependencies ([#436](https://github.com/foundation50/classroom50/issues/436)) ([9e1d355](https://github.com/foundation50/classroom50/commit/9e1d355940fac44589d3bf8361f77c75b3f57d29))

## [1.18.0](https://github.com/foundation50/classroom50/compare/cli-v1.17.0...cli-v1.18.0) (2026-07-28)


### Features

* **cli:** open and repair Feedback PRs from the teacher CLI ([#435](https://github.com/foundation50/classroom50/issues/435)) ([70ff18a](https://github.com/foundation50/classroom50/commit/70ff18ae30c95f0823d85f54064dbcc4f9169600))
* **web:** teacher tools to open and repair Feedback PRs ([#434](https://github.com/foundation50/classroom50/issues/434)) ([91ce244](https://github.com/foundation50/classroom50/commit/91ce244303cf63e99aac4f183442124babd8c97e))

## [1.17.0](https://github.com/foundation50/classroom50/compare/cli-v1.16.1...cli-v1.17.0) (2026-07-28)


### Features

* open the Feedback PR at accept time via the GitHub API ([#409](https://github.com/foundation50/classroom50/issues/409)) ([5ce01b7](https://github.com/foundation50/classroom50/commit/5ce01b749db789192f613040715657ff09b38358))

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
