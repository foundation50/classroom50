# Classroom 50 CLI - Teacher Guide

This is an end-to-end walkthrough of the Classroom 50 CLI for instructors. Each step assumes the previous ones are done. Install the CLI first — see [Installation](Installation).

## 1. Set up the organization (one-time, on github.com)

The CLI doesn't create the org for you. Do these once via the GitHub web UI:

1. **Create the organization** at <https://github.com/account/organizations/new>.
2. **(Optional) Create a template assignment repo.** Assignments can be template-less (students get an empty starter repo with just the autograder shim), so this step is only needed for assignments that ship starter code. Any repo flagged as a template (Settings → "Template repository") works. **A public template always works.** A **private** template works too — but only if it lives **inside your teaching org**: each classroom gets a GitHub team (created by `gh teacher classroom add`), and `gh teacher assignment add` grants that team read access to an in-org private template, so rostered students can create their repo from it under the "No permission" org baseline. A private template **outside** your org is rejected by `gh teacher assignment add` (students can't be granted access to another org's private repo, so `gh student accept` would 404). (GitHub Enterprise Cloud also has an "internal" visibility that all enterprise members can read without per-repo collaboration — see [GitHub's docs on internal repositories](https://docs.github.com/en/enterprise-cloud@latest/repositories/creating-and-managing-repositories/about-repositories#about-internal-repositories).) See [Assignment Templates](Assignment-Templates) for the expected file structure; copy that layout into your own template repo.

The org member-privilege lockdown (base permission "No permission", and disabling every member capability except private-repo creation) is applied by `gh teacher init` (step 3 below) — no manual web-UI tweak required for those. Four settings that have no API are listed as a one-time manual checklist under step 3.

## 2. Log in with the right scopes

`gh teacher login` grants the OAuth scopes the teacher commands need (`admin:org` for org invitations, `workflow` so `gh teacher init` can commit the config repo's workflow files), which a plain `gh auth login` doesn't. Run once:

```sh
gh teacher login
```

![Demo: gh teacher login](images/gh_teacher_auth.gif)

This shells out to `gh auth login -s admin:org -s read:org -s repo -s workflow` and opens a browser to authorize. This is the unified Classroom 50 scope set — `gh student login` requests the same scopes, so one sign-in covers both CLIs. If you haven't logged in to `gh` before, it performs the initial login and grants the scopes in one shot; if you have, it re-authenticates with them appended.

If you skip this step and have no token at all, the CLI detects the missing token and runs `gh teacher login` automatically. If a token exists but lacks one of the required scopes (e.g. `admin:org` for `gh teacher invite` or `workflow` for `gh teacher init`), the affected command fails with an error instructing you to run `gh teacher login` to grant the missing scope.

## 3. Bootstrap the classroom50 config repo

Run once per teaching org to create `<org>/classroom50` — the private config repo that will hold classroom metadata, published assignment manifests, and collected scores:

```sh
CLASSROOM50_SERVICE_TOKEN=github_pat_... gh teacher init <org>
```

Or omit the env var and the command prompts for the token interactively:

```sh
gh teacher init <org>
```

`init` is idempotent: re-running picks up where a prior run left off. It also offers to refresh skeleton files that differ from the CLI's embedded version (how an existing org gains new features like declarative tests) — since that resets any teacher edits to those files, it asks for confirmation first and skips them if you decline (`--yes` skips the prompt for scripted runs).

**Preview first with `--dry-run`.** `gh teacher init <org> --dry-run` runs the read-only preflight checks (OAuth scopes, org access and ownership, plan, and service-token availability) and lists the steps init would perform, without changing anything. If a hard check fails — a missing `admin:org`/`workflow` scope, an org you can't see or don't own, or no token and no interactive terminal — init stops **before** mutating the org, so you never end up half-configured. Run it once before the real run to catch setup problems early.

**Machine-readable output with `--json`.** `gh teacher init <org> --json` emits a single JSON object on stdout (and suppresses the human progress output) summarizing the run: the config repo and Pages URLs, `lockdown_complete`, `lockdown_manual_steps` (member-privilege settings init couldn't apply via the API — plan-gated or enterprise-pinned — each with the exact GitHub-UI instruction to set by hand), `feedback_pr_ready`, `service_token` (how the token was configured this run), the preflight results, every warning, and `manual_hardening_required` — the four settings that have no REST API — as structured `[{setting, url}]` arrays. This lets an orchestrating script or agent branch on "are there manual steps pending?" and "is the org ready?" without scraping prose. `--dry-run --json` emits the same shape with `"dry_run": true`. Add `--quiet`/`-q` to drop the per-step progress chatter while keeping warnings and the final summary.

### Creating the service token

`gh teacher init` provisions a repo-level Actions secret named `CLASSROOM50_SERVICE_TOKEN` (used by `collect-scores.yaml` to read student submissions). You supply the token value; **create it from your own GitHub account** — GitHub's Terms of Service generally permit only one account per person, so there's no separate "service account" to create. Just scope the token tightly to the org you're provisioning.

Create a **fine-grained personal access token** at **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**:

1. **Token name** — e.g. `classroom50-<org>`.
2. **Resource owner** — select **the organization** (`<org>`). This is the critical step: the token can only reach repos owned by the resource owner you pick here. If the org isn't listed, the org has blocked fine-grained PATs (an org owner must allow them).
3. **Expiration** — your choice (fine-grained PATs allow up to 1 year). Set a calendar reminder to rotate before it expires.
4. **Repository access** — **All repositories**. Student repos are created on demand by `gh student accept`, so they don't exist yet — a "Only select repositories" token silently misses them (see the note below).
5. **Repository permissions** — set **Contents: Read and write** and **Actions: Read and write**. (`Metadata: Read-only` is added automatically; that's all group-assignment collaborator reads need too.) Contents read collects scores; Contents write lets regrade push `submit/*` tags; Actions write lets regrade re-run each student repo's autograde workflow.
6. **Organization permissions** — set **Members: Read-only**. This is a **separate section** from Repository permissions and only appears once the org is the Resource owner; it lets `collect-scores` list the classroom team's members (collection is team-driven). It is **not** implied by any repository scope.
7. **Generate** and copy the `github_pat_…` value.

**Approval:** if your org requires approval for fine-grained PATs (the GitHub default), a token created by a regular member stays *pending* until an org owner approves it. Because `gh teacher init` requires you to be an **org owner**, a token you create is **auto-approved** — so it just works. (A classic PAT also works; it's broader than necessary, but init won't stop you.)

**How init uses it:** supply the value via the `CLASSROOM50_SERVICE_TOKEN` environment variable, or let init prompt for it (hidden input) on first setup — there is no `--token` flag (command-line PATs leak via shell history and process listings). init **validates the token against your org before storing it** (it must be able to read *and write* repo contents, and read the org's members), so a mis-scoped or unapproved token is caught immediately instead of surfacing weeks later as a failed `collect-scores` run. On a **re-run**, if the secret is already configured, init leaves it untouched and tells you so — to replace it, set `CLASSROOM50_SERVICE_TOKEN` and re-run, or use `gh teacher rotate-service-token <org>`.

**Verify the full scope set after provisioning.** init's validation is a cheap pre-store check — it proves Contents:write and probes org-member access, but it can't verify the repo-level `Actions` permission (regrade needs it) or the exact per-classroom team read before the team exists. For an exhaustive, read-only signal, run the probe workflow once after `init`/`rotate` (or any time collect/regrade 401/403s):

```sh
gh workflow run probe-token.yaml --repo <org>/classroom50
```

A green run confirms Contents Read+Write, Actions Read+Write, org Members: Read (including each classroom's team read), and Metadata; a red run's log names the missing scope. It's side-effect free — no tags pushed, no runs re-run.

> **Group assignments need no extra scope.** A group assignment grades once in
> the first-accepter's repo; `collect-scores` then reads that repo's collaborators
> to give every group member the same score row. Listing collaborators
> (`GET /repos/{owner}/{repo}/collaborators`) requires only `Metadata: read`,
> which is auto-included on every fine-grained PAT (and already implied by the
> `Contents: read` you grant above), so the same token works for
> individual and group assignments alike — no scope change needed.

> **Why all repositories, not just `<classroom>-*`?** Student repos are created on
> demand when students run `gh student accept`, so they don't exist when you mint the
> token — a PAT scoped to "Only select repositories" can't include them, and
> `collect-scores` silently counts those students as not submitted, logging
> `0/<N> submitted` for the assignment, since an unreadable repo and one with no
> release yet both surface as a 404 from the `/releases` listing. Org-wide
> `Contents: read` is broader than strictly necessary, but it avoids that trap;
> tighten it later if your org policy requires.

Rotate before expiry with:

```sh
gh teacher rotate-service-token <org>

```

**What `init` sets up:** a least-privilege lockdown of org member privileges (the only enabled member capabilities are private repo creation — `members_can_create_private_repositories: true` so `gh student accept` works — and public Pages creation, which init **enforces** so the config repo's public Pages site keeps publishing; everything else is denied: `default_repository_permission: none`, no private Pages, no repo delete/transfer, no repo visibility change, no issue deletion, no team creation, no dependency-insights viewing, and no member-invited outside collaborators — applied via a combined `PATCH /orgs/{org}` that falls back to one PATCH per policy if a plan-gated or enterprise-locked field is rejected, warning only for the fields it can't set; **public/internal repo creation is locked off only on GitHub Enterprise Cloud** — on Team/Free, GitHub couples public and private repo creation into a single "all or none" choice and the student flow needs private creation, so members can also create public repos there and init skips that field), GitHub Actions enabled for the org and re-enabled on the `classroom50` repo so the workflows can run, private `classroom50` repo with `auto_init`, embedded workflows (`publish-pages.yaml`, `collect-scores.yaml`, reusable `autograde-runner.yaml`), GitHub Pages (workflow build, visibility set to **public** so students can fetch published `assignments.json` unauthenticated; non-default `--autograder` YAML shims, when registered, are also fetched from Pages), branch protection on the default branch, workflow `GITHUB_TOKEN` permissions (409 tolerated when the org enforces a stricter policy — skeleton workflows declare their own workflow-level `permissions:` blocks), reusable-workflow access for other repos in the org (so student shims can `uses:` the runner), and the repo-level `CLASSROOM50_SERVICE_TOKEN` Actions secret.

This member-privilege lockdown is what makes it safe for `gh student accept` to leave each student as **admin** of their own assignment repo: students need admin to manage collaborators (so a group founder can add teammates with `gh student invite`), and the org-level locks defang the dangerous repo-admin powers (delete, transfer, visibility change) org-wide.

### Manual org hardening (one-time)

Four member-privilege settings have **no REST API**, so `gh teacher init` can't set them (it prints this same reminder). Apply them once at **Org → Settings → Member privileges** (`https://github.com/organizations/<org>/settings/member_privileges`):

- [ ] **Set "App access requests"** to "Members only" (or "Disable app access requests")
- [ ] **Uncheck "Allow repository admins to install GitHub Apps for their repositories"** (under "GitHub Apps")
- [ ] **Set "Projects base permissions"** to "No access"
- [ ] **Uncheck "Allow repository administrators to rename branches protected by organization rules"** (under "Branch renames"; enabled by default on new orgs; **defense-in-depth** — the `classroom50-protect-submission-history` org ruleset already protects each repo's default branch with org-admin-only bypass, so a student-admin cannot rename out of that protection. Disable it as a tidy-up.)

**Plan check.** `init` warns when the org is not on Team or Enterprise Cloud (required for Pages from a private repo). The warning is advisory; you can still proceed.

**Auditing the lockdown (`gh teacher audit <org>`).** After applying the manual settings — or any time you want to confirm the org is still locked down — run `gh teacher audit <org>`. It's **read-only** (makes no changes) and re-reads the org to report, per setting, whether the least-privilege value is actually in effect. It groups results into:

- **Verified (read from the API)** — the settings `init` sets via `PATCH /orgs/{org}`; verify reads each live value and flags any that drifted (e.g. you re-checked "Allow members to delete or transfer repositories").
- **Confirm by hand** — the four web-UI-only settings above; GitHub exposes no REST API to read them, so verify lists them for you to eyeball rather than implying they're fine.

It exits non-zero when a **critical** API-readable lockdown field is unenforced, so it's scriptable (`gh teacher audit <org> && …`). `--json` emits a machine-readable report (with `lockdown_complete`, `enforced`, `unenforced`, and `manual_unreadable`) for agents. This is the answer to "I unchecked everything from init's Action-required list — did it take?": audit confirms the API-readable ones and reminds you which four you must confirm visually.

After `init` completes, the CLI prints the future Pages URL (`https://<org>.github.io/classroom50/`) and suggests `gh teacher classroom add` as the next step.

## 4. Add a classroom

> **Migrating from GitHub Classroom?** If you already run a course on the legacy product, replace steps 4 and 7 with `gh teacher classroom migrate --source <id-or-org> --target <org>` — it discovers the source classroom, copies each starter repo into your target org as a fresh template, and commits a populated `<short-name>/` directory in one Tree commit. The roster and scores are not migrated; onboard students for the new term via step 6 below. See [`gh teacher classroom migrate`](gh-teacher#gh-teacher-classroom-migrate) for the full reference; pass `--dry-run` first to preview without writing.

Each classroom is a directory at the root of `<org>/classroom50` holding four files:

- `classroom.json` — public name / term / org metadata.
- `assignments.json` — assignment manifest (published via Pages, fetched by `gh student accept` and by the autograde-runner workflow on every submission).
- `roster.csv` — private roster.
- `scores.json` — private collected scores.

Plus, optionally:

- `autograder.py` at the classroom root — the **classroom default autograder**, used by every assignment that doesn't have its own override. Drop it via `gh teacher autograder set-default` (no scaffold by default — classrooms work without one, the runner just publishes a vacuous-pass result).
- `autograders/<slug>/` subdirectories — **per-assignment overrides**. One folder per assignment slug containing `autograder.py` (the entrypoint) and any sibling fixtures or helpers.

Foundation50-managed pieces (the runner-side bootstrap `.github/scripts/runner.py`, the runner workflow, the publish-pages allow-list) live at the org level, not per-classroom; the autograder shim that lands in each student repo is embedded in `gh-student` and never has to be edited by a teacher.

Scaffold one with:

```sh
gh teacher classroom add <org> <short-name> --name "<full name>" --term <term>
```

For example:

```sh
gh teacher classroom add cs50-fall-2026 cs-principles --name "CS Principles" --term Spring-2026
```

The `<short-name>` must match `^[a-z0-9][a-z0-9-]{1,38}$` (2-39 chars, lowercase letters/digits/hyphens, starting with a letter or digit) because it flows into student repo names like `<short-name>-<assignment>-<username>`. `--name` and `--term` are optional but recommended — they're written into `classroom.json` and surface in the published Pages site (forthcoming) and in `gh teacher download` summaries.

The command commits all four paths in a single Tree commit on the default branch. It also creates a **GitHub team** named `classroom50-<short-name>` (privacy `secret`) for the classroom — rostered students are added to it, and it's what grants them read access to in-org private assignment templates (see step 7). If a team by that name already exists, it's adopted in place. If `<org>/classroom50` doesn't exist yet, it prints `run gh teacher init <org> first` and exits non-zero. If the `<short-name>` directory already exists, it refuses to overwrite rather than clobbering an in-progress classroom — modify it via `gh teacher roster add` (step 6) and `gh teacher assignment add` (step 7) instead.

Run this command once per classroom you teach in the org. You can have several classrooms side by side in the same `classroom50` repo.

**Managing classrooms later.** List what's registered with `gh teacher classroom list <org>` (add `--json` for the display name and term). Change a classroom's display name or term with `gh teacher classroom edit <org> <short-name> --name "…" --term …` (the short-name itself is immutable). Delete one with `gh teacher classroom remove <org> <short-name>` — it removes the `<short-name>/` config directory and deletes the classroom's `classroom50-<short-name>` team (not student repos), and asks you to type the short-name to confirm (`--yes` skips the prompt). See the [`gh teacher` reference](gh-teacher#gh-teacher-classroom-list) for details.

## 5. Invite students to the org

The fastest way to add students is `gh teacher roster add` (next step) — it registers them in the classroom roster *and* sends an org invite in one shot. Use the bare `gh teacher invite` only for ad-hoc cases (e.g., inviting a TA who shouldn't be in the student roster, or bringing in someone before the roster is set up):

```sh
gh teacher invite <org> <username>
```

![Demo: gh teacher invite](images/gh_teacher_invite.gif)

The student gets an email invitation. They can accept it by visiting `https://github.com/<org>`, or skip ahead and let `gh student accept` auto-accept the pending invite when they accept their first assignment.

Common API failures (missing scope, not an admin, org not found, already a member, pending invite) surface as actionable messages instead of raw HTTP errors.

To invite a teaching assistant as an org admin instead:

```sh
gh teacher invite --admin <org> <username>
```

To invite someone to a single repo rather than the whole org (e.g. a TA on a specific assignment):

```sh
gh teacher invite <org>/<repo> <username>                 # default: push
gh teacher invite -p maintain <org>/<repo> <username>     # other permissions
```

Permission options for `-p`: `pull`, `triage`, `push`, `maintain`, `admin`. Re-running with a different `-p` updates the existing collaborator's permission in place.

## 6. Track students in the roster

Each classroom keeps a `roster.csv` file inside `<org>/classroom50/<classroom>/`. The CLI manages it for you with three subcommands; you should rarely hand-edit the file.

> **Renamed from `students.csv`.** This file used to be `students.csv`. Classrooms created before the rename are still read automatically (readers fall back to the legacy name), so nothing breaks — but new writes always target `roster.csv`. To convert an existing classroom in a single commit, run `gh teacher roster migrate <org> <classroom>`.

**Add or update one student:**

```sh
gh teacher roster add <org> <classroom> <username> [--first-name <name>] [--last-name <name>] [--email <addr>] [--section <id>]
gh teacher roster add cs50-fall-2026 cs-principles alice --first-name Alice --last-name Andersson --email alice@example.edu --section section-1
```

This resolves the student's immutable `github_id` (GitHub's numeric account ID), upserts the row in `roster.csv` (case-insensitive match on username), and sends an org invitation if they aren't already a member. It also adds the student to the classroom's `classroom50-<classroom>` team, so they inherit read access to the classroom's in-org private assignment templates (the membership goes active immediately for an existing org member, or pending until they accept the org invite). All four data flags are optional; values left unset become empty cells in the CSV. Re-running with the same arguments is safe — the row is replaced, the org invite is skipped if already pending or active, and the team add is idempotent. `gh teacher roster remove` symmetrically removes the student from the team (org membership is left untouched).

**Correct an existing student's details:**

```sh
gh teacher roster update <org> <classroom> <username> [--first-name <name>] [--last-name <name>] [--email <addr>] [--section <id>]
gh teacher roster update cs50-fall-2026 cs-principles alice --email alice@example.edu
```

Reach for `update` when you just need to fix a field on someone already on the roster — a misspelled name, a new email, a section move. Only the flags you pass change; every other column (including `github_id`) is preserved, so `update` won't blank fields the way re-running `add` does. Unlike `add`, it's **roster-only**: no org invite, no `github_id` re-resolution. Pass `--email ""` to clear an address. At least one data flag is required, a patch that already matches the row is a no-op, and an unknown username is an error (it points you at `roster add`).

**Bulk import from a local CSV:**

```sh
gh teacher roster import <org> <classroom> <path-to-csv>
```

Accepts either the canonical 6-column header (`username,first_name,last_name,email,section,github_id` — the same shape `roster.csv` uses on disk) or a 5-column header without `github_id` (recommended for hand-authored CSVs since `github_id` is CLI-managed). The `email` column values may be empty per row. All usernames are resolved up-front; a single typo aborts the whole import before any commit. The entire file is then written in one Tree commit, and every new student is invited to the org. Re-running is safe — already-imported rows just refresh.

**View the current roster:**

```sh
gh teacher roster list <org> <classroom>
gh teacher roster list cs50-fall-2026 cs-principles --json
gh teacher roster list cs50-fall-2026 cs-principles --quiet
```

Prints `roster.csv` without opening it on GitHub. Default output is an aligned table (username, name, email, section, github_id; empty cells show as `-`) with a `N student(s)` summary on stderr. Use `--json` for scripting (the full row objects) or `--quiet` for one username per line (handy for piping into `xargs` or an agent loop). An empty roster exits 0 with a clear note; a missing `roster.csv` points you back at `gh teacher classroom add`. Read-only — no commit lands.

**Remove a student from the roster:**

```sh
gh teacher roster remove <org> <classroom> <username>
```

Drops the row from `roster.csv`. **Does NOT remove org membership** — use `gh teacher remove <org> <username>` (step 8) for that. Splitting roster removal from org removal is deliberate: an off-by-one roster edit shouldn't be able to revoke a student's access to every repo in the org.

**Migrate a legacy classroom's roster file:**

```sh
gh teacher roster migrate <org> <classroom>
```

Renames a classroom's legacy `students.csv` to `roster.csv` in a single commit. Idempotent — a classroom already on `roster.csv` (or with no roster file yet) is a no-op. You rarely need this: readers already fall back to the legacy name, so migrating is only about making the on-disk name match the current convention.

`roster list` is read-only; the write subcommands (`add`, `update`, `import`, `remove`, `migrate`) go through an optimistic-update-with-rebase loop (a small number of retries with exponential backoff) so two teachers editing the roster concurrently can't silently lose each other's work. If you see a `lost the rebase race` message, just retry the command.

## 7. Add assignments

Each classroom keeps an `assignments.json` file inside `<org>/classroom50/<classroom>/`. Each entry pairs a slug (used in student repo names like `<classroom>-<slug>-<username>`) with an optional template repo, an optional due date, an optional runtime block, and the workflow-shim name (the `autograder` field; defaults to `default` = the universal shim embedded in `gh-student`). Register one with:

```sh
gh teacher assignment add <org> <classroom> <slug> --name "<name>" [--template <owner>/<repo>[@branch]] [--description <text>] [--due <ISO-8601>] [--runtime <path>] [--autograder <name>]
gh teacher assignment add cs50-fall-2026 cs-principles hello --name "Hello" --template cs50/hello-template --due 2026-09-15T23:59:00-04:00
gh teacher assignment add cs50-fall-2026 cs-principles greet --name "Greet" --template cs50/greet-template --runtime ./runtime-c.json
gh teacher assignment add cs50-fall-2026 cs-principles reflection --name "Reflection"   # no template → empty starter repo
```

**`--name` is required; `--template` is optional.** Omit `--template` for a template-less assignment — students then get an **empty** private repo containing only the autograder workflow shim (no starter files), which is useful for write-from-scratch or short-answer work. The slug must match `^[a-z0-9][a-z0-9-]{1,38}$` (the same shape as classroom short-names). When you do pass `--template`, the template repo must be flagged `is_template: true` (Settings → "Template repository") and visible to your token. **Private templates:** if the template is private and lives **in your org**, `assignment add` grants the classroom's team read access to it so students can generate from it (idempotent — re-running won't duplicate the grant). A private template **outside** your org is rejected, since students can't be granted access to it. A public template anywhere works with no grant. When you omit `@branch`, the CLI reads the template's default branch from `GET /repos/{owner}/{repo}` and writes that into `assignments.json`. **Note:** re-running `assignment add` on an existing assignment *without* `--template` drops its template (the entry becomes template-less); the CLI warns when this happens.

**Per-assignment grading is NOT registered here.** Drop an `autograder.py` at `<classroom>/autograders/<slug>/autograder.py` in the config repo — that single file is the entrypoint the runner invokes per submission. Or run `gh teacher autograder set-default <org> <classroom> --from <path>` to install a classroom default at `<classroom>/autograder.py` that grades every assignment in the classroom. See the [Autograders](Autograders) wiki page for the entrypoint contract and templates (pytest, check50, custom).

**Optional flags:**

- `--description <text>` — short description written into the entry.
- `--due <ISO-8601>` — a due date, e.g. `2026-09-15T23:59:00-04:00`. Normalized to a UTC instant before storage (so that example lands as `2026-09-16T03:59:00Z`). If you omit the offset (`2026-09-15T23:59:00`), your machine's local timezone is auto-detected and applied. The original value and detected zone are preserved in a `due_meta` block for auditing. A bare date with no time is rejected as ambiguous.
- `--mode individual|group` — `individual` (default) gives each student their own repo. `group` lets teammates share one repo: the first student to `gh student accept` creates it (and becomes its admin), then adds teammates with `gh student invite <org>/<repo> <teammate>`. Requires `--max-group-size`.
- `--max-group-size <N>` — maximum collaborators on a group repo (`>= 2`; required with `--mode group`, rejected otherwise). **The limit is advisory** — the CLI does not hard-enforce it; the founder coordinates group size when adding teammates, and collaborators can also be added directly through GitHub's web UI. At collection time a group submission's score is fanned out to every rostered member (the runner emits the owner; `collect-scores` reads the repo's collaborators and credits each — see step 9).
- `--runtime <path>` — JSON file describing the runtime environment for this assignment's autograde job (`runs-on`, `python` / `node` / `java` / `go` / `rust`, `apt`, or a custom `container` image). Omit for the defaults (ubuntu-latest + Python 3.12). The runner reads this on every submission, so changes propagate without any student-repo edit. See the [Autograders](Autograders) wiki page for the schema and worked examples.
- `--autograder <name>` — reserved for swapping the entire reusable workflow (rare). For different language toolchains or apt packages, use `--runtime` instead. Default `default` resolves to the universal shim embedded in `gh-student`; non-default values reference a sibling `<classroom>/autograders/<name>.yaml` you've authored, and the CLI verifies that file exists before the assignment lands.

Re-running with the same slug replaces the entry in place (idempotent). New slugs append.

Remove an entry with:

```sh
gh teacher assignment remove <org> <classroom> <slug>
```

This does NOT touch existing student repos — the starter code and submission history stay intact; only new `gh student accept` invocations stop finding the slug. Idempotent: an already-absent slug exits 0 with a note.

**List what's registered** at any time:

```sh
gh teacher assignment list <org> <classroom>            # one slug per line on stdout
gh teacher assignment list <org> <classroom> --json     # full JSON array of entries
```

The default form is pipeable directly into `xargs gh teacher download` or any other command that takes a slug from stdin; the `--json` form preserves every field (template ref, due, autograder) for scripting against the manifest. Pass `-q` to suppress the stderr summary when capturing stdout in a script.

## 8. Remove students or TAs when needed

```sh
gh teacher remove <org> <username>           # remove from organization
gh teacher remove <org>/<repo> <username>    # remove from one repo
```

The org form revokes access to every repository in the org, removes the user from all teams, and cancels any pending invitation in one call. Both forms are idempotent — a 404 (user is not a member or collaborator) prints a clear message and exits 0 so re-runs are safe.

**Check who's actually a member:**

```sh
gh teacher member list <org>         # org members + pending invitations, with role
gh teacher member list <org>/<repo>  # repo collaborators, with permission level
```

The roster (`roster.csv`) is the *intended* class list; this is *actual* GitHub membership, so the two can drift — e.g. a student who was added to the roster but never accepted their org invite still shows as a pending `invitation`, not a `member`. Default output is a table (`LOGIN`, `KIND`, `ROLE`, `GITHUB_ID`); add `--json` for scripting or `--quiet` for one login per line (pipe into `xargs`/`grep` or diff against the roster to spot who hasn't joined yet). Reading an org's pending invitations needs the `admin:org` scope (the same scope `invite` uses). Read-only.

## 9. Collect scores

Every student submission publishes a GitHub Release on their own repo carrying a `result.json` asset. The `collect-scores` workflow in `<org>/classroom50` walks every `(student, assignment)` pair in `<classroom>/roster.csv` × `<classroom>/assignments.json`, collects **every** `submit/*` release for each expected repo, and aggregates the results into `<classroom>/scores.json` — the authoritative score record for the class.

Run it from the Actions tab on `<org>/classroom50`, or trigger it from your shell:

```sh
gh workflow run collect-scores.yaml --repo <org>/classroom50
gh workflow run collect-scores.yaml --repo <org>/classroom50 -f classroom=cs-principles    # one classroom only
```

The skeleton committed by `gh teacher init` ships the workflow with a nightly cron (`17 4 * * *` UTC), so even if you never trigger it manually, scores land in `scores.json` once a day. If you want manual-only triggering, comment out the `schedule:` block in `.github/workflows/collect-scores.yaml`.

What it does on each run:

1. Iterates every classroom under `<org>/classroom50/<classroom>/` (or just the one you passed via `-f classroom=`).
2. For each `(student, assignment)` pair in `roster.csv` × `assignments.json`, computes the canonical repo name `<classroom>-<assignment>-<username>` (the same formula `gh student accept` uses) and walks that repo's `submit/*` releases. No releases (or a `404`) means the student hasn't accepted or hasn't submitted yet — the collector counts the gap and moves on.
3. For every `submit/*` release found, downloads `result.json`, schema-validates it, and checks the payload's identity against the source repo: `classroom` / `assignment` must match, the payload's `owner` must equal the repo-name-derived owner, and the payload's `assignment_type` must match the assignment's configured `mode` (a mismatch is warned-and-skipped). This defends against a hostile autograder payload trying to land in the wrong scores.json. For a group assignment, the collector then reads the repo's collaborators and records the rostered member list on the entry's `member_usernames`.
4. Upserts the validated payloads into `<classroom>/scores.json` under that assignment's bucket as one entry per repo (keyed by `owner`), with every collected submission retained newest-first in the entry's `submissions` list (each a stored `result.json` minus the redundant `assignment` bucket key). If the assignment has `due`, each submission record gets `"late": true|false` by comparing its `datetime` against the due timestamp. **Existing entries with `"override": true` are preserved verbatim** -- if you hand-edited an entry to grant partial credit, the next collect run leaves it alone.
5. Logs a per-assignment `cs-principles/hello: 23/30 submitted` line so you see roster coverage at a glance.
6. Commits the updated `*/scores.json` files back to `<org>/classroom50` on a single `[Classroom 50] collect: refresh scores.json` commit. A no-op run (no submissions changed) does not produce a commit.

**Token requirements.** The workflow reads the `CLASSROOM50_SERVICE_TOKEN` secret provisioned by `gh teacher init` (a fine-grained PAT with `Contents: Read and write`, `Actions: Read and write`, and `Members: Read` on the org; see the service-token note in the setup section above). If that token expires mid-semester, the workflow run fails loudly with a 401/403 — rotate with `gh teacher rotate-service-token <org>`.

**Override workflow.** To grant partial credit for a flaky test or correct a misgrade, hand-edit `<classroom>/scores.json` in the config repo, change the entry's submission `score`, and add `"override": true` to the entry. Commit and push. The next collect run will leave that entry alone. A `gh teacher score override` CLI helper is planned for a later release; until then, the JSON edit is the canonical path.

**`scores.json` shape:** the root `assignments` object is keyed by assignment slug; each value is `{ "type": "individual"|"group", "entries": [...] }`. An `entry` is one repo's gradebook record, keyed by `owner` (the repo owner). For an **individual** assignment, `owner` is the sole credited student. For a **group** assignment, the entry also carries `member_usernames` — every credited member (collect-scores reads the group repo's collaborators and intersects them with the roster; see the group note below). Each entry's `submissions` list holds every collected submission (newest first); each is the validated `result.json` payload with the redundant `assignment` field dropped (it's the bucket key) — carrying `owner`, `assignment_type`, and optionally `submitted_by` (who pushed) and `late`.

```json
{
  "schema": "classroom50/scores/v1",
  "assignments": {
    "hello": {
      "type": "individual",
      "entries": [
        {
          "owner": "alice",
          "submissions": [
            {
              "schema": "classroom50/result/v1",
              "classroom": "cs-principles",
              "assignment_type": "individual",
              "owner": "alice",
              "submission": "submit/2026-06-01T14-32-05Z-a1b2c3d",
              "commit": "https://github.com/cs50-fall-2026/cs-principles-hello-alice/commit/...",
              "release": "https://github.com/cs50-fall-2026/cs-principles-hello-alice/releases/tag/submit%2F2026-06-01T14-32-05Z-a1b2c3d",
              "review": "https://github.com/cs50-fall-2026/cs-principles-hello-alice/compare/...",
              "datetime": "2026-06-01T14:33:11Z",
              "score": 18,
              "max-score": 30,
              "tests": [
                { "test-name": "compiles", "passed": true, "score": 10, "max-score": 10 }
              ],
              "submitted_by": { "username": "alice", "id": 12345 }
            }
          ]
        }
      ]
    }
  }
}
```

One entry per repo within each assignment bucket: per student for individual assignments, per group (`member_usernames` carries all members) for group assignments. Re-running collect appends new submissions to each entry's `submissions` history and refreshes the entry unless `override: true` is set. (Pre-canonical scores.json shapes are **not** migrated — a non-canonical file fails the run loudly.)

**Group assignments.** A group assignment is graded once, in the first-accepter's repo. `collect-scores` reads that repo's collaborators, **keeps only those on the classroom team** (the owner is always credited), and records that member list as the entry's `member_usernames`, so every teammate on the team gets the same score — `scores.csv` then has a line per member per submission with the shared score. Crediting is gated on team membership, **not** on collaborator permission (a teammate who is also an org owner / admin is still credited). A collaborator not on the classroom team added out-of-band (e.g. via the GitHub UI) is **not** credited. Reading collaborators needs only `Metadata: read` (auto-included on every fine-grained PAT and already implied by `Contents: read`), so the existing service token works as-is. If the collaborator read fails, or only the owner is found, the score is credited to the repo owner only and the run logs a warning. Teammates who joined a repo own no repo of their own, so they are not reported as "missing" in `gh teacher download`.

## 10. Download submissions

After students have run `gh student submit` and the autograde workflow has published its release, pull every student's latest submission for an assignment with:

```sh
gh teacher download <org> <classroom> <assignment>
```

![Demo: gh teacher download](images/gh_teacher_download.gif)

By default the command is **team-driven**: it lists the classroom GitHub team's members (the source of truth for enrollment) and reads `<classroom>/assignments.json` from your config repo, then for each team member:

1. Probes whether the expected `<classroom>-<assignment>-<username>` repo exists in the org.
2. Clones it if it does, or reports `Missing: <username> (not accepted yet?)` if it doesn't.
3. After each clone, refreshes `<repo>/result.json` (the latest submit-tag submission) **and** `<repo>/results.json` (every submission, newest first) from that repo's submit-tag releases — so the autograded payloads land alongside the code.

After all clones, the command writes a `scores.csv` summary at the destination root: **one line per submission**, grouped by team member in team-member order (`username,score,max_score,datetime,submission_tag,submitted_by,review_url,late,override`). `roster.csv` (if present) supplies each row's optional name/section/email metadata. A student who pushed N times contributes N lines (newest first); for a group assignment each credited member gets the team's submission lines. Non-submitters get a single blank-score line so you can sort the spreadsheet by score and immediately see who hasn't submitted yet.

Each run produces a fresh timestamped folder named `<classroom>-<assignment>_submissions_YYYY_MM_DD_T_HH_MM_SS/` (24-hour local time), so re-running picks up newer submissions without overwriting earlier downloads. Override the destination with `-d`:

```sh
gh teacher download -d <dir> <org> <classroom> <assignment>     # literal, no timestamp
```

Existing target dirs are skipped on the clone step, but `result.json` is still refreshed on the existing clones — so re-running after the latest `collect-scores.yaml` cycle picks up the newest score without re-cloning. Pass `--quiet` / `-q` to suppress the per-repo summary; pass `--verbose` / `-v` to stream raw git output instead of the concise `Cloning <name>... Done` summary.

**Fallback for unconfigured classrooms.** If the config repo isn't bootstrapped yet (no `roster.csv`, no `assignments.json`), or you want to clone every matching repo regardless of who's currently rostered, pass `--by-pattern`:

```sh
gh teacher download --by-pattern <org> <classroom> <assignment>
```

That skips the roster lookup and instead pages through the org's repos, cloning every one whose name starts with `<classroom>-<assignment>-`. The `result.json` refresh and the `scores.csv` summary are also skipped in this mode.

## See also

- [`gh teacher` command reference](gh-teacher) — every command and flag.
- [Troubleshooting](Troubleshooting) — debug flags, common errors.
