# Changelog

All notable changes to the Classroom 50 **web app** (classroom50.org) are
documented here. The CLI extensions (`gh-teacher`, `gh-student`) have their own
release track and are not covered by this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are automated with
[release-please](https://github.com/googleapis/release-please): feature PRs
merge into `main` and release-please maintains a release PR that bumps
`web/package.json` and this file from [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:` -> minor, `fix:` -> patch, `feat!:`/`fix!:` -> major). Merging that
release PR tags `web-vX.Y.Z`, publishes the GitHub Release, and deploys to
classroom50.org (see `.github/workflows/web-release-please.yaml`). You no longer
edit this file or tag by hand; write Conventional Commit messages and
release-please compiles the notes.

## [1.2.0](https://github.com/foundation50/classroom50/compare/web-v1.1.0...web-v1.2.0) (2026-07-06)


### Features

* add Rust runtime toolchain support to the autograder ([#132](https://github.com/foundation50/classroom50/issues/132)) ([4db3da2](https://github.com/foundation50/classroom50/commit/4db3da2679ba9f5faf735073c04d49d7dc5ea783))
* decouple classroom from students.csv — team as source of truth ([#108](https://github.com/foundation50/classroom50/issues/108)) ([#112](https://github.com/foundation50/classroom50/issues/112)) ([be1c1c1](https://github.com/foundation50/classroom50/commit/be1c1c138b263f19d973767cad3dc6c5f6d512b3))
* **web:** add shift-click range selection to roster and member tables ([#138](https://github.com/foundation50/classroom50/issues/138)) ([20fd606](https://github.com/foundation50/classroom50/commit/20fd60648983288ca5b6525f3749a4340cce2da2))
* **web:** edit assignment language runtimes and prevent runtime conflicts ([#128](https://github.com/foundation50/classroom50/issues/128)) ([6a3899e](https://github.com/foundation50/classroom50/commit/6a3899e98a9c70ba93d311f03660490d0a81119b))
* **web:** improve teacher assignment and submissions views ([#123](https://github.com/foundation50/classroom50/issues/123)) ([f7221d7](https://github.com/foundation50/classroom50/commit/f7221d7f2e8fcae61709e6201d690a73659a8ef7))
* **web:** link org name in page headings to github.com ([#142](https://github.com/foundation50/classroom50/issues/142)) ([62b25ca](https://github.com/foundation50/classroom50/commit/62b25cac90928d16f74a010f81c937089ef0838e))
* **web:** make classroom enrollment team-authoritative ([#125](https://github.com/foundation50/classroom50/issues/125)) ([a677ccf](https://github.com/foundation50/classroom50/commit/a677ccf25a19bedcd5280dba6d52db42fc2a8ea2))
* **web:** make skeleton-drift banner self-service ([#136](https://github.com/foundation50/classroom50/issues/136)) ([c0477c7](https://github.com/foundation50/classroom50/commit/c0477c73eff54c96ffc395eddca38e84be1eba19))
* **web:** org-level bulk membership management ([#70](https://github.com/foundation50/classroom50/issues/70) Phase 1) ([#117](https://github.com/foundation50/classroom50/issues/117)) ([28b7c99](https://github.com/foundation50/classroom50/commit/28b7c9934263eee6015075384ee1abd162c608c5))
* **web:** overhaul the classroom roster to reuse the org-members model ([#126](https://github.com/foundation50/classroom50/issues/126)) ([7f7610c](https://github.com/foundation50/classroom50/commit/7f7610c3f5c6ad260d21ce9693bdb88ccc5091c7))
* **web:** polish the student assignment-acceptance view ([#122](https://github.com/foundation50/classroom50/issues/122)) ([d845204](https://github.com/foundation50/classroom50/commit/d84520435254ba339c16d7747e6dce1c5d0941d2))


### Bug Fixes

* **web:** bound GitHub client requests with a default timeout ([#119](https://github.com/foundation50/classroom50/issues/119)) ([cdd7f95](https://github.com/foundation50/classroom50/commit/cdd7f95d504aaa8366162d2db13e18190c0d104f))
* **web:** stop stranding users across the auth flow ([#124](https://github.com/foundation50/classroom50/issues/124)) ([19df339](https://github.com/foundation50/classroom50/commit/19df3392eea144fc833a52a9ed8e80a595150615))
* **web:** surface a warning when re-adding an already-enrolled student ([#137](https://github.com/foundation50/classroom50/issues/137)) ([afea0f3](https://github.com/foundation50/classroom50/commit/afea0f35d36048772bdac7f74ef7f19409e9760d))
* **web:** surface real GitHub 403 cause for template access; block cross-org private forks ([#79](https://github.com/foundation50/classroom50/issues/79)) ([#118](https://github.com/foundation50/classroom50/issues/118)) ([26d4e28](https://github.com/foundation50/classroom50/commit/26d4e2833cb980424c82dcc40be9174bbfce80d8))
* **web:** trigger preview Pages deploy after publish ([#121](https://github.com/foundation50/classroom50/issues/121)) ([e0d4ec8](https://github.com/foundation50/classroom50/commit/e0d4ec876aa85bf55faae1c300c1df09332cbe98))
* **web:** write students.csv header on an empty roster; make regrade team-driven ([#133](https://github.com/foundation50/classroom50/issues/133)) ([19f9dc9](https://github.com/foundation50/classroom50/commit/19f9dc9b3fee79d566854744ff5267e890071d11))

## [1.1.0](https://github.com/foundation50/classroom50/compare/web-v1.0.0...web-v1.1.0) (2026-07-04)


### Features

* **web:** add docs link to logged-in account menu ([#91](https://github.com/foundation50/classroom50/issues/91)) ([#94](https://github.com/foundation50/classroom50/issues/94)) ([ae967f4](https://github.com/foundation50/classroom50/commit/ae967f4cb7ecc7cf3e3ca0540c020572fbc10b60))
* **web:** global GitHub Actions activity banner ([#98](https://github.com/foundation50/classroom50/issues/98)) ([2362f8e](https://github.com/foundation50/classroom50/commit/2362f8e7edb4a7b2ddc2dcdcff34691df6e309fd))
* **web:** localize relative timestamps to the active language ([#100](https://github.com/foundation50/classroom50/issues/100)) ([b78a768](https://github.com/foundation50/classroom50/commit/b78a76866bd104b6ba68b0204e16b8806eafeb01))
* **web:** silently auto-update installed language packs on startup ([#104](https://github.com/foundation50/classroom50/issues/104)) ([1f31521](https://github.com/foundation50/classroom50/commit/1f3152124f404107d2eb8813dabce4cce6d9b2cf))
* **web:** surface skeleton drift and bump skeleton action pins ([#90](https://github.com/foundation50/classroom50/issues/90)) ([2e6314f](https://github.com/foundation50/classroom50/commit/2e6314fc85ee05ee870d276f30efc7b515050af2)), closes [#88](https://github.com/foundation50/classroom50/issues/88)


### Bug Fixes

* **web:** match ConfirmModal cancel button to its description copy ([#93](https://github.com/foundation50/classroom50/issues/93)) ([240484b](https://github.com/foundation50/classroom50/commit/240484b3229d606cfa9a4bdff274e4dda6596f92))

## [1.0.0](https://github.com/foundation50/classroom50/releases/tag/web-v1.0.0) (2026-07-03)

First versioned release of the web app.

### Features

- Runtime internationalization (i18n) with sideloadable language packs, letting the UI be localized and extended without a rebuild.
- Bedrock-backed translation pipeline plus built-in localization UX for generating and maintaining language packs (#61).
- Locale translation prompt and integrity checker to keep translations consistent (#59).
- Language-pack patching from the `en.json` diff instead of full regeneration, so updates only touch changed strings (#69).
- Build version stamp: the running app reports its version, commit, and build date, shows a version badge in the sign-in card footer, and adds an **About** item to the profile menu (version linked to its GitHub release, commit to the source commit).

### Bug Fixes

- Return to the originally requested deep link after a forced sign-in, instead of dropping the user on a default page (#71).
- SSO-aware, fail-open org-membership gate on assignment accept, so SAML SSO orgs no longer incorrectly block valid members (#66).
- Sign out and redirect cleanly when a GitHub token is revoked or expired, rather than leaving the app in a broken authenticated state (#45).
- Pin the OAuth `redirect_uri` to the registered `/login` callback to avoid redirect-URI mismatches (#58).

### Security

- Added `SECURITY.md` with a private vulnerability reporting process (#50).
