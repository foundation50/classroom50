# Autograders

How Classroom 50 grades submissions, how to read the results, and how to
customize grading. If you only remember one thing: **define tests on the
assignment, and every submission gets a score you can read on the submissions
page and export as CSV.**

## How grading works

The whole pipeline, end to end:

1. **You describe the grading** on the assignment — usually
   [declarative tests](#declarative-tests) (input/output checks, run commands,
   or pytest), written in the web form or with `gh teacher assignment test add`.
2. **A student submits** — by pushing to their repository, or explicitly with
   `gh student submit`, depending on the assignment's
   [submission type](#which-commits-grade).
3. **GitHub Actions grades the submission** in the student's own repository:
   a small workflow calls the shared **autograde runner**, which fetches your
   grading config and runs the tests against the submitted commit.
4. **The result is published on the student's repository** as a GitHub
   **Release** on a `submit/<UTC-timestamp>-<short-sha>` tag — the score, a
   per-test PASS/FAIL table, and a machine-readable `result.json`. The graded
   commit also gets a `classroom50/autograde` commit status, and the student's
   **View grade** link opens the Release.
5. **Scores are collected into the gradebook** (`scores.json` in your config
   repo) by the **score-collection** workflow — nightly, or on demand via
   **Sync now** on the submissions page. That's what the web app's submissions
   page and both CSV exports read. See [Reading results](#reading-results).

Steps 3–5 run with no per-repo maintenance: everything substantive (the runner
workflow, `runner.py`, autograders, runtime config) lives in the config repo
and is fetched at run time, so a grading edit reaches every existing student
repo on the next submission.

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
  score, and leaving it unset simply turns the passing concept off.
- **Built-in autograder off** (`no_autograder`) — accept installs no
  autograding workflow at all; a templated assignment's own CI runs instead,
  and score collection skips the assignment. See
  [Turning autograding off or pausing it](#turning-autograding-off-or-pausing-it).

### Declarative tests

The lowest-friction way to grade: describe io/run/pytest checks directly on the
assignment, and the runner grades them with a built-in interpreter — no grading
code to write. The three types map onto GitHub Classroom's legacy autograder
presets.

In the web app, add tests in the assignment form's **Autograding tests**
section. From the CLI, author them one at a time:

```sh
gh teacher assignment test add cs50-fall-2026 cs-principles hello \
    --name compiles --type run --run "gcc -o hello hello.c" --points 1
gh teacher assignment test add cs50-fall-2026 cs-principles hello \
    --name "prints hello" --type io --setup "gcc -o hello hello.c" \
    --run ./hello --expected "Hello, world!" --comparison included --points 2
gh teacher assignment test list cs50-fall-2026 cs-principles hello
gh teacher assignment test remove cs50-fall-2026 cs-principles hello compiles
```

Or set the whole array at once with `gh teacher assignment add ... --tests
<file.json>` (`--tests -` reads stdin). The file is a bare JSON array — the same
shape `assignment test list --json` emits:

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
| `run` | Required. Shell command, run in the student checkout. |
| `setup` | Optional pre-command (e.g., compile). Non-zero exit fails the test. |
| `input` / `input-file` | `io` only, mutually exclusive. Inline stdin or a bundled fixture. |
| `expected` / `expected-file` | `io` only, mutually exclusive. Must be non-empty for `included`/`regex`. |
| `comparison` | `io` only. `included` (substring), `exact` (trimmed equality), or `regex` (Python `re.search`, multiline). |
| `timeout` | Seconds, 1–600. Omit or 0 for the default of 10s. Applies to `setup` and `run` separately. |
| `exit-code` | `run` only, 0–255. Omit to require 0. |
| `points` | Required, 0–1000. A 0-point test does not affect the numeric score; a failure still sets the autograde status to `failure`. |

At most 100 tests per assignment. Put large fixtures in files
(`input-file` / `expected-file`) under `<classroom>/autograders/<slug>/`, not
inline.

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
<summary>How tests flow, and where failures surface</summary>

Tests live inline in `assignments.json`. On the next config-repo push,
publish-pages **materializes** them into the assignment's Pages bundle as
`tests.json`. At grade time, `runner.py` runs each spec in the student checkout:
one row per test in `result.json`, plus a failure breakdown in three places — the
**Release body**, the **grade job log** ("Grade details"), and the **run Summary
page**. Captured output is truncated at 2000 characters.

Specs are validated three times: by the CLI at write time, by the runner
workflow at submission setup, and by `runner.py` before executing.

</details>

<details>
<summary>Writing a valid assignments.json from another client (e.g., a GUI)</summary>

Anything that writes a valid `assignments.json` gets the whole pipeline for
free. A non-CLI client should:

1. Validate against
   [`schemas/assignments-v1.schema.json`](https://github.com/foundation50/classroom50/blob/main/schemas/assignments-v1.schema.json)
   (two rules it can't express: unique test names, and name length ≤ 100 UTF-8
   *bytes*).
2. Probe before writing tests: `<classroom>/autograders/<slug>/autograder.py`
   must NOT exist, and `.github/scripts/materialize_tests.py` MUST exist.
3. Write via the git-data API and retry on a non-fast-forward rejection.

The CLI parses strictly (unknown fields rejected), so persist only schema fields.

</details>

### Writing an `autograder.py`

When declarative tests aren't enough, write the grading logic yourself: the
autograder is a Python script the runner invokes once per submission. There are
two scopes:

| Path | Scope | Used when |
|---|---|---|
| `<classroom>/autograders/<slug>/autograder.py` | One assignment | Present in the bundle. |
| `<classroom>/autograders/<slug>/tests.json` | One assignment | [Declarative tests](#declarative-tests); no per-assignment `autograder.py`. |
| `<classroom>/autograder.py` | One classroom | Neither of the above exists. |

If none exist, the runner emits a vacuous pass (score 0/0) and the submission
still lands as a tagged Release — a valid mid-setup state.

#### Precedence

`runner.py` resolves the grading entrypoint in this order:

1. Per-assignment `<classroom>/autograders/<slug>/autograder.py` (an override
   always wins).
2. Per-assignment `tests.json` (declarative tests).
3. Classroom default `<classroom>/autograder.py`.
4. None of the above → vacuous pass.

To keep precedence from silently swallowing tests, the CLI refuses `assignment
test add` / `--tests` while a per-assignment `autograder.py` exists.

#### Contract

The runner provides:

- **Environment variables:** `CLASSROOM`, `ASSIGNMENT`, `SUBMISSION_TAG`,
  `PAGES_BASE_URL`, `USERNAME`/`OWNER`, `ASSIGNMENT_TYPE`, `COMMIT_URL`,
  `RELEASE_URL`, `REVIEW_URL`, and all standard `GITHUB_*`.
- **Working directory:** the student's checkout (relative paths resolve to
  student code).
- **Sibling files:** anything else under `<classroom>/autograders/<slug>/` is
  bundled and lives at `Path(__file__).parent`.

The autograder must produce **`./result.json`** (required — see
[the `result.json` contract](#the-resultjson-contract)). Optionally
`./release-body.md` and `status=`/`summary=` in `$GITHUB_OUTPUT`; the runner
synthesizes them from `result.json` if absent. Exit **0** if it ran end-to-end
(pass/fail is in `result.json`); a **non-zero** exit is an infrastructure error
and the runner synthesizes a `status=error` result.

<details>
<summary>Template: pytest</summary>

Drop at `<classroom>/autograders/<slug>/autograder.py` alongside your `test_*.py`
files:

```python
"""Pytest-based autograder. Runs sibling test_*.py files against
the student's code, parses pytest's JSON report, emits result.json."""

import datetime, json, os, subprocess, sys
from pathlib import Path

HERE = Path(__file__).parent
REPORT = HERE / "pytest-report.json"

WEIGHTS = {}          # per-test overrides; anything else gets DEFAULT_WEIGHT
DEFAULT_WEIGHT = 1

subprocess.run(
    [sys.executable, "-m", "pip", "install", "--quiet", "--user",
     "pytest", "pytest-json-report"],
    check=True,
)
subprocess.run(
    [sys.executable, "-m", "pytest", str(HERE),
     "--json-report", f"--json-report-file={REPORT}", "-q", "--no-header"],
    cwd=os.getcwd(),
    check=False,
)

if not REPORT.is_file():
    print("::error::pytest did not produce a JSON report", file=sys.stderr)
    sys.exit(1)

data = json.loads(REPORT.read_text())
tests = []
for t in data.get("tests", []):
    nodeid = t.get("nodeid", "")
    passed = t.get("outcome") == "passed"
    max_score = WEIGHTS.get(nodeid.split("::")[-1], DEFAULT_WEIGHT)
    tests.append({
        "test-name": nodeid,
        "passed": passed,
        "score": max_score if passed else 0,
        "max-score": max_score,
    })

result = {
    "schema":     "classroom50/result/v1",
    "classroom":  os.environ["CLASSROOM"],
    "assignment": os.environ["ASSIGNMENT"],
    # owner + assignment_type are stamped authoritatively by the runner.
    "submission": os.environ["SUBMISSION_TAG"],
    "commit":     os.environ["COMMIT_URL"],
    "release":    os.environ["RELEASE_URL"],
    "review":     os.environ.get("REVIEW_URL") or os.environ["COMMIT_URL"],
    "datetime":   datetime.datetime.now(datetime.timezone.utc)
                  .strftime("%Y-%m-%dT%H:%M:%SZ"),
    "score":      sum(t["score"] for t in tests),
    "max-score":  sum(t["max-score"] for t in tests),
    "tests":      tests,
}
Path("result.json").write_text(json.dumps(result, indent=2))
```

</details>

<details>
<summary>Template: minimal custom</summary>

Anything that produces `result.json` works — compile-and-diff, image scoring,
scraping a deployed app:

```python
import datetime, json, os, subprocess
from pathlib import Path

subprocess.run(["gcc", "-o", "hello", "hello.c"], check=True)
proc = subprocess.run(["./hello"], capture_output=True, text=True, check=False)
passed = proc.stdout.strip() == "Hello, world!"

result = {
    "schema":     "classroom50/result/v1",
    "classroom":  os.environ["CLASSROOM"],
    "assignment": os.environ["ASSIGNMENT"],
    "submission": os.environ["SUBMISSION_TAG"],
    "commit":     os.environ["COMMIT_URL"],
    "release":    os.environ["RELEASE_URL"],
    "review":     os.environ.get("REVIEW_URL") or os.environ["COMMIT_URL"],
    "datetime":   datetime.datetime.now(datetime.timezone.utc)
                  .strftime("%Y-%m-%dT%H:%M:%SZ"),
    "score":      1 if passed else 0,
    "max-score":  1,
    "tests": [
        {"test-name": "prints_hello_world", "passed": passed,
         "score": 1 if passed else 0, "max-score": 1},
    ],
}
Path("result.json").write_text(json.dumps(result, indent=2))
```

</details>

#### Classroom default

`gh teacher autograder set-default <org> <classroom> --from <path>` installs a
default that grades every assignment without its own autograder or tests. With no
`--from`, it installs a diagnostic stub (echoes the environment, emits a vacuous
pass) — useful for verifying the pipeline. Inspect it with `autograder show`, and
delete it outright with `autograder remove`.

### The `runtime` block

Per-assignment environment (runner OS, language toolchains, packages, container
image) lives as an optional `runtime` field on each `assignments.json` entry, or
under **Advanced settings** in the web assignment form. The runner reads it on
every submission, so changes propagate with no student-repo edit. Pass a JSON
file to `gh teacher assignment add --runtime`:

```json
{
  "runs-on": "ubuntu-latest",
  "python":  "3.14",
  "node":    "20",
  "java":    "21",
  "go":      "1.23",
  "apt":     ["build-essential", "valgrind"]
}
```

When omitted, the default is `ubuntu-latest` + Python 3.14. Inside a `container`,
the image owns the toolchain unless you set `python` explicitly.

| Field | Notes |
|---|---|
| `runs-on` | A single runner label (`"ubuntu-latest"`) or an array (`["self-hosted", "gpu"]`). No allow-list — you own the label; each is anti-injection-checked (1–10 labels). |
| `python` / `node` / `java` / `go` | Version passed to the matching `setup-*` action. Skipped when unset (`python` defaults to 3.14 on the host path). |
| `rust` | Rustup toolchain (`stable`, `1.79`, …) via `dtolnay/rust-toolchain`. |
| `apt` | Debian/Ubuntu package names. Linux runners only. Mutually exclusive with `container`. |
| `container` | Escape hatch — see below. |

<details>
<summary>Custom and self-hosted runners</summary>

`runs-on` works exactly as in any Actions workflow. Multiple labels are AND-ed; a
misspelled label just won't match a runner. A `container` needs a Linux
`runs-on`.

**Self-hosted runners keep their own toolchains.** On a self-hosted runner the
grade job skips *all* managed toolchain/apt setup (even the default Python), so
the autograder runs against the interpreter and packages your image ships. Bake
those into the runner image; `runner.py` still installs `pytest` /
`pytest-json-report` on demand. Detection uses `runner.environment`, so keep the
runner agent (v2.294.0+) up to date.

</details>

<details>
<summary>Custom container</summary>

```json
{ "container": { "image": "cs50/cli:latest", "user": "root" } }
```

The image must be **publicly pullable** (private-registry pull secrets can't be
delivered safely in a student repo). Set `user` for any image that doesn't run
as root by default, or `actions/checkout` fails with a permission error. `image`
is required and injection-checked; `user` accepts `docker run --user` syntax.

</details>

> [!NOTE]
> `runtime` values are teacher-authored (from your config repo), never student
> input, so a permissive `runs-on` doesn't widen what a student repo can request.

## Which commits grade

What triggers grading is a **per-assignment choice** (the web form's
**Submission type**; `submission_mode` in assignments.json; `gh teacher
assignment add --submission-mode` / `gh teacher assignment submission-mode`):

**`every-push` (the default)** — grading triggers on two events:

- **Push to the default branch** — every commit grades, **except the acceptance
  commit** (the one that introduced `.classroom50.yaml`, with nothing on top).
- **Push of a `submit/*` tag** — manual tag pushes work too.

**`tag`** — grading triggers **only** on `submit/*` tag pushes. A plain
`git push` runs nothing and costs no Actions minutes — the cost lever for
large cohorts. Submissions become an explicit act:

- `gh student submit` pushes a `submit/<UTC-timestamp>-<short-sha>` tag after
  the branch commit — that tag push is what grades.
- A hand-pushed tag works exactly the same: `git tag submit/anything && git
  push origin submit/anything`. Any tag under `submit/` grades; no CLI
  required.

**Milestone submission tags** — with either mode, the assignment can also
name **milestone tags** (`submission_tags` in assignments.json, the web form's
**Submission tags** field, e.g. `["phase1", "phase2", "complete"]`, settable at
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
per-submission and collection, regrade, and the gradebook are unaffected. The
`submit/*` namespace always keeps working alongside milestone tags.

Because the trigger lives in each student repo's workflow (GitHub evaluates a
workflow's `on:` block before any job runs), **changing the mode or the
milestone patterns after repos exist requires retrofitting each repo's
workflow** — see
[Changing the trigger on existing repos](#changing-the-trigger-on-existing-repos).

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

Two guards keep tag mode honest even when a repo's workflow trigger is stale:

- **Stale-trigger suppression** — a repo accepted before the mode flipped to
  `tag` (or whose retrofit failed) still carries the every-push trigger. The
  runner reads `submission_mode` from the published assignments.json at setup
  time and, when the assignment is tag-mode but the run was branch-triggered,
  skips tagging and grading, posting a `classroom50/autograde-skipped`
  success status: *"tag-mode assignment — push not graded; run gh student
  submit"*.
- **Retrofit-commit skip** — the teacher-side trigger update commits with
  `[skip ci]`, so it fires no workflow. As a backstop (e.g., a client that
  dropped the marker), the runner also recognizes a tip commit touching ONLY
  `.github/workflows/autograde.yaml` and skips it with the status
  *"autograder trigger updated — nothing to grade"*.
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

### Changing the trigger on existing repos

The autograding workflow is written into each student repo at accept time and
otherwise never changes, so flipping `submission_mode` on an assignment with
accepted repos needs a retrofit:

- **CLI**: `gh teacher assignment submission-mode <org> <classroom> <slug>
  --tag` (or `--every-push`) flips the field AND rewrites the workflow across
  every student repo (add `--user <login>` for one repo, `--dry-run` to
  preview). Requires the `workflow` OAuth scope
  (`gh auth refresh -s workflow`).
- **Web**: change the trigger on the assignment settings page, then run
  **Update autograding triggers** from the submissions page's actions menu
  (or per-repo from a row's manage dialog).

The rewrite is surgical — only the trigger lines change; a workflow a student
hand-edited is reported and left untouched. **Custom (non-default)
autograders are never rewritten**: you own their `on:` block; edit it
yourself and use `--update-shims=false` to flip only the field.

After a retrofit, students must `git pull` — clones made before the change
will conflict on their next push.

### Turning autograding off or pausing it

Beyond choosing *when* commits grade, you can turn the pipeline off entirely:

- **Per assignment, at creation** — pick **Do not use the built-in
  autograder** (`no_autograder` in assignments.json). Accept installs no
  autograding workflow at all; a templated assignment's own CI workflows run
  instead, and score collection skips the assignment. Changeable later, but
  only affects repositories accepted from then on (existing ones keep their
  setup). See [`gh teacher` reference](gh-teacher#assignment-add).
- **Per assignment, temporarily** — **Pause autograding** in the submissions
  page's **Actions** menu disables the `autograde.yaml` workflow in every
  student repo via GitHub's workflow-disable API. No files change, students'
  other workflows keep running, and **Resume autograding** re-enables it.
  Available on individual assignments using the built-in autograder (a single
  repo can also be paused from its row). A student with admin on their own
  repo can technically re-enable the workflow — a known limitation.
- **Org-wide** — the organization settings' **Pause autograding for all
  student repositories** toggle narrows the org's Actions policy to the config
  repo. **This stops all workflows in student repositories**, including any
  course CI — prefer the per-assignment pause unless that's what you want.

See also the [FAQ on reducing Actions usage](FAQ#can-i-turn-autograding-off-or-reduce-actions-usage).

## Reading results

Where to find scores, per-test breakdowns, past attempts, and who submitted —
and what each export contains.

### Where results live

Every graded submission produces the same three records:

| Record | Where | What it shows |
|---|---|---|
| **Release** | The student repo, on the `submit/<UTC-timestamp>-<short-sha>` tag | The score, a **per-test PASS/FAIL table**, and the machine-readable `result.json`. This is what **View grade** / **View autograder details** links open — and the only place with the per-test breakdown. |
| **Commit status** | The graded commit (`classroom50/autograde`) | success / failure / error at a glance, right on the commit. |
| **Gradebook row** | `scores.json` in the config repo, after collection | What the submissions page and the CSV exports read: score, submission time, links, late flag, and full attempt history. |

Releases and statuses appear the moment grading finishes. The gradebook lags
until **collection** runs — nightly, or on demand with **Sync now** on the
submissions page (`gh workflow run collect-scores.yaml` from the shell). If a
student says "I submitted" and you see no score, sync first.

On the submissions page, each row shows the student's (or group's) current
score with links to the repository, the graded **commit**, the Release
(**View autograder details**), the full **review** diff (starter code → graded
commit), and the Feedback PR (**Review**).

### Latest score vs. history

The score on a row — and in the web CSV's summary columns — is the
**latest submission's** (or a teacher override); in the CLI CSV the latest is
simply the first line per member. "Latest" follows the
*submission*, not the commit: if a student deliberately submits an older
commit (a milestone tag pointing at earlier work, or a regrade), that
submission's Release becomes the latest. The badge and the gradebook always
agree because they use the same rule.

The full history is kept everywhere:

- **Web** — click a row's submission count to open its details: every attempt,
  newest first, each with its commit link and a per-attempt **View grade**
  Release link.
- **Student repo** — one immutable Release per attempt, under the repo's
  Releases tab (each `submit/*` tag is one graded attempt).
- **`scores.json`** — each entry's `submissions` array holds every collected
  attempt, newest first.
- **`gh teacher download`** — writes each repo's `results.json` (all attempts)
  next to `result.json` (latest), and one CSV line per attempt (see below).

### Grading a specific commit

Students sometimes ask you to grade a particular commit, not their latest:

- **Every attempt already has its own frozen result** — find that commit's
  `submit/*` Release in the history; its score and per-test table are exactly
  as graded.
- **To grade an arbitrary commit**, have the student push a `submit/*` tag (or
  a configured milestone tag) pointing at it: `git tag submit/regrade-me
  <sha> && git push origin submit/regrade-me`. That mints a normal graded
  submission at that commit.
- **Regrade** (per-row, or **Regrade all** in the Actions menu) re-runs each
  repo's **latest** submission **at its original commit** — useful after
  fixing a broken test. A never-graded repo is first-graded at its current
  HEAD instead (a new submission). On a re-run, `datetime` (the submission
  instant) stays fixed so late-marking never changes; `graded_at` records the
  re-run.

### Who submitted

- `owner` — the repo owner (the `<username>` in the repo name); the identity
  scores are keyed by.
- `submitted_by` — the GitHub account that actually pushed that submission.
  For group work this is how you see who did the pushing even though the score
  is shared.
- Group scores are credited to every teammate on the classroom team, recorded
  as the entry's `member_usernames` — see
  [Group attribution model](#group-attribution-model).

### Group attribution model

A group assignment is graded once, in the founder's repo. `collect-scores`
credits the shared score to every collaborator **on the classroom team** (the
owner is always included), recorded as the entry's `member_usernames`.

- **Crediting is by team membership, not permission level.** A teammate is
  credited whether they hold `push` or `admin`. Teachers and TAs are excluded
  automatically because they aren't on the student team.
- **Classmates on the team are mutually trusted.** Collection can't tell how a
  collaborator was added, so a student could credit a teammate who's on the team.
  The team intersection bounds this to classmates — an account off the team is
  never credited. Review each group repo's collaborators if you need stricter
  control.
- **Owner-only submissions warn.** If a group submission resolves to just the
  owner, collection emits a `::warning::` so the "team submission scored as solo"
  case is visible.
- **`submitted_by` records the pusher**, so you can see who did the work even
  though the score is shared.
- **Rows are keyed by the repo owner**, so re-collecting a group repo whose
  members changed updates the same row in place.

### Score exports

Two CSV exports cover most gradebook needs; the raw JSON is always there for
anything custom.

#### Web: Download scores (CSV)

**Download scores (CSV)** on the submissions page saves
`<classroom>-<assignment>-scores.csv` — **one row per student (or group)**,
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

`gh teacher download <org> <classroom> <assignment>` clones every student
repo and writes a `scores.csv` at the destination root — **one line per
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
(and in the per-repo `result.json` / `results.json` files the download also
refreshes).

#### Raw JSON

- `<classroom>/scores.json` in your config repo is the authoritative gradebook
  (see [scores.json shape](#the-resultjson-contract) below) — build any custom
  report from it.
- `gh teacher download` leaves `result.json` (latest attempt) and
  `results.json` (all attempts, newest first) in each cloned repo, including
  the per-test arrays.

## The `result.json` contract

This is the **only** contract every autograder must satisfy — whatever produces
it (pytest, check50, a shell script, a Rust binary) is up to you. The runner
reads `result.json` from the workspace after the autograder exits.

```json
{
  "schema":          "classroom50/result/v1",
  "classroom":       "cs-principles",
  "assignment":      "hello",
  "assignment_type": "individual",
  "owner":           "alice",
  "submission":      "submit/2026-06-01T14-32-05Z-a1b2c3d",
  "commit":          "https://github.com/.../commit/<sha>",
  "release":         "https://github.com/.../releases/tag/submit%2F...",
  "review":          "https://github.com/.../compare/<baseline-sha>...<sha>",
  "datetime":        "2026-06-01T14:32:01Z",
  "graded_at":       "2026-06-01T14:33:11Z",
  "score":           4,
  "max-score":       5,
  "tests": [
    { "test-name": "compiles",        "passed": true,  "score": 4, "max-score": 4 },
    { "test-name": "outputs_correct", "passed": false, "score": 0, "max-score": 1 }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `schema` | string | Exactly `classroom50/result/v1`. |
| `classroom` / `assignment` | string | Must match the source repo's identity (checked in code alongside `owner`). |
| `assignment_type` | string | `individual` or `group`, stamped by the runner. |
| `owner` | string | The repo owner login — the identity anchor. |
| `submission` | string | The submit-tag name. |
| `commit` / `release` / `review` | string | URLs. `review` is the full diff from starter code to the graded commit. |
| `datetime` | string | The **submission instant**: the graded commit's committer date (UTC ISO 8601). Invariant across regrades, so late-marking never changes on a re-run. |
| `graded_at` | string | Optional. When this grading run produced the result — moves on every regrade. |
| `score` / `max-score` | int | Sum of test scores / max-scores. |
| `tests` | array | Per-test breakdown (`[]` is valid for a vacuous pass). Extra diagnostic fields on a test are preserved verbatim. |
| `submitted_by` | object | Optional. Who pushed: `username`, and `id` (which may be null or absent). |

`collect-scores` validates this before merging into `scores.json`. A payload
whose identity (classroom/assignment/`owner`) doesn't match the source repo is
rejected, and a mismatched `assignment_type` is warned-and-skipped, so a hostile
payload can't land in another student's gradebook.

<details>
<summary>scores.json shape</summary>

The gradebook is keyed by assignment slug under a root `assignments` object;
each value is `{ "type": "individual"|"group", "entries": [...] }`. An `entry` is
one repo's record: `owner` (the stable key), `submissions` (full history, newest
first), and — for a group — `member_usernames` (credited members). Each bucket
also carries a `collected_at` UTC timestamp stamped whenever a collection run
walks that assignment (even if nothing changed), so per-assignment freshness is
knowable — the web app's "Submission data synced" strip reads it.

</details>

## Feedback pull requests

The Feedback PR is **on by default** for assignments created with `gh teacher
assignment add` (`--feedback-pr=false` to disable). When on, there is
**one long-lived "Feedback" pull request per student repo** so you review
cumulative work with inline comments alongside the scored Release.

- **Base = a frozen branch.** Accept creates a `feedback` branch at the
  student's baseline commit (the accept commit) and never advances it. The PR is
  `base = feedback`, `head = default branch`, so it always shows the full
  starter→latest diff.
- **Opens at accept**, so it is there before the first submission and exists even
  when GitHub Actions is disabled for student repos. The diff still starts at the
  baseline, so the setup files never appear in it.
- **One PR, reused** across submissions, labeled **Individual Assignment** or
  **Group Assignment**. A student closing it reopens it; a teacher merge is left
  alone.
- **The body** is Classroom 50's built-in "here is where your teacher leaves
  feedback" text by default. Set `feedback_pr_template: true` (or check the box
  on the web form) to use the template repository's own pull request template as
  the body instead. Accept reads the first existing of
  `.github/pull_request_template.md`, `pull_request_template.md`, or
  `docs/pull_request_template.md` from the template and uses it verbatim. It
  requires a template and the Feedback PR itself. The read is best-effort: a
  missing, empty, oversized, or unreadable file falls back to the built-in body
  and never blocks the PR. Keeping the template's contents correct is up to you.
- **The runner adopts it** by base+head and maintains it from then on. If accept
  could not open it (a permissions oddity, or a repo accepted before this
  feature), the runner opens it on the first submission instead, and
  re-accepting also retries, which is the only route with Actions off. On that
  fallback open the runner honors the template too, best-effort: its Actions
  token cannot always read a private or external template, so it uses the
  built-in body and logs a warning when it has to.

<details>
<summary>Baseline resolution and prerequisites</summary>

Both accept and the runner resolve the baseline as **the commit that introduced
`.classroom50.yaml`** (a structural marker, not a commit subject) so they agree
on where the base is frozen. The runner refuses to open or update the PR when
the `feedback` branch sits at any other commit, since a student can create that
branch themselves; an org admin deleting it lets the next submission re-freeze
it correctly. If no marker commit is found, the runner opens the PR against the
root commit and **warns** that the baseline is untrusted; if no baseline resolves
at all, it **skips** with a warning.

**Prerequisites (handled by `gh teacher init`):** the org setting "Allow GitHub
Actions to create and approve pull requests" must be on, and two org rulesets
protect submission history and the frozen `feedback` branch. If you enable
feedback on an org set up before this feature, **re-run `gh teacher init`**.

**Student repos accepted before this feature** use an older workflow and must
be re-created (delete + re-accept) to pick up the new one.

</details>

## Restricting submission files (`allowed_files`)

An assignment can declare `allowed_files` — an ordered list of `.gitignore`-style
patterns defining which files belong to the submission. It's an allowlist in
gitignore syntax: `*` ignores everything, then `!hello.py` re-includes it.

```sh
gh teacher assignment add cs50-fall-2026 cs-principles hello \
    --name "Hello" --template cs50/hello-template \
    --allowed-files '*' --allowed-files '!hello.py'
```

- **Git's own syntax:** order matters, last match wins, `!` re-includes. Pass
  `--allowed-files` once per pattern (don't comma-join). Omit it (or pass empty)
  to allow every file.
- **Re-running `add` rewrites the whole entry**, so re-pass `--allowed-files` to
  keep it (the CLI warns when it's dropped).

> [!WARNING]
> **`allowed_files` gates what the autograder reads.** Files are removed before
> setup and grading, so every student-checkout file they read must be
> allowlisted. This includes dependency manifests (`requirements.txt`,
> `pyproject.toml`), package source, setup scripts, and starter scaffolding.
> Control files (`.classroom50.yaml`, `.github/`) are always kept.
>
> **It fails open** and is a grading-scope/hygiene tool, **not** a security
> boundary: a student who forces a git failure (or just `git push`es) gets the
> unfiltered tree graded. Never use it to hide an answer key. Removals are logged
> in the release body ("Removed N file(s)").

## Attaching files to submission Releases

Attach generated PDFs, plots, or logs to each submission's Release via the web
form's **Submission release files**, or the `release_assets` field:

```json
"release_assets": ["report.pdf", "plots/chart.png"]
```

The runner resolves these paths **after grading** (so an autograder can generate
them) and uploads them under their basenames.

**Limits:** at most 50 paths totaling ≤ 8 KiB; each basename must be unique,
Release-safe (ASCII letters/digits/`.`/`_`/`-`, no leading/trailing dot, no `..`,
not `result.json` or `release-body.md`), and relative. A separate 100 MiB
file-content budget applies at runtime. Missing, unsafe, oversized, or failed
uploads warn without changing the score.

> [!NOTE]
> Submission publishing doesn't support GitHub Immutable Releases (reruns edit
> the Release in place). To roll this out to an existing org, run `gh teacher
> init`, approve the workflow-files refresh, and wait for `publish-pages` to
> finish.

## Where to customize

| To change… | Edit… | Propagates on… |
|---|---|---|
| Simple checks, no code | `tests` block (`assignment test add` / `--tests`) | Next Pages publish, then next submission |
| Grading logic for one assignment | `<classroom>/autograders/<slug>/autograder.py` | Next submission |
| Grading logic for a classroom | `<classroom>/autograder.py` (`autograder set-default`) | Next submission |
| Runtime for one assignment | `runtime` block on the entry | Next submission |
| Files attached to Releases | `release_assets` (usually via the web form) | Next submission or regrade |

All layers live in the config repo; none require a student-repo change. Edit
`autograde-runner.yaml` only to add a toolchain GitHub has no setup action for,
or to replace the runner bootstrap.

## Failure paths

Classroom 50 separates an ordinary pass/fail score from an infrastructure error.
Passing and failing scores publish the Release; an `error` posts an error status
and leaves the Release unchanged.

| What failed | What surfaces |
|---|---|
| Invalid hand-edited `release_assets` config | Setup exits with a field-specific `::error::`; no Release update |
| Autograder produces `status=error` | Grade posts `error`; no Release update |
| A configured extra is missing/unsafe/over budget | Warning; core and other extras continue |
| Core Release or `result.json` upload fails | Grade job fails; latest pointer doesn't move |
| Some tests fail | `status=failure`; Release publishes; details in the log and Summary |
| All tests pass | `status=success`; Release publishes |

A failure that stops the reusable workflow from loading doesn't appear in
`scores.json`; collect counts the student as not-yet-submitted.

## No credentials required

Students never configure tokens or secrets. Grading runs on the job-scoped
`GITHUB_TOKEN`, unauthenticated Pages fetches, and reusable-workflow access
between the student repo and the config repo (both in the teacher's org,
configured by `init`). The only PAT in the system is the teacher-side
`CLASSROOM50_SERVICE_TOKEN`, used only by `collect-scores.yaml`.

## Operational notes

- **The grade job stops after 15 minutes.** This includes managed runtime setup,
  the assignment Setup command, every test, and submission Release publishing.
  Per-command timeouts do not extend the job limit.
- **Every push grades, every push gets a Release** (in `every-push` mode). Five
  pushes in ten minutes produce five graded runs and five Releases.
- **Immutable-release rulesets freeze regrade Releases.** Orgs enforcing
  immutable releases (a GitHub ruleset) cannot refresh a submission's Release
  on regrade; the regraded score appears in the commit status and the Actions
  job summary, but the Release — and thus the collected gradebook score for
  that submission — keeps the pre-regrade result.
- **Pages CDN lag:** updated content can take ~10 minutes to serve, so a
  submission in that window may fetch the previous `runner.py` or bundle.
- **Don't force-push or delete submit tags** — collection keys on them.

## Custom runner workflow (rare)

Every earlier layer changes *what* grading does while keeping the built-in
runner. When you need a different grading *pipeline* entirely — a
[reusable workflow](https://docs.github.com/actions/using-workflows/reusing-workflows)
you author yourself — `--autograder <name>` swaps the caller workflow instead of
the autograder script. Most teachers never need this.

**How the swap works.** By default `gh student accept` writes a small caller
workflow to `.github/workflows/autograde.yaml` whose `uses:` points at the
built-in `autograde-runner.yaml`. With `--autograder <name>`, accept instead
fetches your caller from `<classroom>/autograders/<name>.yaml` and writes it
verbatim. Your caller owns its own `on:` triggers and `uses:` a reusable
workflow you control, so your grading logic runs in place of the runner.

**Set one up:**

1. **Add the reusable workflow** to your config repo under `.github/workflows/`,
   with a name other than the reserved `autograde-runner.yaml`. It must be
   [callable](https://docs.github.com/actions/using-workflows/reusing-workflows#creating-a-reusable-workflow)
   (`on: workflow_call`). Non-reserved names are never touched by Classroom 50.
2. **Add a caller workflow** at `<classroom>/autograders/<name>.yaml`. Give it
   your trigger events and a `jobs.<id>.uses:` pointing at the workflow from
   step 1. Because it's written verbatim, template `<org>`/branch refs to your
   own values rather than relying on the built-in caller's substitution.
3. **Register the assignment** with `gh teacher assignment add <org> <classroom>
   <slug> --autograder <name>`.

> [!NOTE]
> Once an assignment uses a custom autograder, `gh teacher assignment
> submission-mode` never rewrites its caller workflow — trigger changes are
> yours to make.

### Bringing a GitHub Classroom autograder along

This is the intended path for keeping an `autograding.json`-driven workflow after
[migrating](FAQ#migrating-from-github-classroom). Classroom 50 has no
`.github/classroom/autograding.json` of its own — the built-in runner reads a
[`tests` block](#declarative-tests) instead — but a custom runner workflow lets
you keep your existing format:

1. Put your grading action's workflow in the config repo's `.github/workflows/`
   (any non-reserved name). Have it read `autograding.json` from the student
   repo as before.
2. Point a caller workflow at it as above, and register assignments with
   `--autograder <name>`.
3. Ship `autograding.json` (and any fixtures) in the **assignment template**, not
   the config repo — it travels with each student's starter code.

> [!WARNING]
> The template must **not** contain `.github/workflows/autograde.yaml`; that
> name is reserved for the autograding caller and would be clobbered on accept
> and submit (see [Assignment Templates](Assignment-Templates#structure)). Use
> any other filename for template-side workflows.
