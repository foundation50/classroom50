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
| `login` | Log in with the Classroom 50 scopes (`admin:org`, `read:org`, `repo`, `workflow`). Add scopes with `-s` (e.g. `delete_repo`). |
| `logout` | Log out via `gh auth logout`. |
| `init <org>` | Set up `<org>/classroom50` (org lockdown, config repo, Pages, branch protection, service token). Idempotent. |
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
| `roster update <org> <classroom> <username>` | Correct fields on an existing row (roster-only). |
| `roster remove <org> <classroom> <username>` | Remove a roster row (not org membership). |
| `roster import <org> <classroom> <csv>` | Bulk upsert from a CSV. |
| `roster migrate <org> <classroom>` | Rename legacy `students.csv` to `roster.csv`. |
| `staff add` / `remove <org> <classroom> <username>` | Manage staff teams (`--role teacher\|hta\|ta`). |
| `assignment add <org> <classroom> <slug>` | Register/upsert an assignment. |
| `assignment reuse <org> <slug> --from <src> --to <dst>` | Copy an assignment into another classroom. |
| `assignment remove <org> <classroom> <slug>` | Remove an assignment entry. |
| `assignment list <org> <classroom>` | List assignment slugs. Flags: `--json`, `-q`. |
| `assignment test add/list/remove` | Manage an assignment's declarative tests. |
| `autograder set-default <org> <classroom>` | Install/replace the classroom default `autograder.py`. |
| `autograder show/list/remove <org> <classroom>` | Inspect or delete autograders. |
| `invite <org>[/<repo>] <username>` | Invite to an org or repo. |
| `remove <org>[/<repo>] <username>` | Remove from an org or repo. |
| `member list <org>[/<repo>]` | List actual members/collaborators. |
| `download <org> <classroom> <assignment>` | Clone submissions and write `scores.csv`. |
| `teardown <org>` | Delete every repo in a Classroom 50 org (dev reset). |

## `init`

One-time bootstrap for the per-org `classroom50` config repo. See the
[CLI Teacher Guide](CLI-Teacher-Guide#3-set-up-the-organization) for when to run
it.

```sh
CLASSROOM50_SERVICE_TOKEN=github_pat_... gh teacher init <org>
gh teacher init <org>              # interactive token prompt
gh teacher init <org> --dry-run    # preview, no changes
gh teacher init <org> --json       # machine-readable summary
gh teacher init <org> --yes        # skip the skeleton-refresh prompt
```

Idempotent: re-running resumes where a prior run stopped and offers to refresh
stale skeleton files (after a confirmation prompt).

<details>
<summary>Steps <code>init</code> performs, in order</summary>

1. **Org plan check** — warns if not on Team/Enterprise Cloud (Pages from a
   private repo). Advisory.
2. **Tighten member defaults** — `default_repository_permission: none`, plus
   private-repo creation enabled so `gh student accept` works. On a plan-gated
   rejection it retries per policy and warns per field.
3. **Enable org Actions** — turns Actions on if it's off org-wide.
4. **Create or fetch the config repo** — `classroom50`, with `auto_init`.
5. **Skeleton drop / refresh** — commits the embedded workflows and scripts; on
   re-runs, refreshes stale files after confirmation (`--yes` skips).
6. **Enable Pages** — public, so students and the runner can fetch published
   files unauthenticated.
7. **Branch protection** — no force-push or deletion on the default branch.
8. **Workflow permissions** — raises `GITHUB_TOKEN` to write.
9. **Reusable-workflow access** — lets student shims call the runner workflow.
10. **Service token** — validates and uploads `CLASSROOM50_SERVICE_TOKEN`.

</details>

**Service token requirements:** a fine-grained PAT with **Contents: Read and
write**, **Actions: Read and write**, **Administration: Read and write** (repo),
and **Members: Read** (organization). Scope it to **All repositories** — student
repos are created on demand, so "Only select repositories" misses them. See the
[CLI Teacher Guide](CLI-Teacher-Guide#create-the-service-token) for the full
walkthrough.

<details>
<summary>Skeleton files shipped into the config repo</summary>

| Path | Purpose |
| --- | --- |
| `.github/workflows/publish-pages.yaml` | Publishes allow-listed files to Pages. |
| `.github/workflows/collect-scores.yaml` | `workflow_dispatch` + nightly cron score collection. |
| `.github/workflows/probe-token.yaml` | Read-only service-token health check. |
| `.github/workflows/autograde-runner.yaml` | Reusable workflow called by every student repo. |
| `.github/scripts/runner.py` | Grading bootstrap fetched from Pages each submission. |
| `.github/scripts/collect_scores.py` | Team-driven score collector. |
| `.github/scripts/probe_token.py` | Service-token scope probe. |
| `README.md` | Describes the config repo layout. |

Both collection and regrade are **team-driven**: the classroom GitHub team is
the source of truth for enrollment.

</details>

## `audit`

Read-only audit of the org member-privilege lockdown. Makes no changes.

```sh
gh teacher audit <org>
gh teacher audit <org> --json
```

Classifies each in-scope setting as **Verified** (API value matches the
lockdown), **Action required** (drifted, with the fix), or **Confirm by hand**
(the four settings GitHub exposes no API to read). Exits non-zero when any
API-readable field is unenforced, so `gh teacher audit <org> && …` is safe in
scripts. `--json` emits `{org, plan, read_ok, lockdown_complete, enforced,
unenforced, manual_unreadable, settings_url}`.

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
gh teacher classroom add <org> <short-name> [--name "<full name>"] [--term <term>]
gh teacher classroom add cs50-fall-2026 cs-principles --name "CS Principles" --term Spring-2026
```

**Short-name rules:** `^[a-z0-9][a-z0-9-]{1,38}$` — 2–39 characters, lowercase
letters/digits/hyphens, starting with a letter or digit. It becomes part of
student repo names (`<short-name>-<assignment>-<username>`).

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

**Legacy alias:** `instructor` is the former name for `teacher`; a pre-rename
team is migrated to `-teacher` automatically on touch.

</details>

**Errors:** missing config repo → `run gh teacher init <org> first`; existing
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
gh teacher classroom migrate --source 95884 --target cs50-fall-2026 --short-name cs-principles --term Spring-2026
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
teacher edits don't lose each other's work. Every row carries an immutable
numeric `github_id` (CLI-managed — don't hand-edit it) so a username change
doesn't desynchronize records.

### `roster list`

```sh
gh teacher roster list <org> <classroom> [--json] [--quiet]
```

Default is an aligned table (empty cells show as `-`). `--json` emits full row
objects (`github_id` is `0` when unresolved); `--quiet` prints one username per
line. Read-only.

### `roster add`

```sh
gh teacher roster add <org> <classroom> <username> [--first-name <n>] [--last-name <n>] [--email <addr>] [--section <s>]
```

Upserts one row by username (case-insensitive), then invites the student to the
organization if needed and adds them to the classroom team. Safe to re-run.

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

Bulk upsert. Accepts a 5-column header
(`username,first_name,last_name,email,section`) or 6-column with a trailing
`github_id` (which is ignored and re-resolved). Every username is resolved up
front — one typo aborts before any commit. New students are invited.

### `roster migrate`

```sh
gh teacher roster migrate <org> <classroom>
```

Renames a classroom's legacy `students.csv` to `roster.csv` in one commit.
Idempotent.

**Errors common to roster commands:** missing config repo → `run gh teacher init
<org> first`; missing `roster.csv` → points at `classroom add`; bad header →
prints the offending header; unknown GitHub user → prints the username; repeated
rebase failures → `lost the rebase race`, retry.

## `staff`

Manage a classroom's **staff teams** — `classroom50-<classroom>-{teacher,hta,ta}`.
The `teacher` and `hta` (head TA) teams get write on the config repo; `ta` gets
read-only. The classroom's GitHub teams — not the `role` column in `roster.csv` —
are the role authority, so a classroom's staff is the same from the CLI or the
web app. (`instructor` is a legacy alias of `teacher`.)

```sh
gh teacher staff add <org> <classroom> <username> [--role teacher|hta|ta]
gh teacher staff remove <org> <classroom> <username> [--role teacher|hta|ta]
```

`--role` defaults to `teacher`. `add` self-heals a classroom that predates staff
teams (creating and recording the missing team). `remove` doesn't touch org
membership and is idempotent.

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
| `--template <owner>/<repo>[@branch]` | Starter-code repo (must be flagged as a template). Omit for a template-less empty repo. Branch defaults to the template's default. |
| `--description <text>` | Short description. |
| `--due <ISO-8601>` | Due date; timezone required. Stored verbatim. |
| `--mode individual\|group` | `individual` (default) or `group` (requires `--max-group-size`). |
| `--max-group-size <N>` | Max group collaborators (2–100). Advisory. |
| `--runtime <path>` | JSON runtime (`runs-on`, toolchains, `apt`, `container`). See [Autograders](Autograders). |
| `--tests <path>` | JSON array of declarative tests. Mutually exclusive with a per-assignment `autograder.py`. |
| `--autograder <name>` | Swap the reusable workflow (rare). Default `default`. |
| `--feedback-pr` | One review PR per student repo. **On by default**; `--feedback-pr=false` disables. |
| `--empty-repo` | Truly bare repos (no README/marker/shim); autograding and feedback PR disabled; immutable; mutually exclusive with template/tests/feedback-pr/allowed-files/pass-threshold. |
| `--pass-threshold <0–100>` | Advisory passing bar shown by gradebook clients. Off when omitted (distinct from `0`). |

**Where grading logic lives** (increasing effort): declarative `--tests` → a
per-assignment `<classroom>/autograders/<slug>/autograder.py` → a classroom
default via `gh teacher autograder set-default`. See [Autograders](Autograders).

<details>
<summary>Errors</summary>

- Missing config repo / `assignments.json` → points at `init` / `classroom add`.
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

### `assignment test`

```sh
gh teacher assignment test add <org> <classroom> <slug> --name "<n>" --type {io,run,python} --run "<cmd>" [options]
gh teacher assignment test list <org> <classroom> <slug> [--json] [-q]
gh teacher assignment test remove <org> <classroom> <slug> <test-name>
```

Manage the declarative `tests` block — GitHub Classroom-style io/run/python
checks graded with no `autograder.py`. `add` upserts by `--name`; it's refused
while a per-assignment `autograder.py` exists. See
[Autograders](Autograders#declarative-tests) for fields and semantics. For bulk
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
CLI** — author them with ordinary git operations. See [Autograders](Autograders).

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
reconcile drift — e.g. a student who never accepted their invite. Default is an
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
`result.json` refresh, and the `scores.csv` summary. Use it when the config repo
isn't bootstrapped, or to grab every matching repo regardless of the roster.

## `teardown`

```sh
gh teacher teardown <org>          # typed org-name prompt
gh teacher teardown --yes <org>    # skip the prompt (scripts only)
```

Deletes **every** repository in `<org>` — a development reset. It confirms the
`classroom50` marker repo exists (refusing otherwise), lists all repos, prompts
for the typed org name, then deletes each (the config repo last, so an
interrupted run stays safe to re-run).

> [!WARNING]
> Requires the `delete_repo` scope, which is **not** in the default set. Opt in
> once with `gh teacher login -s delete_repo`.

## `whoami` / `login` / `logout`

- `whoami` — prints the authenticated GitHub user.
- `login` — runs `gh auth login -s admin:org -s read:org -s repo -s workflow`;
  add scopes with `-s`.
- `logout` — runs `gh auth logout`.

## Contributing

Building, testing, and linting the extension are documented in the
[`cli/gh-teacher/` README](https://github.com/foundation50/classroom50/blob/main/cli/gh-teacher/README.md).
