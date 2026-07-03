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
