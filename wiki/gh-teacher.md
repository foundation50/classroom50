# `gh teacher` reference

Every command and flag for the teacher CLI. For a walkthrough, see the
[CLI Teacher Guide](CLI-Teacher-Guide).

Run `gh teacher <command> --help` for the live flag list. Errors go to stderr
with a non-zero exit code. Pass `--quiet` / `-q` to suppress informational
output, or `--verbose` / `-v` for per-step detail.

## Commands at a glance

| Command | Description |
| --- | --- |
| `whoami` | Print the authenticated GitHub user. |
| `login` | Log in with the Classroom 50 scopes (`admin:org`, `read:org`, `repo`, `workflow`). Add scopes with `-s` (e.g., `delete_repo`). |
| `logout` | Log out via `gh auth logout`. |
| `init <org>` | Set up `<org>/classroom50` (org lockdown, repository, Pages, branch protection, service token). Idempotent. |
| `audit <org>` | Read-only audit of the org member-privilege lockdown. |
| `rotate-service-token <org>` | Replace the `CLASSROOM50_SERVICE_TOKEN` secret. |
| `classroom add <org> <short-name>` | Add a classroom. Flags: `--name`, `--term`, `--unlisted`, `--key`. |
| `classroom list <org>` | List classrooms. Flags: `--all`, `--json`, `--quiet`. |
| `classroom edit <org> <short-name>` | Update a classroom's name/term. |
| `classroom archive` / `unarchive <org> <short-name>` | Archive or restore a classroom. |
| `classroom remove <org> <short-name>` | Delete a classroom's config directory (not student repos). |
| `classroom migrate --source <id-or-org> --target <org>` | Import a GitHub Classroom. |
| `roster list <org> <classroom>` | List roster rows. Flags: `--json`, `--quiet`. |
| `roster add <org> <classroom> <username>` | Add/upsert a student; invites them. |
| `roster invite <org> <classroom> <email>` | Invite one student by email. Flags: `--first-name`, `--last-name`, `--section`. |
| `roster cancel-invite <org> <classroom> <email>` | Revoke a pending email invitation and clear what it left behind. |
| `roster sync <org> <classroom>` | Reconcile the roster with GitHub. Dry run; `--write` applies. |
| `roster update <org> <classroom> <username>` | Correct fields on an existing row (roster-only). |
| `roster remove <org> <classroom> <username>` | Remove a roster row (not org membership). |
| `roster import <org> <classroom> <csv>` | Bulk upsert from a CSV. |
| `staff add` / `remove <org> <classroom> <username>` | Manage staff teams (`--role teacher\|hta\|ta`). |
| `assignment add <org> <classroom> <slug>` | Register/upsert an assignment. |
| `assignment reuse <org> <slug> --from <src> --to <dst>` | Copy an assignment into another classroom. |
| `assignment remove <org> <classroom> <slug>` | Remove an assignment entry. |
| `assignment list <org> <classroom>` | List assignment slugs. Flags: `--json`, `-q`. |
| `assignment submission-mode <org> <classroom> <slug> --tag\|--every-push` | Change when the autograder fires and retrofit existing repos' shims. |
| `assignment lock <org> <classroom> <slug>` | Lock (or `--unlock`) an assignment against student access. |
| `assignment feedback-pr <org> <classroom> <assignment>` | Open or repair the Feedback PR on every student repo. Flags: `--user`, `-q`. |
| `assignment test add/list/remove` | Manage an assignment's declarative tests. |
| `autograder set-default <org> <classroom>` | Install/replace the classroom default `autograder.py`. |
| `autograder show/list/remove <org> <classroom>` | Inspect or delete autograders. |
| `invite <org>[/<repo>] <username>` | Invite to an org or repo. |
| `remove <org>[/<repo>] <username>` | Remove from an org or repo. |
| `member list <org>[/<repo>]` | List actual members/collaborators. |
| `download <org> <classroom> <assignment>` | Clone submissions and write `scores.csv`. |
| `teardown <org>` | Delete every repo in a Classroom 50 org (dev reset). |

## `init`

One-time bootstrap for the per-org `classroom50` repository. See the
[CLI Teacher Guide](CLI-Teacher-Guide#3-set-up-the-organization) for when to run
it.

```sh
CLASSROOM50_SERVICE_TOKEN=github_pat_... gh teacher init <org>
gh teacher init <org>              # interactive token prompt
gh teacher init <org> --dry-run    # preview, no changes
gh teacher init <org> --json       # machine-readable summary
gh teacher init <org> --yes        # skip the workflow-refresh prompt
```

Idempotent: re-running resumes where a prior run stopped and offers to refresh
stale workflow files (after a confirmation prompt).

<details>
<summary>Steps <code>init</code> performs, in order</summary>

1. **Org plan check** — warns if not on Team/Enterprise Cloud (Pages from a
   private repo). Advisory.
2. **Tighten member defaults** — `default_repository_permission: none`, plus
   private-repo creation enabled so `gh student accept` works. On a plan-gated
   rejection it retries per policy and warns per field.
3. **Enable org Actions** — turns Actions on if it's off org-wide.
4. **Set the $0 Actions budget cap** — stops paid overage; applied only when
   the org has no budget yet. Advisory.
5. **Allow Actions to create pull requests** — org-wide, so the autograde
   runner can open Feedback PRs.
6. **Install branch rulesets** — two org-wide rulesets protecting submission
   history and the frozen Feedback PR base. See
   [How student repositories are protected](How-Classroom-50-Works#how-student-repositories-are-protected).
7. **Create or fetch the `classroom50` repository** — private, with `auto_init`.
8. **Enable repo-level Actions** — on the `classroom50` repository itself.
9. **Commit or refresh workflow and script files** — commits the embedded
   workflows and scripts; on re-runs, refreshes stale files after confirmation
   (`--yes` skips).
10. **Enable Pages** — public, so students and the runner can fetch published
    files unauthenticated.
11. **Branch protection** — no force-push or deletion on the default branch.
12. **Workflow permissions** — raises `GITHUB_TOKEN` to write.
13. **Reusable-workflow access** — lets student shims call the runner workflow.
14. **Service token** — validates and uploads `CLASSROOM50_SERVICE_TOKEN`.

</details>

**Service token:** a fine-grained PAT `init` validates and uploads as the
`CLASSROOM50_SERVICE_TOKEN` secret. See the
[walkthrough](CLI-Teacher-Guide#create-the-service-token) in the CLI Teacher
Guide and the
[permission table](GitHub-Integration#4-fine-grained-pat-for-score-collection)
in GitHub Integration.

<details>
<summary>Workflow and script files shipped into the <code>classroom50</code> repository</summary>

| Path | Purpose |
| --- | --- |
| `.github/workflows/publish-pages.yaml` | Publishes allow-listed files to Pages. |
| `.github/workflows/collect-scores.yaml` | `workflow_dispatch` + nightly cron score collection. |
| `.github/workflows/probe-token.yaml` | Read-only service-token health check. |
| `.github/workflows/autograde-runner.yaml` | Reusable workflow called by every student repo. |
| `.github/workflows/regrade.yaml` | Teacher-triggered regrade: re-runs each targeted repo's latest autograde run against the current autograder, without creating a new submission. |
| `.github/scripts/runner.py` | Grading bootstrap fetched from Pages each submission. |
| `.github/scripts/collect_scores.py` | Team-driven score collector. |
| `.github/scripts/probe_token.py` | Service-token scope probe. |
| `.github/scripts/ensure_feedback_pr.py` | Feedback PR maintainer run by the autograde runner. |
| `.github/scripts/materialize_tests.py` | Writes each assignment's declarative `tests` block to a `tests.json` before publishing to Pages. |
| `.github/scripts/regrade_repos.py` | Fan-out driver behind `regrade.yaml`. |
| `README.md` | Describes the `classroom50` repository layout. |

Both collection and regrade are **team-driven**: the classroom GitHub teams are
the source of truth for enrollment. Collection polls the student team plus the
staff teams (teacher/hta/ta), so a staff member who accepted an assignment (to
test the autograde flow) is collected like a student; staff who never accepted
have no repo and produce no entry.

</details>

## `audit`

Read-only audit of the org member-privilege lockdown. Makes no changes.

```sh
gh teacher audit <org>
gh teacher audit <org> --json
```

Classifies each in-scope setting as **Verified** (API value matches the
lockdown), **Action required** (changed outside Classroom 50, with the fix), or **Confirm by hand**
(the four settings GitHub exposes no API to read). Exits non-zero when any
API-readable field is unenforced, so `gh teacher audit <org> && …` is safe in
scripts. `--json` emits `{org, plan, read_ok, lockdown_complete, enforced,
unenforced, manual_unreadable, budget_cap, settings_url}`.

## `rotate-service-token`

Replaces the `CLASSROOM50_SERVICE_TOKEN` secret in place. Use when the PAT nears
expiry or after a suspected compromise.

```sh
CLASSROOM50_SERVICE_TOKEN=github_pat_... gh teacher rotate-service-token <org>
gh teacher rotate-service-token <org>
```

The token is validated against the organization before it's stored. Fails
clearly if `<org>/classroom50` doesn't exist.

## `classroom`

Classrooms are root-level directories in `<org>/classroom50`, each with a
`classroom.json`.

### `classroom add`

```sh
gh teacher classroom add <org> <short-name> [--name "<full name>"] [--term <term>] [--unlisted] [--key <key>]
gh teacher classroom add cs50-fall-2026 cs-principles --name "CS Principles" --term Fall-2026
```

**Short-name rules:** `^[a-z0-9][a-z0-9-]{1,38}$` — 2–39 characters, lowercase
letters/digits/hyphens, starting with a letter or digit. It becomes part of
student repo names (`<short-name>-<assignment>-<username>`).

`--unlisted` publishes the classroom's resources at an unguessable URL path
segment (the web app's "Use an unlisted link" option — obscurity, not access
control; it prompts to accept a generated key). `--key <key>` supplies a
specific access key instead of the generated one (implies `--unlisted`).

Scaffolds four files in one commit — `classroom.json`, `assignments.json`,
`roster.csv`, `scores.json` — and creates the `classroom50-<short-name>` GitHub
team (plus the `classroom50-<short-name>-{teacher,hta,ta}` staff teams). Refuses to overwrite an existing
classroom.

<details>
<summary>What the scaffold does and doesn't include</summary>

The `roster.csv` header is
`username,first_name,last_name,email,section,github_id,role`. `github_id` is
CLI-managed (don't hand-edit it), and `role` is best-effort metadata refreshed
from the classroom's GitHub teams (the teams, not this column, remain the role
authority).

Not included: the shared runner bootstrap (landed once by `init`), any
autograder (classrooms grade as a vacuous pass until you add one), and the
autograde shim (embedded in `gh-student`, dropped into each student repo at
accept).

</details>

**Errors:** missing `classroom50` repository → `run gh teacher init <org> first`; existing
classroom directory → refuses to overwrite; bad short-name → prints the rule.

### `classroom list`

```sh
gh teacher classroom list <org> [--all] [--json] [--quiet]
```

One short-name per line on stdout. Archived classrooms (`active: false`) are
hidden unless you pass `--all` (tagged ` (archived)`). `--json` emits
`{short_name, name, term, active}` objects; `--quiet` suppresses the stderr
summary. Read-only.

### `classroom edit`

```sh
gh teacher classroom edit <org> <short-name> [--name "<full name>"] [--term <term>]
```

Updates the display name and/or term. At least one flag is required; the
short-name is immutable (it flows into repo names). No-op when values are
unchanged.

### `classroom archive` / `unarchive`

```sh
gh teacher classroom archive <org> <short-name>
gh teacher classroom unarchive <org> <short-name>
```

`archive` sets `active: false`; `unarchive` drops the key (absent = active).
Archived classrooms leave the default `list`, and `assignment add`/`reuse`
refuse to write into them. Existing student repos are untouched. Both are
idempotent.

> [!NOTE]
> Student `accept` is blocked only after the next `publish-pages` run updates the
> published index — a documented v1 limitation, matching the web app.

### `classroom remove`

```sh
gh teacher classroom remove <org> <short-name> [--yes]
```

Deletes the `<short-name>/` directory and the classroom's teams in one commit.
Prompts for the typed short-name unless `--yes`. Does **not** delete student
repos.

### `classroom migrate`

Import an existing GitHub Classroom into `<target>/classroom50`.

```sh
gh teacher classroom migrate --source <id-or-org> --target <org> [--dry-run]
gh teacher classroom migrate --source 95884 --target cs50-fall-2026 --short-name cs-principles --term Fall-2026
```

For each assignment, it copies the source starter repo into the target
organization as a fresh template, then commits the classroom's four-file
scaffold. GitHub Classroom is 1:1 with organizations, so migrate several legacy
classrooms into one target organization by running this once per source.

**Flags:** `--source <id-or-org>` (required), `--target <org>` (required),
`--short-name`, `--term`, `--template-suffix` (escape target name collisions),
`--include-archived`, `--dry-run`.

**Not migrated:** roster, scores, accepted student repos, and GitHub Classroom's
autograding config. Re-onboard students with `gh teacher roster add`/`import`
and author grading under `<classroom>/autograders/<slug>/`.

<details>
<summary>Source resolution, provenance, and failure model</summary>

- **Numeric source** resolves the classroom directly; **org-login source** lists
  the classrooms you administer and matches by organization. Multiple matches in
  one org enumerate candidates and ask for `--source <id>`.
- Each migrated entry carries a `migrated_from` provenance block.
- `mode: group` assignments migrate with their `max_group_size`.
- Per-assignment failures skip that entry with a reason; the commit still lands
  with the successes and exits non-zero. Re-running reuses templates that
  already exist.

</details>

## `roster`

Manage student rows in `<org>/classroom50/<classroom>/roster.csv`. All write
subcommands use an optimistic-rebase loop (up to 5 retries), so concurrent
teacher edits don't lose each other's work. Every row for a student who has
joined carries an immutable numeric `github_id` (CLI-managed — don't hand-edit
it) so a username change doesn't desynchronize records. A student invited by
email has neither a username nor a `github_id` until they accept: `roster invite`
creates that pending row, and `roster sync` completes it once they've joined.

### `roster list`

```sh
gh teacher roster list <org> <classroom> [--json] [--quiet]
```

Default is an aligned table (empty cells show as `-`). `--json` emits full row
objects (`github_id` is `0` when unresolved; `role` is `""` when unknown);
`--quiet` prints one username per line. The table and `--json` include pending
rows for students invited by email; `--quiet` omits them, since they have no
username yet and a blank line would feed scripts an empty argument. The `role`
column is a display snapshot of the account's highest team-derived role — see
[Dual roles](#dual-roles-staff-who-are-also-students). Read-only.

### `roster add`

```sh
gh teacher roster add <org> <classroom> <username> [--first-name <n>] [--last-name <n>] [--email <addr>] [--section <s>]
```

Upserts one row by username (case-insensitive), then invites the student to the
organization if needed and adds them to the classroom team. Safe to re-run. When
no row matches the username and `--email` matches a pending row's address, that
row is filled in rather than duplicated; the pending row's `role` is deliberately
not inherited, since the team is the authority for role.

### `roster invite`

```sh
gh teacher roster invite <org> <classroom> <email> [--first-name <n>] [--last-name <n>] [--section <s>]
```

Invites one student who has no GitHub account yet (or whose username you don't
know). It sends an organization invitation carrying two teams — the classroom
team and a per-invite `secret` metadata team retaining the address — and appends
a pending row to `roster.csv`. The same three artifacts the web app's email
invite creates, so either tool can complete the invitation. For a student whose
username you already know, use `roster add`, which resolves their `github_id`
immediately.

**Student role only.** Unlike the web app, this can't invite staff, so a
mistyped address can never be handed organization ownership. Grant a staff role
with `gh teacher staff add` once the person has an account.

Once the student accepts, `roster sync` fills in their username and `github_id`.

Non-zero on: a classroom with no usable team recorded in `classroom.json`
(nothing is sent), an address the roster already lists **as a pending
invitation**, or a failed invitation. An address that already belongs to an
organization member — or already has a pending invitation — is reported as
skipped and exits **0**. An address that some *other* row merely carries is a
shared address (a parent, a lab contact), so the invitation is still sent and
the command exits **0**: you get a note on stderr naming that row, and no second
row is written for it.

If the invitation itself fails, a metadata team this run created is deleted
again — unless the failure was a rate limit, in which case the team is kept so a
retry adopts it instead of creating a second one against the same limit. If the
invitation is sent but the roster write fails, nothing is rolled back (the
invitation is the source of truth and the metadata team retains the address):
the command exits non-zero and `roster sync` adds the row.

### `roster cancel-invite`

```sh
gh teacher roster cancel-invite <org> <classroom> <email>
```

Revokes the pending invitation and clears the two records it left behind: the
metadata team and the pending roster row. The same teardown the web app
performs, so either tool can revoke either tool's invitation.

Acts only on a **pending** invitation. With none for the address it reports and
changes nothing, exiting 0 — an invitation the student already accepted looks
identical from here, and the metadata team holds the only record of which
address their account came from. Run `roster sync` in that case: it records the
student, and collects a genuine leftover under its own checks. For a student
already on the roster with a username, use `roster remove` (and `gh teacher
remove` for the organization).

Because an organization invitation is org-wide while everything it tears down is
classroom-scoped, it first **proves the invitation is this classroom's**: the
metadata team for the address must exist, hold a readable invite record, and name
this classroom, and the invitation itself must carry one of this classroom's
teams. It refuses — changing nothing, with the invitation intact — when any of
those fails: a missing or record-less metadata team (an interrupted send leaves
exactly that) or an invitation that belongs to a sibling classroom. Revoke such
an invitation from the web app's roster or from GitHub's
`https://github.com/orgs/<org>/people/pending_invitations` page; a sibling
classroom's is cancelled by naming that classroom instead. It is also non-zero if
the cancellation or the roster write following it fails.

### `roster sync`

```sh
gh teacher roster sync <org> <classroom>            # dry run: report only
gh teacher roster sync <org> <classroom> --write    # apply
```

Reconciles `roster.csv` against GitHub: records the students who accepted an
email invitation, fills in a missing `github_id` from the classroom team's
membership, drops the pending rows nothing backs, and deletes the metadata teams
that are done. The same reconciliation the web app runs when a teacher opens the
roster — here it's explicit and script-callable.

Its scope is the email-invite lifecycle and `github_id`: it never rewrites a
`role` already recorded on a row, and it doesn't add rows for organization
members who were never invited through Classroom 50 — see
[Already an org member, but not on the roster](Troubleshooting#already-an-org-member-but-not-on-the-roster).
A row it *adds* for an accepted invitation records the role of the classroom team
the account was found on, highest rank first (`teacher > hta > ta > student`), so
a staff member who accepted an email invitation is recorded with their staff role
rather than as a student; if no team names them, whatever role is already stored
is left as it is.

**Dry-run by default**: without `--write` it issues no write request at all. A dry
run also reports a metadata team whose address the roster *already* records —
that team is redundant and `--write` would retire it — and counts it as changes
pending, so a pass with nothing to fold exits `2` rather than claiming the
classroom is up to date. `--write` is refused outright on an **archived**
classroom (`active: false` in `classroom.json`), whose roster is frozen; a dry run
still works, so the leftovers stay inspectable.

Exit codes follow `terraform plan -detailed-exitcode`:

| Code | Meaning |
| --- | --- |
| `0` | Nothing to do — or `--write` applied everything. |
| `1` | An error, or a degraded read left the pass incomplete (nothing was removed and no metadata team was deleted). |
| `2` | A dry run found changes pending. |

Conservative by construction. Any degraded read (the pending-invitation list, a
team) makes the whole pass read-mostly: no row is dropped and **no metadata team
is deleted at all** — not even one whose address the roster already records —
because an unreadable team can't prove its row is dead, and the exit-1 message
promises nothing was removed. Such a pass doesn't report a deletion it won't
make. A team whose stored address no longer hashes to its name, or that has more
than one member, is reported on stderr and left standing. A member-less team is
collected only past 24 hours old with no pending invitation for its address, and a
recovered team is deleted only after the roster commit carrying its address has
landed.

### `roster update`

```sh
gh teacher roster update <org> <classroom> <username> [--first-name <n>] [--last-name <n>] [--email <addr>] [--section <s>]
```

Corrects fields on an **existing** row. Only the flags you pass change;
`github_id` and other columns are preserved. Roster-only: no invite, no
`github_id` lookup. Pass `--email ""` to clear an address. At least one flag is
required; an unknown username is an error.

### `roster remove`

```sh
gh teacher roster remove <org> <classroom> <username>
```

Drops the row (idempotent). Does **not** remove organization membership — use
`gh teacher remove <org> <username>` for that.

### `roster import`

```sh
gh teacher roster import <org> <classroom> <path-to-csv>
```

Bulk upsert. The header may be the stored roster shape
(`username,first_name,last_name,email,section,github_id,role`), the same without
`role`, or just the first five columns — so a `roster.csv` exported from a
web-managed classroom imports verbatim, with no hand-trimming. The field
reference is in [Roster CSV fields](Web-Teacher-Guide#roster-csv-fields).

Each row is routed by what identifies it:

- **A `username`** is resolved through `GET /users/{username}`, so the stored
  `github_id` is always GitHub-authoritative. A `github_id` cell naming a
  different account than the username **fails that line**, naming both ids —
  a row that addresses two students isn't something to guess at.
- **An email address alone** is a pending email invitation: import updates that
  row's name and section, matched by address, and nothing else. It never sends or
  cancels an invitation, and never creates an identity-less row, so an address
  with no pending row is skipped with a notice. Send the invitation with
  [`roster invite`](#roster-invite) first.
- **A `github_id` with no `username`** is round-trip cargo: `import` resolves
  students by username and has no id→account lookup, so the row is skipped with a
  notice pointing at the web app's **Upload**, and anything stored for that
  student is left untouched.

`role` is carried, never applied: import grants no role beyond the organization
invitation and classroom-team membership every imported student gets, and never
overwrites a role already recorded.

Every unusable line is reported in one pass and **nothing is committed**, so one
editing pass fixes the whole file — a malformed line and a `username` that names
no GitHub account are reported together, not one round-trip each. The roster is
written in a single commit, so a partial-import state can't appear on the
repository. After it lands, any student who isn't already in the organization is
invited.

**Errors common to roster commands:** missing `classroom50` repository → `run gh teacher init
<org> first`; missing `roster.csv` → points at `classroom add`; bad header →
prints the offending header; unknown GitHub user → prints the username; repeated
rebase failures → `lost the rebase race`, retry.

## `staff`

Manage a classroom's **staff teams** — `classroom50-<classroom>-{teacher,hta,ta}`.
The `teacher` and `hta` (head TA) teams get write on the `classroom50` repository; `ta` gets
read-only. The classroom's GitHub teams — not the `role` column in `roster.csv` —
are the role authority, so a classroom's staff is the same from the CLI or the
web app.

```sh
gh teacher staff add <org> <classroom> <username> [--role teacher|hta|ta]
gh teacher staff remove <org> <classroom> <username> [--role teacher|hta|ta]
```

`--role` defaults to `teacher`. `add` self-heals a classroom that predates staff
teams (creating and recording the missing team). `remove` doesn't touch org
membership and is idempotent.

### Dual roles (staff who are also students)

Nothing stops one account from being on a staff team and the roster at once
(`staff add` and `roster add` each manage their own GitHub team). How a
dual-role account behaves in the app is covered in
[Staff who are also students](Staff-TAs-and-Multiple-Teachers#staff-who-are-also-students-dual-roles).
The CLI-visible effects:

- **`roster list` and the `role` column** record the single **highest** role
  (`teacher > hta > ta > student`). The web app's automatic sync refreshes the
  column, so you may see a commit rewrite an empty role to `teacher` shortly
  after `roster add` — the snapshot updating, not a change to enrollment; nothing
  reads this column to decide access. `roster sync` never rewrites a role
  already recorded; a row it *adds* for an accepted email invitation records the
  role of the classroom team the account was found on, so a staffer who accepted
  one is recorded with their staff role.
- **`roster add` prints a note** when the target is already staff, so the
  later `role`-column rewrite isn't a surprise.
- **`roster remove` (unenroll) drops only the student side** — the roster row
  and student-team membership; any staff role stays intact.

## `assignment`

Manage entries in `<org>/classroom50/<classroom>/assignments.json` — the manifest
the autograde workflow and `gh student accept` both read. Writes use the same
optimistic-rebase loop as roster commands.

### `assignment add`

```sh
gh teacher assignment add <org> <classroom> <slug> --name "<name>" [flags]
gh teacher assignment add cs50-fall-2026 cs-principles hello --name "Hello" --template cs50/hello-template --due 2026-09-15T23:59:00-04:00
gh teacher assignment add cs50-fall-2026 cs-principles reflection --name "Reflection"   # template-less
gh teacher assignment add cs50-fall-2026 cs-principles actions-lab --name "Actions Lab" --empty-repo
```

Registers or upserts one assignment. Re-running with the same slug replaces the
entry wholesale (dropping tests or a template you don't re-pass — the CLI warns).
The slug must match `^[a-z0-9][a-z0-9-]{1,38}$`.

**Required:** `--name`.

**Optional:**

| Flag | Purpose |
| --- | --- |
| `--template <owner>/<repo>[@branch]` | Starter-code repo (must be flagged as a template). Omit for a template-less assignment (an initialized repo: README plus the control files). Branch defaults to the template's default. |
| `--description <text>` | Short description. |
| `--due <ISO-8601>` | Due date, e.g. `2026-09-15T23:59:00-04:00`. Stored as UTC; the machine's local timezone is assumed if you omit the offset. |
| `--available-from <ISO-8601>` | Release date; stored as UTC (local timezone assumed without an offset). Assignments are hidden from the student list by default (invite-link accept only); set this to list it for everyone once the date passes. Listing-only, not access control: students who already accepted always see it. |
| `--mode individual\|group` | `individual` (default) or `group` (requires `--max-group-size`). |
| `--max-group-size <N>` | Max group collaborators (2–100). Advisory. |
| `--runtime <path>` | JSON runtime (`runs-on`, toolchains, `apt`, `container`). See [Advanced Autograding](Advanced-Autograding#the-runtime-block). |
| `--tests <path>` | JSON array of declarative tests. Mutually exclusive with a per-assignment `autograder.py`. |
| `--autograder <name>` | Swap the reusable workflow (rare). Default `default`. |
| `--feedback-pr` | One review PR per student repo. **On by default**; `--feedback-pr=false` disables. |
| `--empty-repo` | Truly bare repos (no README/marker/shim); autograding and feedback PR disabled; changeable on a same-slug re-add (warns; only affects future accepts); mutually exclusive with template/tests/feedback-pr/allowed-files/pass-threshold/submission-mode/submission-tag/no-autograder/init-shim. |
| `--allowed-files <pattern>` | Ordered `.gitignore`-style pattern (repeatable, order preserved) defining which files belong to the submission. Last match wins; `!` re-includes. The autograde runner removes disallowed files before grading (control files are always kept); `gh student submit` filters them too. Omit to allow every file. See [Advanced Autograding](Advanced-Autograding#restricting-submission-files-allowed_files). |
| `--student-permission <role>` | Collaborator role each student gets on their **own** repo at accept: `pull`, `triage`, `push`, `maintain`, or `admin`. Omit for the default (`push` individual, `admin` group). Affects future accepts only. Caution: `admin` lets the student manage the repo's settings and collaborators; the org lockdown from `init` still blocks visibility changes. |
| `--pass-threshold <0–100>` | Advisory passing bar shown on the submissions page. Off when omitted (distinct from `0`). |
| `--submission-mode every-push\|tag` | When the autograder fires: `every-push` (default) grades every push; `tag` grades only `submit/*` tag pushes (the submit clients push the tag — plain `git push` costs no Actions minutes). Change it later with `assignment submission-mode`. |
| `--submission-tag <pattern>` | Milestone tag (repeatable) that also triggers grading: `git tag phase1 && git push origin phase1` grades that commit. Simple globs (`v*`) work; exact names are safer. The record still lives at the canonical `submit/*` tag. Mutually exclusive with `--empty-repo`. |

**Where grading logic lives** (increasing effort): declarative `--tests` → a
per-assignment `<classroom>/autograders/<slug>/autograder.py` → a classroom
default via `gh teacher autograder set-default`. See
[Autograding Basics](Autograding-Basics#declarative-tests) and
[Advanced Autograding](Advanced-Autograding#writing-an-autograderpy).

**Repository shapes.** Three more provisioning settings live in
`assignments.json` only — there is no `assignment add` flag for them; set them
in the web assignment form or by editing the file. All three are mutable but
affect only repositories accepted from then on. The concept-level comparison
of every shape is in
[Repository shapes](Assignment-Templates#repository-shapes).

- **`no_autograder: true`** (web: **Do not use the built-in autograder**) —
  accept commits the `.classroom50.yaml` marker and the template's content but
  no autograde workflow, so the template's own CI runs instead. Requires a
  template (it carries the workflows); keeps the Feedback PR. Score collection
  and regrade skip it (no `submit/*` releases). Mutually exclusive with
  `empty_repo`, a non-default `--autograder`, and the grading-adjacent fields
  (tests/allowed-files/release-assets/pass-threshold/submission-mode/
  submission-tag).
- **`init_shim: true`** (web: **No template**, **Add a README** off, built-in
  autograder on) — an initialized but README-less repo carrying only the
  control files, which autogrades and is collected like any built-in
  assignment. Requires the default autograder and no template; mutually
  exclusive with `empty_repo`, `template`, `no_autograder`, and a non-default
  `--autograder`; permits the grading-adjacent fields.
- **`include_all_branches: true`** (web: **Include all branches**) — accept
  passes `include_all_branches` to GitHub's generate call, so each student
  repo gets **all** of the template's branches. Requires a template; mutually
  exclusive with `empty_repo` and `init_shim`; compatible with everything
  else.

<details>
<summary>Errors</summary>

- Missing `classroom50` repository / `assignments.json` → points at `init` / `classroom add`.
- Template 404 → make it public or copy it into the org.
- Template private and outside `<org>` → rejected (students can't be granted
  access).
- Template not flagged as a template → names the Settings toggle.
- `--autograder <name>` references a missing file → tells you to create it.
- `--runtime` / `--tests` fail validation → names the offending field.
- Repeated rebase failures → `lost the rebase race`.

**Same-slug concurrent writes** are last-writer-wins; both commits stay in git
history, so an unexpected overwrite is recoverable with `git revert`.

</details>

### `assignment reuse`

```sh
gh teacher assignment reuse <org> <source-slug> --from <src-classroom> --to <dst-classroom> [--slug <new>] [--name "<new>"] [--json]
```

Copies an assignment record into another classroom in the **same org** — the
scriptable version of the web app's "reuse assignment". Every field is copied
verbatim (including unknown/future ones); only slug and name can change. Student
repos and scores are not copied.

- A colliding slug auto-suffixes `-2`, `-3`, … unless you pass `--slug`
  explicitly (which refuses a collision). Read the final slug from `--json`, not
  the prose.
- Re-grants the target classroom's team read on a private in-org template.
  In-org only (v1). Refuses an archived target.

### `assignment remove`

```sh
gh teacher assignment remove <org> <classroom> <slug>
```

Drops the entry (idempotent). Does **not** touch existing student repos — only
new `gh student accept` calls stop finding the slug.

### `assignment list`

```sh
gh teacher assignment list <org> <classroom> [--json] [-q]
```

One slug per line (pipeable into `xargs`). `--json` emits the full entries array.
Read-only.

### `assignment submission-mode`

```sh
gh teacher assignment submission-mode <org> <classroom> <slug> (--every-push | --tag) [flags]
gh teacher assignment submission-mode cs50-fall-2026 cs-principles hello --tag
gh teacher assignment submission-mode cs50-fall-2026 cs-principles hello --tag --user alice
gh teacher assignment submission-mode cs50-fall-2026 cs-principles hello --every-push --dry-run
```

Sets when the autograder fires — `--every-push` (every default-branch push
grades; the default behavior) or `--tag` (**only** `submit/*` tag pushes
grade; `gh student submit`, or a hand-pushed `submit/*`
tag; plain `git push` costs no Actions minutes) — and, by default,
**retrofits the autograde shim in every existing student repo** to match.
The trigger lives in each repo's workflow file, so a mode change doesn't
reach already-accepted repos without the retrofit.

| Flag | Purpose |
| --- | --- |
| `--update-shims` | Retrofit each existing repo's shim (default on). `--update-shims=false` flips only the assignments.json field. |
| `--user <login>` | Retrofit a single student's repo (e.g., one that failed on a previous run). |
| `--dry-run` | Report the field flip and per-repo changes without writing anything. |
| `-q, --quiet` | Suppress per-repo and summary lines. |

Details that matter:

- **Idempotent** — an already-set field and already-current shims commit
  nothing; re-running only fills gaps.
- The retrofit commit carries `[skip ci]`, so it **never triggers grading**.
- Repos whose shim was hand-edited are **reported and left untouched** —
  the rewrite only touches a recognizable default-shim trigger block.
- **Custom autograders**: the command refuses to rewrite a teacher-authored
  shim. Edit its `on:` block yourself, then re-run with
  `--update-shims=false` (the field still controls whether the submit
  clients push the tag).
- `empty_repo` assignments are rejected (no shim exists).
- Needs the `workflow` OAuth scope to commit workflow files
  (`gh auth refresh -s workflow` if you see a scope error).
- **Tell students to `git pull` afterward** — clones made before the change
  conflict on their next push.

### `assignment lock`

```sh
gh teacher assignment lock <org> <classroom> <slug>
gh teacher assignment lock <org> <classroom> <slug> --unlock
```

Locks an assignment so students can no longer access it: the web accept page,
the student assignments list, the submission view, and `gh student accept` all
refuse a locked assignment for every student, including ones who already
accepted. `--unlock` reverses it.

Because `assignments.json` is published publicly to Pages, those client-side
gates are best-effort. The enforceable boundary applies only to a **private,
in-org template**: locking also removes the classroom student team's read on
the template repo, so no new student can generate a repo from it while locked
(unlocking re-grants it). Staff teams are never touched, and existing student
repos are not deleted.

### `assignment feedback-pr`

```sh
gh teacher assignment feedback-pr <org> <classroom> <assignment>
gh teacher assignment feedback-pr --user alice <org> <classroom> <assignment>
```

Opens (or repairs) the [Feedback PR](Autograding-Basics#feedback-pull-requests)
on every existing student repo for an assignment, retroactively and
idempotently, for repos that predate the feature or missed the PR because of
an outage. It re-runs the same ensure flow accept uses, so the runner adopts
the PR and teachers never see two. Repos that already have a Feedback PR (in
any state) are left as-is. Pass `--user` to target a single student, `-q` to
suppress per-repo output. Requires owner/admin access to the org's repos.

A student-precreated `feedback` branch frozen at the wrong commit is reported
as **BLOCKED**: an org admin must delete that branch before the PR can open;
re-running never fixes it.

### `assignment test`

```sh
gh teacher assignment test add <org> <classroom> <slug> --name "<n>" --type {io,run,python} --run "<cmd>" [options]
gh teacher assignment test list <org> <classroom> <slug> [--json] [-q]
gh teacher assignment test remove <org> <classroom> <slug> <test-name>
```

Manage the declarative `tests` block — GitHub Classroom-style io/run/python
checks graded with no `autograder.py`. `add` upserts by `--name`; it's refused
while a per-assignment `autograder.py` exists. See
[Autograders](Autograding-Basics#declarative-tests) for fields and semantics. For bulk
edits, use `assignment add --tests <file.json>`.

## `autograder`

Manage the **classroom default autograder** at `<classroom>/autograder.py` and
inspect the autograders under `<classroom>/autograders/`.

```sh
gh teacher autograder set-default <org> <classroom> [--from <path|->]
gh teacher autograder show <org> <classroom> [--json] [-q]
gh teacher autograder list <org> <classroom> [--json] [-q]
gh teacher autograder remove <org> <classroom> [--yes]
```

- **`set-default`** replaces `<classroom>/autograder.py` with `--from` (a file or
  `-` for stdin). With no `--from`, it installs a diagnostic stub that echoes the
  runner's environment and emits a vacuous pass — useful for verifying the
  pipeline. The classroom must already exist.
- **`show`** prints the default to stdout; `--json` emits metadata
  `{path, exists, is_stub, size, sha}`. Read-only.
- **`list`** enumerates named shims (`<name>.yaml`) and per-assignment override
  bundles (`<slug>/`); `--json` emits `{name, kind, path}`. The default isn't
  listed (use `show`). Read-only.
- **`remove`** deletes the default (distinct from overwriting it with the stub).
  Prompts unless `--yes`. Idempotent.

Named shims and per-assignment `autograder.py` overrides are **read-only from the
CLI** — author them with ordinary git operations. See
[Advanced Autograding](Advanced-Autograding).

## `invite`

```sh
gh teacher invite <org> <username>             # org member
gh teacher invite --admin <org> <username>     # org admin
gh teacher invite <org>/<repo> <username>      # repo collaborator (default push)
gh teacher invite -p maintain <org>/<repo> <username>
```

Invites by resolved user ID. `-p` accepts `pull`, `triage`, `push`, `maintain`,
`admin`; re-running updates the collaborator in place. Org invites need
`admin:org` (run `gh teacher login` once). Common API states (already a member,
pending invite, not an admin) become actionable messages.

## `remove`

```sh
gh teacher remove <org> <username>           # from the organization
gh teacher remove <org>/<repo> <username>    # from one repo
```

The org form revokes access to every repo, removes the user from all teams, and
cancels any pending invitation. Both forms are idempotent (a 404 exits 0).

## `member list`

```sh
gh teacher member list <org>         # members + pending invitations, with role
gh teacher member list <org>/<repo>  # collaborators, with permission
gh teacher member list <org> --json
gh teacher member list <org> --quiet
```

Shows *actual* GitHub membership (the roster is the *intended* list), so you can
spot mismatches — e.g., a student who never accepted their invite. Default is an
aligned table; `--json` emits `{login, kind, role, github_id}`; `--quiet` prints
one login per line. Reading org invitations needs `admin:org`. Read-only.

## `download`

```sh
gh teacher download <org> <classroom> <assignment>              # team-driven (default)
gh teacher download --by-pattern <org> <classroom> <assignment> # clone by name prefix
gh teacher download -d <dir> <org> <classroom> <assignment>     # literal dir
```

**Team-driven (default):** lists the classroom team's members and, for each,
probes the expected `<classroom>-<assignment>-<username>` repo, clones it (or
reports `Missing: <username>`), and refreshes `result.json` (latest) and
`results.json` (all submissions) from its releases. Then writes a `scores.csv`
at the destination root, one line per submission (a student with several pushes
contributes several lines), plus a blank-score line for each non-submitter.

Each run creates a fresh timestamped folder unless you pass `-d`. Existing target
dirs are skipped on clone but still get `result.json` refreshed.

**`--by-pattern`** pages through the org's repos and clones every one whose name
starts with `<classroom>-<assignment>-`, skipping the team lookup, the
`result.json` refresh, and the `scores.csv` summary. Use it when the `classroom50` repository
isn't bootstrapped, or to grab every matching repo regardless of the roster.

## `teardown`

```sh
gh teacher teardown <org>          # typed org-name prompt
gh teacher teardown --yes <org>    # skip the prompt (scripts only)
```

Deletes **every** repository in `<org>` — a development reset. It confirms the
`classroom50` marker repo exists (refusing otherwise), lists all repos, prompts
for the typed org name, then deletes each (the `classroom50` repository last, so an
interrupted run stays safe to re-run). It then removes the classroom and invite
teams it finds, so no invited address is left behind.

> [!WARNING]
> Requires the `delete_repo` scope, which is **not** in the default set. Opt in
> once with `gh teacher login -s delete_repo`.

## `whoami` / `login` / `logout`

- `whoami` — prints the authenticated GitHub user.
- `login` — wraps `gh auth login` with the required scopes (`admin:org`,
  `read:org`, `repo`, `workflow`); add more with `-s`. It always mints a new
  token and **replaces** your stored github.com auth, so when one already
  exists it warns and asks for confirmation first. Other commands don't: they
  reuse a sufficiently-scoped token untouched, and widen an under-scoped
  gh-managed one in place with `gh auth refresh`. See
  [Will `gh teacher login` disturb my existing `gh` setup?](Troubleshooting#will-gh-teacher-login-disturb-my-existing-gh-setup).
- `logout` — runs `gh auth logout`.

## Contributing

Building, testing, and linting the extension are documented in the
[`cli/gh-teacher/` README](https://github.com/foundation50/classroom50/blob/main/cli/gh-teacher/README.md).
