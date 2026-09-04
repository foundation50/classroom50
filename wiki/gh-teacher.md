# `gh teacher` reference

Every command and flag for the teacher CLI. For a walkthrough, see the
[CLI Teacher Guide](CLI-Teacher-Guide).

Run `gh teacher <command> --help` for the live flag list. Errors go to stderr
with a non-zero exit code. Every command accepts `--verbose` / `-v` for
per-step API and git detail; most commands that print progress also accept
`--quiet` / `-q` to suppress informational output.

## Commands at a glance

| Command | Description |
| --- | --- |
| `whoami` | Print the authenticated GitHub user. |
| `login` | Log in with the Classroom 50 scopes (`admin:org`, `read:org`, `repo`, `workflow`). Add scopes with `-s`, such as `delete_repo`. |
| `logout` | Log out with `gh auth logout`. |
| `init <org>` | Set up `<org>/classroom50` (org lockdown, repository, Pages, branch protection, service token). Idempotent. |
| `audit <org>` | Read-only audit of the org member-privilege lockdown. |
| `rotate-service-token <org>` | Replace the `CLASSROOM50_SERVICE_TOKEN` secret. |
| `classroom add <org> <short-name>` | Add a classroom. Flags: `--name`, `--term`, `--unlisted`, `--key`. |
| `classroom list <org>` | List classrooms. Flags: `--all`, `--json`, `--quiet`. |
| `classroom edit <org> <short-name>` | Update a classroom's name/term. |
| `classroom archive` / `unarchive <org> <short-name>` | Archive or restore a classroom. |
| `classroom remove <org> <short-name>` | Delete a classroom's config directory (not student repos). |
| `roster list <org> <classroom>` | List roster rows. Flags: `--json`, `--quiet`. |
| `roster add <org> <classroom> <username>` | Add/upsert a student; invites them. |
| `roster invite <org> <classroom> <email>` | Invite one student by email, or a whole list with `--file <path>`. Flags: `--first-name`, `--last-name`, `--section` (single invite only). |
| `roster cancel-invite <org> <classroom> <email>` | Revoke a pending email invitation and clear what it left behind. |
| `roster sync <org> <classroom>` | Sync the roster with GitHub. Dry run; `--write` applies. |
| `roster update <org> <classroom> <username>` | Correct fields on an existing row (roster-only). |
| `roster remove <org> <classroom> <username>` | Remove a roster row (not org membership). |
| `roster import <org> <classroom> <csv>` | Bulk upsert from a CSV. |
| `staff add` / `remove <org> <classroom> <username>` | Manage staff teams (`--role teacher\|hta\|ta`). |
| `assignment add <org> <classroom> <slug>` | Register/upsert an assignment. |
| `assignment reuse <org> <slug> --from <src> --to <dst>` | Copy an assignment into another classroom. |
| `assignment rename <org> <classroom> <old-slug> <new-slug>` | One-shot rename of an over-budget assignment slug and its student repos. |
| `assignment remove <org> <classroom> <slug>` | Remove an assignment entry. |
| `assignment list <org> <classroom>` | List assignment slugs. Flags: `--json`, `-q`. |
| `assignment submission-mode <org> <classroom> <slug> --tag\|--every-push` | Change when the autograder fires and retrofit existing repos' shims. |
| `assignment lock <org> <classroom> <slug>` | Lock (or `--unlock`) an assignment against student access. |
| `assignment feedback-pr <org> <classroom> <assignment>` | Open or repair the feedback PR on every student repo. Flags: `--user`, `-q`. |
| `assignment test add/set/list/remove` | Manage an assignment's declarative tests. |
| `team create <org> <classroom> <assignment>` | Create a group team for a team assignment. Flags: `--name`, `--member` (repeatable). |
| `team list <org> <classroom> <assignment>` | List a team assignment's group teams, members, and drift. |
| `team add` / `remove <org> <classroom> <assignment> <team> <username>` | Add or remove a rostered student on a group team. |
| `team delete <org> <classroom> <assignment> <team>` | Delete a group team (not its repository). |
| `team copy <org> <classroom> <assignment> --from <src>` | Recreate another assignment's group teams for this one. |
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

Setup checks run first and are read-only: your OAuth scopes, organization
access and ownership, the organization plan (a warning if the plan can't serve
Pages from a private repository; advisory only), and that a service token is
available. A hard failure stops `init` before it changes anything.

<details>
<summary>Steps <code>init</code> performs, in order</summary>

1. **Org member-privilege lockdown.** Sets `default_repository_permission` to
   `none` and turns every member privilege off except private-repo creation
   (so `gh student accept` works), public Pages creation (so the `classroom50`
   repository can publish), and team creation (for student-formed groups).
   Plan-gated rejections are retried per field and reported.
2. **Org Actions.** Turns GitHub Actions on if it's off org-wide.
3. **$0 Actions budget cap.** Stops paid overage; created only when the org
   has no Actions budget yet. Never fatal.
4. **Actions may create pull requests.** Org-wide, so the autograde runner can
   open feedback PRs.
5. **Branch rulesets.** Two org-wide rulesets protecting submission history
   and the frozen feedback PR base. See
   [How student repositories are protected](How-Classroom-50-Works#how-student-repositories-are-protected).
6. **The `classroom50` repository.** Created private with `auto_init`, or
   fetched if it exists.
7. **Repo-level Actions.** Enabled on the `classroom50` repository itself.
8. **Workflow and script files.** Commits the embedded workflows and scripts
   in one commit; on re-runs, refreshes stale files after confirmation
   (`--yes` skips).
9. **GitHub Pages.** Public, so students and the runner can fetch published
   files unauthenticated.
10. **Branch protection.** No force-push or deletion on the default branch.
11. **Workflow permissions.** Raises `GITHUB_TOKEN` to write.
12. **Reusable-workflow access.** Lets student shims call the runner workflow.
13. **Service token.** Validates and uploads `CLASSROOM50_SERVICE_TOKEN`.

When it finishes, `init` prints the future Pages URL
(`https://<org>.github.io/classroom50/`) and suggests
`gh teacher classroom add <org> <short-name>` as the next command.

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
| `.github/workflows/collect-scores.yaml` | `workflow_dispatch` score collection. |
| `.github/workflows/probe-token.yaml` | Read-only service-token health check. |
| `.github/workflows/autograde-runner.yaml` | Reusable workflow called by every student repo. |
| `.github/workflows/regrade.yaml` | Teacher-triggered regrade: re-runs each targeted repo's latest autograde run against the current autograder, without creating a new submission. |
| `.github/scripts/runner.py` | Grading bootstrap fetched from Pages each submission. |
| `.github/scripts/collect_scores.py` | Team-driven score collector. |
| `.github/scripts/probe_token.py` | Service-token scope probe. |
| `.github/scripts/ensure_feedback_pr.py` | Maintains the feedback PR; run by the autograde runner. |
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

**Short-name rules:** `^[a-z0-9][a-z0-9-]{1,99}$` (lowercase letters, digits,
and hyphens, starting with a letter or digit), and at most 40 characters for a
new classroom. The short-name flows into student repo names
(`<short-name>-<assignment>-<username>`), which GitHub caps at 100 characters,
so the 40-character cap leaves room for the assignment slug and any username.
Existing classrooms with longer short-names stay readable and operable.

`--unlisted` publishes the classroom's resources at an unguessable URL path
segment (the web app's **Use an unlisted link for this classroom** option).
This is obscurity, not access control; the command prompts you to accept a
generated key. `--key <key>` supplies a specific access key instead of the
generated one (implies `--unlisted`); it must be 4 to 64 lowercase letters or
digits.

Scaffolds four files in one commit (`classroom.json`, `assignments.json`,
`roster.csv`, `scores.json`) and creates the `classroom50-<short-name>` GitHub
team plus the `classroom50-<short-name>-{teacher,hta,ta}` staff teams. Refuses
to overwrite an existing classroom.

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

**Errors:** a missing `classroom50` repository points at `gh teacher init
<org>`; an existing classroom directory is refused rather than overwritten; a
bad short-name prints the rule.

### `classroom list`

```sh
gh teacher classroom list <org> [--all] [--json] [-q]
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
> published index. This is a documented v1 limitation, matching the web app.

### `classroom remove`

```sh
gh teacher classroom remove <org> <short-name> [--yes]
```

Deletes the `<short-name>/` directory and the classroom's teams in one commit.
Prompts for the typed short-name unless `--yes`. Does **not** delete student
repos.

## `roster`

Manage student rows in `<org>/classroom50/<classroom>/roster.csv`. All write
subcommands retry on top of each other (up to 5 attempts), so concurrent
teacher edits don't lose each other's work. Every row for a student who has
joined carries an immutable numeric `github_id` (CLI-managed; don't hand-edit
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
column is a display snapshot of the account's highest team-derived role. See
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

Invites one student who has no GitHub account yet, or whose username you don't
know. It sends an organization invitation carrying two teams (the classroom team,
and a per-invite `secret` invite team that retains the address) and appends a
pending row to `roster.csv`. The CLI's output calls that team the metadata team.
Those are the same three artifacts the web app's email invite creates, so either
tool can complete the invitation. When you already know the username, use
`roster add`, which resolves their `github_id` immediately.

**Student role only.** Unlike the web app, this can't invite staff, so a
mistyped address can never be handed organization ownership. Grant a staff role
with `gh teacher staff add` once the person has an account.

Once the student accepts, `roster sync` fills in their username and `github_id`.

A single address is non-zero on: a classroom with no usable team recorded in
`classroom.json` (nothing is sent), an address the roster already lists **as a
pending invitation**, or a failed invitation. An address that already belongs to an
organization member, or that already has a pending invitation, is reported as
skipped and exits **0**.

An address that some *other* row merely carries is a shared address (a parent, a
lab contact), so the invitation is still sent and the command exits **0**: a note
on stderr names that row, and no second row is written for the address.

If the invitation fails, an invite team this run created is deleted again. A rate
limit is the exception: the team is kept so a retry adopts it. If the invitation
is sent but the roster write fails, the command exits non-zero and rolls nothing
back; run `roster sync` to add the row.

**Invite a list with `--file`.**

```sh
gh teacher roster invite <org> <classroom> --file <path>
```

Pass `--file` in place of the positional `<email>` to invite a whole list.
The file is plaintext, one address per line; blank lines and `#` comment lines
are ignored. Every address is validated up front: one unusable line refuses the
whole run and nothing is sent. Each address takes the same path as a single
invite, is reported as it resolves, and the invited batch is retained in **one**
roster commit. Every skipped or failed address is named with its file line.

Bulk mode is student-only and carries no name/section metadata, so
`--first-name`, `--last-name`, and `--section` are rejected with `--file`. Fill
that metadata in afterwards with `roster import`, or with `roster update` once the
student has accepted and has a username. A sync never writes a name or a section:
those columns are yours, and are never derived from a GitHub profile.

Exit codes follow [`roster sync`](#roster-sync): **0** all invited or cleanly
skipped, **2** nothing failed but a rate limit left addresses uninvited, **1** an
address failed or the roster write failed. An address the roster already lists as
pending is a skip here, not a failure, so it doesn't change the exit code. On a
rate limit the run stops sending, waits out `Retry-After` before recording what it
already sent, and reports the rest; re-running is safe, since already-invited
addresses skip.

### `roster cancel-invite`

```sh
gh teacher roster cancel-invite <org> <classroom> <email>
```

Revokes the pending invitation and clears the two records it left behind: the
invite team and the pending roster row. This is the same teardown the web app
performs, so either tool can revoke either tool's invitation.

Acts only on a **pending** invitation. With none for the address it reports and
changes nothing, exiting 0: an invitation the student already accepted looks
identical from here. Run `roster sync` in that case. It records the student, and
collects a genuine leftover under its own checks. For a student already on the
roster with a username, use `roster remove` (and `gh teacher remove` for the
organization).

An organization invitation is org-wide, while everything this tears down is
classroom-scoped, so it first **proves the invitation is this classroom's**: the
invite team for the address must exist, hold a readable invite record, and name
this classroom, and the invitation itself must carry one of this classroom's
teams. When any of those fails it refuses, changing nothing and leaving the
invitation intact. Cancel a sibling classroom's invitation by naming that
classroom instead. Revoke any other from the web app's roster or from GitHub's
`https://github.com/orgs/<org>/people/pending_invitations` page. It is also
non-zero if the cancellation, or the roster write following it, fails.

### `roster sync`

```sh
gh teacher roster sync <org> <classroom>            # dry run: report only
gh teacher roster sync <org> <classroom> --write    # apply
```

Catches `roster.csv` up with GitHub: records the students who accepted an email
invitation (username and `github_id`, onto their own pending row), fills in a
missing `github_id` from the classroom team's membership, and deletes the
invite teams that are done. If no row claims a recovered invitation (the
pending row was deleted, or `roster invite`'s commit never landed), it appends
a row so the address isn't lost. The web app runs this same sync when a teacher
opens the roster; here it's explicit and script-callable. The web app's pass
does two things more: it refreshes each row's recorded `role` from live team
membership, and it adds a row for a classroom-team member the roster is
missing.

The sync **never removes a roster row**. An email-only row nothing backs (an
expired or canceled invitation) stays on the roster for you to link or delete
by hand; the web app shows it as unlinked. Its scope is the email-invite
lifecycle and `github_id`. It never rewrites a `role` already recorded on a
row, and it doesn't add rows for organization members who were never invited
through Classroom 50; see
[Already an org member, but not on the roster](Troubleshooting#already-an-org-member-but-not-on-the-roster).
A row it *adds* for an accepted invitation records the role of the classroom team
the account was found on, highest rank first (`teacher > hta > ta > student`), so
a staff member who accepted an email invitation is recorded with their staff role
rather than as a student. If no team names them, the stored role is left as it is.

**Dry run by default**: without `--write` it issues no write request at all. A dry
run also reports an invite team whose address the roster *already* records, since
that team is redundant and `--write` would retire it. It counts as changes
pending, so a pass with nothing to fold exits `2` rather than claiming the
classroom is up to date. `--write` is refused outright on an **archived**
classroom (`active: false` in `classroom.json`), whose roster is frozen; a dry run
still works, so the leftovers stay inspectable.

Exit codes follow `terraform plan -detailed-exitcode`:

| Code | Meaning |
| --- | --- |
| `0` | Nothing to do, or `--write` applied everything. |
| `1` | An error, or a degraded read left the pass incomplete (no invite team was deleted). |
| `2` | A dry run found changes pending. |

Conservative by construction. Any degraded read (the pending-invitation list, a
team) makes the whole pass report-only: **no invite team is deleted at all**,
not even one whose address the roster already records. Such a pass doesn't
report a deletion it won't make. A team whose stored address no longer hashes
to its name, or that has more than one member, is reported on stderr and left
standing. A member-less team is collected only once it's more than 24 hours old
with no pending invitation for its address, and a recovered team is deleted
only after the roster commit carrying its address has landed.

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

Drops the row (idempotent). Does **not** remove organization membership; use
`gh teacher remove <org> <username>` for that.

### `roster import`

```sh
gh teacher roster import <org> <classroom> <path-to-csv>
```

Bulk upsert. Accepts three header shapes: the stored roster shape
(`username,first_name,last_name,email,section,github_id,role`), the same without
`role`, and the first five columns alone, so a `roster.csv` exported from a
web-managed classroom imports verbatim. The field reference is in
[Roster CSV fields](Web-Teacher-Guide#roster-csv-fields). A file that isn't
UTF-8 is read as Windows-1252 (Excel's plain "CSV" export), with a notice to
double-check non-ASCII names.

Each row is routed by what identifies it:

- **A `username`.** Resolved through `GET /users/{username}`, so the stored
  `github_id` is always GitHub-authoritative. A `github_id` cell naming a
  different account than the username **fails that line**, naming both ids,
  because a row that addresses two students isn't something to guess at.
- **An email address alone.** This is a pending email invitation: import updates
  that row's name and section, matched by address, and nothing else. It never
  sends or cancels an invitation, and never creates an identity-less row, so an
  address with no pending row is skipped with a notice. Send the invitation with
  [`roster invite`](#roster-invite) first.
- **A `github_id` with no `username`.** The one shape a round-trip can't
  preserve: `import` resolves students by username and has no id-to-account
  lookup, so the row is skipped with a notice pointing at the web app's
  **Upload roster** dialog, and anything stored for that student is left
  untouched. A row whose `github_id` cell is present but unusable is skipped
  the same way.

`role` is carried, never applied: import grants no role beyond the organization
invitation and classroom-team membership each `username` row gets, and never
overwrites a role already recorded.

Every unusable line is reported in one pass and **nothing is committed**, so one
editing pass fixes the whole file: a malformed line and a `username` that names
no GitHub account are reported together. The roster is written in a single commit,
so a partial-import state can't appear on the repository. After it lands, every
`username` row's student is added to the classroom team and, unless they're
already a member or already invited, invited to the organization.

**Errors common to roster commands:** a missing `classroom50` repository points
at `gh teacher init <org>`; a missing `roster.csv` points at `classroom add`; a
bad header prints the offending header; an unknown GitHub user prints the
username; repeated rebase failures print `lost the rebase race` (retry).

## `staff`

Manage a classroom's **staff teams**: `classroom50-<classroom>-{teacher,hta,ta}`.
The `teacher` and `hta` (head TA) teams get write on the `classroom50`
repository; `ta` gets read-only. Head TAs are organization members, never
owners. The classroom's GitHub teams, not the `role` column in `roster.csv`,
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
  column, so a commit can rewrite an empty role to `teacher` shortly after
  `roster add`: the snapshot updating, not a change to enrollment. Nothing reads
  this column to decide access. `roster sync` never rewrites a role already
  recorded. A row it *adds* for an accepted email invitation records the role of
  the classroom team the account was found on, so a staff member who accepted one
  is recorded with their staff role.
- **`roster add` prints a note** when the target is already staff, so the
  later `role`-column rewrite isn't a surprise.
- **`roster remove` (unenroll) drops only the student side**: the roster row
  and student-team membership; any staff role stays intact.

## `assignment`

Manage entries in `<org>/classroom50/<classroom>/assignments.json`, the manifest
the autograde workflow and `gh student accept` both read. Writes retry on top of
each other, the same as roster commands.

### `assignment add`

```sh
gh teacher assignment add <org> <classroom> <slug> --name "<name>" [flags]
gh teacher assignment add cs50-fall-2026 cs-principles hello --name "Hello" --template cs50/hello-template --due 2026-09-15T23:59:00-04:00
gh teacher assignment add cs50-fall-2026 cs-principles reflection --name "Reflection"   # template-less
gh teacher assignment add cs50-fall-2026 cs-principles actions-lab --name "Actions Lab" --empty-repo
```

Registers or upserts one assignment. Re-running with the same slug rebuilds the
entry from the flags you pass: a template, tests, allowed files, pass
threshold, or student permission you don't re-pass is dropped (the CLI warns).
The lock state, submission mode and tags, repository visibility, release
assets, and every field the CLI has no flag for are carried forward. The slug
must match `^[a-z0-9][a-z0-9-]{1,99}$`, and a **new** slug must fit the
repo-name budget: `<classroom>-<slug>` plus a worst-case 39-character
username must stay within GitHub's 100-character repo-name limit, so the
classroom short-name and the slug share 59 characters. A slug retired by
`assignment rename` is permanently reserved. A same-slug replace of an
existing over-budget entry stays allowed (the entry must remain editable);
the CLI warns that students with long usernames can't accept it.

**Required:** `--name`.

**Optional:**

| Flag | Purpose |
| --- | --- |
| `--template <owner>/<repo>[@branch]` | Starter-code repo (must be flagged as a template). Omit for a template-less assignment (an initialized repo: README plus the control files). A `@branch` suffix is tolerated but ignored, with a warning: the assignment always copies the template's default branch. To use a different branch, change the template repository's default branch. |
| `--description <text>` | Short description. |
| `--due <ISO-8601>` | Due date, such as `2026-09-15T23:59:00-04:00`. Stored as UTC; the machine's local timezone is assumed if you omit the offset. |
| `--available-from <ISO-8601>` | Release date; stored as UTC (local timezone assumed without an offset). Assignments are hidden from the student list by default (invite-link accept only); set this to list it for everyone once the date passes. Listing-only, not access control: students who already accepted always see it. |
| `--locked` | Register the assignment locked: students can't see or accept it, and a private in-org template stays unreadable to the classroom team until you unlock. Same effect as [`assignment lock`](#assignment-lock). On a same-slug re-add, `--locked=false` unlocks and omitting the flag keeps the stored lock. See [Timed assessments](Course-Lifecycle-and-End-of-Term#timed-assessments). |
| `--mode individual\|group\|team` | `individual` (default), `team` (a group assignment: one shared repository per group, owned by a GitHub Team; see [`team`](#team)), or `group` (the legacy collaborator-based shared repository). Both group modes require `--max-group-size`; `team` also requires `--team-formation`. |
| `--team-formation teacher\|student` | Who forms a team assignment's groups: `teacher` (you create the group teams with [`team create`](#team-create); students not in a group can't accept) or `student` (the first student founds a group with `gh student accept --new-team` and adds teammates). Required with `--mode team`. |
| `--max-group-size <N>` | Maximum group size (2 to 100). Enforced by Classroom 50 clients when groups form; advisory beyond that (direct GitHub-UI changes can bypass it). |
| `--runtime <path>` | JSON runtime (`runs-on`, toolchains, `apt`, `container`). See [Advanced Autograding](Advanced-Autograding#the-runtime-block). |
| `--tests <path>` | Declarative tests as a bare JSON array or the generated `tests.json` envelope (`-` for stdin). Mutually exclusive with a per-assignment `autograder.py`. To change only the tests on an existing assignment, use [`assignment test set`](#assignment-test). |
| `--autograder <name>` | Swap the reusable workflow (rare). Default `default`. |
| `--feedback-pr` | One review PR per student repo. **On by default**; `--feedback-pr=false` disables. Requires the org prerequisites `gh teacher init` sets up. |
| `--empty-repo` | Truly bare repos (no README, marker, or shim); autograding and the feedback PR are disabled; changeable on a same-slug re-add (warns; only affects future accepts); mutually exclusive with `--template`, `--tests`, `--feedback-pr`, `--allowed-files`, `--pass-threshold`, `--submission-mode`, and `--submission-tag`. |
| `--allowed-files <pattern>` | Ordered `.gitignore`-style pattern (repeatable, order preserved) defining which files belong to the submission. Last match wins; `!` re-includes. The autograde runner removes disallowed files before grading (control files are always kept); `gh student submit` filters them too. Omit to allow every file. See [Advanced Autograding](Advanced-Autograding#restricting-submission-files-allowed_files). |
| `--student-permission <role>` | Collaborator role each student gets on their **own** repo at accept: `pull`, `triage`, `push`, `maintain`, or `admin`. Omit for the default (`push` individual, `admin` group). Affects future accepts only. Caution: `admin` lets the student manage the repo's settings and collaborators; the org lockdown from `init` still blocks visibility changes. |
| `--repo-visibility private\|public` | Visibility each student repo is **created** with at accept: `private` (default) or `public` (peer-review, portfolio, or showcase work; accept warns the student upfront that their work will be publicly visible). If org policy blocks a student from creating a public repo, accept falls back to private and says so. Affects future accepts only; flip existing repos with the submissions page's **Change repository visibility**. Re-adding without the flag keeps the stored value. |
| `--pass-threshold <0-100>` | Advisory passing bar shown on the submissions page. Off when omitted (distinct from `0`). |
| `--submission-mode every-push\|tag` | When the autograder fires: `every-push` (default) grades every push; `tag` grades only `submit/*` tag pushes (the submit clients push the tag; plain `git push` costs no Actions minutes). Change it later with `assignment submission-mode`. |
| `--submission-tag <pattern>` | Milestone tag (repeatable) that also triggers grading: `git tag phase1 && git push origin phase1` grades that commit. Simple globs (`v*`) work; exact names are safer. The record still lives at the canonical `submit/*` tag. Mutually exclusive with `--empty-repo`. |

**Where grading logic lives**, in increasing effort: declarative `--tests`, then
a per-assignment `<classroom>/autograders/<slug>/autograder.py`, then a
classroom default with `gh teacher autograder set-default`. See
[Autograding Basics](Autograding-Basics#declarative-tests) and
[Advanced Autograding](Advanced-Autograding#writing-an-autograderpy).

**Repository shapes.** Three more provisioning settings live in
`assignments.json` only; there is no `assignment add` flag for them. Set them
in the web assignment form or by editing the file. All three are mutable but
affect only repositories accepted from then on. The concept-level comparison
of every shape is in
[Repository shapes](Assignment-Templates#repository-shapes).

- **`no_autograder: true`** (web: **Do not use the built-in autograder**).
  Accept commits the `.classroom50.yaml` marker and the template's content but
  no autograde workflow, so the template's own CI runs instead. Requires a
  template (it carries the workflows); keeps the feedback PR. Score collection
  records who submitted but no scores (there are no `submit/*` releases);
  regrade skips it. Mutually exclusive with
  `empty_repo`, a non-default `--autograder`, and the grading-adjacent fields
  (tests/allowed-files/release-assets/pass-threshold/submission-mode/
  submission-tag).
- **`init_shim: true`** (web: **No template**, **Add a README** off, built-in
  autograder on). An initialized but README-less repo carrying only the
  control files, which autogrades and is collected like any built-in
  assignment. Requires the default autograder and no template; mutually
  exclusive with `empty_repo`, `template`, `no_autograder`, and a non-default
  `--autograder`; permits the grading-adjacent fields.
- **`include_all_branches: true`** (web: **Include all branches**). Accept
  passes `include_all_branches` to GitHub's generate call, so each student
  repo gets **all** of the template's branches. Requires a template; mutually
  exclusive with `empty_repo` and `init_shim`; compatible with everything
  else.

Several other fields are also JSON-only from the CLI's point of view and are
carried forward unchanged on a same-slug re-add: `release_assets` (files
attached to each submission release), `copy_about` and `copy_topics` (copy the
template's About text and topics onto each new student repo), `feedback_pr_template`
(use the template's pull request template as the feedback PR body), `closed`
(the web app's **Close submission** state), and `grading` (the web app's
grading-mode choice). Set them in the web app or by editing the file; the
field reference is `schemas/assignments-v1.schema.json`.

<details>
<summary>Errors</summary>

- A missing `classroom50` repository or `assignments.json` points at `init` or
  `classroom add`.
- Template 404: make it public or copy it into the org.
- Template private and outside `<org>`: rejected (students can't be granted
  access).
- Template not flagged as a template: names the Settings toggle.
- `--autograder <name>` references a missing file: tells you to create it.
- `--runtime` or `--tests` fails validation: names the offending field.
- Repeated rebase failures: `lost the rebase race`.

**Same-slug concurrent writes** are last-writer-wins; both commits stay in git
history, so an unexpected overwrite is recoverable with `git revert`.

</details>

### `assignment reuse`

```sh
gh teacher assignment reuse <org> <source-slug> --from <src-classroom> --to <dst-classroom> [--slug <new>] [--name "<new>"] [--json]
```

Copies an assignment record into another classroom in the **same org**: the
scriptable version of the web app's **Reuse assignment** action. Every field is
copied verbatim (including unknown/future ones); only slug and name can change.
Student repos and scores are not copied.

- Without `--slug`, the copy keeps the source slug, trimmed to the target
  classroom's repo-name budget and auto-suffixed `-2`, `-3`, and so on past
  collisions (a trim is reported on stderr). An explicit `--slug` refuses a
  collision, an over-budget value, or a reserved pre-rename slug. Read the
  final slug from `--json`, not the prose: `auto_suffixed` is true for a
  collision suffix or a budget trim.
- Re-grants the target classroom's team read on a private in-org template.
  In-org only (v1). Refuses an archived target.

### `assignment rename`

```sh
gh teacher assignment rename <org> <classroom> <old-slug> <new-slug> [--dry-run] [--yes]
gh teacher assignment rename cs50-fall-2026 cs-principles problem-set-three-with-a-long-name ps3
```

One-shot remediation for an over-budget slug: when
`<classroom>-<slug>-<username>` can exceed GitHub's 100-character repo-name
limit, this renames the assignment **and every existing student repo** to
match. It refuses a slug that already fits the budget, and it refuses a second
rename: the old slug is recorded as `renamed_from` and permanently reserved,
because a new repo at a renamed repo's old name would sever the automatic
redirects student clones rely on.

What happens, in order:

1. One config commit: the slug changes, `renamed_from` records the old slug,
   the `scores.json` bucket is re-keyed, a per-assignment `autograders/<slug>/`
   directory moves, and the assignment is locked so nobody accepts mid-rename.
2. Each student repo, matched by prefix and verified through its
   `.classroom50.yaml` marker, has the marker's `assignment` field rewritten
   (`[skip ci]`), then the repo is renamed. GitHub redirects git, web, and API
   traffic from the old name indefinitely, so student clones keep working.
3. The lock is restored to its pre-rename state.

Confirmation requires typing the new slug (skip with `--yes` in scripted
runs); `--dry-run` prints the plan without writing anything. Per-repo failures
never abort the batch: re-running the same command resumes, skipping
already-renamed repos and healing stragglers. The assignment stays locked
while any repo is unrenamed, because an accept would occupy the new repo name
and strand the straggler's rename.

Historical submissions keep their scores (collection accepts the pre-rename
slug through `renamed_from`). Students run `git pull` once before their next
`gh student submit`; plain pushes grade correctly immediately. Repos whose
marker names a different assignment (a sibling slug sharing the prefix), or
with no readable marker, are skipped untouched.

**Flags:** `--dry-run`, `--yes`, `-q, --quiet`.

### `assignment remove`

```sh
gh teacher assignment remove <org> <classroom> <slug>
```

Drops the entry (idempotent). Does **not** touch existing student repos; only
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

Sets when the autograder fires and, by default, **retrofits the autograde shim
in every existing student repo** to match. `--every-push` grades every
default-branch push (the default behavior; `submit/*` tag pushes grade too).
`--tag` grades **only** `submit/*` tag pushes: `gh student submit` pushes the
tag, a hand-pushed `submit/*` tag works too, and plain `git push` costs no
Actions minutes. The trigger lives in each repo's workflow file, so a mode
change doesn't reach already-accepted repos without the retrofit.

| Flag | Purpose |
| --- | --- |
| `--update-shims` | Retrofit each existing repo's shim (default on). `--update-shims=false` flips only the assignments.json field. |
| `--user <login>` | Retrofit a single student's repo (for instance, one that failed on a previous run). |
| `--dry-run` | Report the field flip and per-repo changes without writing anything. |
| `-q, --quiet` | Suppress per-repo and summary lines. |

Details that matter:

- **Idempotent.** An already-set field and already-current shims commit
  nothing; re-running only fills gaps.
- The retrofit commit carries `[skip ci]`, so it **never triggers grading**.
- Repos whose shim was hand-edited are **reported and left untouched**: the
  rewrite only touches a recognizable default-shim trigger block.
- **Custom autograders.** The command refuses to rewrite a teacher-authored
  shim. Edit its `on:` block yourself, then re-run with
  `--update-shims=false` (the field still controls whether the submit
  clients push the tag).
- `empty_repo` assignments are rejected (no shim exists).
- Needs the `workflow` OAuth scope to commit workflow files
  (`gh auth refresh -s workflow` if you see a scope error).
- **Tell students to `git pull` afterward.** Clones made before the change
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

Opens (or repairs) the
[feedback pull request](Autograding-Basics#feedback-pull-requests) on every
existing student repo for an assignment, retroactively and idempotently, for
repos that predate the feature or missed the PR because of an outage. It
re-runs the same ensure flow accept uses, so the runner adopts the PR and
teachers never see two. Repos that already have a feedback PR (in any state)
are left as-is. Pass `--user` to target a single student, `-q` to suppress
per-repo output. Requires owner/admin access to the org's repos.

A student-precreated `feedback` branch frozen at the wrong commit is reported
as **BLOCKED**: an org admin must delete that branch before the PR can open;
re-running never fixes it.

A repo that exists but never received its `.classroom50.yaml` setup commit
(the student's accept stopped partway) is reported as **Setup incomplete**.
There is no baseline to open a PR against, so re-running this command doesn't
help; ask the student to open the assignment link and choose **Re-run setup**,
then run the command again.

### `assignment test`

```sh
gh teacher assignment test add <org> <classroom> <slug> --name "<n>" --type {io,run,python} --run "<cmd>" [options]
gh teacher assignment test set <org> <classroom> <slug> --tests <path>
gh teacher assignment test list <org> <classroom> <slug> [--json] [-q]
gh teacher assignment test remove <org> <classroom> <slug> <test-name>
```

Manage the declarative `tests` block: GitHub Classroom-style io/run/python
checks graded with no `autograder.py`. `add` upserts by `--name`; it's refused
while a per-assignment `autograder.py` exists, and it fails if the slug isn't
registered yet. Commands run in the student checkout, and bundled files are
not copied there: `$CLASSROOM50_BUNDLE_DIR` points at the teacher-only files in
`<classroom>/autograders/<slug>/` (see
[Teacher-only test files](Autograding-Basics#teacher-only-test-files)). See
[Declarative tests](Autograding-Basics#declarative-tests) for fields and
semantics and [Report options](Autograding-Basics#report-options) for what
each failure-details level shows.

**`test set`** replaces the whole test list from `--tests <path>` (`-` for
stdin) and changes nothing else on the assignment, so it's the command for
keeping tests in a file outside the `classroom50` repository and syncing them.
The file is either a bare JSON array (what `test list --json` prints) or the
generated `tests.json` envelope (`schema`, `tests`, optional `defaults`). A bare
array leaves the assignment's `test_defaults` alone; an envelope replaces them
from its `defaults` block, clearing them when the block is absent. An empty
array removes every test. `assignment add --tests` takes the same file when
creating an assignment; unlike `test set`, it rewrites the whole entry.

**`test add` flags** (`--name`, `--type`, and `--run` are required):

| Flag | Purpose |
| --- | --- |
| `--name <n>` | Test name, unique within the assignment. |
| `--type io\|run\|python` | `io` compares stdout, `run` checks the exit code, `python` runs pytest (points are split across discovered cases at grade time). |
| `--run <cmd>` | Command to run. |
| `--setup <cmd>` | Optional command run before `--run` (a compile step, for example). |
| `--points <N>` | Points the test is worth. |
| `--timeout <s>` | Seconds before the test fails (`0` = the default of 10 s). |
| `--input <text>` / `--input-file <name>` | `io` only: inline stdin, or a bundled fixture file fed on stdin. |
| `--expected <text>` / `--expected-file <name>` | `io` only: inline expected stdout, or a bundled fixture file holding it. |
| `--comparison included\|exact\|regex` | `io` only, required: how stdout is compared. No default. |
| `--exit-code <N>` | `run` only: required exit code (default `0`). |
| `--failure-details full\|actual-only\|none` | How much failure detail students see; omit for the assignment default. |
| `--show-output` | Include captured setup/run output in the report even when the test passes (`--show-output=false` opts one test out of a `show-output` default). |

`--input-file` and `--expected-file` name a fixture you committed alongside the
assignment at `<classroom>/autograders/<slug>/`; it's bundled and read at grade
time. `test list` prints one test name per line (`--json` for the full array,
`-q` to drop the stderr summary); `test remove` is idempotent and errors only
if the slug itself isn't registered.

## `team`

Manage the GitHub Teams behind a `--mode team` assignment. Each group is a
secret GitHub Team named `classroom50-group-<hash>-<n>` that owns the shared
repository `<classroom>-<assignment>-group-<n>`. Membership writes also update
`<classroom>/teams.json` in the `classroom50` repository: the snapshot of
intended membership that survives drift (GitHub Teams stay authoritative for
who can push). Every subcommand takes `<org> <classroom> <assignment>` and
requires a team assignment; a `<team>` argument accepts the group's counter
(`2`) or the full team slug.

### `team create`

```sh
gh teacher team create <org> <classroom> <assignment> [--name "<display name>"] [--member <username>]...
gh teacher team create cs50-fall-2026 cs-principles project --name "The Sharks" --member alice --member bob
```

Creates the next free group team for the assignment and adds the given
members.

- Members must be on the classroom roster; usernames not on `roster.csv` are
  skipped with a warning.
- A student can be on only one of the assignment's groups, so a member who is
  already on another group is refused before the team is created.
- The member count is capped by the assignment's `max_group_size`.
- The new team is recorded in `<classroom>/teams.json`.
- The team is attached to its shared repository when a student accepts;
  creating the team first is the teacher-formation flow.

`--name` records a display name (shown in the teacher views and to the
group's members; never part of the slug or the repository name). If a member
add fails partway, the team itself is already created: re-run
`gh teacher team add` for the missing members rather than `create` again.

### `team list`

```sh
gh teacher team list <org> <classroom> <assignment>
```

Shows every live group team: counter, display name, members, member count
against `max_group_size`, and drift against the `teams.json` snapshot
(members present live but not in the snapshot, or recorded but missing live).
A snapshot row with no live team is noted separately. Read-only; no commit
lands on the repository.

### `team add` / `team remove`

```sh
gh teacher team add <org> <classroom> <assignment> <team> <username>
gh teacher team remove <org> <classroom> <assignment> <team> <username>
gh teacher team add cs50-fall-2026 cs-principles project 2 alice
```

`add` puts a rostered student on the group team and records them in
`teams.json`. The student must be on the classroom roster, a student already
on another of the assignment's groups is refused (one student, one group),
the team's live member count is capped by the assignment's `max_group_size`,
and adding a student who is already on the team changes nothing. `remove`
takes the student off the team and drops them from the snapshot; removing a
student who is not on the team changes nothing.

### `team delete`

```sh
gh teacher team delete <org> <classroom> <assignment> <team>
gh teacher team delete cs50-fall-2026 cs-principles project 2
```

Deletes the group team and drops it from `teams.json`. The shared repository
is not touched. The delete is guarded: the live team must match the full
group-team shape, its recorded id, and a verified group record, so a
same-named team created by something else is never deleted blind. A team that
is already gone counts as deleted (the stale snapshot row is still dropped).

### `team copy`

```sh
gh teacher team copy <org> <classroom> <assignment> --from <assignment>
gh teacher team copy cs50-fall-2026 cs-principles project2 --from project
```

Recreates the source assignment's group teams for the target assignment: same
members and display names, fresh counters under the target's own team
namespace. Both assignments must be team assignments in the same classroom.
Members no longer on the roster, and members already on one of the target
assignment's groups, are skipped with a warning; a source team whose members
are all skipped is not recreated. A source team over the target's
`max_group_size` fails the copy. The new teams are recorded in
`<classroom>/teams.json`. The web app's **Copy groups** dialog is the same
operation with an editable preview.

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
  runner's environment and emits a vacuous pass, which is useful for verifying
  the pipeline. Re-running with identical content skips the commit. The
  classroom must already exist.
- **`show`** prints the default to stdout; `--json` emits metadata
  `{path, exists, is_stub, size, sha}`. Read-only.
- **`list`** enumerates named shims (`<name>.yaml`) and per-assignment override
  bundles (`<slug>/`); `--json` emits `{name, kind, path}`. The default isn't
  listed (use `show`). Read-only.
- **`remove`** deletes the default (distinct from overwriting it with the stub).
  Prompts unless `--yes`. Idempotent.

Named shims and per-assignment `autograder.py` overrides are **read-only from the
CLI**; author them with ordinary git operations. See
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
spot mismatches, such as a student who never accepted their invitation. Default is an
aligned table; `--json` emits `{login, kind, role, github_id}`; `--quiet` prints
one login per line. Reading org invitations needs `admin:org`. Read-only.

On a `member` or `collaborator` row, `github_id` is the account's id. On an
`invitation` row (a pending invitation) it is the **invitation's** id instead,
since GitHub's invitations API reports no account id for an invitee, so don't
join it against `roster.csv`'s `github_id`.

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

Deletes **every** repository in `<org>`; this is a development reset. It
confirms the `classroom50` marker repo exists (refusing otherwise), lists all
repos, prompts for the typed org name, then deletes each (the `classroom50`
repository last, so an interrupted run stays safe to re-run). It then removes
the classroom and invite teams it finds, so no invited address is left behind,
and sweeps each classroom's group teams (`classroom50-group-…`), verifying each
team's group record before deleting it.

> [!WARNING]
> Requires the `delete_repo` scope, which is **not** in the default set. Opt in
> once with `gh teacher login -s delete_repo`.

## `whoami` / `login` / `logout`

- `whoami` prints the authenticated GitHub user.
- `login` wraps `gh auth login` with the required scopes (`admin:org`,
  `read:org`, `repo`, `workflow`); add more with `-s`. It always mints a new
  token and **replaces** your stored github.com auth, so when one already
  exists it warns and asks for confirmation first. Other commands don't: they
  reuse a sufficiently-scoped token untouched, and widen an under-scoped
  gh-managed one in place with `gh auth refresh`. See
  [Will `gh teacher login` disturb my existing `gh` setup?](Troubleshooting#will-gh-teacher-login-disturb-my-existing-gh-setup).
- `logout` runs `gh auth logout`.

## Contributing

Building, testing, and linting the extension are documented in the
[`cli/gh-teacher/` README](https://github.com/foundation50/classroom50/blob/main/cli/gh-teacher/README.md).
