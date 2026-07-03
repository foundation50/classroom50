# Security Policy

Thanks for helping keep Classroom 50 and its users safe. This project is an
open-source, client-side [GitHub Classroom](https://classroom.github.com/)
alternative supported by the [Fifty Foundation](https://fifty.foundation/): there is no
backend, and all state lives in GitHub repos and config files. Most security
concerns therefore relate to the CLI extensions, the web app, the autograder
workflows, or the tokens they use.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, report them privately through GitHub's
[private vulnerability reporting](https://github.com/foundation50/classroom50/security/advisories/new).
This opens a private advisory visible only to you and the maintainers.

When reporting, please include as much of the following as you can:

- The component affected (`gh-teacher`, `gh-student`, `web`, autograder
  workflows/scripts, schemas, or CI).
- A description of the issue and its impact.
- Steps to reproduce, a proof of concept, or affected code paths.
- Any suggested remediation, if you have one.

**Never include real tokens, secrets, or private student data in a report.**
Redact them and describe the exposure instead.

## What to expect

- We aim to acknowledge new reports within a few business days.
- We will keep you informed as we investigate and work on a fix.
- Once a fix is available, we will coordinate disclosure and credit you in the
  advisory unless you prefer to remain anonymous.

## Scope

In scope:

- The CLI extensions (`cli/gh-teacher`, `cli/gh-student`, `cli/shared`).
- The web app (`web/`).
- The autograder runner, skeleton workflows, and scripts scaffolded into
  teacher config repos.
- The reusable workflows in `.github/workflows/` and their handling of secrets.

Out of scope:

- Vulnerabilities in GitHub itself (report those to
  [GitHub](https://bounty.github.com/)).
- Issues that require a compromised GitHub account, org owner, or already-leaked
  token to exploit.
- Findings from automated scanners without a demonstrated, realistic impact.

## Supported versions

Classroom 50 is under active development and ships from `main`. Security fixes
are applied to the latest release of the CLI extensions and the deployed web
app; we do not backport to older tags.
