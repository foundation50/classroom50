# Changelog

All notable changes to the Classroom 50 **web app** (classroom50.org) are
documented here. The CLI extensions (`gh-teacher`, `gh-student`) have their own
release track and are not covered by this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut by tagging a `main` commit `web-vX.Y.Z` (see
`web/package.json` for the current version and `.github/workflows/web-release.yaml`
for the release automation). Add new entries under **[Unreleased]** as work
lands on `preview`, then rename that section to the version and date when a
release is tagged.

## [Unreleased]

## [1.0.0] - 2026-07-03

First versioned release of the web app.

### Added

- Runtime internationalization (i18n) with sideloadable language packs, letting
  the UI be localized and extended without a rebuild.
- Bedrock-backed translation pipeline plus built-in localization UX for
  generating and maintaining language packs (#61).
- Locale translation prompt and integrity checker to keep translations
  consistent (#59).
- Language-pack patching from the `en.json` diff instead of full regeneration,
  so updates only touch changed strings (#69).
- Build version stamp: the running app reports its version, commit, and build
  date (surfaced in the browser console; see `web/src/version.ts`), shows a
  version badge in the sign-in card footer (`v<version> · <commit>`), and adds
  an **About** item to the profile menu with the version linked to its GitHub
  release and the commit linked to the source commit.

### Fixed

- Return to the originally requested deep link after a forced sign-in, instead
  of dropping the user on a default page (#71).
- SSO-aware, fail-open org-membership gate on assignment accept, so SAML SSO
  orgs no longer incorrectly block valid members (#66).
- Sign out and redirect cleanly when a GitHub token is revoked or expired,
  rather than leaving the app in a broken authenticated state (#45).
- Pin the OAuth `redirect_uri` to the registered `/login` callback to avoid
  redirect-URI mismatches (#58).

### Security

- Added `SECURITY.md` with a private vulnerability reporting process (#50).

[Unreleased]: https://github.com/foundation50/classroom50/compare/web-v1.0.0...HEAD
[1.0.0]: https://github.com/foundation50/classroom50/releases/tag/web-v1.0.0
