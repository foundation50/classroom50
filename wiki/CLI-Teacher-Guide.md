# CLI Teacher Guide

An end-to-end walkthrough of the `gh teacher` CLI. Each step builds on the last.
[Install the CLI](Installation) first.

For every command and flag, see the [`gh teacher` reference](gh-teacher).

**The path:**

1. [Create a GitHub organization](#1-create-a-github-organization) (on github.com).
2. [Log in](#2-log-in).
3. [Set up the organization](#3-set-up-the-organization) (`gh teacher init`).
4. [Add a classroom](#4-add-a-classroom).
5. [Invite students](#5-invite-students).
6. [Track students in the roster](#6-track-students-in-the-roster).
7. [Add assignments](#7-add-assignments).
8. [Remove people when needed](#8-remove-people-when-needed).
9. [Collect scores](#9-collect-scores).
10. [Download submissions](#10-download-submissions).

## 1. Create a GitHub organization

The CLI doesn't create the organization for you. Do this once on github.com:

1. **Create the organization** at <https://github.com/account/organizations/new>.
2. **(Optional) Create a template repository** for assignments that ship starter
   code. Flag it as a template in **Settings → Template repository**. See
   [Assignment Templates](Assignment-Templates) for the expected layout.

> [!NOTE]
> **Template visibility.** A **public** template always works. A **private**
> template works only if it's **inside your organization** — `gh teacher
> assignment add` grants the classroom's team read access to it. A private
> template **outside** your organization is rejected. (Enterprise Cloud's
> "internal" visibility also works.)

`gh teacher init` (step 3) locks down organization member privileges for you.
Four settings have no API and are listed as a manual checklist in that step.

## 2. Log in

```sh
gh teacher login
```

![gh teacher login](images/gh_teacher_auth.gif)

This runs `gh auth login` with the scopes the teacher commands need
(`admin:org`, `read:org`, `repo`, `workflow`) and opens a browser to authorize.
It's the same scope set `gh student login` requests, so one sign-in covers both
CLIs.

> [!NOTE]
> If you skip this, the CLI logs you in automatically on first use. If your
> existing token lacks a required scope, the affected command fails with a
> message telling you to run `gh teacher login`.

## 3. Set up the organization

Run once per organization to create `<org>/classroom50`, the private config repo
that holds classroom metadata, published assignment manifests, and collected
scores:

```sh
CLASSROOM50_SERVICE_TOKEN=github_pat_... gh teacher init <org>
```

Or omit the variable and `init` prompts for the token:

```sh
gh teacher init <org>
```

`init` is **idempotent** — re-running picks up where a prior run left off. It
also offers to refresh skeleton files when the CLI ships newer versions (this is
how an existing organization gains new features); it asks before overwriting, so
your edits are safe. Use `--yes` to skip the prompt in scripts.

**Useful flags:**

| Flag | Purpose |
| --- | --- |
| `--dry-run` | Run read-only preflight checks and list planned steps without changing anything. Run this once first to catch problems early. |
| `--json` | Emit a machine-readable summary (implies `--quiet`). Lets a script check "any manual steps pending?" and "is the org ready?". |
| `--quiet` / `-q` | Drop per-step progress; keep warnings and the final summary. |
| `--yes` | Skip the skeleton-refresh confirmation. |

<details>
<summary>What <code>init</code> configures</summary>

`init` applies a least-privilege lockdown of organization member privileges (the
only member capabilities left on are private-repo creation, so `gh student
accept` works, and public Pages creation, so the config repo can publish),
enables GitHub Actions, creates the private `classroom50` repo, commits the
skeleton workflows and scripts, enables GitHub Pages (public, so students and
the autograder can fetch published files), protects the default branch, raises
workflow token permissions, allows reusable-workflow access, and uploads the
service token secret.

This lockdown is what makes it safe for `gh student accept` to leave each
student as **admin** of their own repository: they need admin to manage
collaborators, and the organization-level locks remove the dangerous repo-admin
powers (delete, transfer, visibility change) org-wide.

</details>

### Create the service token

`init` provisions a repo secret named `CLASSROOM50_SERVICE_TOKEN`, used by the
score-collection and regrade workflows. Create it from **your own** GitHub
account (there's no separate service account) and scope it tightly to this
organization.

Create a **fine-grained personal access token** at **Settings → Developer
settings → Personal access tokens → Fine-grained tokens → Generate new token**:

1. **Token name** — e.g. `classroom50-<org>`.
2. **Resource owner** — select **the organization**. This is critical: the token
   can only reach repos owned by the resource owner you pick.
3. **Expiration** — up to 1 year. Set a reminder to rotate it.
4. **Repository access** — **All repositories**. Student repos are created on
   demand, so "Only select repositories" silently misses them.
5. **Repository permissions** — **Contents: Read and write**, **Actions: Read
   and write**, **Administration: Read and write**. (Metadata: Read is added
   automatically.)
6. **Organization permissions** — **Members: Read**. This is a separate section
   that appears only after you pick the org as resource owner. It lets score
   collection list the classroom team.
7. **Generate** and copy the `github_pat_…` value.

> [!NOTE]
> Because `gh teacher init` requires you to be an **organization owner**, a
> token you create is auto-approved even if your org requires approval for
> fine-grained PATs.

**Supply the token** via the `CLASSROOM50_SERVICE_TOKEN` environment variable or
the interactive prompt — there is no `--token` flag (command-line tokens leak
via shell history). `init` validates the token against your organization before
storing it. On a re-run, an existing secret is left untouched; to replace it, set
the variable and re-run, or use `gh teacher rotate-service-token <org>`.

<details>
<summary>Verify the full token scope after provisioning</summary>

`init`'s validation is a cheap pre-store check. For an exhaustive, read-only
check, run the probe workflow after `init`/`rotate` (or any time collect/regrade
returns 401/403):

```sh
gh workflow run probe-token.yaml --repo <org>/classroom50
```

A green run confirms every scope; a red run's log names the missing scope(s). It's
side-effect free.

</details>

Rotate before expiry:

```sh
gh teacher rotate-service-token <org>
```

### Manual organization hardening (one-time)

Four member-privilege settings have **no API**, so `init` can't set them (it
prints this same reminder). Apply them once at
**Org → Settings → Member privileges**
(`https://github.com/organizations/<org>/settings/member_privileges`):

- [ ] **App access requests** → "Members only" (or disable).
- [ ] **Uncheck** "Allow repository admins to install GitHub Apps for their
      repositories".
- [ ] **Projects base permissions** → "No access".
- [ ] **Uncheck** "Allow repository administrators to rename branches protected
      by organization rules". (Defense-in-depth; the config repo's rulesets
      already protect submission history.)

> [!NOTE]
> **Plan check.** `init` warns if the organization isn't on Team or Enterprise
> Cloud (needed for Pages from a private repo). The warning is advisory.

### Audit the lockdown

Any time, confirm the organization is still locked down:

```sh
gh teacher audit <org>
```

It's **read-only** and reports, per setting, whether the least-privilege value is
in effect: **Verified** (read from the API), **Action required** (drifted), and
**Confirm by hand** (the four API-less settings above). It exits non-zero when a
critical field is unenforced, so it's scriptable; add `--json` for a
machine-readable report.

When `init` finishes, it prints the future Pages URL
(`https://<org>.github.io/classroom50/`) and suggests adding a classroom next.

## 4. Add a classroom

> [!TIP]
> **Migrating from GitHub Classroom?** Replace steps 4 and 7 with
> `gh teacher classroom migrate --source <id-or-org> --target <org>`. It copies
> each starter repo into your organization as a fresh template and commits the
> classroom in one go. Roster and scores aren't migrated. Pass `--dry-run`
> first. See [`gh teacher classroom migrate`](gh-teacher#classroom-migrate).

Each classroom is a directory in `<org>/classroom50` holding four files:

| File | Purpose |
| --- | --- |
| `classroom.json` | Name, term, and organization metadata. |
| `assignments.json` | The assignment manifest (published via Pages; read by `gh student accept` and the autograde runner). |
| `roster.csv` | The roster (private). |
| `scores.json` | Collected scores (private). |

Optionally, add grading logic later:

- `<classroom>/autograder.py` — the **classroom default autograder**, used by
  every assignment without its own. Install it with `gh teacher autograder
  set-default`.
- `<classroom>/autograders/<slug>/` — **per-assignment overrides**.

Create a classroom:

```sh
gh teacher classroom add <org> <short-name> --name "<full name>" --term <term>
gh teacher classroom add cs50-fall-2026 cs-principles --name "CS Principles" --term Spring-2026
```

The `<short-name>` must match `^[a-z0-9][a-z0-9-]{1,38}$` (2–39 characters,
lowercase letters/digits/hyphens, starting with a letter or digit), because it
becomes part of student repo names like `<short-name>-<assignment>-<username>`.
`--name` and `--term` are optional but recommended.

This commits the four files and creates a **GitHub team** named
`classroom50-<short-name>` that grants rostered students read access to in-org
private templates. Run it once per classroom; you can have several side by side.

**Manage classrooms later:**

- List: `gh teacher classroom list <org>` (add `--json` for name and term).
- Rename/retag: `gh teacher classroom edit <org> <short-name> --name "…" --term …`
  (the short-name itself is immutable).
- Delete: `gh teacher classroom remove <org> <short-name>` — removes the config
  directory and the team, but **not** student repos.

## 5. Invite students

The fastest way to add students is `gh teacher roster add` (next step) — it
rosters them *and* sends an organization invite. Use bare `gh teacher invite`
only for ad-hoc cases, like inviting a TA who isn't a student:

```sh
gh teacher invite <org> <username>
```

![gh teacher invite](images/gh_teacher_invite.gif)

The student gets an email invitation, or `gh student accept` auto-accepts the
pending invite when they accept their first assignment.

**Other targets:**

```sh
gh teacher invite --admin <org> <username>              # invite as org admin (e.g. a TA)
gh teacher invite <org>/<repo> <username>               # invite to one repo (default: push)
gh teacher invite -p maintain <org>/<repo> <username>   # other permissions
```

`-p` accepts `pull`, `triage`, `push`, `maintain`, `admin`. Re-running updates
the collaborator's permission in place.

## 6. Track students in the roster

Each classroom keeps a `roster.csv`. The CLI manages it — you rarely hand-edit
it.

> [!NOTE]
> **Renamed from `students.csv`.** Older classrooms are still read
> automatically, but new writes target `roster.csv`. Convert one with
> `gh teacher roster migrate <org> <classroom>`.

**Add or update one student:**

```sh
gh teacher roster add <org> <classroom> <username> [--first-name <n>] [--last-name <n>] [--email <addr>] [--section <id>]
gh teacher roster add cs50-fall-2026 cs-principles alice --first-name Alice --email alice@example.edu --section section-1
```

Resolves the student's numeric `github_id`, upserts the row (case-insensitive by
username), sends an organization invite if needed, and adds the student to the
classroom team (so they can read in-org private templates). Re-running is safe.

**Correct an existing student's details:**

```sh
gh teacher roster update <org> <classroom> <username> [--email <addr>] ...
```

Use `update` to fix a field on someone already on the roster. Only the flags you
pass change; everything else (including `github_id`) is preserved. Unlike `add`,
it's roster-only: no invite, no `github_id` lookup. Pass `--email ""` to clear an
address.

**Bulk import from a CSV:**

```sh
gh teacher roster import <org> <classroom> <path-to-csv>
```

Accepts a header of `username,first_name,last_name,email,section` (a trailing
`github_id` column is accepted but ignored, since the CLI re-resolves each ID
from GitHub). Every username is resolved up front; one typo aborts the whole
import before any commit. New students are invited.

**View the roster:**

```sh
gh teacher roster list <org> <classroom>            # aligned table
gh teacher roster list <org> <classroom> --json     # for scripting
gh teacher roster list <org> <classroom> --quiet    # one username per line
```

**Remove a student from the roster:**

```sh
gh teacher roster remove <org> <classroom> <username>
```

> [!NOTE]
> This does **not** remove organization membership — use `gh teacher remove`
> (step 8) for that. Splitting the two is deliberate: a roster edit shouldn't be
> able to revoke a student's access to every repo in the organization.

> [!NOTE]
> Roster writes use an optimistic-rebase loop, so two teachers editing at once
> can't lose each other's work. If you see `lost the rebase race`, retry.

## 7. Add assignments

Each classroom keeps an `assignments.json`. Register an assignment:

```sh
gh teacher assignment add <org> <classroom> <slug> --name "<name>" [flags]
gh teacher assignment add cs50-fall-2026 cs-principles hello --name "Hello" --template cs50/hello-template --due 2026-09-15T23:59:00-04:00
gh teacher assignment add cs50-fall-2026 cs-principles reflection --name "Reflection"   # no template → empty starter repo
```

**`--name` is required; `--template` is optional.** Omit `--template` for a
template-less assignment (students get an empty repo with just the autograder
shim). The slug must match `^[a-z0-9][a-z0-9-]{1,38}$`.

**Optional flags:**

| Flag | Purpose |
| --- | --- |
| `--template <owner>/<repo>[@branch]` | Starter-code repository (must be flagged as a template). Branch defaults to the template's default. |
| `--description <text>` | Short description. |
| `--due <ISO-8601>` | Due date, e.g. `2026-09-15T23:59:00-04:00`. Stored as UTC; local timezone assumed if you omit the offset. A bare date with no time is rejected. |
| `--mode individual\|group` | `individual` (default) or `group`. Group requires `--max-group-size`. |
| `--max-group-size <N>` | Max collaborators on a group repo (2–100). Advisory, not hard-enforced. |
| `--runtime <path>` | JSON describing the autograde environment (`runs-on`, language versions, `apt`, or a `container`). Omit for ubuntu-latest + Python 3.12. See [Autograders](Autograders). |
| `--autograder <name>` | Reserved for swapping the whole reusable workflow (rare). Use `--runtime` for language toolchains. |

> [!NOTE]
> **Custom grading isn't registered here.** Drop an `autograder.py` at
> `<classroom>/autograders/<slug>/` in the config repo, or set a classroom
> default with `gh teacher autograder set-default`. See [Autograders](Autograders).

Re-running with the same slug replaces the entry in place; new slugs append.

**Remove an assignment:**

```sh
gh teacher assignment remove <org> <classroom> <slug>
```

This does **not** touch existing student repos — only new `gh student accept`
calls stop finding the slug.

**List assignments:**

```sh
gh teacher assignment list <org> <classroom>            # one slug per line
gh teacher assignment list <org> <classroom> --json     # full entries
```

## 8. Remove people when needed

```sh
gh teacher remove <org> <username>           # remove from the organization
gh teacher remove <org>/<repo> <username>    # remove from one repo
```

The org form revokes access to every repo, removes the user from all teams, and
cancels any pending invitation. Both forms are idempotent.

**Check who's actually a member** (the roster is the *intended* list; this is
*actual* GitHub membership):

```sh
gh teacher member list <org>         # org members + pending invitations
gh teacher member list <org>/<repo>  # repo collaborators
```

## 9. Collect scores

Every submission publishes a GitHub Release carrying a `result.json`. The
`collect-scores` workflow walks every `(student, assignment)` pair, collects each
repo's submissions, and aggregates them into `<classroom>/scores.json` — the
class's authoritative gradebook.

Run it from the Actions tab on `<org>/classroom50`, or from your shell:

```sh
gh workflow run collect-scores.yaml --repo <org>/classroom50
gh workflow run collect-scores.yaml --repo <org>/classroom50 -f classroom=cs-principles   # one classroom
```

The workflow also runs nightly (`17 4 * * *` UTC), so scores land daily even if
you never trigger it. To disable that, comment out the `schedule:` block in
`.github/workflows/collect-scores.yaml`.

<details>
<summary>What each collection run does</summary>

1. Iterates each classroom (or just the one you passed).
2. For each `(student, assignment)` pair, computes the repo name
   `<classroom>-<assignment>-<username>` and walks its `submit/*` releases. No
   releases means the student hasn't accepted or submitted yet.
3. Downloads and schema-validates each `result.json`, checking its identity
   against the source repo (a hostile payload can't land in another student's
   scores). For a group assignment, it reads the repo's collaborators and
   records the credited members.
4. Upserts the results into `scores.json`, newest first. If the assignment has a
   `due`, each submission is marked `late` or not. Entries flagged
   `"override": true` are preserved verbatim.
5. Logs a per-assignment `cs-principles/hello: 23/30 submitted` line.
6. Commits the updated `scores.json`. A no-op run produces no commit.

</details>

> [!NOTE]
> **Override a score.** To grant partial credit or fix a misgrade, edit
> `<classroom>/scores.json`, change the submission's `score`, add
> `"override": true` to the entry, and commit. Later collection runs leave it
> alone.

> [!WARNING]
> If the service token expires mid-semester, collection fails with a 401/403.
> Rotate it with `gh teacher rotate-service-token <org>`.

**Group assignments** are graded once, in the founder's repo. Collection reads
that repo's collaborators, keeps those on the classroom team, and credits each
with the same score. See [Autograders](Autograders#group-attribution-model) for
the full attribution model.

## 10. Download submissions

Pull every student's latest submission for an assignment:

```sh
gh teacher download <org> <classroom> <assignment>
```

![gh teacher download](images/gh_teacher_download.gif)

By default this is **team-driven**: it lists the classroom team's members, and
for each one probes for the expected repo, clones it (or reports `Missing:
<username>`), and refreshes `result.json` (latest submission) and `results.json`
(all submissions) from the repo's releases.

It then writes a `scores.csv` at the destination root, **one line per
submission** (a student with several pushes contributes several lines), plus a
blank-score line for each non-submitter, so you can sort by
score to see who hasn't submitted.

Each run creates a fresh timestamped folder. Override the destination with `-d`:

```sh
gh teacher download -d <dir> <org> <classroom> <assignment>
```

> [!NOTE]
> **Unconfigured classrooms.** If the config repo isn't bootstrapped, or you
> want every matching repo regardless of the roster, pass `--by-pattern`. It
> clones every repo whose name starts with `<classroom>-<assignment>-` and skips
> the `result.json` refresh and `scores.csv` summary.

## See also

- [`gh teacher` reference](gh-teacher) — every command and flag.
- [Troubleshooting](Troubleshooting) — debug flags and common errors.
