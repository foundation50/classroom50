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
