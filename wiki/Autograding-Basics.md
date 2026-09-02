# Autograding Basics

How Classroom 50 grades submissions and how to read the results: define
tests on the assignment, and every submission gets a score you can read on
the submissions page and export as CSV. For custom grading scripts and
environments, see [Advanced Autograding](Advanced-Autograding); for
ready-made per-language setups, see
[Autograder Recipes](Autograder-Recipes); for reducing what grading costs,
see [Managing Actions cost](Managing-Actions-Cost).

## How grading works

1. You define tests on the assignment — usually
   [declarative tests](#declarative-tests) (input/output checks, run commands,
   or pytest), written in the web form or with `gh teacher assignment test add`.
2. A student submits by pushing to their repository, or explicitly with
   `gh student submit`, depending on the assignment's
   [submission type](#which-commits-grade).
3. GitHub Actions grades the submission in the student's own repository:
   a small workflow calls the shared **autograde runner**, which fetches your
   grading config and runs the tests against the submitted commit.
4. The runner publishes the result on the student's repository as a GitHub
   **Release** on a `submit/<UTC-timestamp>-<short-sha>` tag — the score, a
   per-test PASS/FAIL table, and a machine-readable `result.json`. The graded
   commit also gets a `classroom50/autograde` commit status, and the student's
   **View grade** link opens the Release.
5. The **score-collection** workflow gathers the **collected scores**
   (`scores.json` in your `classroom50` repository) — on demand with
   **Collect now** on the submissions page, or **Collect all** on the classroom's
   assignments list to refresh every assignment in one run. That's what the
   web app's submissions
   page and both CSV exports read. See [Reading results](#reading-results).

Steps 3–5 run with no per-repository maintenance: everything substantive (the runner
workflow, `runner.py`, autograders, runtime config) lives in the `classroom50` repository
and is fetched at run time, so a grading edit reaches every existing student
repository on the next submission.

Both surfaces drive the same pipeline: the web assignment form and
`gh teacher assignment` write the same `assignments.json`, and the submissions
page and `gh teacher download` read the same results.

> [!NOTE]
> Grading and publishing share one job and runner, so the workflow is **not** a
> credential or hostile-workflow isolation boundary between them.

## Setting up grading

### Grading modes

Each assignment has a **Grading** choice (the web form's Grading field; the
`grading` block in `assignments.json`):

- **Not graded** — no scores; submissions still tag and publish Releases, and
  the Feedback PR still works.
- **Autograded** — the default meaning of grading here: tests or an
  `autograder.py` score each submission automatically. The rest of this page
  is about this mode.
- **Manual** — you enter each score by hand on the submissions page, out of
  the assignment's **Max points**. No autograder score is used — though the
  built-in workflow still runs on submissions unless you also turn the
  built-in autograder off.

Two related, optional settings:

- **Pass threshold** — an advisory percentage of the max score (0–100) at or
  above which the submissions page shows a submission as *passing* (badges,
  passing/failing rollups, and filters). It never changes a student's actual
  score, and leaving it unset turns the passing concept off.
- **Built-in autograder off** (`no_autograder`) — accept installs no
  autograding workflow at all; a templated assignment's own CI runs instead,
  and score collection records who submitted but no scores. See
  [Turning autograding off or pausing it](Managing-Actions-Cost#turning-autograding-off-or-pausing-it).

### Declarative tests

The lowest-friction way to grade: describe io/run/pytest checks directly on the
assignment, and the runner grades them with a built-in interpreter, no grading
code to write. The three types map onto GitHub Classroom's legacy autograder
presets.

Tests are stored on the assignment itself (its entry in `assignments.json`).
Add them in one of two ways:

- In the web app, use the assignment form's **Autograding tests** section.
- From the CLI, add them one at a time with `gh teacher assignment test add`:

```sh
gh teacher assignment test add cs50-fall-2026 cs-principles hello \
    --name compiles --type run --run "gcc -o hello hello.c" --points 1
gh teacher assignment test add cs50-fall-2026 cs-principles hello \
    --name "prints hello" --type io --setup "gcc -o hello hello.c" \
    --run ./hello --expected "Hello, world!" --comparison included --points 2
gh teacher assignment test list cs50-fall-2026 cs-principles hello
gh teacher assignment test remove cs50-fall-2026 cs-principles hello compiles
```

To set the whole list at once, pass a file to `gh teacher assignment add ...
--tests hello-tests.json` (`--tests -` reads stdin). The file is a bare JSON
array, the same shape `assignment test list --json` emits. Keep it anywhere
outside the `classroom50` repository; the CLI copies its contents into the
assignment.

```json
[
  { "name": "compiles", "type": "run", "run": "gcc -o hello hello.c", "timeout": 30, "points": 1 },
  { "name": "prints Hello, world!", "type": "io", "setup": "gcc -o hello hello.c",
    "run": "./hello", "expected": "Hello, world!", "comparison": "included", "points": 2 },
  { "name": "greets by name", "type": "io", "setup": "gcc -o hello hello.c",
    "run": "./hello", "input": "Alice\n", "expected": "^hello,\\s+Alice\\b",
    "comparison": "regex", "points": 2 },
  { "name": "pytest suite", "type": "python", "run": "python -m pytest -q", "timeout": 120, "points": 10 }
]
```

#### Where tests live

You never write a `tests.json` yourself. When you push to the `classroom50`
repository, the **Publish Pages** workflow reads each assignment's tests and
generates `CLASSROOM/autograders/ASSIGNMENT/tests.json` inside the published
bundle, wrapped in an envelope (`schema`, `tests`, and optional `defaults`)
that the runner checks at grade time.

Don't commit a `tests.json` to `CLASSROOM/autograders/ASSIGNMENT/` in the
`classroom50` repository:

- If the assignment has tests, publishing replaces your file and logs a warning.
- If it doesn't, the runner rejects your file (`tests.json is a bare test
  array` or `tests.json is not a JSON object`), and every submission ends as an
  error until you remove it. See
  [Troubleshooting](Troubleshooting#testsjson-is-a-bare-test-array-or-testsjson-is-not-a-json-object-in-the-grading-log).

That directory is for the files tests read: fixtures for `input-file` and
`expected-file`, and grading scripts students must not see. See
[Teacher-only test files](#teacher-only-test-files). In paths and commands on
this page, replace `CLASSROOM` with the classroom's short name and `ASSIGNMENT`
with the assignment slug.

#### Test types

| Type | Passes when | Type-specific fields |
|---|---|---|
| `io` | stdout of `run` matches `expected` per `comparison` | `input` / `input-file`, `expected` / `expected-file`, `comparison` |
| `run` | exit code of `run` equals `exit-code` (default 0) | `exit-code` |
| `python` | pytest passes; points split across cases | — |

> [!NOTE]
> The runner auto-installs `pytest` and `pytest-json-report` for `python` tests.
> Add a `setup` install line only to pin a version.

#### Fields

| Field | Notes |
|---|---|
| `name` | Required. Unique within the assignment; ≤ 100 UTF-8 bytes; no control characters. |
| `type` | Required. `io`, `run`, or `python`. |
| `run` | Required. Shell command, run in the student checkout. `$CLASSROOM50_BUNDLE_DIR` points at the assignment's bundle; see [Teacher-only test files](#teacher-only-test-files). |
| `setup` | Optional pre-command (for example, compile). Non-zero exit fails the test. Same working directory and `$CLASSROOM50_BUNDLE_DIR` as `run`. |
| `input` / `input-file` | `io` only, mutually exclusive. Inline stdin or a bundled fixture. |
| `expected` / `expected-file` | `io` only, mutually exclusive. Must be non-empty for `included`/`regex`. |
| `comparison` | `io` only. `included` (substring), `exact` (trimmed equality), or `regex` (Python `re.search`, multiline). |
| `timeout` | Seconds, 1–600. Omit or 0 for the default of 10s. Applies to `setup` and `run` separately. |
| `exit-code` | `run` only, 0–255. Omit to require 0. |
| `points` | Required, 0–1000. A 0-point test does not affect the numeric score; a failure still sets the autograde status to `failure`. |
| `failure-details` | Optional. How much failure detail students see: `full` (default), `actual-only`, or `none`. See [Report options](#report-options). |
| `show-output` | Optional. `true` includes the test's captured output in the report even when it passes. See [Report options](#report-options). |

At most 100 tests per assignment. Put large fixtures in files
(`input-file` / `expected-file`) under `CLASSROOM/autograders/ASSIGNMENT/`, not
inline. See [Where tests live](#where-tests-live) for what else belongs in that
directory, and what doesn't.

#### Report options

Two per-test fields control what a submission's report shows, in the Release
body, the grade job log, and the run Summary. Both can also be set once for
the whole assignment in a `test_defaults` block on the assignment entry (the
web form's **Report defaults** panel below the tests table); a test's own
value overrides the default.

```json
"test_defaults": { "failure-details": "actual-only", "show-output": true }
```

**`failure-details`** — how much of a failing run students see:

| Value | Students see |
|---|---|
| `full` (default) | A unified diff for `exact` comparisons, otherwise the expected and actual output, plus stderr. |
| `actual-only` | The student's own stdout/stderr only — never the expected output and never a diff, since either would reveal the answer. |
| `none` | Only the failure kind: wrong output, wrong exit code, timeout, or setup failed. |

**`show-output`** — `true` adds a passing test's captured setup and run
output to the report and the Actions log, in a collapsed section. Off by
default (passing output is discarded). Turn it on while authoring or
debugging an autograder; an explicit `false` on one test opts it out of a
`show-output: true` default.

In the web app, the per-test selects sit under **Report options** in the test
editor. From the CLI, pass `--failure-details` and `--show-output` to
[`gh teacher assignment test add`](gh-teacher#assignment-test).

### Setup commands, dependencies, and environment variables

The web assignment's **Setup command** is stored as the leading zero-point
`run` test named `setup`. New setup commands start with a 120-second timeout.
Set the timeout to 0 for the runner's 10-second default, or choose a whole
number from 1 through 600. A failure or timeout sets the autograde status to
`failure` without changing the numeric score; later tests still run.

Use the command for filesystem changes that later tests need. Install a
requirements file with:

```sh
python3 -m pip install -r requirements.txt
```

For a packaged project, including one with a `src/` layout, install the package
in editable mode:

```sh
python3 -m pip install -e .
```

Choose the command that matches the project. An editable package install reads
the project's package metadata; a separate requirements install is needed only
when the project uses that file.

Every assignment setup, per-test `setup`, and `run` command starts in a separate
shell process in the student checkout. Files, virtual-environment directories,
and installed packages persist between commands. Shell state does not: `cd`,
`export`, aliases, and virtual-environment activation end when their command
exits. Invoke a virtual environment's interpreter by path in later commands,
for example `.venv/bin/python -m pytest -q` on Linux or macOS and
`.venv\Scripts\python.exe -m pytest -q` on Windows.

For pytest-only import paths, set `pythonpath` in `pyproject.toml` or
`pytest.ini`. A command that needs one environment value can set it inline on
Linux or macOS:

```sh
PYTHONPATH=src python3 -m pytest -q
```

On Windows:

```bat
set "PYTHONPATH=src" && python -m pytest -q
```

Do not write grading environment variables to `$GITHUB_ENV`. All declarative
commands run as child processes inside the single Grade details workflow step,
and GitHub Actions reads `$GITHUB_ENV` only after that step finishes. A write
cannot change the runner process or the environment of later tests.

<details>
<summary>Where failures surface</summary>

At grade time, the runner runs each test in the student checkout: one row per
test in `result.json`, plus a failure breakdown in three places: the **Release
body**, the **grade job log** ("Grade details"), and the **run Summary page**.
What the breakdown contains follows the test's
[report options](#report-options). Captured output is clipped per block:
2,000 characters in the Release body and Summary, 100,000 in the grade job
log, so long compiler or build output stays readable in the log.

Tests are validated three times: by the CLI or web form when you save them, by
the runner workflow at submission setup, and by the runner before executing.

</details>

### Teacher-only test files

Students receive every file in the assignment template, so a test script kept
there can be read and edited, for example changed to always exit 0. Put grading
files in the `classroom50` repository under `CLASSROOM/autograders/ASSIGNMENT/`
instead. Publishing bundles that directory, and the runner downloads a fresh
copy on every grading run, so nothing a student changes in their repository
affects it.

Every `setup` and `run` command receives the bundle's absolute path in
`CLASSROOM50_BUNDLE_DIR`. Commands still start in the student checkout, so
student files stay relative and teacher files go through the variable.

The following example grades a Python assignment where students implement
`add.py` and the checks live in a script students never see. Replace `ORG` with
your organization.

1. Write the script. The test passes when the script exits 0. Use any tool the
   grading runner has installed; the assignment's
   [`runtime` block](Advanced-Autograding#the-runtime-block) controls what's
   available.

   ```sh
   # check.sh
   set -euo pipefail
   test "$(python3 add.py 2 3)" = "5"
   test "$(python3 add.py -1 1)" = "0"
   ```

2. Upload the script to `CLASSROOM/autograders/ASSIGNMENT/` in the
   `classroom50` repository. In the web app, open the saved assignment, click
   **Upload test files**, then click **Open upload page**, and drop the file on
   the GitHub upload page. Or commit it from a clone:

   ```sh
   git clone https://github.com/ORG/classroom50 && cd classroom50
   mkdir -p CLASSROOM/autograders/ASSIGNMENT
   cp check.sh CLASSROOM/autograders/ASSIGNMENT/
   git add . && git commit -m "ASSIGNMENT: grading script" && git push
   ```

3. Add a `run` test that calls the script through the variable. In the web app,
   enter `bash "$CLASSROOM50_BUNDLE_DIR/check.sh"` as the **Run command**. From
   the CLI:

   ```sh
   gh teacher assignment test add ORG CLASSROOM ASSIGNMENT \
       --name "adds correctly" --type run \
       --run 'bash "$CLASSROOM50_BUNDLE_DIR/check.sh"' --points 5
   ```

4. Wait for the **Publish Pages** workflow in the `classroom50` repository to
   finish, then submit as a test student. To confirm the bundle contains the
   script:

   ```sh
   curl -fsSL "https://ORG.github.io/classroom50/CLASSROOM/autograders/ASSIGNMENT.tar.gz" | tar -tz
   # ASSIGNMENT/tests.json  ASSIGNMENT/check.sh
   ```

The variable works for every test type:

- A `python` test can run pytest against hidden test files with
  `python3 -m pytest -q "$CLASSROOM50_BUNDLE_DIR"`. Add
  `sys.path.insert(0, os.getcwd())` or a `pythonpath` setting so the tests
  import the student's modules.
- An `io` test reads hidden fixtures with `input-file` and `expected-file`,
  with no variable needed.

Details to know:

- Invoke scripts through their interpreter (`bash check.sh`, `python3 check.py`)
  rather than relying on the executable bit surviving the commit.
- On a Windows runner the shell is `cmd.exe`, so write
  `%CLASSROOM50_BUNDLE_DIR%` instead of `$CLASSROOM50_BUNDLE_DIR`.
- Don't add an `autograder.py` to the same directory: it takes precedence over
  declarative tests, and the CLI refuses `test add` while one exists. An
  `autograder.py` receives the same variable, and its sibling files are also
  at `Path(__file__).parent`. See
  [Advanced Autograding](Advanced-Autograding#writing-an-autograderpy).
- If the script's failure output would give away the answer, set
  `failure-details` to `actual-only` or `none`. See
  [Report options](#report-options).

> [!IMPORTANT]
> Hidden means students can't change these files, not that they can't read
> them. Your organization's GitHub Pages site serves the bundle publicly, so a
> student who finds the URL can download it. Keep anything confidential (a full
> solution, a private dataset) out of the bundle. See
> [Known Limitations](Known-Limitations#templates-and-student-repositories).

### Beyond declarative tests

When declarative tests aren't enough, write the grading logic yourself as an
`autograder.py`, customize the grading environment with the `runtime` block,
or swap the grading pipeline entirely. All three live in
[Advanced Autograding](Advanced-Autograding). For worked per-language
setups, see [Autograder Recipes](Autograder-Recipes).

## Which commits grade

What triggers grading is a **per-assignment choice** (the web form's
**Submission type**; `submission_mode` in assignments.json; `gh teacher
assignment add --submission-mode` / `gh teacher assignment submission-mode`):

**`every-push` (the default)** — grading triggers on two events:

- **Push to the default branch** — every commit grades, **except the acceptance
  commit** (the one that introduced `.classroom50.yaml`, with nothing on top).
- **Push of a `submit/*` tag** — manual tag pushes work too.

**`tag`** — grading triggers **only** on `submit/*` tag pushes. A plain
`git push` runs nothing and costs no GitHub Actions minutes — the cost lever for
large cohorts. Submissions become an explicit act:

- `gh student submit` pushes a `submit/<UTC-timestamp>-<short-sha>` tag after
  the branch commit — that tag push is what grades.
- A hand-pushed tag works exactly the same: `git tag submit/anything && git
  push origin submit/anything`. Any tag under `submit/` grades; no CLI
  required.

**Milestone submission tags** — with either mode, the assignment can also
name **milestone tags** (`submission_tags` in assignments.json, the web form's
**Submission tags** field, for example `["phase1", "phase2", "complete"]`, settable at
creation or from the assignment settings / `gh teacher assignment add
--submission-tag`). Pushing a matching tag grades that commit — plain git, no
CLI required:

```sh
git tag phase1
git push origin phase1
```

Simple globs work too (`v*`), though exact milestone names are safer — a
broad glob grades every matching tag a student pushes. The milestone tag
**triggers** grading; the graded **record** still lives at the canonical
`submit/<UTC-timestamp>-<short-sha>` tag the runner mints at that commit (its
Release title notes *"via phase1"*), so history stays one-immutable-release-
per-submission and collection, regrade, and the collected scores are unaffected. The
`submit/*` namespace always keeps working alongside milestone tags.

Because the trigger lives in each student repository's workflow (GitHub evaluates a
workflow's `on:` block before any job runs), **changing the mode or the
milestone patterns after repositories exist requires retrofitting each repository's
workflow** — see
[Changing the trigger on existing repositories](#changing-the-trigger-on-existing-repositories).

<details>
<summary>Why the acceptance commit is skipped</summary>

Accepting lands `.classroom50.yaml` + the workflow in one commit, which fires
the workflow — but that's *accepting*, not *submitting*. The runner detects it
and skips tagging, grading, and the Release (the run still appears in the
Actions tab with a `notice`). Detection is **fail-open**: any uncertainty grades
rather than risk dropping a real submission. Your first `gh student submit`
always stacks a fresh commit, so it's never mistaken for the acceptance.

</details>

<details>
<summary>Tag-mode defenses in the runner</summary>

Two guards keep tag mode honest even when a repository's workflow trigger is stale:

- **Stale-trigger suppression** — a repository accepted before the mode flipped to
  `tag` (or whose retrofit failed) still carries the every-push trigger. The
  runner reads `submission_mode` from the published assignments.json at setup
  time and, when the assignment is tag-mode but the run was branch-triggered,
  skips tagging and grading, posting a `classroom50/autograde-skipped`
  success status: *"tag-mode assignment — push not graded; run gh student
  submit"*.
- **Retrofit-commit skip** — the teacher-side trigger update commits with
  `[skip ci]`, so it fires no workflow. As a backstop (for example, a client that
  dropped the marker), the runner also recognizes a tip commit touching ONLY
  `.github/workflows/autograde.yaml` and skips it with the status
  *"autograder trigger updated — nothing to grade"*. The submissions page
  leaves that commit out of its counts too, along with the empty commit that
  opens a Feedback PR — the only two commits Classroom 50 writes into a
  student repository on its own.
- **Foreign-tag suppression** — a pushed tag matching neither `submit/*` nor
  any configured milestone pattern (possible only with a stale or hand-edited
  workflow) is skipped gracefully with the `classroom50/autograde-skipped`
  status *"tag is not a submission trigger — not graded"*, never a failed run.

The two suppression statuses use the separate `classroom50/autograde-skipped`
context deliberately: in both cases the student's real work exists but was
**not** graded, and a green `classroom50/autograde` would read as "graded
successfully". Graded commits alone report under `classroom50/autograde`.
(The nothing-to-grade skips — acceptance commit, trigger-update commit, no
autograder configured — stay on the main context: there is no work there to
mistake for graded.)

</details>

### Changing the trigger on existing repositories

The autograding workflow is written into each student repository at accept time and
otherwise never changes, so flipping `submission_mode` on an assignment with
accepted repositories needs a retrofit:

- **CLI**: `gh teacher assignment submission-mode ORG CLASSROOM ASSIGNMENT
  --tag` (or `--every-push`) flips the field AND rewrites the workflow across
  every student repository (add `--user USERNAME` for one repository, `--dry-run` to
  preview). Requires the `workflow` OAuth scope
  (`gh auth refresh -s workflow`).
- **Web**: change the trigger on the assignment settings page, then run
  **Update autograding triggers** from the submissions page's actions menu
  (or per-repository from a row's manage dialog).

The rewrite is surgical — only the trigger lines change; a workflow a student
hand-edited is reported and left untouched. **Custom (non-default)
autograders are never rewritten**: you own their `on:` block; edit it
yourself and use `--update-shims=false` to flip only the field.

After a retrofit, students must `git pull` — clones made before the change
conflict on their next push.

To turn autograding off for an assignment, pause it over a break, or reduce
what grading costs, see [Managing Actions cost](Managing-Actions-Cost).

## Reading results

### Where results live

Every graded submission produces the same three records:

| Record | Where | What it shows |
|---|---|---|
| **Release** | The student repository, on the `submit/<UTC-timestamp>-<short-sha>` tag | The score, a **per-test PASS/FAIL table**, and the machine-readable `result.json`. This is what **View grade** / **View autograder details** links open — and the only place with the per-test breakdown. |
| **Commit status** | The graded commit (`classroom50/autograde`) | success / failure / error at a glance, right on the commit. |
| **Collected score** | `scores.json` in the `classroom50` repository, after collection | What the submissions page and the CSV exports read: score, submission time, links, late flag, and full attempt history. |

Releases and statuses appear the moment grading finishes. The collected scores
lag until **collection** runs — on demand with **Collect now** on the
submissions page, **Collect all** on the classroom's assignments list
(every assignment in one run), or `gh workflow run collect-scores.yaml` from
the shell. If a
student says "I submitted" and you see no score, collect first.

On the submissions page, each row shows the student's (or group's) current
score with links to the repository, the graded **commit**, the Release
(**View autograder details**), the full **review** diff (starter code → graded
commit), and the Feedback PR (**View feedback PR** on the row, or **Review**
in its manage dialog).

### Latest score versus history

The score on a row — and in the web CSV's summary columns — is the
**latest submission's** (or a teacher override); in the CLI CSV the latest is
the first line per member. "Latest" follows the *submission*, not the commit:
if a student deliberately submits an older
commit (a milestone tag pointing at earlier work, or a regrade), that
submission's Release becomes the latest. The badge and the collected scores
always agree because they use the same rule.

The full history is kept everywhere:

- **Web** — click a row's submission count to open its details: every attempt,
  newest first, each with its commit link and a per-attempt **View grade**
  Release link.
- **Student repository** — one immutable Release per attempt, under the repository's
  Releases tab (each `submit/*` tag is one graded attempt).
- **`scores.json`** — each entry's `submissions` array holds every collected
  attempt, newest first.
- **`gh teacher download`** — writes each repository's `results.json` (all attempts)
  next to `result.json` (latest), and one CSV line per attempt (see below).

### Grading a specific commit

Students sometimes ask you to grade a particular commit, not their latest:

- **Every attempt already has its own frozen result** — find that commit's
  `submit/*` Release in the history; its score and per-test table are exactly
  as graded.
- **To grade an arbitrary commit**, have the student push a `submit/*` tag (or
  a configured milestone tag) pointing at it: `git tag submit/regrade-me
  SHA && git push origin submit/regrade-me`. That mints a normal graded
  submission at that commit.
- **Regrade** (per-row, or **Regrade all** in the **Actions** menu) re-runs each
  repository's **latest** submission **at its original commit** — useful after
  fixing a broken test. A never-graded repository is first-graded at its current
  HEAD instead (a new submission). On a re-run, `datetime` (the submission
  instant) stays fixed so late-marking never changes; `graded_at` records the
  re-run.

### Who submitted

- `owner` — the repository owner (the `USERNAME` in the repository name); the identity
  scores are keyed by.
- `submitted_by` — the GitHub account that actually pushed that submission.
  For group work this is how you see who did the pushing even though the score
  is shared.
- Group scores are credited to every teammate on the classroom team, recorded
  as the entry's `member_usernames` — see
  [Group attribution model](#group-attribution-model).

### Group attribution model

A group assignment is graded once, in the group's shared repository; the score
fans out to members at collection time. How they're resolved depends on the
mode.

**Group** assignments credit the group team's live members, intersected with
the classroom roster, recorded as the entry's `member_usernames` next to the
team's `team_slug`:

- **The team is authoritative.** Repository collaborators are never read;
  membership in the group's GitHub team is what counts, so an account off the
  roster is never credited.
- **A failed team read skips the repository.** If the team's member list can't
  be read, or the team was deleted, collection skips that repository and
  preserves its previous entry and credit rather than degrading to an
  owner-only credit (the repository's owner is the group, not a person). The
  submissions page flags a deleted team as **Group team missing** so you can
  recreate it.
- **An empty credit is loud.** A team whose live members are all unenrolled
  still writes its entry, with nobody credited and a warning, so the drift is
  visible rather than silent.

**Group (legacy)** assignments are graded in the founder's repository.
`collect-scores`
credits the shared score to every collaborator **on the classroom team** (the
owner is always included), recorded as the entry's `member_usernames`.

- **Crediting is by team membership, not permission level.** A teammate is
  credited whether they hold `push` or `admin`. Teachers and TAs are excluded
  automatically because they aren't on the student team.
- **Classmates on the team are mutually trusted.** Collection can't tell how a
  collaborator was added, so a student could credit a teammate who's on the team.
  The team intersection bounds this to classmates — an account off the team is
  never credited. Review each group repository's collaborators if you need stricter
  control.
- **Owner-only submissions warn.** If a group submission resolves to only the
  owner, collection emits a `::warning::` so the "team submission scored as solo"
  case is visible.
- **`submitted_by` records the pusher**, so you can see who did the work even
  though the score is shared.
- **Rows are keyed by the repository owner**, so re-collecting a group repository whose
  members changed updates the same row in place.

### Score exports

Two CSV exports cover most needs; the raw JSON is always there for anything
custom.

#### Web: Download scores (CSV)

**Download scores (CSV)** on the submissions page saves
`CLASSROOM-ASSIGNMENT-scores.csv` — **one row per student (or group)**,
sorted by last name, with the latest submission's data:

| Column | Description |
|---|---|
| `name` / `first_name` / `last_name` | From the roster (blank if the login isn't on it). |
| `usernames` | The credited GitHub username(s) — one for individual work, every credited member (alphabetical) for a group. |
| `score` / `max_score` | The latest submission's score. Blank if submitted but not yet collected; `0` with blanks for a non-submitter. |
| `submissions` | How many attempts were collected. |
| `submitted_at` | The latest submission instant (ISO 8601 UTC). |
| `late` | `yes` / `no` against the due date; blank for non-submitters. |
| `commit` / `review` / `release` | Links: the graded commit, the full starter→graded diff, and the Release. |

#### CLI: `gh teacher download`

`gh teacher download ORG CLASSROOM ASSIGNMENT` clones every student
repository and writes a `scores.csv` at the destination root — **one line per
submission** (a student with several attempts contributes several lines,
newest first), plus one blank-score line per non-submitter:

| Column | Description |
|---|---|
| `username` | The team member. For a group, every credited member repeats the shared submission's lines under their own username. |
| `first_name` / `last_name` / `email` / `section` | Joined from `roster.csv` when present. |
| `score` / `max_score` | This attempt's score. Blank for non-submitters. |
| `datetime` | This attempt's submission instant (ISO 8601 UTC). |
| `submission_tag` | The `submit/…` tag identifying the attempt. |
| `submitted_by` | Who pushed this attempt. |
| `review_url` | The starter→graded diff for this attempt. |
| `late` | `true` / `false` against the due date; blank when unknown. |
| `override` | `true` when a teacher override is in effect for the entry. |

Per-test breakdowns aren't in either CSV — they're in each attempt's Release
(and in the per-repository `result.json` / `results.json` files the download also
refreshes).

#### Raw JSON

- `CLASSROOM/scores.json` in your `classroom50` repository is the
  authoritative record (see
  [scores.json shape](Advanced-Autograding#the-resultjson-contract)) — build
  any custom report from it.
- `gh teacher download` leaves `result.json` (latest attempt) and
  `results.json` (all attempts, newest first) in each cloned repository, including
  the per-test arrays.

## Feedback pull requests

The Feedback PR is **on by default** for assignments created with `gh teacher
assignment add` (`--feedback-pr=false` to disable). When on, there is
**one long-lived "Feedback" pull request per student repository** so you review
cumulative work with inline comments alongside the scored Release.

- **Frozen base branch.** Accept creates a `feedback` branch at the
  student's baseline commit (the accept commit) and never advances it. The PR's
  base is `feedback` and its head is the default branch, so it always shows the
  full starter→latest diff.
- **Opened at accept.** The PR is there before the first submission and exists even
  when GitHub Actions is disabled for student repositories. The diff still starts at the
  baseline, so the setup files never appear in it.
- **One PR, reused** across submissions, labeled **Individual Assignment** or
  **Group Assignment**. A student closing it reopens it; a teacher merge is left
  alone.
- **Default body.** The PR opens with Classroom 50's built-in "here is where your teacher leaves
  feedback" text by default. Set `feedback_pr_template: true` (or check the box
  on the web form) to use the template repository's own pull request template as
  the body instead. Accept reads the first existing of
  `.github/pull_request_template.md`, `pull_request_template.md`, or
  `docs/pull_request_template.md` from the template and uses it verbatim. It
  requires a template and the Feedback PR itself. The read is best-effort: a
  missing, empty, oversized, or unreadable file falls back to the built-in body
  and never blocks the PR. Keeping the template's contents correct is up to you.
- **Maintained by the runner.** The runner adopts the PR by base and head and
  maintains it from then on. If accept
  could not open it (a permissions oddity, or a repository accepted before this
  feature), the runner opens it on the first submission instead, and
  re-accepting also retries, which is the only route with GitHub Actions off. On that
  fallback open the runner honors the template too, best-effort: its GitHub Actions
  token cannot always read a private or external template, so it uses the
  built-in body and logs a warning when it has to.

<details>
<summary>Baseline resolution and prerequisites</summary>

Both accept and the runner resolve the baseline as **the commit that introduced
`.classroom50.yaml`** (a structural marker, not a commit subject) so they agree
on where the base is frozen. The runner refuses to open or update the PR when
the `feedback` branch sits at any other commit, since a student can create that
branch themselves; an organization administrator deleting it lets the next submission re-freeze
it correctly. If no marker commit is found, the runner opens the PR against the
root commit and **warns** that the baseline is untrusted; if no baseline resolves
at all, it **skips** with a warning.

**Prerequisites (handled by `gh teacher init`):** the organization setting "Allow GitHub
Actions to create and approve pull requests" must be on, and two organization rulesets
protect submission history and the frozen `feedback` branch. If you enable
feedback on an organization set up before this feature, **re-run `gh teacher init`**.

**Student repositories accepted before this feature** use an older workflow and must
be re-created (delete + re-accept) to pick up the new one.

</details>
