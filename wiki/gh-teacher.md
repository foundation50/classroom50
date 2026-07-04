# `gh teacher` reference

Complete reference for the teacher CLI. For a step-by-step walkthrough, see the [CLI Teacher Guide](CLI-Teacher-Guide).

Run `gh teacher <command> --help` for the live flag list. Errors always go to stderr with a non-zero exit code. Commands that emit informational output accept `--quiet` / `-q` to suppress it; pass `--verbose` / `-v` to see per-step operational details (e.g. raw `git` output during `download`).

## Commands at a glance

| Command | Description |
| --- | --- |
| `gh teacher whoami` | Print the authenticated GitHub user. |
| `gh teacher login` | Log in to GitHub via `gh auth login`, requesting the unified Classroom 50 scope set — `admin:org`, `read:org`, `repo`, `workflow` — the same set `gh student login` requests, so one sign-in covers both CLIs. Pass `-s` to add other scopes (e.g. `delete_repo` for teardown). Other commands trigger this same login flow automatically when no token is configured for `github.com`. |
| `gh teacher logout` | Log out of GitHub via `gh auth logout`. |
| `gh teacher invite <org> <user>` | Invite user to an org (use `--admin` for org admin). |
| `gh teacher invite <org>/<repo> <user>` | Invite user to a specific repo. Default permission `push`; override with `-p {pull,triage,push,maintain,admin}`. Re-running updates the collaborator in place. |
| `gh teacher remove <org> <user>` | Remove user from an org. Revokes access to every repo in the org, removes them from all teams, and cancels any pending invitation. Idempotent. |
| `gh teacher remove <org>/<repo> <user>` | Remove user from a single repo. Idempotent. |
| `gh teacher member list <org>` | List actual org members + pending invitations, with role. Optional: `--json`, `--quiet` (login-only). Read-only. |
| `gh teacher member list <org>/<repo>` | List actual repo collaborators, with permission level. Optional: `--json`, `--quiet` (login-only). Read-only. |
| `gh teacher download <org> <classroom> <assignment>` | Roster-driven by default: clone one repo per `<classroom>/students.csv` row, refresh each repo's `result.json` (latest submission) and `results.json` (every submission) from its submit-tag releases, and write a per-submission `scores.csv` summary at the destination root. Pass `--by-pattern` to skip the roster lookup and clone by name prefix instead. Default destination is `<classroom>-<assignment>_submissions_<YYYY_MM_DD_T_HH_MM_SS>/`; override with `-d`. |
| `gh teacher teardown <org>` | Delete every repo in a Classroom 50 org (development reset). Requires `<org>/classroom50` to exist (the marker repo guards against accidental teardown of non-Classroom orgs); prompts for typed org-name confirmation unless `--yes`; deletes `classroom50` last so an interrupted run stays safe to re-run. Requires the `delete_repo` OAuth scope (opt in once via `gh teacher login -s delete_repo`). |
| `gh teacher init <org>` | Bootstrap `<org>/classroom50` (org member defaults, config repo, Pages, branch protection, service-token secret). Idempotent; re-runs also refresh stale skeleton files after a confirmation prompt (`--yes` to skip). |
| `gh teacher audit <org>` | Read-only audit of the org member-privilege lockdown. Re-reads the org and reports which API-readable settings are enforced vs. drifted, plus the four web-UI-only settings it can't read (confirm by hand). Exits non-zero if **any** API-readable lockdown field is unenforced (matching the web GUI's verdict); `--json` for a machine-readable report. |
| `gh teacher rotate-service-token <org>` | Replace the `CLASSROOM50_SERVICE_TOKEN` repo secret on an existing config repo. |
| `gh teacher classroom add <org> <short-name>` | Add a new classroom directory to `<org>/classroom50`. Optional flags: `--name "<display name>"`, `--term <e.g. Spring-2026>`. Refuses to overwrite an existing classroom. |
| `gh teacher classroom list <org>` | List the classrooms registered in `<org>/classroom50`, one short-name per line. Archived classrooms (`active: false`) are hidden by default — pass `--all` to include them (tagged ` (archived)`). Optional: `--json` (full `{short_name, name, term, active}` objects), `--quiet` (suppress the stderr summary). Read-only. |
| `gh teacher classroom edit <org> <short-name>` | Update a classroom's display name and/or term in `classroom.json`. Requires at least one of `--name "<display name>"`, `--term <term>`. The short-name itself is immutable. No-op when values are unchanged. |
| `gh teacher classroom archive <org> <short-name>` | Mark a classroom as archived (`active: false`). Archived classrooms drop out of the default `classroom list`, and `assignment add`/`reuse` refuse to write into them. Existing student repos are untouched. No-op if already archived. Reverse with `unarchive`. |
| `gh teacher classroom unarchive <org> <short-name>` | Restore an archived classroom to active by dropping the `active` flag from `classroom.json` (absent = active). No-op if already active. |
| `gh teacher classroom remove <org> <short-name>` | Delete a classroom's `<short-name>/` directory from `<org>/classroom50` in one commit. Prompts for the typed short-name to confirm; `--yes` skips the prompt. Does NOT delete student repos. |
| `gh teacher classroom migrate --source <id-or-org> --target <org>` | Import an existing GitHub Classroom into `<target>/classroom50`. Discovers the source classroom (numeric ID or org login), copies each starter repo into the target org as a fresh template, and commits a populated `<short-name>/` directory in one Tree commit. Optional: `--short-name`, `--term`, `--template-suffix`, `--include-archived`, `--dry-run`. Roster and scores are NOT migrated. |
| `gh teacher roster list <org> <classroom>` | List the students in `students.csv` as an aligned table (username, name, email, section, github_id). Optional: `--json` (full `{username, first_name, last_name, email, section, github_id}` objects), `--quiet` (one username per line, no table or stderr summary). Read-only. |
| `gh teacher roster add <org> <classroom> <username>` | Append or upsert a student in `students.csv`; resolves `github_id`, sends an org invite if needed. Optional flags: `--first-name`, `--last-name`, `--email`, `--section`. |
| `gh teacher roster update <org> <classroom> <username>` | Correct fields on an existing row (matched by username); only the flags you pass change, `github_id` and unset columns are preserved. Roster-only: no invite, no `github_id` re-resolution. Errors if the student isn't on the roster. Same four optional flags as `add`. |
| `gh teacher roster remove <org> <classroom> <username>` | Remove a row from `students.csv`. Does NOT touch org membership (use `gh teacher remove <org> <username>` for that). Idempotent. |
| `gh teacher roster import <org> <classroom> <path-to-csv>` | Bulk upsert from a local CSV (`username,first_name,last_name,email,section` header; trailing `github_id` accepted but ignored). One Tree commit; auto-invites new students. |
| `gh teacher staff add <org> <classroom> <username>` | Add a user to a classroom's staff team. `--role instructor` (default) or `--role ta`. Membership only — no `students.csv` change. |
| `gh teacher staff remove <org> <classroom> <username>` | Remove a user from a classroom's staff team (`--role instructor`/`ta`). Does not touch org membership. Idempotent. |
| `gh teacher assignment add <org> <classroom> <slug>` | Register or upsert an assignment in `assignments.json`. Required flag: `--name`. Optional: `--template <owner>/<repo>[@branch]` (starter-code repo; omit for a template-less assignment, where students get an empty repo with just the autograder shim), `--description`, `--due` (ISO-8601; stored as UTC, local timezone assumed when the offset is omitted), `--mode` (`individual` default, or `group`), `--max-group-size <N>` (required with `--mode group`, `>= 2`), `--runtime <path-to-json>` (per-assignment runtime: `runs-on`, language toolchains, apt packages, container image), `--tests <path-to-json>` (declarative io/run/python tests, graded with no `autograder.py`), `--autograder <name>` (default `default`; non-default values reference a sibling shim at `<classroom>/autograders/<name>.yaml`), `--feedback-pr` (open one long-lived instructor-review PR per student repo — **on by default**; `--feedback-pr=false` to disable), `--pass-threshold <0–100>` (opt-in advisory passing bar shown by gradebook clients; off when omitted, distinct from `0`). Custom grading code is NOT registered here — drop an `autograder.py` (and any sibling fixtures) under `<classroom>/autograders/<slug>/` in the config repo, or set a classroom default with `gh teacher autograder set-default`. |
| `gh teacher assignment test add <org> <classroom> <slug>` | Add or update one declarative test on an existing assignment's `tests` block. Required flags: `--name`, `--type {io,run,python}`, `--run`. Optional: `--setup`, `--input`/`--input-file`, `--expected`/`--expected-file`, `--comparison {included,exact,regex}`, `--timeout`, `--exit-code`, `--points`. Mutually exclusive with a per-assignment `autograder.py`. |
| `gh teacher assignment test list <org> <classroom> <slug>` | Print the declarative test names on an assignment, one per line. `--json` for the full spec array, `-q` to suppress the stderr summary. Read-only. |
| `gh teacher assignment test remove <org> <classroom> <slug> <test-name>` | Drop one declarative test by name. Idempotent. |
| `gh teacher autograder set-default <org> <classroom>` | Drop a default `autograder.py` at `<classroom>/autograder.py` in the config repo. With `--from <path>` (or `--from -` for stdin), uploads the given Python source. Without `--from`, installs a diagnostic stub that echoes runner metadata and emits a vacuous-pass `result.json` — useful for verifying the runner pipeline before authoring real grading logic. |
| `gh teacher autograder show <org> <classroom>` | Print the classroom default `autograder.py` to stdout, or report none. Optional: `--json` (metadata `{path, exists, is_stub, size, sha}` instead of the body), `--quiet` (suppress the stderr summary). Read-only. |
| `gh teacher autograder list <org> <classroom>` | List named shims (`<name>.yaml`) and per-assignment override bundles (`<slug>/`) under `<classroom>/autograders/`, one per line. Optional: `--json` (full `{name, kind, path}` objects), `--quiet`. The classroom default is not listed (use `show`). Read-only. |
| `gh teacher autograder remove <org> <classroom>` | Delete the classroom default `<classroom>/autograder.py` in one commit (distinct from overwriting it with the stub). Prompts `[y/N]` to confirm; `--yes` skips. Idempotent. Does NOT touch per-assignment overrides or named shims. |
| `gh teacher assignment reuse <org> <source-slug> --from <src> --to <dst>` | Copy an assignment record from one classroom's `assignments.json` into another in the **same org**, changing only slug/name. Every field is copied verbatim (template, due, mode, autograder, tests, …), including unknown/future fields. Refuses an archived target. Optional: `--slug`/`--name` to override (a colliding slug auto-suffixes `-2`/`-3`… case-insensitively unless `--slug` is given), `--json` (emit the resolved copy incl. the final slug). Re-grants the private in-org template's team read for the target. In-org only (v1). |
| `gh teacher assignment list <org> <classroom>` | Print every assignment slug registered in `assignments.json`, one per line on stdout. Pass `--json` for the full entries array, `-q` to suppress the stderr summary. Read-only. |

## `gh teacher init`

One-shot bootstrap for the per-org `classroom50` config repo. See the [CLI Teacher Guide](CLI-Teacher-Guide) for when to run it in your workflow.

```sh
CLASSROOM50_SERVICE_TOKEN=github_pat_... gh teacher init <org>
gh teacher init <org>                  # interactive token prompt (first setup)
gh teacher init <org> --dry-run        # preview preflight + planned steps, no changes
gh teacher init <org> --json           # machine-readable summary on stdout
gh teacher init <org> --yes            # skip the skeleton-refresh confirmation (scripted runs)
```

Performs these steps in order:

1. **Org plan check** — `GET /orgs/{org}`; warns when the org is not on Team or Enterprise Cloud (Pages from a private repo). Advisory only.
2. **Tighten org member defaults** — a combined `PATCH /orgs/{org}` setting `default_repository_permission: "none"` (new members don't get implicit read access to other repos in the org -- existing members and their established access are unaffected) and `members_can_create_repositories: true` + `members_can_create_private_repositories: true` (so `gh student accept` can create each student's private repo). Restricting members to *private repos only* (`members_can_create_public_repositories: false`) is a GitHub Enterprise Cloud capability and is applied only there; on Team/Free GitHub couples public+private into one "all or none" choice and the student flow needs private creation, so members can also create public repos on those plans (init skips that field rather than attempting an impossible lockdown that would also disable private creation). Idempotent -- re-runs on an already-tightened org are no-ops. On 403/422 (a plan-gated or enterprise-locked field), init retries each policy in its own PATCH, applies the ones GitHub accepts, and warns per rejected field with a manual fix at `https://github.com/organizations/{org}/settings/member_privileges`; init still completes. Re-audit any time with `gh teacher audit <org>`.
3. **Enable org Actions** — `GET`/`PUT /orgs/{org}/actions/permissions` turns Actions on for the org when it's disabled org-wide (Classroom50's workflows run as Actions and won't run otherwise); if Actions is limited to selected repositories, init warns to include the config and `<classroom>-*` repos. Read failures and enterprise-locked rejections warn-and-continue.
4. **Create or fetch repo** — `POST /orgs/{org}/repos` with `auto_init: true` for `classroom50`. On 422 (name taken), falls back to `GET /repos/{org}/classroom50`. The default branch from the response flows through to later steps (org policy can rename `main`). Init then re-enables Actions on the new repo via `GET`/`PUT /repos/{owner}/{repo}/actions/permissions` so the skeleton push and first workflow run aren't blocked.
5. **Skeleton drop / refresh** — fresh repos get a single Tree commit of the embedded files (`.github/workflows/`, `.github/scripts/`, `README.md`); `publish-pages.yaml` is templated with the org's actual default branch at commit time. On re-runs, init diffs the repo's skeleton against this CLI's embedded version: identical files report "skeleton up to date", and stale or missing files (e.g. an org bootstrapped before declarative tests gaining `materialize_tests.py`) are listed and committed **after a confirmation prompt** — teacher-customized skeleton files would be reset, so declining is allowed and init continues. `--yes` skips the prompt.
6. **Enable Pages** — `POST .../pages` with `build_type: workflow`; 409 = already enabled. Followed by `PUT .../pages` with `{"public": true}` so the published content is reachable unauthenticated: the student CLIs fetch `assignments.json` (and a non-default `--autograder` shim, when registered); the runner workflow fetches `assignments.json`, `runner.py`, the per-classroom `<classroom>/autograder.py` (when set), and per-assignment bundles. The visibility step is warn-and-continue if the API rejects it (rare org policy), with a manual `Settings → Pages → Visibility` toggle as the recovery path.
7. **Branch protection** — no force pushes or branch deletion on the default branch.
8. **Workflow permissions** — raises default `GITHUB_TOKEN` to `write`. HTTP 409 (org-enforced policy) is tolerated; skeleton workflows declare workflow-level `permissions:` blocks.
9. **Reusable-workflow access** — `PUT .../actions/permissions/access` with `access_level: organization` so student-repo shims can `uses:` the autograde-runner workflow. 403/409 is warn-and-continue with manual recovery instructions.
10. **Service token** — reads `CLASSROOM50_SERVICE_TOKEN` from env (trimmed), piped stdin, or hidden TTY prompt; validates it can read org repo contents; libsodium sealbox-encrypts and uploads as a repo-level Actions secret. A re-run with the secret already present leaves it untouched.

**Service token requirements:** fine-grained PAT with `Contents: Read and write`, `Actions: Read and write`, and Organization `Members: Read` on the org (student repos are created on demand by `gh student accept`, so an "Only select repositories" scope silently misses them). `Contents: write` pushes `submit/*` tags and `Actions: write` re-runs autograde workflows during regrade; `Members: Read` lets `collect-scores` list the classroom team (collection is team-driven); it is a separate Organization-permissions section, not implied by any repository scope. This also covers **group assignments** — `collect-scores` reads a group repo's collaborators via the always-present `Metadata: read` permission (auto-included on every fine-grained PAT), so no extra scope beyond the above is needed.

**Skeleton shipped:**

| Path | Status |
| --- | --- |
| `.github/workflows/publish-pages.yaml` | Working allow-list Pages publisher |
| `.github/workflows/collect-scores.yaml` | Working `workflow_dispatch` + nightly cron |
| `.github/workflows/probe-token.yaml` | `workflow_dispatch` service-token health check. Runs `probe_token.py` to exercise every scope the token needs (Contents R/W, Actions R/W, Members: Read, Metadata) with read-only calls; green means the token will work for collect and regrade. Side-effect free. |
| `.github/workflows/autograde-runner.yaml` | Reusable workflow called by every student-repo autograde shim |
| `.github/scripts/runner.py` | Runner-side bootstrap fetched from Pages on every submission. Downloads the per-assignment bundle, resolves the entrypoint (per-assignment `autograder.py` if present, otherwise the classroom default at `<classroom>/autograder.py`, otherwise a vacuous-pass synthesis), execs it, and validates the v1 `result.json` it produces. Teachers don't normally edit this file — grading logic lives in `autograder.py`. |
| `.github/scripts/collect_scores.py` | Working roster-driven score collector. Walks `(student, assignment)` pairs from `<classroom>/students.csv` x `assignments.json`, collects **every** submit-tag release per `<classroom>-<assignment>-<username>` repo, downloads + schema-validates each `result.json`, and upserts into `<classroom>/scores.json`. The root `assignments` map is keyed by slug → `{type, entries[]}`; each entry is one repo's record (`owner` key, `submissions[]` history, `member_usernames` for groups). `override:true` entries respected; atomic per-classroom write; a malformed per-classroom file is isolated (skip + continue, run exits non-zero). Per-assignment "X of Y submitted" summary on stdout. |
| `.github/scripts/probe_token.py` | Service-token scope probe (run by `probe-token.yaml`). Read-only checks that the `CLASSROOM50_SERVICE_TOKEN` holds every scope collect and regrade need — org Members: Read (plus the exact per-classroom team read), Contents Read+Write (via the config repo's `permissions.push`), Actions Read+Write (via `actions/permissions` reachability), and Metadata. Exits non-zero listing any missing scope; "no student repos / no team yet" is a pass with a note. |
| `README.md` | Describes the config repo layout |

Score collection is **pull-based** and **roster-driven**: the collect workflow reads `<classroom>/students.csv` × `assignments.json`, computes the canonical repo name for each pair, and collects every submit-tag release on that repo. A repo with no releases means the student hasn't accepted or submitted yet (no error — just a gap in the "X of Y submitted" report). No org-repo enumeration, no longest-slug-wins disambiguation, no cross-repo write PAT or `repository_dispatch` from student repos.

## `gh teacher audit`

Read-only audit of the org member-privilege lockdown — the standalone counterpart to the read-back `init` does at the end of its run. Makes **no changes**; safe to run any time.

```sh
gh teacher audit <org>
gh teacher audit <org> --json    # machine-readable report on stdout
```

Re-reads `GET /orgs/{org}` and classifies each in-scope member-default setting (filtered by the org's plan) into:

- **Verified (read from the API)** — settings whose live value matches the locked-down value `init` applies via `PATCH /orgs/{org}`. Drift is flagged here (e.g. you re-checked "Allow members to delete or transfer repositories").
- **Action required** — API-readable settings that are NOT locked down, each with the exact GitHub-UI fix. Critical fields (the ones that defang the founder repo-admin grant org-wide) failing is what makes the command exit non-zero.
- **Confirm by hand** — the four web-UI-only settings (App access requests, repo-admin GitHub App installs, Projects base permissions, branch renames). GitHub exposes **no REST API to read** these, so audit can neither confirm nor deny them; it lists them for a visual check rather than implying they're fine.

**Exit status** is non-zero when **any** API-readable field is unenforced — critical or not (so `gh teacher audit <org> && …` is safe in scripts) or when the org couldn't be read back (inconclusive — treated as a conservative failure, never a false all-clear). This matches the web GUI, which flags **any** drift as "Needs attention"; the two tools agree on the same org state. The unreadable manual items never fail the command. `--json` emits `{org, plan, read_ok, lockdown_complete, enforced[], unenforced[], manual_unreadable[], settings_url}` for an orchestrating agent to branch on.

This answers "I unchecked everything from init's Action-required list — did it take?": audit confirms the API-readable settings landed and reminds you which four you must confirm visually.

## `gh teacher rotate-service-token`

Re-runs only the service-token step of `init` — replaces the `CLASSROOM50_SERVICE_TOKEN` secret in place. Use when the PAT nears expiry or after a suspected compromise. The supplied token is **validated against the org before it's stored** (it must be able to read repository contents), so a misconfigured PAT is caught here rather than via a failed `collect-scores` run.

```sh
CLASSROOM50_SERVICE_TOKEN=github_pat_... gh teacher rotate-service-token <org>
gh teacher rotate-service-token <org>
```

Fails with a clear message if `<org>/classroom50` does not exist (`run gh teacher init <org> first`). Accepts the same token input paths as `init`.

## `gh teacher classroom add`

Create a new classroom directory at the root of `<org>/classroom50` and scaffold its four canonical files in a single commit:

```sh
gh teacher classroom add <org> <short-name> --name "<full name>" --term <term>
gh teacher classroom add cs50-fall-2026 cs-principles --name "CS Principles" --term Spring-2026
gh teacher classroom add cs50-fall-2026 intro-java
```

**Short-name rules** (must match `^[a-z0-9][a-z0-9-]{1,38}$`):

- 2-39 characters total
- lowercase letters, digits, or hyphens
- must start with a letter or digit (not a hyphen)

The short-name flows into student repo names like `<short-name>-<assignment>-<username>` (the convention `gh student accept` and `gh teacher download` rely on), so it has to stay within GitHub's repo-name constraints.

**Flags:**

- `--name <full name>` — display name written into `classroom.json` (e.g. `"CS Principles"`). Optional but recommended.
- `--term <term>` — term identifier written into `classroom.json` (e.g. `Spring-2026`). Optional.

**What it scaffolds**, all in one Tree commit on the default branch:

| Path | Schema sentinel | Contents |
| --- | --- | --- |
| `<short-name>/classroom.json` | `classroom50/classroom/v1` | `name`, `short_name`, `term`, `org`, and a `team` block (`{id, slug}`) recording the classroom's GitHub team |
| `<short-name>/assignments.json` | `classroom50/assignments/v1` | Empty `assignments: []` array — populated by `gh teacher assignment add`. |
| `<short-name>/students.csv` | n/a | Header row begins with `username,first_name,last_name,email,section,github_id`. The `email` column is optional per row (values may be empty). The trailing `github_id` is a hidden column populated by `gh teacher roster add/import` — do not hand-edit it. The Classroom50 web app may append optional onboarding columns after `github_id` (`enrollment_status`, `enrollment_method`, `email_hash`, `invite_token`, `invited_at`, `enrolled_at`); the CLI reads past them and preserves them on edit. |
| `<short-name>/scores.json` | `classroom50/scores/v1` | Scaffolds with an empty `assignments: {}` object -- entries are written by the `collect-scores.yaml` workflow, keyed by assignment slug → `{type, entries[]}`. |

Three things this scaffold does **not** include:

- **The runner-side bootstrap** (`.github/scripts/runner.py`) is landed once by `gh teacher init` and shared across every classroom in the org. The runner stays untouched in normal use.
- **No autograder by default.** Classrooms work end-to-end without one — the runner publishes a vacuous-pass `result.json` (status=`success`, score 0/0) so submissions still tag and release. Add a classroom default later with `gh teacher autograder set-default`, or per-assignment overrides at `<classroom>/autograders/<slug>/autograder.py`.
- **The autograder workflow shim** is embedded in `gh-student` and dropped into each student repo at accept time. Teachers don't write or maintain it.

Per-assignment autograders (an `autograder.py` entrypoint + any sibling fixtures) go under `<short-name>/autograders/<slug>/` once the classroom is in place; the runner picks them over the classroom default at `<short-name>/autograder.py`. Per-assignment runtime customization (Python version, language toolchains, apt packages, container image) lives in the `runtime:` block on each `assignments.json` entry; see [Autograders](Autograders) for the schema.

**Classroom team.** Besides the config files, `classroom add` creates a GitHub team `classroom50-<short-name>` (privacy `secret`, via `POST /orgs/{org}/teams`), reconciling-and-adopting an existing team of that name rather than failing. The team's members are the classroom's rostered students (added by `gh teacher roster add`); it exists to grant those students read access to **in-org private** assignment templates (`gh teacher assignment add` grants `pull` on the template to this team). `gh teacher classroom remove` deletes the team; `gh teacher roster remove` drops a student from it. `members_can_create_teams: false` (set by `init`'s lockdown) doesn't block this — the teacher authenticates as an org owner.

**Staff teams.** `classroom add` (and `classroom migrate`) also create two `secret` staff teams — `classroom50-<short-name>-instructor` and `classroom50-<short-name>-ta` — each granted `push` (write) on the `classroom50` config repo so staff can author assignments. The creating teacher is added to the instructor team as a maintainer. Their `{id, slug}` are recorded under `classroom.json` `teams.{instructor,ta}`, mirroring the web GUI so a classroom managed from either surface has the same staff teams. Manage membership with `gh teacher staff add/remove` (below). `classroom remove` and `teardown` sweep the staff teams alongside the students team.

**Errors:**

- `<org>/classroom50` does not exist → prints `run gh teacher init <org> first` and exits non-zero.
- `<short-name>` directory already exists in the config repo → refuses to overwrite. Use `gh teacher roster add` or `gh teacher assignment add` to modify an existing classroom.
- Short-name fails the slug regex → prints the exact rule with the offending input.

The command commits all four paths in a single Tree commit on the default branch.

## `gh teacher classroom list`

List every classroom registered in `<org>/classroom50`. A classroom is a root-level directory containing a `classroom.json`; directories without one (e.g. `.github`) are skipped.

```sh
gh teacher classroom list <org>
gh teacher classroom list cs50-fall-2026
gh teacher classroom list cs50-fall-2026 --all
gh teacher classroom list cs50-fall-2026 --json
```

Default output is one short-name per line on stdout — pipeable into `xargs`, `grep`, or an agent loop. A one-line `<org>/classroom50: N classroom(s)` summary prints to stderr.

**Archived classrooms are hidden by default.** A classroom archived with `gh teacher classroom archive` (`active: false` in its `classroom.json`) drops out of the default listing, mirroring the web's default classes view. Pass `--all` to include them: in the default output an archived classroom is tagged ` (archived)` after its short-name; in `--json` it carries `"active": false`. An active classroom omits the `active` key entirely (absent = active), so legacy classrooms and re-activated ones read identically.

**Flags:**

- `--json` — emit the full JSON array of `{short_name, name, term, active}` objects instead of bare short-names, preserving the display name, term, and archival state without a second call. `active` is present only on archived classrooms (`false`); absent means active. Scripts/agents that need archived classrooms too must pass `--all` — the filter runs before both the text and JSON render paths.
- `--all` — include archived classrooms (`active: false`), which are hidden by default.
- `-q`, `--quiet` — suppress the stderr summary so stdout is the only output stream a capturing script has to parse.

This is a read-only command; no commit lands on the repo. Missing `<org>/classroom50` points at `gh teacher init`. Exits 0 with empty stdout when no classrooms are registered yet.

## `gh teacher classroom edit`

Update the display name and/or term in `<org>/classroom50/<short-name>/classroom.json`:

```sh
gh teacher classroom edit <org> <short-name> --name "<full name>" --term <term>
gh teacher classroom edit cs50-fall-2026 cs-principles --name "Computer Science Principles"
gh teacher classroom edit cs50-fall-2026 cs-principles --term Fall-2026
```

At least one of `--name` / `--term` must be provided. Only the flags you pass are changed; the rest of `classroom.json` (including `short_name`, `org`, and any `migrated_from` provenance) is preserved.

**The short-name is immutable.** It flows into student repo names (`<short-name>-<assignment>-<username>`), so renaming it would orphan existing repos — to rename, add a new classroom instead.

Lands as a single Tree commit on the default branch. Re-running with values that already match the file is a no-op (no commit). Missing config repo points at `gh teacher init`; a missing classroom points at `gh teacher classroom add`.

## `gh teacher classroom archive` / `unarchive`

Toggle a classroom's lifecycle state via the `active` flag in `<org>/classroom50/<short-name>/classroom.json`:

```sh
gh teacher classroom archive <org> <short-name>
gh teacher classroom archive cs50-fall-2026 cs-principles
gh teacher classroom unarchive cs50-fall-2026 cs-principles
```

**Archival semantics** (schema `classroom50/classroom/v1`, mirroring the web): `active: false` = archived; `active: true` **or absent** = active. Legacy classrooms that never wrote the key read as active. `archive` stamps `active: false`; `unarchive` **drops the key entirely** (rather than writing `active: true`) so a re-activated classroom is byte-identical to one that was never archived.

**What archiving does:**

- The classroom is **hidden from the default `gh teacher classroom list`** (pass `--all` to see it, tagged ` (archived)`).
- `gh teacher assignment add` and `gh teacher assignment reuse` **refuse to write** into an archived target classroom, with an error pointing at `unarchive`.
- **Existing student repos are untouched** — archiving is a config-repo state change only.

**Student `accept` is blocked only after the next publish.** The student-facing accept guard reads `active` from the published `classrooms-index.json`, which only gains the flag on the next `publish-pages` run (and only once the classroom has re-run `gh teacher init` to pick up the updated `publish-pages.yaml`). Until then, archive is teacher-side only — a documented v1 limitation, matching the web. `archive` prints a stderr note to this effect.

Both verbs land a single Tree commit and are **idempotent**: re-archiving an already-archived classroom (or unarchiving an active one) is a no-op with a `no changes` note and no commit. Missing config repo points at `gh teacher init`; a missing classroom points at `gh teacher classroom add`.

## `gh teacher classroom remove`

Delete a classroom's `<short-name>/` directory — `classroom.json`, `assignments.json`, `students.csv`, `scores.json`, and any `autograders/` — from `<org>/classroom50` in a single commit:

```sh
gh teacher classroom remove <org> <short-name>
gh teacher classroom remove cs50-fall-2026 cs-principles
gh teacher classroom remove --yes cs50-fall-2026 cs-principles
```

This removes the classroom's **configuration only**. It does NOT delete student assignment repositories already created in the org — remove those via the GitHub web UI (or `gh teacher teardown` for a full development reset) if intended.

**Confirmation.** You'll be asked to type the short-name to confirm before anything is deleted. Pass `--yes` to skip the prompt (scripted runs only).

**Flags:**

- `--yes` — skip the typed-confirmation prompt.

Missing config repo points at `gh teacher init`; a non-existent classroom exits non-zero with `nothing to remove`. The deletion is one Tree commit that sets every blob under `<short-name>/` to `null`; git prunes the now-empty directory automatically.

## `gh teacher classroom migrate`

Import an existing GitHub Classroom into your `<target>/classroom50` config repo. For each assignment, the command copies the source starter repo into the target org as a fresh template (with `is_template: true`), then commits the matching `<short-name>/` directory — `classroom.json` / `assignments.json` / `students.csv` / `scores.json` — in a single Tree commit.

```sh
gh teacher classroom migrate --source <id-or-org> --target <org>
gh teacher classroom migrate --source 95884 --target cs50-fall-2026 --dry-run
gh teacher classroom migrate --source classroom50test --target cs50-fall-2026
gh teacher classroom migrate --source 95884 --target cs50-fall-2026 \
    --short-name cs-principles --term Spring-2026
```

**Why this exists.** GitHub Classroom is 1:1 with orgs — the org IS the classroom container. Classroom 50 hosts multiple classrooms per org under one `classroom50` config repo. To migrate N legacy classrooms into one target org, run this command N times, once per source classroom.

**What it does** (in order):

1. **Discovery** — resolves `--source`, derives a short-name from the classroom name, fetches every assignment detail (including `starter_code_repository`) from the GitHub Classroom REST API.
2. **Pre-flight** — refuses if the target `<short-name>/` directory already exists in `<target>/classroom50` before any template repos are created.
3. **Template copy** — for each assignment: verify the source repo is a template → probe the target name for collision → `POST /repos/.../generate` → `PATCH .../is_template:true` → wait for the new branch ref to stabilize.
4. **Config commit** — single Tree commit on `<target>/classroom50` writing the four-file scaffold with the migrated entries.

**Flags:**

- `--source <id-or-org>` (required) — numeric GitHub Classroom ID (e.g. `95884`) or the source org's login (e.g. `classroom50test`).
- `--target <org>` (required) — destination org where the `classroom50` config repo lives. Run `gh teacher init <target>` first if it doesn't exist yet. `--target` is *unrelated to the source classroom's org* — Classroom 50 lets you migrate several legacy classrooms into one target org as siblings under the same `classroom50` repo.
- `--short-name <name>` — override the auto-derived classroom directory name. By default the source classroom's name is slugified (lowercase, non-alnum → `-`, collapsed, trimmed, truncated to 39 chars) and validated against `^[a-z0-9][a-z0-9-]{1,38}$`. Pass `--short-name` explicitly if the derived value fails validation.
- `--term <text>` — set `classroom.json.term` (e.g. `Spring-2026`).
- `--template-suffix <suffix>` — appended to every target template repo name. Use to escape collisions: `--template-suffix migrated` renames the target template from `<slug>` to `<slug>-migrated`.
- `--include-archived` — include archived classrooms when resolving `--source` by org name (ignored when `--source` is a numeric ID — archived classrooms always resolve by ID, with a stderr warning).
- `--dry-run` — run discovery and print the plan without any API writes against source or target. Useful for previewing what would migrate before committing to anything.

**Source resolution:**

- **Numeric** (`--source 95884`) → `GET /classrooms/95884` directly. Archived classrooms resolve with a stderr warning (`archived in GitHub Classroom — proceeding`). The `--include-archived` flag is irrelevant here.
- **Org login** (`--source classroom50test`) → list every classroom your token can administer, fetch each one's detail to recover `organization.login`, filter case-insensitively. The Classroom listing endpoint doesn't carry `organization` so the per-row detail fetch is unavoidable. Errors when zero matches (with a hint about `--include-archived`) or when multiple classrooms in the same org match (enumerates candidates with IDs and asks for `--source <id>`).

**Target template repo naming.** Each migrated assignment becomes `<target>/<slug>` in the target org. Use `--template-suffix <s>` to rename to `<slug>-<s>` when a name collides with an existing repo. If the colliding repo is *already* a template (e.g. you re-ran migrate), the existing template is reused without re-generating; if it's a regular repo, migrate skips that assignment with an actionable error pointing at `--template-suffix`.

**`migrated_from` provenance.** Every migrated `classroom.json` and `assignments.json` entry carries an optional `migrated_from` block recording the legacy classroom/assignment IDs, source starter-repo path, GitHub Classroom invite link, and migration timestamp. Hand-authored classrooms (from `gh teacher classroom add` / `gh teacher assignment add`) never carry this block — it's exclusively a provenance marker for migrated content.

**`mode: "group"` preserved.** Group assignments from the source are recorded in `assignments.json` with their `max_group_size` (mapped from the source's `max_teams`, falling back to the cap when the source doesn't report a usable value). Migrated group assignments work end-to-end like CLI-created ones — no re-migration needed.

**What's NOT migrated** (covered by separate workflows):

- **Roster** — `students.csv` is left empty. Re-onboard students for the new term with `gh teacher roster add` / `gh teacher roster import`. (This is a deliberate "fresh start" — most teachers want a clean roster for the new term anyway.)
- **Scores / grades** — `scores.json` is left empty.
- **Accepted-assignment student repos** — student work isn't cloned. The new term starts fresh; old submissions stay on the legacy org if you need them.
- **Autograding test config** — GitHub Classroom's `.github/classroom/autograding.json` schema doesn't translate to our `autograder.py` model. Author grading code separately under `<classroom>/autograders/<slug>/` or set a classroom default with `gh teacher autograder set-default`.

**Failure model.** Per-assignment failures are best-effort: a source repo that isn't a template, a target collision with a non-template repo, or a failed generate/PATCH call skips that single entry with a stderr reason. The commit still lands with the entries that succeeded; exit code is non-zero so partial completion is visible. Re-running reuses any templates that already exist (collision = template path).

**Errors:**

- `<target>/classroom50` missing → `run gh teacher init <target> first`.
- Target classroom dir already exists → `pick a different --short-name or delete the dir`. The pre-flight probe fires *before* any template repos get created, so no orphan repos are left behind in the target org.
- `--source <id>` 404 → `classroom is not accessible — confirm you are a GitHub Classroom admin`.
- `--source <org>` resolves to zero classrooms → `no classrooms found in org "<source>"`. If `--include-archived` wasn't passed, the error includes a hint about it.
- `--source <org>` resolves to multiple classrooms (rare — Classroom is 1:1 with orgs) → lists candidates with IDs and asks for `--source <id>`.
- Derived short-name fails the slug regex → asks for `--short-name <name>` explicitly with the offending input.

## `gh teacher roster`

Manage student rows in `<org>/classroom50/<classroom>/students.csv`. All three subcommands write through a shared optimistic-update-with-rebase loop: each attempt reads the current branch tip, re-applies the upsert/remove against the latest file, and PATCHes the ref with a fast-forward check. Up to 5 attempts with exponential backoff before giving up — concurrent edits from multiple teachers can't silently lose each other's work.

Every row carries an immutable numeric `github_id` (resolved at write time via `GET /users/{username}`) so a mid-class username change doesn't desynchronize records. The `github_id` column is CLI-managed; teachers should not hand-edit it. The column is named `github_id` (not the API-side `id`) to keep the source unambiguous when classroom50 grows additional ID columns from non-GitHub sources.

### `gh teacher roster list`

```sh
gh teacher roster list <org> <classroom>
gh teacher roster list cs50-fall-2026 cs-principles --json
gh teacher roster list cs50-fall-2026 cs-principles --quiet
```

Reads `<classroom>/students.csv` and prints it. Three output modes:

- **Default** — an aligned table on stdout (`USERNAME`, `NAME`, `EMAIL`, `SECTION`, `GITHUB_ID`; empty cells render as `-`), plus a one-line `<org>/<repo>/<classroom>/students.csv: N student(s)` summary on stderr.
- `--json` — emit the full JSON array of `{username, first_name, last_name, email, section, github_id}` objects (`github_id` is `0` for an unresolved row, not omitted; gate on `github_id == 0`). Takes precedence over `--quiet`.
- **`--quiet`** — one username per line on stdout, no table and no stderr summary — pipeable into `xargs`, `grep`, or an agent loop.

An empty roster is a clean exit-0: the table shows just the header (or stdout is empty under `--json`/`--quiet`), and stderr notes there are no students. A missing `students.csv` errors and points at `gh teacher classroom add`. Read-only; no commit lands.

### `gh teacher roster add`

```sh
gh teacher roster add <org> <classroom> <username> [--first-name <n>] [--last-name <n>] [--email <addr>] [--section <s>]
gh teacher roster add cs50-fall-2026 cs-principles alice --first-name Alice --last-name Andersson --email alice@example.edu --section section-1
gh teacher roster add cs50-fall-2026 cs-principles bob
```

Appends or upserts one row by `username` (case-insensitive match). All four data flags are optional; an absent flag writes an empty value into its column. After the roster write lands, sends an org invitation if the student isn't already a member and doesn't have a pending invite — same path `gh teacher invite` uses, but quiet about already-member/already-pending cases.

Safe to re-run: the row is replaced in place — every run produces a commit, but a no-change re-run yields a same-tree commit (never duplicates or removes data). The org-invite step is skipped when the student is already an active or pending member.

### `gh teacher roster update`

```sh
gh teacher roster update <org> <classroom> <username> [--first-name <n>] [--last-name <n>] [--email <addr>] [--section <s>]
gh teacher roster update cs50-fall-2026 cs-principles alice --email alice@example.edu
gh teacher roster update cs50-fall-2026 cs-principles alice --first-name Alice --section section-2
```

Corrects fields on an **existing** row, matched by `<username>` (case-insensitive). Only the flags you pass are changed — every other column, including the immutable `github_id`, is left untouched. This is the difference from `roster add`, which rewrites the whole row and blanks any field you don't re-supply. Pass `--email ""` to clear an address.

**Roster-only:** unlike `roster add`, it never sends an org invite and never re-resolves `github_id` — use it for typo fixes, not onboarding. At least one data flag is required. A patch that already matches the row is a no-op (no commit). Unlike `roster remove`, an unknown `<username>` is an **error** (you're correcting a specific person), pointing you at `gh teacher roster add`.

### `gh teacher roster remove`

```sh
gh teacher roster remove <org> <classroom> <username>
```

Drops the row matching `<username>` (case-insensitive). Idempotent: a no-op + zero exit when the row is already absent. **Does NOT remove org membership** — that's a separate `gh teacher remove <org> <username>` so an off-by-one roster edit can't accidentally revoke a student's repo access.

### `gh teacher roster import`

```sh
gh teacher roster import <org> <classroom> <path-to-csv>
gh teacher roster import cs50-fall-2026 cs-principles ./section-1.csv
```

Bulk upsert from a local CSV. Accepts either header shape:

- **5-column** (recommended for hand-authored CSVs): `username,first_name,last_name,email,section`
- **6-column** (exported from a previous `students.csv`): same as above plus `github_id`, which is ignored — the CLI re-resolves `github_id` at import time so the on-disk roster always carries the GitHub-authoritative ID.

The `email` column values may be empty per row.

> **Import takes only the canonical shape.** If your `students.csv` carries the web app's onboarding columns (`enrollment_status`, `invite_token`, …) appended after `github_id`, trim everything after `github_id` before importing — `roster import` accepts only the 5- or 6-column canonical header and rejects a wider file with a message naming the cause. `roster add`/`roster update`/`roster remove` *do* preserve those onboarding columns; import re-resolves `github_id` and carries no onboarding state, so it stays canonical-only by design.

Resolves every username up-front (one `GET /users/{username}` per row); a non-existent username aborts the import with the row number, before any commit. Once all usernames resolve, the entire file is written in a single Tree commit — there's no partial-import state visible on the repo. After the commit, each non-member is invited; the command prints a summary `N invited, M already members, K already pending`.

Duplicate usernames within the input (case-insensitive) collapse with last-wins semantics.

### Errors common to all three subcommands

- `<org>/classroom50` missing → `run gh teacher init <org> first`, non-zero exit.
- `<classroom>/students.csv` missing → `run gh teacher classroom add <org> <classroom> first, or restore the file if it was deleted`.
- `students.csv` header doesn't begin with `username,first_name,last_name,email,section,github_id` → exits non-zero with the offending header. (Optional onboarding columns appended after `github_id` by the web app are accepted and preserved.)
- GitHub user not found (404 from `GET /users/{username}`) → exits with the offending username.
- Repeated rebase failures (the CLI retries a small fixed number of times with exponential backoff) → exits with a `lost the rebase race` message and a hint to retry or investigate concurrent writers.

## `gh teacher staff`

Manage a classroom's **staff teams** — the per-classroom GitHub teams that back the web GUI's in-app roles: `classroom50-<classroom>-instructor` and `classroom50-<classroom>-ta`, each granted write on the `classroom50` config repo. Membership lives entirely in these GitHub teams (there is **no** `role` column in `students.csv`), so a classroom's staff is the same whether managed from the CLI or the web.

The staff teams are created by `gh teacher classroom add` / `classroom migrate`. If a classroom predates the staff-teams feature (no `teams` block in `classroom.json`), re-run `gh teacher classroom add <org> <classroom>` to create them, then add staff.

### `gh teacher staff add`

```
gh teacher staff add <org> <classroom> <username> [--role instructor|ta]
gh teacher staff add cs50-fall-2026 cs-principles alice
gh teacher staff add cs50-fall-2026 cs-principles bob --role ta
```

Adds `<username>` to the classroom's instructor (default) or ta staff team. `--role` accepts `instructor` or `ta` (case-insensitive; defaults to `instructor`). The user gains write on the config repo through the team; if they aren't yet an org member the team membership goes pending until they accept the org invitation. The team slug is read from `classroom.json` (authoritative — never re-derived). If the classroom predates the staff-teams feature (or its `teams` block is partial), `staff add` self-heals: it creates/adopts the missing team, grants it config-repo write, and records the ref in `classroom.json` before adding the user.

### `gh teacher staff remove`

```
gh teacher staff remove <org> <classroom> <username> [--role instructor|ta]
gh teacher staff remove cs50-fall-2026 cs-principles alice --role ta
```

Removes `<username>` from the named staff team. **Does NOT** touch the user's org membership. Idempotent — a user who isn't on the team (or an already-gone team) is a clean no-op.

**Errors:** missing config repo → `run gh teacher init <org> first`; classroom not found → points at `gh teacher classroom add`; GitHub user not found → exits with the offending username.

## `gh teacher assignment`

Manage entries in `<org>/classroom50/<classroom>/assignments.json` — the authoritative manifest the autograde workflow and `gh student accept` both read. Each entry pairs a `slug` (used in student repo names like `<classroom>-<slug>-<username>`) with an optional template repo, an optional due date, a `mode` (`individual` or `group`), and an optional `autograder` name (defaults to `default`).

Writes flow through the same optimistic-update-with-rebase loop the roster commands use (up to 5 attempts with exponential backoff), so concurrent edits from multiple teachers don't silently lose each other's work.

### `gh teacher assignment add`

```sh
gh teacher assignment add <org> <classroom> <slug> --name "<name>" [--template <owner>/<repo>[@branch]] [--description <text>] [--due <ISO-8601>] [--mode individual|group] [--max-group-size <N>] [--runtime <path-to-json>] [--tests <path-to-json>] [--autograder <name>] [--feedback-pr] [--pass-threshold <0–100>]
gh teacher assignment add cs50-fall-2026 cs-principles hello --name "Hello" --template cs50/hello-template --due 2026-09-15T23:59:00-04:00
gh teacher assignment add cs50-fall-2026 cs-principles project --name "Project" --template cs50/project-template --mode group --max-group-size 3
gh teacher assignment add cs50-fall-2026 cs-principles intro --name "Intro" --template cs50/intro-template@main --runtime ./runtime-c.json
gh teacher assignment add cs50-fall-2026 cs-principles reflection --name "Reflection"   # template-less: empty starter repo
```

Register or upsert one assignment. Idempotent on re-run: the same `slug` replaces the existing entry in place (position-preserving), a new `slug` appends. Replacement is wholesale — re-running without `--tests` drops any tests previously added via `gh teacher assignment test add`, and re-running without `--template` drops a previously-set template (making the assignment template-less). The CLI prints a warning in both cases.

**Slug rules** (same as classroom short-names): `^[a-z0-9][a-z0-9-]{1,38}$`, 2-39 chars, lowercase letters/digits/hyphens, starting with a letter or digit. The slug becomes part of the student repo name `<classroom>-<slug>-<username>`, so the constraint mirrors GitHub's repo-name rules.

**Required flags:**

- `--name <display name>` — written into `assignments.json`'s `name` field. Used in release titles and the published Pages site (forthcoming).

**Optional flags:**

- `--template <owner>/<repo>[@branch]` — the starter-code repo. **Optional**: omit it for a template-less assignment, where `gh student accept` creates an *empty* private repo containing only the autograder workflow shim (no starter files). When supplied, the CLI calls `GET /repos/{owner}/{repo}` to verify it exists, is visible to your token, and has `is_template: true`. When you omit `@branch`, the template's `default_branch` from the response is used; pass `@main` (or `@master`, etc.) to pin explicitly.

- `--description <text>` — short description written into the entry (omitted from the file when empty).
- `--due <ISO-8601>` — due date in RFC 3339 form, e.g. `2026-09-15T23:59:00-04:00`. The timezone is required. Stored verbatim, so a teacher's choice of offset round-trips through the file.
- `--mode individual|group` — `individual` (default) gives each student their own repo. `group` lets teammates share one repo: the first student to `gh student accept` creates it (and becomes its admin), then adds others with `gh student invite` (see the [gh student](gh-student) reference). Requires `--max-group-size`.
- `--max-group-size <N>` — maximum collaborators on a group repo (`>= 2`; required with `--mode group`, rejected otherwise). **The limit is advisory** — not hard-enforced by the CLI; the founder coordinates group size when adding teammates, and collaborators can also be added through GitHub's web UI. Grading attribution fans a group submission's score to every rostered member at collection time (the runner emits the owner; `collect-scores` reads the repo's collaborators and credits each — see the [Autograders](Autograders) wiki page).
- `--runtime <path>` — JSON file (or `-` for stdin) describing the runtime environment for this assignment's autograde job: `runs-on` (a single runner label or an array of labels, including self-hosted), `python` / `node` / `java` / `go` toolchain versions, `apt` packages, and an escape-hatch `container` image. Omit for the defaults (ubuntu-latest + Python 3.12). See the [Autograders](Autograders) wiki page for the full schema and worked examples.
- `--tests <path>` — JSON file with a bare array of declarative test specs (`io` / `run` / `python`), or `-` for stdin. Replaces the entry's whole `tests` block — the bulk counterpart to `gh teacher assignment test add`, in the same shape `assignment test list --json` emits. Mutually exclusive with a per-assignment `autograder.py`. See the [Autograders](Autograders) wiki page for the field reference.
- `--autograder <name>` — reserved for the rare case where you want to call a different *reusable workflow* entirely (not just different language toolchains — for that, use `--runtime`). The default `default` resolves to the universal shim embedded in `gh-student`. Non-default values reference a sibling shim at `<classroom>/autograders/<name>.yaml` in the config repo; the referenced file must exist at write time.
- `--feedback-pr` — control the **Feedback Pull Request**: each student repo gets one long-lived PR (base = a frozen `feedback` branch at the student's baseline commit, head = the default branch) so you review the full starter→submission diff with inline GitHub review comments. The autograde runner opens/updates it on submissions that have a diff; the PR auto-updates as the student submits. The PR is labeled **Individual Assignment** or **Group Assignment** by the assignment's mode. **Default on** — pass `--feedback-pr=false` to disable it for an assignment (e.g. an autograded-only problem set where you won't review diffs). Requires `gh teacher init` to have enabled the org "Allow GitHub Actions to create and approve pull requests" setting and installed the feedback rulesets (init does this automatically; re-run init if your org was set up before this feature). See the [Autograders](Autograders) wiki page for the full flow and limitations.
- `--pass-threshold <0–100>` — opt-in passing bar as a percentage of max score: at or above it a gradebook client (e.g. the web GUI) shows a submission as passing. **Advisory/display-only** — like `--max-group-size`, the CLI does not enforce it and it never changes a student's score. **Omit to leave it off** (no passing concept at all, which is distinct from a 0% bar); pass `--pass-threshold 0` for an explicit 0%. Note `assignment add` rewrites the whole entry, so re-running it **without** `--pass-threshold` clears a previously-set value (often set in the gradebook GUI) — the command warns when this happens; pass the flag again to keep it.

**Where grading logic lives.** Three options, in increasing order of effort:

1. **Declarative tests** — pass `--tests` here (or use `gh teacher assignment test add`) to describe io/run/python checks the runner grades with no grading code.
2. **Per-assignment `autograder.py`** — a Python script that produces `result.json`, dropped at `<classroom>/autograders/<slug>/autograder.py` in the config repo. Sibling fixtures and helpers ride along in the bundle. Mutually exclusive with declarative tests.
3. **Classroom default** — `gh teacher autograder set-default <org> <classroom>` installs `<classroom>/autograder.py`, used by every assignment that has neither of the above.

See the [Autograders](Autograders) wiki page for the entrypoint contract and copy-pasteable templates (pytest, check50, custom).

**Errors:**

- `<org>/classroom50` missing → `run gh teacher init <org> first`, non-zero.
- `<classroom>/assignments.json` missing → `run gh teacher classroom add <org> <classroom> first, or restore the file if it was deleted`.
- Template repo 404 (private, in another org, or doesn't exist) → `template <owner>/<repo> is not visible to your account — either make it public, or copy it into your org and reference the copy`.
- Template repo exists but is **private and outside `<org>`** → rejected: `template <owner>/<repo> is private and outside the org <org> — students can't be granted access to it … Copy it into <org> and reference the copy, or make the template public`. (A private template **inside** `<org>` is accepted, and the classroom team is granted `pull` on it so students can generate from it.)
- Template repo exists but `is_template: false` → message naming the Settings toggle to flip.
- `--autograder <name>` (non-default) references a file that doesn't exist in the config repo at write time → `autograder "<name>" does not exist at <org>/classroom50/<classroom>/autograders/<name>.yaml — create it (or pass --autograder default) before registering this assignment`. The default name resolves to the embedded gh-student shim and skips the file-existence probe.
- `--runtime <path>` JSON fails validation (e.g. a `runs-on` label with whitespace or shell metacharacters, more than 10 labels, an empty `runs-on` string/array, a malformed apt name, or an unsupported container key) → an error naming the offending field, with the path to the JSON file.
- `--tests <path>` JSON fails validation (unknown field, bad `type`/`comparison`, out-of-bounds timeout/points, duplicate names) → an error naming the offending test and field, with the path to the JSON file.
- `--tests` passed while `<classroom>/autograders/<slug>/autograder.py` exists → `declarative tests and a hand-written autograder.py are mutually exclusive`, with the conflicting path.
- `--tests` passed but the config repo is missing `.github/scripts/materialize_tests.py` (skeleton predates declarative tests, so they would never run) → an error pointing at `gh teacher init` to update the skeleton. Applies to `gh teacher assignment test add` too.
- Repeated rebase failures (5 attempts with exponential backoff) → `lost the rebase race` with a retry hint.

**Same-slug concurrent writes.** The rebase loop handles concurrent edits to *different* slugs cleanly — each teacher's retry sees the other's commit and re-applies their own upsert. For concurrent edits to the *same* slug (two teachers running `gh teacher assignment add hello ...` within the rebase window), the contract is last-writer-wins: the loser's retry observes the winner's entry and replaces it with theirs, without an on-CLI signal. Both commits remain in the config repo's git history, so a teacher who notices an unexpected overwrite can recover with `git revert` on the config repo.

### `gh teacher assignment reuse`

```sh
gh teacher assignment reuse <org> <source-slug> --from <source-classroom> --to <target-classroom> [--slug <new-slug>] [--name "<new name>"] [--json]
gh teacher assignment reuse cs50-fall-2026 hello --from cs-principles-2025 --to cs-principles-2026
gh teacher assignment reuse cs50-fall-2026 hello --from old --to new --slug hello-redux --name "Hello (Redux)"
gh teacher assignment reuse cs50-fall-2026 hello --from old --to new --json
```

Copy an existing assignment record from one classroom's `assignments.json` into another's, **within the same org** — the scriptable counterpart to the web's "reuse assignment", ideal for rebuilding last term's assignments in a new classroom. The source record is copied **verbatim** through the typed entry (template, due/due_meta, mode, autograder, max_group_size, feedback_pr, runtime, allowed_files, pass_threshold, tests, description); only the slug and name can change. Unknown/future top-level entry fields (added by a newer binary or the web GUI) are preserved too, so reuse never drops a field this CLI doesn't yet model.

**Required flags:**

- `--from <source-classroom>` — the classroom to copy from.
- `--to <target-classroom>` — the classroom to copy into (same org).

**Optional flags:**

- `--slug <new-slug>` — slug for the copy in the target classroom. By default the source slug is reused; on a **case-insensitive** collision it auto-suffixes `-2`, `-3`, … (slugs become GitHub repo path segments, which are case-insensitive). Passing `--slug` explicitly **refuses** a colliding name instead of auto-suffixing. An auto-suffix that would exceed the 39-char slug cap errors with a hint to pass a shorter `--slug`.
- `--name "<new name>"` — display name for the copy (default: the source name).
- `--json` — emit the resolved copy as JSON on stdout — `{org, classroom, slug, source_slug, auto_suffixed, template}` — instead of the human summary. **Read the final slug from here**, not by parsing the prose: an auto-suffixed slug isn't known until the write resolves the collision, so scripts/agents should rely on the `slug` field. Advisory notes still go to stderr, keeping stdout a single parseable JSON value.

**Template team grant.** When the copied assignment references a **private, in-org** template, reuse re-applies the target classroom's team read grant on it (the same grant `assignment add` performs) so rostered students in the target classroom can generate from it. A public template (or no template) needs no grant. A **private out-of-org** template can't be granted (reuse is in-org only for private templates in v1) — reuse warns and lands the copy anyway rather than failing; copy the template into the org and re-add to fix it. A template that 404s (deleted or invisible) warns similarly.

**In-org only (v1).** Cross-org reuse of a private template is out of scope, since the target classroom's students can only be team-granted read on a template inside their own org.

**Archived target refused.** Like `assignment add`, reuse refuses to write into an archived (`active: false`) target classroom, pointing at `gh teacher classroom unarchive`.

**Errors:**

- `<org>/classroom50` missing → `run gh teacher init <org> first`.
- Source slug not found in the source classroom → lists the `gh teacher assignment list` command to see available slugs.
- An explicit `--slug` that collides (case-insensitively) in the target → `choose a different --slug`.
- `--from` and `--to` are the same classroom with no `--slug` → refused (an in-place reuse must rename to a distinct slug).
- The post-commit template grant fails (missing team, transport error) **after the copy already landed** → the error makes the partial state clear; the copy is committed and re-running is safe (the grant is idempotent).

### `gh teacher assignment remove`

```sh
gh teacher assignment remove <org> <classroom> <slug>
```

Drops the matching entry. Idempotent: if the slug is already absent, exits 0 with a note. **Does NOT touch existing student repos** — the starter code and submission history stay intact; only new `gh student accept` invocations stop finding the slug.

### `gh teacher assignment list`

```sh
gh teacher assignment list <org> <classroom>
gh teacher assignment list <org> <classroom> --json
gh teacher assignment list <org> <classroom> -q | xargs -I{} gh teacher download <org> <classroom> {}
```

Read-only enumeration of every slug registered in `<org>/classroom50/<classroom>/assignments.json`. Default output is one slug per line on stdout — pipeable directly into `xargs gh teacher download`, `grep`, an agent loop, or anything else expecting a newline-separated list.

**Flags:**

- `--json` — emit the full JSON array of assignment entries instead of one slug per line. Preserves every field (template ref, due, mode, autograder, runtime, tests) so an agent can introspect the manifest without a second API call. Output matches the on-disk indent so `jq` pipes work without reformatting.
- `--quiet` / `-q` — suppress the one-line stderr summary (`<repo-path>: N assignments`). Use this when capturing stdout from a script that should not have to filter mixed streams.

**Errors:** same shape as `add` and `remove` — missing config repo points at `gh teacher init`, missing `assignments.json` points at `gh teacher classroom add`. Exits 0 with empty stdout when the classroom has no assignments yet (the stderr summary, when not suppressed, hints at `gh teacher assignment add` for the next step).

### `gh teacher assignment test`

```sh
gh teacher assignment test add <org> <classroom> <slug> --name "<name>" --type {io,run,python} --run "<command>" [--setup <cmd>] [--input <text> | --input-file <name>] [--expected <text> | --expected-file <name>] [--comparison {included,exact,regex}] [--timeout <seconds>] [--exit-code <n>] [--points <n>]
gh teacher assignment test list <org> <classroom> <slug> [--json] [-q]
gh teacher assignment test remove <org> <classroom> <slug> <test-name>

gh teacher assignment test add cs50-fall-2026 cs-principles hello \
    --name compiles --type run --run "gcc -o hello hello.c" --points 1
gh teacher assignment test add cs50-fall-2026 cs-principles hello \
    --name "prints hello" --type io --setup "gcc -o hello hello.c" \
    --run ./hello --expected "Hello, world!" --comparison included --points 2
```

Manage the **declarative `tests` block** on an existing assignment — GitHub Classroom-style io / run / python checks the runner grades with a built-in interpreter, no `autograder.py` needed. On the next config-repo push, publish-pages materializes the block into the assignment's Pages bundle as `tests.json`; grading picks it up on the submission after that. See the [Autograders](Autograders) wiki page for the field reference, comparison semantics, and precedence rules.

- **`add`** upserts one test by `--name`: the same name replaces in place, a new name appends. The slug must already be registered (`gh teacher assignment add` first). Refused while a hand-written `<classroom>/autograders/<slug>/autograder.py` exists — the runner prefers `autograder.py`, so the tests would silently never run.
- **`list`** prints test names one per line on stdout (pipeable into `remove`); `--json` emits the full spec array (`[]` when empty), `-q` suppresses the stderr summary. Read-only.
- **`remove`** drops one test by name. Idempotent: an already-absent name exits 0 with a note and lands no commit. Errors only if the slug itself isn't registered.

For bulk edits (or a GUI/agent export), `gh teacher assignment add ... --tests <file.json>` replaces the whole array in one write.

Writes flow through the same optimistic-rebase loop as every other `assignments.json` edit; the conflict probe and slug lookup re-run against each attempt's parent commit, so concurrent edits rebase cleanly.

## `gh teacher autograder`

Manage the **classroom default autograder** at `<classroom>/autograder.py` — `set-default` to install or replace it, `show` to read it, `remove` to delete it, and `list` to enumerate the named shims and per-assignment overrides under `<classroom>/autograders/`. The runner uses the default for every assignment in the classroom that has neither a per-assignment override under `<classroom>/autograders/<slug>/` nor a declarative `tests` block on its entry.

### `gh teacher autograder set-default`

```sh
gh teacher autograder set-default <org> <classroom> --from <path>
gh teacher autograder set-default <org> <classroom> --from -
gh teacher autograder set-default <org> <classroom>
gh teacher autograder set-default cs50-fall-2026 cs-principles \
    --from examples/autograders/cs50/autograder.py
```

Replaces `<classroom>/autograder.py` in the config repo with the contents of `--from <path>`. `--from -` reads from stdin (one-shot agent flows). When `--from` is omitted, installs the diagnostic stub shipped with this CLI — the stub echoes every env var the runner exposed and emits a vacuous-pass `result.json`, so teachers can verify the pipeline before authoring real grading logic.

Lands as a single Tree commit on the config repo's default branch and is picked up by every subsequent submission once the next `publish-pages.yaml` run deploys (~30s). Re-running with the same content is a no-op.

**Validation.** The classroom must already exist (`<classroom>/classroom.json` present in the repo). If it doesn't, the command refuses to write — preventing typos from creating phantom-classroom directories that contain only `autograder.py`. Run `gh teacher classroom add` first.

### `gh teacher autograder show`

```sh
gh teacher autograder show <org> <classroom>
gh teacher autograder show cs50-fall-2026 cs-principles
gh teacher autograder show cs50-fall-2026 cs-principles --json
gh teacher autograder show cs50-fall-2026 cs-principles > autograder.py
```

Print the classroom default at `<classroom>/autograder.py`. Default output writes the file body to stdout (pipe it to a file or pager); a one-line stderr summary says whether it's the shipped diagnostic stub or a custom autograder, with its size.

**Flags:**

- `--json` — emit metadata only — `{path, exists, is_stub, size, sha}` — without the body, so a script can branch on whether a real autograder is installed. `sha` is the git blob object id (matches what the contents/trees API reports).
- `-q`, `--quiet` — suppress the stderr summary so stdout is the only output stream.

Read-only; no commit lands. When the classroom has no default autograder, stdout stays empty and stderr says so — the command still exits 0, because an unset default is a valid mid-setup state (graded as a vacuous pass). A missing classroom points at `gh teacher classroom add`.

### `gh teacher autograder list`

```sh
gh teacher autograder list <org> <classroom>
gh teacher autograder list cs50-fall-2026 cs-principles
gh teacher autograder list cs50-fall-2026 cs-principles --json
```

List everything under `<classroom>/autograders/`: named workflow shims (`<name>.yaml`, opted into with `gh teacher assignment add --autograder <name>`) and per-assignment override bundles (`<slug>/`, holding a hand-written `autograder.py` for that one assignment). Default output is one entry per line on stdout — named shims as `<name>.yaml`, override bundles as `<slug>/` (trailing slash). A one-line `<path>: N autograder(s)` summary goes to stderr.

**Flags:**

- `--json` — emit the full array of `{name, kind, path}` objects (`kind` is `named-shim` or `per-assignment`).
- `-q`, `--quiet` — suppress the stderr summary.

The classroom **default** (`<classroom>/autograder.py`) is not listed here — inspect it with `gh teacher autograder show`. Read-only; no commit lands. Stray non-`.yaml` files at the top of `autograders/` are skipped.

### `gh teacher autograder remove`

```sh
gh teacher autograder remove <org> <classroom>
gh teacher autograder remove --yes cs50-fall-2026 cs-principles
```

Delete `<classroom>/autograder.py` in a single commit. This is distinct from `set-default` with no `--from`, which **overwrites** the file with the diagnostic stub — `remove` deletes it outright.

**Grading impact.** Once removed, any assignment in the classroom that has neither a per-assignment override (`<classroom>/autograders/<slug>/autograder.py`) nor a declarative `tests` block falls back to a vacuous pass (0/0) on its next submission, until you set a new default. Per-assignment overrides and named shims are **not** touched.

**Confirmation.** You'll be asked to confirm (`[y/N]`) before anything is deleted; pass `--yes` to skip the prompt (scripted runs only). Idempotent: removing a classroom that has no default autograder is a clean no-op.

### Named and per-assignment autograders

Named shims (`<classroom>/autograders/<name>.yaml`) and per-assignment overrides (`<classroom>/autograders/<slug>/autograder.py`) are **read-only from the CLI** — `autograder list` shows what's present, but authoring, editing, and deleting them is done with ordinary git operations against the config repo (the files ride into each submission's Pages bundle). See [Autograders](Autograders) for the file layout and precedence rules.

## `gh teacher invite`

Uses the API to invite a student or teaching assistant to an org or a specific repo.

```sh
gh teacher invite <org> <username>             # direct_member to org
gh teacher invite --admin <org> <username>     # admin to org
gh teacher invite <org>/<repo> <username>      # collaborator on repo (default push)
gh teacher invite -p maintain <org>/<repo> <username>
```

Under the hood:

1. Resolve the username to a user ID via `GET /users/{username}` ([docs](https://docs.github.com/en/rest/users/users?apiVersion=2026-03-10#get-a-user)).
2. For org targets, invite by user ID via `POST /orgs/{org}/invitations` ([docs](https://docs.github.com/en/rest/orgs/members?apiVersion=2026-03-10#create-an-organization-invitation)).
3. For repo targets, add via `PUT /repos/{owner}/{repo}/collaborators/{username}` ([docs](https://docs.github.com/en/rest/collaborators/collaborators?apiVersion=2026-03-10#add-a-repository-collaborator)).
4. Advise the user to sign in to `https://github.com` as the invited GitHub user, then visit `https://github.com/<org>` to accept.

The org-invitation endpoint requires the `admin:org` OAuth scope. Run `gh teacher login` once before the first org invite to grant it.

Common API failures (missing scope, not an admin, org not found, already a member, pending invite) are translated into actionable messages instead of raw HTTP errors.

## `gh teacher remove`

```sh
gh teacher remove <org> <username>           # remove from organization
gh teacher remove <org>/<repo> <username>    # remove from one repository
```

- Org targets call `DELETE /orgs/{org}/memberships/{username}` ([docs](https://docs.github.com/en/rest/orgs/members?apiVersion=2026-03-10#remove-organization-membership-for-a-user)). Revokes access to every repository in the org, removes the user from all teams, and cancels any pending invitation in one call.
- Repo targets call `DELETE /repos/{owner}/{repo}/collaborators/{username}` ([docs](https://docs.github.com/en/rest/collaborators/collaborators?apiVersion=2026-03-10#remove-a-repository-collaborator)).
- Both forms are idempotent: a `204` prints `removed <username>`; a `404` (user is not a member or collaborator) prints a clear message and exits 0 so re-runs are safe.

## `gh teacher member list`

```sh
gh teacher member list <org>         # org members + pending invitations, with role
gh teacher member list <org>/<repo>  # repo collaborators, with permission level
gh teacher member list <org> --json
gh teacher member list <org> --quiet
```

The Read counterpart to `invite` / `remove`. The roster (`students.csv`) is the *intended* membership; this command shows *actual* GitHub membership, so the two can be reconciled when they drift (a student who never accepted their invite, or a collaborator added out of band).

- **Org target** lists active members and pending invitations. Active members come from `GET /orgs/{org}/members` ([docs](https://docs.github.com/en/rest/orgs/members?apiVersion=2026-03-10#list-organization-members)) — walked once with `?role=admin` to label admins and once unfiltered — and pending invitations from `GET /orgs/{org}/invitations` ([docs](https://docs.github.com/en/rest/orgs/members?apiVersion=2026-03-10#list-pending-organization-invitations)). Reading pending invitations needs the `admin:org` scope; a `403` surfaces as a clear "scope required" error rather than silently dropping them. Each row's `kind` is `member` or `invitation`; `role` is `admin` or `member`.
- **Repo target** lists collaborators from `GET /repos/{owner}/{repo}/collaborators` ([docs](https://docs.github.com/en/rest/collaborators/collaborators?apiVersion=2026-03-10#list-repository-collaborators)); `kind` is `collaborator` and `role` is the permission level (`read`/`triage`/`write`/`maintain`/`admin`).
- **Output:** default is an aligned table (`LOGIN`, `KIND`, `ROLE`, `GITHUB_ID`; a missing id or unreported permission renders as `-`) with a one-line `<target>: N member(s)` (or `N collaborator(s)`) summary on stderr. `--json` emits the full array of `{login, kind, role, github_id}` objects (empty target → `[]`, not `null`); `--quiet` prints one login per line with no table or stderr summary. `--json` takes precedence over `--quiet`. In `--json`, `github_id` is always present and is `0` when the source endpoint doesn't report a numeric id (e.g. pending invitations); `role` is `admin`/`member` (or `billing_manager`) for an org and the permission level for a repo, and may be an empty string when GitHub doesn't report it.
- Both surfaces are paginated (100 per page) so large orgs/repos enumerate fully. Read-only; no write lands.

## `gh teacher download`

```sh
gh teacher download <org> <classroom> <assignment>              # roster-driven (default)
gh teacher download --by-pattern <org> <classroom> <assignment> # skip roster, clone by name prefix
gh teacher download -d <dir> <org> <classroom> <assignment>     # literal dir, no timestamp
gh teacher download -v <org> <classroom> <assignment>           # stream raw git output per repo
gh teacher download -q <org> <classroom> <assignment>           # suppress per-repo summary, forward --quiet to git
```

### Roster-driven mode (default)

The command reads `<org>/classroom50/<classroom>/students.csv` and `<classroom>/assignments.json`, then for each roster row:

1. Computes the canonical `<classroom>-<assignment>-<username>` repo name (lowercased — matches `gh student accept`'s naming).
2. Probes `GET /repos/<org>/<name>` ([docs](https://docs.github.com/en/rest/repos/repos?apiVersion=2026-03-10#get-a-repository)). A 404 prints `Missing: <username> (not accepted yet?)` and contributes to the per-run summary; a non-404 error surfaces as a per-repo failure.
3. For repos that exist, shells out to `gh repo clone <org>/<name> <dir>/<name>` so authentication flows through the current `gh` session.
4. For each cloned repo (and for repos already on disk), refreshes `<repo>/result.json` (the latest submission) **and** `<repo>/results.json` (every submit-tag submission, newest first) from that repo's submit-tag releases. Each asset is fetched via the release's asset API URL with `Accept: application/octet-stream`, and `Authorization` is stripped on the redirect to the signed storage URL so the GitHub token never reaches the storage origin. A repo with no submit-tag releases, or releases with no `result.json` asset, is a silent no-op.
5. After all clones, writes a `scores.csv` summary at the destination root with **one line per submission**, grouped by roster entry in roster order (columns `username,score,max_score,datetime,submission_tag,submitted_by,review_url,late,override`). A student who pushed N times contributes N lines (newest first); for a group assignment each credited member (the entry's `member_usernames`) gets the team's submission lines. Non-submitters get a single blank-score line so a teacher can sort by score and immediately see who hasn't submitted yet. Student-controlled string cells are guarded against spreadsheet formula injection.

The command refuses to run when:

- `<org>/classroom50` doesn't exist → `run gh teacher init <org> first`.
- `<classroom>/students.csv` is missing → `run gh teacher classroom add` first.
- `<assignment>` isn't registered in `assignments.json` → `run gh teacher assignment add <org> <classroom> <assignment>` first, or pass `--by-pattern` to skip the roster lookup.

### `--by-pattern`

Pages through `GET /orgs/{org}/repos` ([docs](https://docs.github.com/en/rest/repos/repos?apiVersion=2026-03-10#list-organization-repositories)) and clones every repo whose name starts with `<classroom>-<assignment>-`. Skips the roster lookup, the `result.json` refresh, and the `scores.csv` summary — useful when the config repo isn't bootstrapped yet, or when you want every matching repo regardless of who's currently on the roster.

### Destination

Default is `<classroom>-<assignment>_submissions_YYYY_MM_DD_T_HH_MM_SS/` (24-hour local time) so each run produces a fresh folder and prior downloads are preserved without manual cleanup. Pass `-d` to override (the value is taken literally, no timestamp appended).

Existing target dirs are skipped on the clone step, so re-runs with the same `-d` pick up new submissions without aborting on the ones already cloned. `result.json` is still refreshed on the existing clones — so a re-run after the latest collect-scores cycle picks up the newest score without re-cloning. Clone failures carry git's actionable diagnostic (e.g. `fatal: ...`) rather than just an exit code; a non-zero exit code surfaces after the rest of the run still completes.

## `gh teacher teardown`

```sh
gh teacher teardown <org>              # interactive (typed org-name prompt)
gh teacher teardown --yes <org>        # skip the prompt (scripted runs)
```

Delete every repository in `<org>` after confirming the org is a Classroom 50 setup. Intended for **development scenarios** — resetting a test org between runs of `gh teacher init` / `migrate` / etc. Production teachers should use the GitHub web UI for selective deletion; this is a sledgehammer.

**What it does:**

1. Confirms the marker repo exists: `GET /repos/<org>/classroom50`. A 404 refuses teardown with `not found — refusing teardown on an org without the Classroom 50 marker repo`. This is the safety net that prevents accidental nukes of orgs that aren't dedicated to a single classroom.
2. Lists every repo in the org via `GET /orgs/<org>/repos` (paginated). Prints the full set on stdout — teachers see exactly what's about to disappear.
3. Prompts for **typed org-name confirmation** (e.g. `Type the org name (cs50-fall-2026) to confirm:`). Anything other than the org name aborts with `confirmation did not match org name — aborted without deleting anything`. Pass `--yes` to skip the prompt; CI / scripts only.
4. Issues `DELETE /repos/<org>/<repo>` for each repo. `<org>/classroom50` is deleted **last** so a mid-run failure leaves the marker repo behind — re-running teardown still passes the precondition check and tries again on the survivors.
5. Per-repo failures are tolerated: each prints to stderr with the failure reason and the run continues. Exits non-zero when any repo failed so scripts see the partial-completion signal.

**Required scope (opt-in).** `delete_repo` is NOT part of the default `gh teacher login` scope set. Opt in once with `gh teacher login -s delete_repo` before running teardown. This is intentional: teachers who haven't explicitly opted in can't accidentally wipe their org. If your token lacks the scope, the first `DELETE` returns 403 and teardown surfaces an actionable hint pointing back at `gh teacher login -s delete_repo`.

**Errors:**

- `<org>/classroom50` not found → refuses with the "Classroom 50 marker repo" message. Re-create with `gh teacher init <org>` if this is intended, or delete repos manually via the web UI.
- Confirmation mismatch → aborts cleanly, no `DELETE` calls are made.
- 403 on a `DELETE` → token lacks `delete_repo`. Run `gh teacher login -s delete_repo` and retry.
- Other per-repo failures → continue the run, print to stderr, exit non-zero at the end.

## `gh teacher whoami` / `login` / `logout`

- `gh teacher whoami` — prints the authenticated GitHub user (a thin wrapper around `gh api user`).
- `gh teacher login` — runs `gh auth login -s admin:org -s read:org -s repo -s workflow` (the unified scope set shared with `gh student login`), optionally with additional scopes via `-s/--scopes`.
- `gh teacher logout` — runs `gh auth logout`.

## Contributing

Building, testing, and linting the extension is documented in the [`cli/gh-teacher/` README](https://github.com/foundation50/classroom50/blob/main/cli/gh-teacher/README.md) in the repo (where contributors expect to find it).
