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

## 1.11.0

Automated releases start here. CLI versions through `cli-v1.11.0` were cut by
hand (tags aligned to the matching web release commit) before this track
existed, so they are not itemized above; see the git history and the per-tag
Releases on the `gh-teacher` / `gh-student` repos for those. release-please
compiles every entry from this point forward.
