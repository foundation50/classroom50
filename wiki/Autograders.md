# Autograders

How Classroom 50 grades submissions, and how to customize grading.

## How grading works

Every push to a student's default branch triggers a small shim at
`.github/workflows/autograde.yaml`, which calls the reusable **autograde-runner**
workflow in `<org>/classroom50`. On each submission the runner:

1. Creates (or reuses) the `submit/<UTC-timestamp>-<short-sha>` tag.
2. Fetches `runner.py` and the assignment's autograder from Pages.
3. Runs the autograder against the graded commit.
4. Publishes a GitHub Release with the score, and maintains the Feedback PR.

Later, `collect-scores.yaml` aggregates each Release's `result.json` into
`<classroom>/scores.json`.

Everything substantive (the runner workflow, `runner.py`, autograders, runtime
config) lives in the config repo and is fetched at run time, so teacher edits
reach every existing student repo on the next submission with no per-repo
maintenance.

> [!NOTE]
> Grading and publishing share one job and runner, so the workflow is **not** a
> credential or hostile-workflow isolation boundary between them.

## Which commits grade

The shim triggers on two events:

- **Push to the default branch** — every commit grades, **except the acceptance
  commit** (the one that introduced `.classroom50.yaml`, with nothing on top).
- **Push of a `submit/*` tag** — manual tag pushes work too.

<details>
<summary>Why the acceptance commit is skipped</summary>

Accepting lands `.classroom50.yaml` + the shim in one commit, which fires the
workflow — but that's *accepting*, not *submitting*. The runner detects it and
skips tagging, grading, and the Release (the run still appears in the Actions
tab with a `notice`). Detection is **fail-open**: any uncertainty grades rather
than risk dropping a real submission. Your first `gh student submit` always
stacks a fresh commit, so it's never mistaken for the acceptance.

</details>

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
  "datetime":        "2026-06-01T14:33:11Z",
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
| `datetime` | string | UTC ISO 8601. |
| `score` / `max-score` | int | Sum of test scores / max-scores. |
| `tests` | array | Per-test breakdown (`[]` is valid for a vacuous pass). |
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
first), and — for a group — `member_usernames` (credited members).

</details>

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
  though the grade is shared.
- **Rows are keyed by the repo owner**, so re-collecting a group repo whose
  members changed updates the same row in place.

## Declarative tests

The lowest-friction way to grade: describe io/run/pytest checks directly on the
assignment, and the runner grades them with a built-in interpreter — no grading
code to write. The three types map onto GitHub Classroom's legacy autograder
presets.

Author tests one at a time:

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

### Test types

| Type | Passes when | Type-specific fields |
|---|---|---|
| `io` | stdout of `run` matches `expected` per `comparison` | `input` / `input-file`, `expected` / `expected-file`, `comparison` |
| `run` | exit code of `run` equals `exit-code` (default 0) | `exit-code` |
| `python` | pytest passes; points split across cases | — |

> [!NOTE]
> The runner auto-installs `pytest` and `pytest-json-report` for `python` tests.
> Add a `setup` install line only to pin a version.

### Fields

| Field | Notes |
|---|---|
| `name` | Required. Unique within the assignment; ≤ 100 UTF-8 bytes; no control characters. |
| `type` | Required. `io`, `run`, or `python`. |
| `run` | Required. Shell command, run in the student checkout. |
| `setup` | Optional pre-command (e.g. compile). Non-zero exit fails the test. |
| `input` / `input-file` | `io` only, mutually exclusive. Inline stdin or a bundled fixture. |
| `expected` / `expected-file` | `io` only, mutually exclusive. Must be non-empty for `included`/`regex`. |
| `comparison` | `io` only. `included` (substring), `exact` (trimmed equality), or `regex` (Python `re.search`, multiline). |
| `timeout` | Seconds, 1–600. Omit or 0 for the default of 10s. Applies to `setup` and `run` separately. |
| `exit-code` | `run` only, 0–255. Omit to require 0. |
| `points` | Required, 0–1000. 0-point tests are informational. |

At most 100 tests per assignment. Put large fixtures in files
(`input-file` / `expected-file`) under `<classroom>/autograders/<slug>/`, not
inline.

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

### Precedence

`runner.py` resolves the grading entrypoint in this order:

1. Per-assignment `<classroom>/autograders/<slug>/autograder.py` (an override
   always wins).
2. Per-assignment `tests.json` (declarative tests).
3. Classroom default `<classroom>/autograder.py`.
4. None of the above → vacuous pass.

To keep precedence from silently swallowing tests, the CLI refuses `assignment
test add` / `--tests` while a per-assignment `autograder.py` exists.

<details>
<summary>Writing a valid assignments.json from another client (e.g. a GUI)</summary>

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

## Writing an `autograder.py`

The autograder is a Python script the runner invokes once per submission. There
are two scopes:

| Path | Scope | Used when |
|---|---|---|
| `<classroom>/autograders/<slug>/autograder.py` | One assignment | Present in the bundle. |
| `<classroom>/autograders/<slug>/tests.json` | One assignment | [Declarative tests](#declarative-tests); no per-assignment `autograder.py`. |
| `<classroom>/autograder.py` | One classroom | Neither of the above exists. |

If none exist, the runner emits a vacuous pass (score 0/0) and the submission
still lands as a tagged Release — a valid mid-setup state.

### Contract

The runner provides:

- **Environment variables:** `CLASSROOM`, `ASSIGNMENT`, `SUBMISSION_TAG`,
  `PAGES_BASE_URL`, `USERNAME`/`OWNER`, `ASSIGNMENT_TYPE`, `COMMIT_URL`,
  `RELEASE_URL`, `REVIEW_URL`, and all standard `GITHUB_*`.
- **Working directory:** the student's checkout (relative paths resolve to
  student code).
- **Sibling files:** anything else under `<classroom>/autograders/<slug>/` is
  bundled and lives at `Path(__file__).parent`.

The autograder must produce **`./result.json`** (required). Optionally
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

### Classroom default

`gh teacher autograder set-default <org> <classroom> --from <path>` installs a
default that grades every assignment without its own autograder or tests. With no
`--from`, it installs a diagnostic stub (echoes the environment, emits a vacuous
pass) — useful for verifying the pipeline. Inspect it with `autograder show`, and
delete it outright with `autograder remove`.

## The `runtime` block

Per-assignment environment (runner OS, language toolchains, packages, container
image) lives as an optional `runtime` field on each `assignments.json` entry. The
runner reads it on every submission, so changes propagate with no student-repo
edit. Pass a JSON file to `gh teacher assignment add --runtime`:

```json
{
  "runs-on": "ubuntu-latest",
  "python":  "3.12",
  "node":    "20",
  "java":    "21",
  "go":      "1.23",
  "apt":     ["build-essential", "valgrind"]
}
```

When omitted, the default is `ubuntu-latest` + Python 3.12. Inside a `container`,
the image owns the toolchain unless you set `python` explicitly.

| Field | Notes |
|---|---|
| `runs-on` | A single runner label (`"ubuntu-latest"`) or an array (`["self-hosted", "gpu"]`). No allow-list — you own the label; each is anti-injection-checked (1–10 labels). |
| `python` / `node` / `java` / `go` | Version passed to the matching `setup-*` action. Skipped when unset (`python` defaults to 3.12 on the host path). |
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

## Feedback pull requests

The Feedback PR is **on by default** for assignments created with `gh teacher
assignment add` (`--feedback-pr=false` to disable). When on, the runner maintains
**one long-lived "Feedback" pull request per student repo** so you review
cumulative work with inline comments alongside the scored Release.

- **Base = a frozen branch.** On the first submission with a diff, the runner
  creates a `feedback` branch at the student's baseline commit (the accept
  commit) and never advances it. The PR is `base = feedback`, `head = default
  branch`, so it always shows the full starter→latest diff.
- **One PR, reused** across submissions, labeled **Individual Assignment** or
  **Group Assignment**. A student closing it reopens it; a teacher merge is left
  alone.
- **Opens on first work, not at accept** — unlike GitHub Classroom, so the diff
  never includes the setup files.

<details>
<summary>Baseline resolution and prerequisites</summary>

The runner resolves the baseline as **the commit that introduced
`.classroom50.yaml`** (a structural marker, not a commit subject). If no such
commit is found, it opens the PR against the root commit and **warns** that the
baseline is untrusted; if no baseline resolves at all, it **skips** with a
warning.

**Prerequisites (handled by `gh teacher init`):** the org setting "Allow GitHub
Actions to create and approve pull requests" must be on, and two org rulesets
protect submission history and the frozen `feedback` branch. If you enable
feedback on an org set up before this feature, **re-run `gh teacher init`**.

**Student repos accepted before this feature** use an older shim and must be
re-created (delete + re-accept) to pick up the new one.

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
> **`allowed_files` gates what the autograder *reads*.** Files are removed
> *before* grading, so any file the grader needs — starter scaffolding, helpers,
> fixtures — must be allowlisted too, or grading fails with a confusing "file not
> found". Control files (`.classroom50.yaml`, `.github/`) are always kept.
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
uploads warn without changing the grade.

> [!NOTE]
> Submission publishing doesn't support GitHub Immutable Releases (reruns edit
> the Release in place). To roll this out to an existing org, run `gh teacher
> init`, approve the skeleton refresh, and wait for `publish-pages` to finish.

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

Classroom 50 separates an ordinary pass/fail grade from an infrastructure error.
Passing and failing grades publish the Release; an `error` posts an error status
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

- **Every push grades, every push gets a Release.** Five pushes in ten minutes
  produce five graded runs and five Releases.
- **"Latest" follows commit time** — the pointer moves only when the new
  submission's commit is newer than the current latest.
- **Pages CDN lag:** updated content can take ~10 minutes to serve, so a
  submission in that window may fetch the previous `runner.py` or bundle.
- **Don't force-push or delete submit tags** — collection keys on them.

## Custom runner workflow (rare)

The `--autograder <name>` flag calls a different *reusable
workflow*, not just a different `autograder.py`. Drop a shim at
`<classroom>/autograders/<name>.yaml` (its `uses:` points at your workflow) and
register it with `gh teacher assignment add ... --autograder <name>`. Most
teachers never need this.
