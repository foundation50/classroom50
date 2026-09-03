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
   code. In the repository's **Settings**, select **Template repository**. See
   [Assignment Templates](Assignment-Templates) for the expected layout.

> [!NOTE]
> A private template must live **inside your organization**; see
> [Template visibility](Assignment-Templates#template-visibility).

`gh teacher init` (step 3) locks down organization member privileges for you.
Four settings have no API and are listed as a manual checklist in that step.

## 2. Log in

```sh
gh teacher login
```

This runs `gh auth login` with the scopes the teacher commands need
(`admin:org`, `read:org`, `repo`, `workflow`) and opens a browser to authorize.
It's the same scope set `gh student login` requests, so one sign-in covers both
CLIs.

> [!NOTE]
> If you skip this, the CLI runs `gh auth login` for you on first use. If your
> existing `gh` login lacks a required scope, the CLI widens it in place with
> `gh auth refresh` (your token is kept, not replaced). A token you supplied
> through `GH_TOKEN` can't be widened; re-issue it with the scopes above or
> unset it and run `gh teacher login`.

## 3. Set up the organization

Run once per organization to create `<org>/classroom50`, the private repository
that holds classroom metadata, published assignment manifests, and collected
scores:

```sh
CLASSROOM50_SERVICE_TOKEN=github_pat_... gh teacher init <org>
```

Or omit the variable and `init` prompts for the token:

```sh
gh teacher init <org>
```

`init` is **idempotent**: re-running picks up where a prior run left off. It
also offers to refresh the **workflow files** (the workflow and script files
Classroom 50 commits to the `classroom50` repository) when the CLI ships newer
versions (this is how an existing organization gains new features); it asks
before overwriting, so your edits are safe. Use `--yes` to skip the prompt in
scripts.

**Useful flags:**

| Flag | Purpose |
| --- | --- |
| `--dry-run` | Run read-only setup checks and list planned steps without changing anything. Run this once first to catch problems early. |
| `--json` | Emit a machine-readable summary (implies `--quiet`). Lets a script check "any manual steps pending?" and "is the org ready?". |
| `--quiet` / `-q` | Drop per-step progress; keep warnings and the final summary. |
| `--yes` | Skip the workflow-refresh confirmation. |

<details>
<summary>What <code>init</code> configures</summary>

`init` applies a least-privilege lockdown of organization member privileges (the
only member capabilities left on are private-repo creation, so `gh student
accept` works, public Pages creation, so the `classroom50` repository can
publish, and team creation, for student-formed groups), enables GitHub Actions,
sets a $0 Actions budget cap when the org has none, creates the private
`classroom50` repository, commits the workflow and script files, enables GitHub
Pages (public, so students and the autograder can fetch published files),
protects the default branch, raises workflow token permissions, allows
reusable-workflow access, and uploads the service token secret.

This lockdown is what makes it safe for `gh student accept` to give students
broad access to their own repository: accept creates the repo with the student
as its creator, then grants them **push** (a legacy `group` founder keeps
admin, which they need to manage collaborators), and the organization-level
locks remove the dangerous repo-admin powers (delete, transfer, visibility
change) org-wide.

</details>

### Create the service token

`init` provisions a repo secret named `CLASSROOM50_SERVICE_TOKEN`, used by the
score-collection, regrade, and token-probe workflows. Create it from **your
own** GitHub account (there's no separate service account) and scope it tightly
to this organization.

Create a **fine-grained personal access token**. On github.com, open your
**Settings**, click **Developer settings**, click **Personal access tokens**,
click **Fine-grained tokens**, then click **Generate new token**:

1. **Token name**: `classroom50-<org>`, for example.
2. **Resource owner**: select **the organization**. This is critical: the token
   can only reach repos owned by the resource owner you pick.
3. **Expiration**: up to 1 year. Set a reminder to rotate it.
4. **Repository access**: **All repositories**. Student repos are created on
   demand, so "Only select repositories" silently misses them.
5. **Repository permissions**: **Contents: Read and write**, **Actions: Read
   and write**, **Administration: Read and write**. (Metadata: Read is added
   automatically.)
6. **Organization permissions**: **Members: Read**. This is a separate section
   that appears only after you pick the org as resource owner. It lets score
   collection list the classroom team.
7. **Generate** and copy the `github_pat_…` value.

> [!NOTE]
> Because `gh teacher init` requires you to be an **organization owner**, a
> token you create is auto-approved even if your org requires approval for
> fine-grained PATs.

**Supply the token** through the `CLASSROOM50_SERVICE_TOKEN` environment variable
or the interactive prompt. There is no `--token` flag, because command-line tokens
leak through shell history. `init` validates the token against your organization
before storing it. On a re-run, an existing secret is left untouched; to replace
it, use `gh teacher rotate-service-token <org>`.

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
prints this same reminder). Apply them once in the organization's **Settings**
under **Member privileges**
(`https://github.com/organizations/<org>/settings/member_privileges`):

- [ ] Set **App access requests** to **Members only** (or **Disable app access
      requests**).
- [ ] Uncheck **Allow repository admins to install GitHub Apps for their
      repositories** (under **GitHub Apps**).
- [ ] Set **Projects base permissions** to **No access**.
- [ ] Uncheck **Allow repository administrators to rename branches protected
      by organization rules** (under **Branch renames**). Defense in depth: the
      `classroom50` repository's rulesets already protect submission history.

`init` also warns if the organization isn't on Team or Enterprise Cloud (needed
for Pages from a private repository). The warning is advisory.

### Audit the lockdown

Any time, confirm the organization is still locked down:

```sh
gh teacher audit <org>
```

It's **read-only** and reports, per setting, whether the least-privilege value is
in effect: **Verified** (read from the API), **Action required** (changed outside
Classroom 50, with the fix), and **Confirm by hand** (the four API-less settings
above). It exits non-zero when any API-readable setting is unenforced, so it's
scriptable; add `--json` for a machine-readable report.

When `init` finishes, it prints the future Pages URL
(`https://<org>.github.io/classroom50/`) and suggests adding a classroom next.

## 4. Add a classroom

Each classroom is a directory in `<org>/classroom50` holding four files:

| File | Purpose |
| --- | --- |
| `classroom.json` | Name, term, and organization metadata. |
| `assignments.json` | The assignment manifest (published through Pages; read by `gh student accept` and the autograde runner). |
| `roster.csv` | The roster (private). |
| `scores.json` | Collected scores (private). |

Optionally, add grading logic later:

- `<classroom>/autograder.py`: the **classroom default autograder**, used by
  every assignment without its own. Install it with `gh teacher autograder
  set-default`.
- `<classroom>/autograders/<slug>/`: **per-assignment overrides**.

Create a classroom:

```sh
gh teacher classroom add <org> <short-name> --name "<full name>" --term <term>
gh teacher classroom add cs50-fall-2026 cs-principles --name "CS Principles" --term Fall-2026
```

The `<short-name>` must match `^[a-z0-9][a-z0-9-]{1,99}$` (lowercase
letters/digits/hyphens, starting with a letter or digit) and, for a new
classroom, is capped at 40 characters. It becomes part of student repository
names like `<short-name>-<assignment>-<username>`, which GitHub limits to 100
characters, so the cap leaves room for the assignment slug and any
username. `--name` and `--term` are optional but recommended.

This commits the four files and creates a **GitHub team** named
`classroom50-<short-name>` that grants rostered students read access to in-org
private templates, plus the `classroom50-<short-name>-{teacher,hta,ta}` staff
teams. Run it once per classroom; you can have several side by side.

**Manage classrooms later:**

- List: `gh teacher classroom list <org>` (add `--json` for name and term, or
  `--all` to include archived classrooms).
- Rename or retag: `gh teacher classroom edit <org> <short-name> --name "…"
  --term …` (the short-name itself is immutable).
- Archive at the end of a term: `gh teacher classroom archive <org>
  <short-name>`. An archived classroom leaves the default list and refuses new
  assignments; student repositories are untouched. `gh teacher classroom
  unarchive` restores it. See
  [`classroom archive`](gh-teacher#classroom-archive--unarchive).
- Delete: `gh teacher classroom remove <org> <short-name>` removes the config
  directory and the classroom's teams, but **not** student repos.

## 5. Invite students

The fastest way to add students is `gh teacher roster add` (next step): it
rosters them *and* sends an organization invite. Use bare `gh teacher invite`
only for ad-hoc cases, like inviting a TA who isn't a student:

```sh
gh teacher invite <org> <username>
```

The student gets an email invitation, or `gh student accept` auto-accepts the
pending invite when they accept their first assignment.

**Other targets:**

```sh
gh teacher invite --admin <org> <username>              # invite as org admin (a co-teacher, for example)
gh teacher invite <org>/<repo> <username>               # invite to one repo (default: push)
gh teacher invite -p maintain <org>/<repo> <username>   # other permissions
```

`-p` accepts `pull`, `triage`, `push`, `maintain`, `admin`. Re-running updates
the collaborator's permission in place.

**Adding staff:** to give a TA or co-teacher a classroom role (not only org
membership), use `gh teacher staff add <org> <classroom> <username> --role
teacher|hta|ta` (`teacher` is the default). `gh teacher staff remove` takes the
role away again without touching org membership. For the roles and what each
can see, see
[Staff, TAs, and multiple teachers](Staff-TAs-and-Multiple-Teachers).

**Inviting by email:** `gh teacher roster invite <org> <classroom> <email>`
invites a student by address and records them on the roster until they accept.
Invite a whole list at once with `--file <path>` (one address per line). See
[Inviting a student by email](#inviting-a-student-by-email).

## 6. Track students in the roster

Each classroom keeps a `roster.csv`. The CLI manages it; you rarely hand-edit
it.

**Add or update one student:**

```sh
gh teacher roster add <org> <classroom> <username> [--first-name <n>] [--last-name <n>] [--email <addr>] [--section <id>]
gh teacher roster add cs50-fall-2026 cs-principles alice --first-name Alice --email alice@example.edu --section section-1
```

Resolves the student's numeric `github_id`, upserts the row (case-insensitive by
username), sends an organization invite if needed, and adds the student to the
classroom team (so they can read in-org private templates). Re-running is safe.
If the student was invited by email, pass `--email` with that same address:
`add` then fills in the pending row instead of adding a second one for the same
person. Without it, the pending row stays put and the student is listed twice. See
[Inviting a student by email](#inviting-a-student-by-email).

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

Accepts three header shapes: the stored roster header
(`username,first_name,last_name,email,section,github_id,role`), the same without
`role`, and the first five columns alone, so a `roster.csv` exported from a
web-managed classroom imports verbatim. The column-by-column reference is in
[Roster CSV fields](Web-Teacher-Guide#roster-csv-fields).

Every username is resolved up front, and a `github_id` cell naming a different
account than the username beside it fails that line rather than guessing. Every
unusable line is reported in one pass and nothing is committed, so one editing
pass fixes the whole file. New students are invited once the commit lands.

> [!NOTE]
> `import` never sends or cancels an email invitation. A row with only an email
> address updates that pending invitation's name and section, matched by address.
> A row carrying a `github_id` but no username is skipped with a notice, since
> `import` resolves students by username and the web app's **Upload roster**
> dialog is what reads id-keyed rows. A `role` column is carried but never
> applied; grant roles with `gh teacher staff add`.

**View the roster:**

```sh
gh teacher roster list <org> <classroom>            # aligned table
gh teacher roster list <org> <classroom> --json     # for scripting
gh teacher roster list <org> <classroom> --quiet    # one username per line
```

The table and `--json` output include pending rows for students invited by email.
`--quiet` omits them, since a row with no username yet would feed scripts a blank
argument.

**Remove a student from the roster:**

```sh
gh teacher roster remove <org> <classroom> <username>
```

> [!NOTE]
> This does **not** remove organization membership; use `gh teacher remove`
> (step 8) for that. Splitting the two is deliberate: a roster edit shouldn't be
> able to revoke a student's access to every repo in the organization.

Roster writes retry on top of each other, so two teachers editing at once can't
lose each other's work. If you see `lost the rebase race`, retry.

### Inviting a student by email

Invite the address itself when a student has no GitHub account yet, or when their
address is all you have:

```sh
gh teacher roster invite <org> <classroom> <email> [--first-name <n>] [--last-name <n>] [--section <s>]
gh teacher roster invite cs50-fall-2026 cs-principles ada@example.edu --first-name Ada --section section-1
```

This sends the organization invitation and records the address on the roster as a
**pending row**: the name and section you gave, with no username yet. Accepting
enrolls the student in one step, because the invitation carries the classroom
team. Record their account afterwards with
[`roster sync`](#syncing-the-roster-with-github).

`roster invite` sends **student** invitations only. Unlike the web app it can't
invite staff, so a mistyped address can never be handed organization ownership.
Grant a classroom role with `gh teacher staff add` once the person has an
account. An address that's already an organization member, or that already has a
pending invitation, is reported as skipped and the command exits 0.

It refuses to send in two cases: the classroom has no usable team recorded in
`classroom.json`, or the roster already lists the address as a **pending
invitation**. (With `--file` that second case is a skip rather than a refusal, so
one already-invited address doesn't stop the batch.) An address some *other* row
merely carries is a shared address (a
parent, a lab contact), so the real person still gets invited: the invitation is
sent, a note on stderr names that row, and **no second row is written**. If the
invitation fails outright, an invite team this run created is cleaned up again,
except after a rate limit, where it's kept for a retry to adopt.

**Invite a whole list by email:**

```sh
gh teacher roster invite <org> <classroom> --file <path>
gh teacher roster invite cs50-fall-2026 cs-principles --file ./section-1-emails.txt
```

Pass `--file` instead of a single address to invite a whole section at once. The
file is plaintext, **one address per line**; blank lines and lines starting with
`#` are ignored, so you can annotate the list. Every address is validated first:
if any line is unusable, the command reports every bad line and **sends nothing**.

Each address goes through the same invite path as a single `roster invite`, and
every successful invitation is retained as a pending row in **one commit** for
the batch. Each address is reported as it resolves, then a summary counts them
(invited, already members or invited, already on the roster, failed, or
deferred), and every skipped or failed address is named with its file line.
Bulk mode is **student-only** and carries no names or sections, so the
`--first-name`, `--last-name`, and `--section` flags are **rejected** with
`--file`. Fill that metadata in afterwards with
[`roster import`](gh-teacher#roster-import), or with `roster update` once the
student has accepted and has a username. A sync never writes a name or a
section: those columns are yours, and are never derived from a GitHub profile.

Exit codes match [`roster sync`](#syncing-the-roster-with-github) so a script can
tell a retryable run from a broken one:

| Code | Meaning |
| ---- | ------------------------------------------------------------------ |
| 0 | Every address was invited or cleanly skipped |
| 2 | Nothing failed, but a GitHub rate limit left addresses uninvited |
| 1 | An address genuinely failed, or the roster write failed |

On a rate limit the command stops sending, waits out GitHub's `Retry-After`
before recording the invitations already sent, then reports the remaining
addresses and exits 2. **Re-running the same command is safe**: addresses already
invited are skipped automatically, and addresses already on the roster get no
second row.

**Call an invitation off:**

```sh
gh teacher roster cancel-invite <org> <classroom> <email>
```

This revokes the invitation, deletes the team that retains the address, and drops
the pending row. It acts only on an invitation GitHub still lists as pending. With
none for the address it reports, changes nothing, and exits 0, because an
invitation the student already accepted looks exactly the same from outside. Run
`roster sync` in that case: it records the student instead of discarding the one
record of which address their account came from.

An organization invitation is org-wide, while the team and row this removes belong
to one classroom, so it first proves the invitation is *this* classroom's: the
invite team for the address must exist, carry a readable invite record, and name
this classroom, and the invitation must carry one of this classroom's teams.
Otherwise it refuses with the invitation intact. Re-run naming the classroom that
actually sent it, or revoke that invitation from the web app's roster or from
`https://github.com/orgs/<org>/people/pending_invitations`.

For the lifecycle end to end, see
[Invitations by email](How-Classroom-50-Works#invitations-by-email).

### Syncing the roster with GitHub

`roster.csv` carries what GitHub can't: names, sections, and the address of a
student who hasn't joined yet. So it can fall behind the organization when a
student accepts an email invitation or a row is missing its `github_id`.
`roster sync` catches the roster up:

```sh
gh teacher roster sync <org> <classroom>            # report what's pending, change nothing
gh teacher roster sync <org> <classroom> --write    # apply it
```

It records the students who accepted an email invitation (username and
`github_id`, onto their own pending row), fills in a missing `github_id` from the
classroom team's membership, and deletes the invite teams that are done. If no
row claims an accepted invitation (the pending row was deleted, or the invite's
roster commit never landed), it appends one so the address isn't lost; that row
records the role of the classroom team the account was found on, so a staff
member who accepted an email invitation is recorded with their staff role rather
than as a student. A role already recorded is never rewritten.

The sync **never removes a row**. A pending row whose invitation expired or was
canceled stays on the roster for you to link or delete by hand (the web app
shows it as unlinked); drop it from the web app's roster or by editing
`roster.csv`.

The web app runs this same sync when a teacher opens the roster, and
additionally refreshes each row's recorded `role` from live team membership; this
is the rest of that work without a browser. For every trigger, see
[What triggers a sync](How-Classroom-50-Works#what-triggers-a-sync).

**Dry run unless you pass `--write`**: without it, no write request is issued at
all. A dry run also flags an invite team whose address the roster *already*
records, since `--write` would retire it. That counts as changes pending, so the
run exits `2` rather than reporting the classroom up to date. On an **archived**
classroom `--write` is refused (the roster is frozen), while a dry run still
reports what's outstanding.

**Exit codes** follow `terraform plan -detailed-exitcode`, so a script can branch
on state without parsing output:

| Code | Meaning |
| --- | --- |
| `0` | Nothing to do, or `--write` applied everything. |
| `1` | An error, or a degraded read left the pass incomplete. No invite team was deleted; re-run once GitHub is healthy. |
| `2` | A dry run found changes pending. |

A scheduled check that only reports what's outstanding:

```sh
gh teacher roster sync "$ORG" "$CLASSROOM"
case $? in
  0) echo "roster is up to date" ;;
  2) echo "roster has changes pending" ;;      # re-run with --write to apply
  *) echo "sync could not complete" >&2 ;;     # degraded read or error
esac
```

Wrap the call in `set +e` (or the `case` above) if your script runs under `set
-e`, since `2` is a normal outcome rather than a failure.

> [!NOTE]
> `sync` is deliberately conservative. Any degraded read, whether GitHub's
> pending invitations or one of the invite teams, makes the whole pass report-only
> and exits `1`, because an unreadable team can't prove that an invite team is
> redundant. No invite team is deleted at all. Warnings about a team it left
> standing go to stderr; the planned edits go to stdout.

## 7. Add assignments

Each classroom keeps an `assignments.json`. Register an assignment:

```sh
gh teacher assignment add <org> <classroom> <slug> --name "<name>" [flags]
gh teacher assignment add cs50-fall-2026 cs-principles hello --name "Hello" --template cs50/hello-template --due 2026-09-15T23:59:00-04:00
gh teacher assignment add cs50-fall-2026 cs-principles reflection --name "Reflection"   # no template: initialized repo (README + control files)
```

**`--name` is required; `--template` is optional.** Omit `--template` for a
template-less assignment (students get an initialized repository with a README
and the autograding setup). The slug must match `^[a-z0-9][a-z0-9-]{1,99}$`
and fit the classroom's slug budget: the classroom short-name and the slug
together can spend at most 59 characters, so
`<classroom>-<slug>-<username>` stays within GitHub's 100-character
repository-name limit for any username. The CLI names the exact budget when a
slug is too long.

**Optional flags:**

| Flag | Purpose |
| --- | --- |
| `--template <owner>/<repo>[@branch]` | Starter-code repository (must be flagged as a template). A `@branch` suffix is ignored with a warning: the assignment always copies the template's default branch. |
| `--description <text>` | Short description. |
| `--due <ISO-8601>` | Due date, such as `2026-09-15T23:59:00-04:00`. Stored as UTC; local timezone assumed if you omit the offset. A bare date with no time is rejected. |
| `--available-from <ISO-8601>` | Release date. Assignments are hidden from the student list by default (invite-link accept only); set this to list the assignment for everyone once the date passes. Listing-only, not access control. |
| `--locked` | Register the assignment locked: students can't see or accept it, and a private in-org template stays unreadable to the classroom team until you unlock with `gh teacher assignment lock --unlock` or `--locked=false` on a re-add. Omitting the flag on a re-add keeps the stored lock. See [Timed assessments](Course-Lifecycle-and-End-of-Term#timed-assessments). |
| `--mode individual\|group\|team` | `individual` (default), `team` (a group assignment: one shared repository per group, owned by a GitHub Team), or `group` (the legacy collaborator-based shared repository). Both group modes require `--max-group-size`; `team` also requires `--team-formation`. |
| `--team-formation teacher\|student` | Who forms a team assignment's groups: `teacher` (you create the group teams; see [Manage group teams](#manage-group-teams)) or `student` (the first student founds a group with `gh student accept --new-team`). Required with `--mode team`. |
| `--max-group-size <N>` | Maximum group size (2 to 100). Enforced by Classroom 50 clients when groups form; advisory beyond that. |
| `--runtime <path>` | JSON describing the autograde environment (`runs-on`, language versions, `apt`, or a `container`). Omit for ubuntu-latest and Python 3.14. See [Advanced Autograding](Advanced-Autograding#the-runtime-block). |
| `--tests <path>` | JSON array of declarative tests (or `-` for stdin). Sets the whole `tests` block at once; add one test at a time with `assignment test add` instead. Mutually exclusive with a per-assignment `autograder.py`. |
| `--autograder <name>` | Reserved for swapping the whole reusable workflow (rare). Use `--runtime` for language toolchains. |
| `--feedback-pr` | One long-lived feedback PR per student repo for inline review. On by default; `--feedback-pr=false` disables. |
| `--empty-repo` | Truly bare student repos (no README, marker, or autograde workflow) for students who build everything from scratch. Disables autograding and the feedback PR. |
| `--allowed-files <pattern>` | Repeatable `.gitignore`-style pattern defining which files belong to the submission; the runner removes everything else before grading. See [Restricting submission files](Advanced-Autograding#restricting-submission-files-allowed_files). |
| `--student-permission <role>` | Role each student gets on their own repo at accept (`pull`, `triage`, `push`, `maintain`, `admin`). Default `push` for individual, `admin` for group. |
| `--repo-visibility private\|public` | Visibility each student repo is created with. Default `private`; `public` warns students upfront that their work is visible to anyone. |
| `--pass-threshold <0-100>` | Advisory passing bar shown on the submissions page. Off when omitted. |
| `--submission-mode every-push\|tag` | When the autograder fires. `every-push` (default) grades every push; `tag` grades only on explicit submits (`gh student submit`, or a hand-pushed `submit/*` tag), so regular pushes cost no Actions minutes: the cost lever for large classrooms. |
| `--submission-tag <pattern>` | Milestone tag (repeatable) that also triggers grading, such as `--submission-tag phase1 --submission-tag phase2`. Students grade a milestone with plain git: `git tag phase1 && git push origin phase1`. Works with either mode; the graded record still appears as a `submit/*` release. |

A few provisioning settings have no flag and live in `assignments.json` only:
opting out of the built-in autograder (`no_autograder`), the README-less
`init_shim` shape, `include_all_branches`, and `release_assets` (files attached
to each submission release). Set them in the web assignment form or by editing
the file; a same-slug re-add carries them forward. See
[Repository shapes](gh-teacher#assignment-add) in the reference.

> [!NOTE]
> **Custom grading isn't registered here.** Drop an `autograder.py` at
> `<classroom>/autograders/<slug>/` in the `classroom50` repository, or set a classroom
> default with `gh teacher autograder set-default`. See [Advanced Autograding](Advanced-Autograding#classroom-default).

Re-running with the same slug rebuilds the entry from the flags you pass (a
template, tests, allowed files, pass threshold, or student permission you
don't re-pass is dropped, with a warning); new slugs append.

**Add declarative tests** without writing an autograder:

```sh
gh teacher assignment test add cs50-fall-2026 cs-principles hello --name compiles --type run --run "gcc -o hello hello.c" --points 1
gh teacher assignment test add cs50-fall-2026 cs-principles hello --name "prints hello" --type io --setup "gcc -o hello hello.c" --run ./hello --expected "Hello, world!" --comparison included --points 2
gh teacher assignment test list cs50-fall-2026 cs-principles hello
gh teacher assignment test remove cs50-fall-2026 cs-principles hello compiles
```

`add` upserts by `--name` and is refused while the assignment has a
hand-written `autograder.py`. Tests are stored on the assignment and bundled
into a `tests.json` when Pages publishes, so never commit a `tests.json` under
`<classroom>/autograders/<slug>/`. For every flag, see
[`assignment test`](gh-teacher#assignment-test); for the field semantics, see
[Declarative tests](Autograding-Basics#declarative-tests).

**Manage the classroom default autograder:**

```sh
gh teacher autograder set-default <org> <classroom> --from ./autograder.py   # install or replace
gh teacher autograder set-default <org> <classroom>                          # install the diagnostic stub
gh teacher autograder show <org> <classroom>                                 # print it (--json for metadata)
gh teacher autograder list <org> <classroom>                                 # named shims and per-assignment overrides
gh teacher autograder remove <org> <classroom>                               # delete it (prompts; --yes skips)
```

The default runs for every assignment without a per-assignment override or
declarative tests. Without one, those assignments grade as a vacuous pass. The
stub `set-default` installs with no `--from` echoes the runner's environment,
which is useful for checking the pipeline before writing real grading logic.
See [`autograder`](gh-teacher#autograder).

**Lock or unlock an assignment** (a timed assessment, for example):

```sh
gh teacher assignment lock <org> <classroom> <slug>
gh teacher assignment lock <org> <classroom> <slug> --unlock
```

While locked, students can't see or accept the assignment, including students
who already accepted, and the student team loses read on a private in-org
template. `--locked` on `assignment add` registers it locked from the start.
See [`assignment lock`](gh-teacher#assignment-lock).

**Reuse an assignment in another classroom** (next term's classroom, for
example):

```sh
gh teacher assignment reuse <org> <slug> --from <source-classroom> --to <target-classroom>
gh teacher assignment reuse cs50-fall-2026 hello --from cs-principles-2025 --to cs-principles-2026
```

Every field is copied; only the slug and name can change (`--slug`, `--name`).
Student repositories and scores are not copied. Add `--json` to read the final
slug, which is auto-suffixed on a collision. See
[`assignment reuse`](gh-teacher#assignment-reuse).

**Change when grading runs (and fix existing repos):**

```sh
gh teacher assignment submission-mode <org> <classroom> <slug> --tag          # grade on submit only
gh teacher assignment submission-mode <org> <classroom> <slug> --every-push   # back to grading every push
```

The trigger lives in each student repo's workflow file (set at accept time),
so this command both flips the assignment field and rewrites the workflow
across existing student repos, idempotently, with a `[skip ci]` commit that
doesn't trigger grading. Hand-edited workflows are reported and left
untouched. Tell students to `git pull` afterward. See
[`assignment submission-mode`](gh-teacher#assignment-submission-mode) for
`--user`, `--dry-run`, and the custom-autograder rules.

**Rename an over-budget assignment slug:**

```sh
gh teacher assignment rename <org> <classroom> <old-slug> <new-slug>
```

Offered only when the current slug can push student repository names past
GitHub's 100-character limit (for example, a slug imported from GitHub
Classroom before the budget existed). One command renames the assignment and
every student repository to match; GitHub redirects the old names, so
existing clones keep working, and collected scores follow the new slug. A
rename is one-shot (the old slug stays permanently reserved), and the
assignment stays locked until every repository is renamed (re-run the same
command to heal failures). Students run `git pull` once before their next
`gh student submit`. See
[`assignment rename`](gh-teacher#assignment-rename) for the full flow.

**Remove an assignment:**

```sh
gh teacher assignment remove <org> <classroom> <slug>
```

This does **not** touch existing student repos; only new `gh student accept`
calls stop finding the slug.

**List assignments:**

```sh
gh teacher assignment list <org> <classroom>            # one slug per line
gh teacher assignment list <org> <classroom> --json     # full entries
```

### Manage group teams

A `--mode team` assignment's groups are GitHub Teams named
`classroom50-group-<hash>-<n>`, each owning the shared repository
`<classroom>-<assignment>-group-<n>`. Manage them with `gh teacher team`:

```sh
gh teacher team create cs50-fall-2026 cs-principles project --name "The Sharks" --member alice --member bob
gh teacher team list cs50-fall-2026 cs-principles project
gh teacher team add cs50-fall-2026 cs-principles project 2 alice
gh teacher team remove cs50-fall-2026 cs-principles project 2 alice
gh teacher team delete cs50-fall-2026 cs-principles project 2
gh teacher team copy cs50-fall-2026 cs-principles project2 --from project
```

- Members must be on the classroom roster, and each team's size is capped by
  the assignment's `max_group_size`. A student can be on only one of an
  assignment's groups.
- A team can be referenced by its counter (`2`) or by its full slug.
- Membership writes also update the `<classroom>/teams.json` snapshot, the
  record of intended membership; `team list` shows each team's drift against
  it. GitHub Teams stay authoritative for who can push.
- `team copy` recreates another assignment's teams for this one (same members
  and display names, fresh numbering), useful for a project sequence with
  stable groups.

For a teacher-formed assignment (`--team-formation teacher`), create the
groups before sharing the invite link: a student who isn't in a group can't
accept. The web app's **Manage groups** page manages the same teams. See
[`team`](gh-teacher#team) for every subcommand and flag.

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
`collect-scores` workflow walks each `(member, assignment)` pair in scope,
collects each repo's submissions, and aggregates them into
`<classroom>/scores.json`, the classroom's authoritative score record. By
default the scope is every classroom and every assignment; you can narrow it to
one classroom, or to a single assignment (see below). Members are the union of
the student team and the staff teams (teacher/hta/ta), so a staff member who
accepted an assignment to test the autograde flow is collected like a student;
staff who never accepted have no repo and produce no entry.

Run it from the **Actions** tab on `<org>/classroom50`, with the web app's
per-assignment **Collect now** button, or from your shell. Scores refresh only
once one of those triggers a run.

```sh
gh workflow run collect-scores.yaml --repo <org>/classroom50
gh workflow run collect-scores.yaml --repo <org>/classroom50 -f classroom=cs-principles   # one classroom
gh workflow run collect-scores.yaml --repo <org>/classroom50 -f classroom=cs-principles -f assignment=hello   # one assignment
```

An `assignment=` run walks only that assignment's repos, which is much faster
and lighter on API rate limits for a large classroom, and is exactly what the
web app's per-assignment **Collect now** button dispatches. Each collected
assignment's bucket in `scores.json` gets a `collected_at` UTC timestamp, so
you (and the web app's freshness strip) can tell when each assignment was last
walked; a scoped run leaves sibling assignments' buckets untouched. The
staff-team access grant that rides along with collection is scoped the same
way: an `assignment=` run grants the staff teams read on only that
assignment's repositories and template, and staff teams with no members are
skipped.

<details>
<summary>What each collection run does</summary>

1. Iterates each classroom (or only the one you passed).
2. For each `(member, assignment)` pair (every student team member plus every
   staff team member, narrowed to one assignment when you passed
   `assignment=`), computes the repo name
   `<classroom>-<assignment>-<username>` and walks its `submit/*` releases. No
   releases means the member hasn't accepted or submitted yet (a staff member
   who never accepted drops out here).
3. Downloads and schema-validates each `result.json`, checking its identity
   against the source repo (a hostile payload can't land in another student's
   scores). For a group assignment, it credits the group team's live rostered
   members; for a legacy group assignment, it reads the repo's collaborators
   and records the credited members.
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

**Group assignments** are graded once, in the group's shared repository.
Collection credits the group team's live members who are on the classroom
roster (recording the team slug with the entry); a group team it can't read is
skipped, so the entry's previous credit is preserved rather than degraded. A
**legacy group** assignment is graded once in the founder's repo: collection
reads that repo's collaborators, keeps those on the classroom team, and
credits each with the same score. See
[Group attribution model](Autograding-Basics#group-attribution-model) for the
full attribution model, and [Reading results](Autograding-Basics#reading-results)
for where every result lives, per-test breakdowns, and past attempts.

## 10. Download submissions

Pull every student's latest submission for an assignment:

```sh
gh teacher download <org> <classroom> <assignment>
```

By default this is **team-driven**: it lists the classroom team's members, and
for each one probes for the expected repo, clones it (or reports `Missing:
<username>`), and refreshes `result.json` (latest submission) and `results.json`
(all submissions) from the repo's releases.

It then writes a `scores.csv` at the destination root, **one line per
submission** (a student with several pushes contributes several lines), plus a
blank-score line for each non-submitter, so you can sort by
score to see who hasn't submitted. The column-by-column reference for
`scores.csv` (and the per-repository `result.json` / `results.json` files) is in
[Score exports](Autograding-Basics#score-exports) in Autograding Basics.

Each run creates a fresh timestamped folder. Override the destination with `-d`:

```sh
gh teacher download -d <dir> <org> <classroom> <assignment>
```

> [!NOTE]
> **Unconfigured classrooms.** If the `classroom50` repository isn't bootstrapped, or you
> want every matching repo regardless of the roster, pass `--by-pattern`. It
> clones every repo whose name starts with `<classroom>-<assignment>-` and skips
> the `result.json` refresh and `scores.csv` summary.

## Resetting a development organization

`gh teacher teardown <org>` deletes **every** repository in a Classroom 50
organization, then removes its classroom, invite, and group teams. It's meant
for resetting a test organization between iterations, not for a live classroom;
it refuses unless `<org>/classroom50` exists, lists every repository first, and
asks you to type the org name. It needs the `delete_repo` scope, which
`gh teacher login` doesn't request by default: opt in once with
`gh teacher login -s delete_repo`. See [`teardown`](gh-teacher#teardown).

## See also

- [`gh teacher` reference](gh-teacher): every command and flag.
- [Troubleshooting](Troubleshooting): debug flags and common errors.
