# Autograders

How Classroom 50 grades student submissions, and how teachers customize.

## Architecture in one paragraph

Every push to a student's `main` branch triggers the small shim at `.github/workflows/autograde.yaml`, which calls the reusable **autograde-runner** in `<org>/classroom50`. The `setup` job detects acceptance commits, creates or reuses the submit tag, validates assignment/runtime configuration, and passes configured release-file paths to `grade`. The `grade` job checks out the graded commit, runs the Pages-fetched `runner.py` and configured autograder, and then copies accepted extra files into a fresh directory under runner temp. The same job posts the commit status, publishes the core Release output before the extras, and maintains the Feedback PR. Extra collection or upload failures warn without changing the grade or suppressing core publication. The serialized `set-latest` job advances the latest pointer only after core Release publication. Grading and publishing share a job and runner, so the workflow does not provide a credential or hostile-workflow isolation boundary between them. `collect-scores.yaml` later aggregates each Release's `result.json` into `<classroom>/scores.json`.

Everything substantive (runner workflow, `runner.py`, classroom-default and per-assignment `autograder.py`, runtime configuration, per-assignment bundle) lives in the config repo and is fetched at workflow runtime, so teacher edits propagate to every existing student repo on the next submission with zero per-student-repo maintenance.

## Submission triggers

The shim listens on two events:

- **`push` to `main`** — every commit grades, **except the acceptance commit**. The runner creates the `submit/<UTC-timestamp>-<short-sha>` tag at the pushed SHA. This is what `gh student submit` and a plain `git push origin main` both end up using.
- **`push` of a `submit/*` tag** — manual or web-UI tag pushes work too. The runner detects the tag-trigger and reuses `github.ref_name` instead of creating a new tag.

Tags pushed by the runner with the workflow's `GITHUB_TOKEN` don't fire workflows (GitHub's anti-recursion rule), so the auto-tag step never causes a second run.

### The acceptance commit is not graded

Accepting an assignment lands `.classroom50.yaml` + the autograde shim in one student-authored commit, which fires this workflow — but that commit is the student *accepting*, not *submitting*, so there's nothing to grade. The `setup` job detects it (the pushed commit is the commit that introduced `.classroom50.yaml`, with nothing stacked on top) and **skips tagging, grading, and the release** — no `submit/*` tag, no `0/0` "acceptance" release. The run still appears in the Actions tab with a `notice` explaining there's nothing to grade yet.

Detection reuses the same accept-commit contract as the Feedback PR baseline (the structural `.classroom50.yaml` marker, not a commit subject — see ["How the baseline is identified"](#feedback-pull-requests)), and is **fail-open**: any uncertainty (shallow clone that can't deepen, unreadable git history, a Pages fetch failure) grades rather than risk dropping a real submission. The first `gh student submit` always stacks a fresh commit on top (it commits with `--allow-empty`), so it is never mistaken for the acceptance and always grades. Templates whose default branch isn't `main` don't fire the workflow at accept time at all; their first graded run is the first `gh student submit` to `main`, which is correctly a submission.

## The `result.json` contract

This is the **only** contract every autograder must satisfy. Whatever produces it — pytest, check50, JUnit, a shell script, a Rust binary — is up to the teacher. The runner reads `result.json` from the workflow workspace after the autograder exits.

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
    { "test-name": "compiles",       "passed": true,  "score": 4, "max-score": 4 },
    { "test-name": "outputs_correct","passed": false, "score": 0, "max-score": 1 }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `schema` | string | Must be `classroom50/result/v1` exactly |
| `classroom` | string | Must match `<classroom>` in the repo name |
| `assignment` | string | Must match `<assignment>` in the repo name |
| `assignment_type` | string | `"individual"` or `"group"`, stamped by the runner from the assignment mode. `collect-scores` cross-checks it against `assignments.json` `mode` and warns-and-skips a mismatched submission |
| `owner` | string | The repo owner login (the `<username>` from `<classroom>-<assignment>-<username>`). The **identity anchor** the validators check; for an individual assignment it is the sole credited student, for a group it is the founder whose repo was graded. There is no `usernames` field — who pushed is `submitted_by`, who is credited (group) is resolved by collection |
| `submission` | string | The submit-tag name |
| `commit` | string | URL to the submission commit |
| `release` | string | URL to the release |
| `review` | string | URL teachers click to review — the full diff from the starter code to the graded commit (compare view); falls back to the commit view when repo history is unavailable or there is nothing to compare (baseline == graded commit) |
| `datetime` | string | UTC ISO 8601 (`YYYY-MM-DDTHH:MM:SSZ`) |
| `score` | int | Sum of test scores (0 ≤ score ≤ max-score) |
| `max-score` | int | Sum of test max-scores |
| `tests` | `[object]` | Per-test breakdown (optional content — `[]` is valid for the "vacuous pass / no tests configured" case) |
| `submitted_by` | object | Optional. The GitHub actor who pushed this submission: `{"username": <login>, "id": <numeric id\|null>}`, stamped by the runner from `GITHUB_ACTOR`/`GITHUB_ACTOR_ID`. For a **group** submission the score is credited to every member (collection resolves the member list), but `submitted_by` records *who actually pushed* this submission — so teachers can see who did the work even though the grade is shared. Absent on results produced before this field existed |

`collect-scores.yaml` validates this payload before merging into `scores.json`. Mismatches against the source repo's identity (classroom/assignment/`owner` triple) are rejected with a warning, and a submission whose `assignment_type` disagrees with the assignment's configured `mode` is warned-and-skipped. The `owner` must equal the repo-name-derived owner in both modes.

**scores.json shape.** The gradebook is keyed by assignment slug under a root `assignments` object; each value is `{ "type": "individual"|"group", "entries": [...] }`. An `entry` is one repo's record: `owner` (the stable key), `submissions` (the full history, newest first — each a stored result/v1 payload), and — for a **group** entry — `member_usernames` (the credited members). An individual entry has no member list; its `owner` is the sole credited student.

**Group attribution model.** For a group assignment, `collect-scores` credits the shared score to every collaborator on the repo who is **on the classroom team** (the repo owner is always included), recorded as the entry's `member_usernames`. Crediting is gated on **team membership, not on collaborator permission level** — a teammate is credited whether they hold `push` or `admin`. A few consequences worth knowing:

- **Classmates on the team are mutually trusted.** GitHub does not record *how* a collaborator was added, so collection cannot distinguish a teammate the founder added via `gh student invite` from one a student added directly through the GitHub UI. A student could therefore add a teammate who is on the classroom team as a collaborator and credit them this assignment's score. The team intersection bounds this to classmates on the team — an account off the team can never be credited — and this "students in a classroom are mutually trusted" model is intentional. If you need stricter control, review the collaborator list on each group repo.
- **Permission level does not gate crediting.** Crediting is decided by classroom-team membership, not by whether a collaborator is `push` or `admin`. This matters because a teammate who is *also an org owner* is `admin` on every repo, and the founder is kept `admin` so they can invite teammates — an earlier version excluded all admins and silently credited only the repo owner. Teachers/TAs are excluded automatically because they are **not on the student team**, so dropping the admin filter loses no protection. (Permission level is still used by `gh student invite` when *counting* members against `max_group_size` — but that is an advisory limit, separate from crediting.)
- **If only the owner is credited, collection warns.** When a group submission resolves to the owner alone (no other teammate on the team found), `collect-scores` emits a `::warning::` pointing you to check that each teammate is both on the classroom team and a collaborator on the repo — so the silent "team submission scored as solo" case is visible.
- **`submitted_by` records the pusher.** Each submission carries who pushed it (see the `submitted_by` field above), so even though the grade is shared across the team you can see who submitted each push.
- **Rows are keyed by the repo owner.** In `scores.json` each row carries an `owner` field (the repo owner login) and the bucket is keyed on it, so re-collecting a group repo whose member set changed (e.g. a teammate joined, or a transient read degraded attribution to owner-only) **updates the same row in place** rather than leaving a stale duplicate.

## Declarative tests (no `autograder.py`)

The lowest-friction way to grade: describe input/output, run-command, and pytest checks directly on the assignment's entry in `assignments.json`, and the runner grades them with a built-in interpreter — no grading code to write. The three test types map one-to-one onto GitHub Classroom's legacy autograder presets, so migrating classrooms can keep their existing tests.

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

Or set the whole array at once with `gh teacher assignment add ... --tests <file.json>` (`--tests -` reads stdin). The file is a bare JSON array of test specs — the same shape `assignment test list --json` emits:

```json
[
  { "name": "compiles", "type": "run", "run": "gcc -o hello hello.c", "timeout": 30, "points": 1 },
  { "name": "prints Hello, world!", "type": "io", "setup": "gcc -o hello hello.c",
    "run": "./hello", "expected": "Hello, world!", "comparison": "included", "points": 2 },
  { "name": "greets by name", "type": "io", "setup": "gcc -o hello hello.c",
    "run": "./hello", "input": "Alice\n", "expected": "^hello,\\s+Alice\\b",
    "comparison": "regex", "points": 2 },
  { "name": "pytest suite", "type": "python",
    "run": "python -m pytest -q", "timeout": 120, "points": 10 }
]
```

> The runner auto-installs `pytest` and `pytest-json-report` for `python` tests, so no `setup` install line is needed. Add one (e.g. `"setup": "pip install --quiet pytest==8.* pytest-json-report"`) only to pin a version — the runner leaves an already-importable version untouched.

### How it flows

The tests live inline on the assignment's entry in `assignments.json`. On the next config-repo push, the publish-pages workflow **materializes** them into `<classroom>/autograders/<slug>/tests.json` and tars that into the per-assignment Pages bundle, alongside any fixture files in the same directory. At grade time, `runner.py` runs each spec in the student checkout: one row per test in `result.json`, plus a pass/fail breakdown in the release body with a truncated expected-vs-actual diff for each failure.

Test commands are teacher-authored shell, executed at the same privilege as a hand-written `autograder.py` — inside the sandboxed grade job, fetched as data from Pages, never interpolated into workflow YAML. Students can't edit `assignments.json`; it lives in your config repo.

### Test types

| Type | Pass criterion | Type-specific fields |
|---|---|---|
| `io` | stdout of `run` matches `expected` per `comparison` | `input` / `input-file`, `expected` / `expected-file`, `comparison` |
| `run` | exit code of `run` equals `exit-code` (default 0) | `exit-code` |
| `python` | pytest passes; points split across cases as `points × passed/total`. The runner auto-installs `pytest` + `pytest-json-report`; if a report still can't be produced (e.g. an offline runner), it falls back to all-or-nothing on the exit code | — |

### Fields

| Field | Type | Notes |
|---|---|---|
| `name` | string | Required. Unique within the assignment (it's the test's identity in `result.json`), ≤ 100 bytes (UTF-8), no control characters. |
| `type` | string | Required. `io`, `run`, or `python`. |
| `run` | string | Required. Shell command, executed in the student checkout. |
| `setup` | string | Optional pre-command (e.g. compile). Non-zero exit fails the test with captured stderr. |
| `input` / `input-file` | string | `io` only, mutually exclusive. Inline stdin, or a fixture file bundled from `<classroom>/autograders/<slug>/`. |
| `expected` / `expected-file` | string | `io` only, mutually exclusive. Inline expected stdout, or a bundled fixture. Must be non-empty for `included`/`regex` — an empty expected would match everything. |
| `comparison` | string | `io` only. `included` (substring), `exact` (equal after trimming surrounding whitespace), or `regex` (Python `re.search` with `re.MULTILINE`, so `^`/`$` anchor at line boundaries and lookaround/backreferences work; a malformed pattern surfaces as a failing test, not a write error). |
| `timeout` | int | Seconds, 1–600. Omit (or 0) for the default of 10s. Applies to `setup` and `run` separately. |
| `exit-code` | int | `run` only, 0–255. Omit to require 0. |
| `points` | int | Required, 0–1000. 0-point tests are informational. |

At most 100 tests per assignment. Large fixtures belong in files (`input-file` / `expected-file`) committed under `<classroom>/autograders/<slug>/` rather than inline, so `assignments.json` stays well under the contents-API size ceiling.

### Precedence and the conflict rule

Entrypoint resolution order in `runner.py`:

1. Bundled per-assignment `autograder.py` — a hand-written override always wins (the escape hatch).
2. Bundled per-assignment `tests.json` — the declarative grader.
3. Classroom default `<classroom>/autograder.py`.
4. None of the above — vacuous pass.

Tests beat the classroom default (more specific intent); a per-assignment `autograder.py` beats tests. So that precedence never silently swallows anyone's tests, the CLI refuses `assignment test add` and `assignment add --tests` while `<classroom>/autograders/<slug>/autograder.py` exists. When declarative tests can't express what you need, remove them and graduate to an `autograder.py`.

### Validation

Specs are validated three times, mirroring the `runtime:` block's discipline. The CLI checks at write time (enums, bounds, name uniqueness, field applicability). The inline validator in `autograde-runner.yaml` re-checks at submission setup, so a hand-edited `assignments.json` fails with a clear `::error::` instead of mid-grade. And `runner.py` re-checks the materialized `tests.json` before executing, turning a malformed file into a `status=error` release rather than a crash.

### For other clients (GUI)

Anything that writes a valid `assignments.json` gets the whole pipeline for free — materialization and grading don't care who authored the file. A non-CLI client (e.g. the web UI) should:

1. Validate against [`schemas/assignments-v1.schema.json`](https://github.com/foundation50/classroom50/blob/main/schemas/assignments-v1.schema.json) before writing (a JSON Schema mirroring the CLI's validators; usable directly with `ajv`). Two rules it can't express: test names must be unique within an assignment, and name length is capped at 100 UTF-8 *bytes*.
2. Probe before writing tests, exactly like the CLI: `<classroom>/autograders/<slug>/autograder.py` must NOT exist (mutual exclusion), and `.github/scripts/materialize_tests.py` MUST exist (skeleton supports materialization).
3. Write via the git-data API against the current branch tip and retry on a non-fast-forward rejection — the read-modify-write loop in `cli/gh-teacher/tree_commit.go` is the reference implementation.

The CLI must stay interoperable with the file afterwards, and it parses strictly (unknown fields are rejected) — so only schema fields may be persisted. `examples/declarative-tests/tests.json` is a canonical fixture covering every test feature.

## Writing an `autograder.py`

The autograder is a Python script the runner invokes once per submission. There are two scopes:

| Path | Scope | Resolution |
|---|---|---|
| `<classroom>/autograders/<slug>/autograder.py` | One assignment | Used if present in the bundle |
| `<classroom>/autograders/<slug>/tests.json` | One assignment | [Declarative tests](#declarative-tests-no-autograderpy), materialized from `assignments.json`; used when no per-assignment `autograder.py` exists |
| `<classroom>/autograder.py` | One classroom | Falls back to this when the assignment has neither of the above |

If none exist, the runner synthesizes a vacuous-pass result (status=`success`, score 0/0, summary "submitted — no autograder configured for `<slug>`") and the submission still lands as a tagged release. "No autograder configured" is a valid mid-setup state — classrooms work end-to-end before any grading code is written.

Replace the classroom default to grade every assignment in the classroom with one script (e.g., a slug-driven dispatcher that calls a third-party grader like `check50`); add per-assignment overrides only where individual assignments diverge from the classroom default.

### Contract

The runner provides:

- **Environment variables**:
  - `CLASSROOM`, `ASSIGNMENT`, `SUBMISSION_TAG`, `PAGES_BASE_URL`
  - `USERNAME` / `OWNER` (the repo owner, derived from the repo name; identical value)
  - `ASSIGNMENT_TYPE` (`individual` or `group`)
  - `COMMIT_URL`, `RELEASE_URL`, `REVIEW_URL` (full diff from the starter code to the graded commit; equals `COMMIT_URL` when history is unavailable or there is nothing to compare)
  - All standard `GITHUB_*` (REPOSITORY, SHA, ACTOR, OUTPUT, etc.)
- **Working directory**: the student's repo checkout (relative paths resolve to student code).
- **Sibling files**: anything else under `<classroom>/autograders/<slug>/` is bundled with the autograder and lives at `Path(__file__).parent` after extraction. Use `Path(__file__).parent` to find fixtures, helpers, framework configs, etc.

The autograder must produce:

- **`./result.json`** — `classroom50/result/v1` payload (REQUIRED).
- **`./release-body.md`** — Markdown body for the GitHub Release (optional; the runner synthesizes one from `result.json` if absent).
- **`status=` and `summary=` lines in `$GITHUB_OUTPUT`** (optional; the runner derives them from `result.json` if absent — `success` when all tests pass or `tests` is empty, `failure` when any test failed).

Exit code:

- **0** — autograder ran end-to-end (test pass/fail captured in `result.json`).
- **non-zero** — infrastructure failure. The runner synthesizes a `status=error` result.

### Classroom default (diagnostic stub)

`gh teacher autograder set-default <org> <classroom>` (with no `--from`) drops a diagnostic stub at `<classroom>/autograder.py`. The stub echoes every env var to stdout, writes a vacuous-pass `result.json` (empty `tests` array → "submitted, no autograder configured"), and exits 0. This lets you verify the runner wires up correctly before writing real grading logic. Replace it via `set-default --from <path>` once you're ready to grade.

If you skip `set-default` entirely, the runner produces the same vacuous-pass result on its own — submissions still tag and publish releases, just with status=`success` 0/0. The stub is only useful if you want diagnostic stdout in the workflow log.

Inspect the current default with `gh teacher autograder show <org> <classroom>` (`--json` for metadata: whether it's the stub, its size, and git blob `sha`). To revert a classroom to "no autograder configured" outright, `gh teacher autograder remove <org> <classroom>` deletes the file (distinct from `set-default` with no `--from`, which overwrites it with the stub). Named shims and per-assignment overrides under `autograders/` are listed by `gh teacher autograder list` but authored via ordinary git operations.

### Template: pytest

Drop this at `<classroom>/autograders/<slug>/autograder.py` alongside your `test_*.py` files:

```python
"""Pytest-based autograder. Runs sibling test_*.py files against
the student's code, parses pytest's JSON report, emits result.json."""

import datetime, json, os, subprocess, sys
from pathlib import Path

HERE = Path(__file__).parent
REPORT = HERE / "pytest-report.json"

# Per-test weights. Anything not listed here gets DEFAULT_WEIGHT.
WEIGHTS = {}
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
    # owner + assignment_type are stamped authoritatively by the runner —
    # you may omit them (or set them from OWNER / ASSIGNMENT_TYPE env).
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

# Let the runner synthesize release-body.md and status/summary
# from result.json (which it does whenever they're absent).
```

Test files are still ordinary pytest — `test_*.py` next to `autograder.py`, optional `conftest.py` for fixtures.

### Template: minimal custom

Anything that produces `result.json` works. Compile-and-diff, image-similarity scoring, web-scraping the student's deployed app — write it however you like:

```python
import datetime, json, os, subprocess
from pathlib import Path

# Compile, run, compare output.
subprocess.run(["gcc", "-o", "hello", "hello.c"], check=True)
proc = subprocess.run(["./hello"], capture_output=True, text=True, check=False)
passed = proc.stdout.strip() == "Hello, world!"

result = {
    "schema":     "classroom50/result/v1",
    "classroom":  os.environ["CLASSROOM"],
    "assignment": os.environ["ASSIGNMENT"],
    # owner + assignment_type are stamped authoritatively by the runner —
    # you may omit them (or set them from OWNER / ASSIGNMENT_TYPE env).
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

## The `runtime` block in `assignments.json`

Per-assignment runtime customization (runner OS, language toolchains, system packages, container image) lives in `assignments.json` as an optional `runtime:` field on each entry. The autograde-runner workflow's setup job reads it on every submission, so changes propagate without any student-repo edit and without changing the workflow file.

Pass a JSON file to `gh teacher assignment add --runtime`:

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

```sh
gh teacher assignment add cs50-fall-2026 cs-principles greet \
    --name "Greet" --template cs50/greet-template \
    --runtime ./runtime-greet.json
```

When `runtime` is omitted, the workflow defaults to `ubuntu-latest` with Python 3.12 set up via `actions/setup-python` so most autograders work without any per-assignment runtime config. No other toolchains are set up and no apt install runs. Inside a custom `container`, the image owns the toolchain — `python` is left alone unless explicitly set.

### Fields

| Field | Type | Notes |
|---|---|---|
| `runs-on` | string \| `[string]` | Runner selection, exactly like GitHub Actions' own `runs-on`: a single label (`"ubuntu-latest"`) or an array of labels (`["self-hosted", "gpu"]`) for a custom / self-hosted runner. No value allow-list — you own getting the label right; each label is only anti-injection-checked (1–10 labels). Omit for `ubuntu-latest`. |
| `python` / `node` / `java` / `go` | string | Version strings passed to `actions/setup-python` / `setup-node` / `setup-java` (with `distribution: temurin`) / `setup-go`. `node`, `java`, `go` steps are skipped when their field is unset. `python` defaults to `3.12` on the host path; inside a `container` the image owns Python unless `python` is set explicitly. |
| `rust` | string | Rustup toolchain specifier (`stable`, `nightly`, `1.79`, `nightly-2025-01-01`) passed to `dtolnay/rust-toolchain` (no first-party setup action exists). Skipped when unset. |
| `apt` | `[string]` | Each package name must match `^[a-z0-9][a-z0-9.+-]{0,63}$` (Debian/Ubuntu source-package grammar, length-capped). Linux runners only. |
| `container` | object | Escape hatch — see below. Mutually exclusive with `apt`. |

### Custom / self-hosted runners

`runs-on` works exactly as it does in any GitHub Actions workflow. For a GitHub-hosted runner, give a single label; for CPU/memory-heavy assignments on your own infrastructure, give your self-hosted label(s):

```json
{ "runs-on": ["self-hosted", "gpu"], "python": "3.12" }
```

Multiple labels are AND-ed by Actions (a runner must carry all of them). There is no allow-list of valid labels — a misspelled label simply won't match a runner (the job queues until one does), the same behavior as a hand-written workflow, so double-check custom labels. Each label is validated against `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` purely so it can't inject into the workflow YAML. A `container` can be combined with a self-hosted Linux `runs-on`; matching the runner OS to the image is your responsibility (a recognized `macos-*`/`windows-*` label with a container is rejected, since Actions only runs containers on Linux).

> **Security note.** The autograde runner re-validates `assignments.json` on every student submission, but the `runs-on` value comes from your config repo (teacher-authored), never from student input — so a permissive `runs-on` doesn't widen what an untrusted student repo can request.

### Custom container

Anything beyond apt + setup-X actions reaches for `runtime.container`. The image runs on Linux hosts; `runs-on` may be omitted or set to an `ubuntu-*` label.

```json
{
  "container": {
    "image": "cs50/cli:latest",
    "user": "root"
  }
}
```

`user` is recommended for any image that doesn't run as root by default (cs50/cli, most maintained Docker Hub images). Without it, `actions/checkout` fails with `EACCES: permission denied` when writing to GitHub Actions' temp directory at `/__w/_temp/`. Accepts `docker run --user` syntax: a name (`root`, `appuser`), a numeric uid (`0`, `1000`), or `uid:gid` (`1000:1000`). Internally translated to `container.options: --user <value>` because GitHub Actions doesn't accept `container.user` directly.

The image must be **publicly pullable**. The grade job runs inside the student repo, where GitHub Actions provides no way to deliver a private-registry pull secret safely, so private images are not supported — publish your grading image publicly (e.g. a public `ghcr.io/<org>/<name>`).

| Field | Type | Notes |
|---|---|---|
| `image` | string | Required. Must be publicly pullable. Validated against an injection-safe character set. |
| `user` | string | Optional but recommended for non-root images. `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,31})?$`. |

## Attaching generated files to submission Releases

An assignment may attach generated PDFs, plots, logs, or other files to each submission Release. Configure exact paths in the web form's **Submission release files** textarea, one per line, or write the equivalent optional assignment field:

```json
"release_assets": [
  "report.pdf",
  "plots/chart.png"
]
```

The runner resolves paths in the submission workspace **after grading**, so an autograder may generate them. Each entry names an exact path, not a glob; `*`, `?`, `[` and `]` remain literal in a parent directory. An absent or empty list disables the feature.

During setup, the workflow validates the ordered paths and passes them to the existing grade job. After grading, `runner.py` copies accepted files into a fresh directory under runner temp and reports only their Release-safe basenames. The existing Release step publishes the core result first, then uploads accepted extras.

GitHub Release uploads flatten each path to its basename. Configure at most 50 path strings totaling at most 8 KiB (8,192 raw UTF-8 bytes), and give every path a unique basename. A basename must contain 1 to 255 ASCII characters using only letters, digits, `.`, `_`, and `-`; it may not begin or end with `.`, contain consecutive periods, or be `result.json` or `release-body.md` (case-insensitive). Paths must be relative, use `/`, contain no empty, `.` or `..` segment, and may not select the root `.git` tree. `.github/report.pdf` is allowed.

The 8 KiB limit applies only to the configured path strings. At runtime, the runner accepts only observed regular files inside the workspace, rejects any symlink in the path, and applies a separate 100 MiB total file-content budget in configuration order. If the next file does not fit, it skips that file and still considers later smaller files. Missing, unsafe, oversized, or failed extra uploads produce warnings but do not change a passing/failing grade, block `result.json`, or stop the latest pointer after core publication.

Classroom 50 submission publishing does not support GitHub Immutable Releases. The first publication creates and publishes the Release with `result.json` before uploading extras, so immutable mode rejects those later uploads. With Immutable Releases disabled, workflow reruns edit the Release and replace `result.json`; each extra is replaced only when its `--clobber` upload succeeds, so reruns also depend on mutable Releases. Removing a configured path, or skipping it before upload because it is missing, unsafe, or over budget, does **not** delete a same-named asset already present on the Release; Classroom 50 cannot safely infer ownership of unknown Release assets.

To roll this out to an existing organization, install or upgrade to the new `gh-teacher` CLI, run `gh teacher init <org>`, approve the skeleton refresh, and wait for the config repo's `Publish Pages` workflow to finish before the next submission or regrade. Student repos need no changes because their existing shims use the refreshed shared workflow and Pages resources.

## Customization layers

| What you want to change | Where to edit it | Propagation |
|---|---|---|
| **Simple checks for one assignment, no grading code** | `tests:` block in the matching `assignments.json` entry (via `gh teacher assignment test add` / `--tests`) | Next config-repo Pages publish, then next submission |
| **Grading logic for one assignment** | `<classroom>/autograders/<slug>/autograder.py` (mutually exclusive with the `tests:` block) | Next submission |
| **Grading logic shared across one classroom** | `<classroom>/autograder.py` (set via `gh teacher autograder set-default`; can branch on `ASSIGNMENT` to handle slug differences) | Next submission |
| **Runtime environment for one assignment** | `runtime:` block in the matching `assignments.json` entry | Next submission |
| **Runtime environment shared across many assignments** | Repeat the `runtime:` block on each entry, or pick a container image that covers everyone | Next submission |
| **Generated files attached to submission Releases** | `release_assets:` in `assignments.json`, normally edited through the web form | Next submission or regrade |

All customization layers live in the config repo. None require a change in a student repo.

Edit `autograde-runner.yaml` only when you need to add a language toolchain GitHub does not provide a setup action for or replace the runner bootstrap. Use `autograder.py`, declarative tests, assignment settings, and `runtime:` for ordinary customization.

## Feedback Pull Requests

The **Feedback PR is on by default** for assignments created with `gh teacher assignment add` (persisted as `feedback_pr: true` in `assignments.json`); pass `--feedback-pr=false` to turn it off for a given assignment. When on, the autograde runner maintains **one long-lived "Feedback" pull request per student repo** so you review the student's cumulative work with inline GitHub review comments instead of (or alongside) the scored Release.

> **Difference from GitHub Classroom:** GitHub Classroom opens the feedback PR at *accept* time; Classroom 50 opens it on the student's **first submission that adds work**. GitHub can't open a zero-change PR, and — when the repo was created by an accept flow — we freeze the PR base at the accept commit so the diff you review contains only the student's own work, never the setup files (`.classroom50.yaml`, the autograde workflow). If the accept commit can't be identified, we fall back to the root commit and warn (see "Open by default, warn when untrusted" below). Bonus: if a student edits those setup files, it shows up as a change in the Feedback PR diff.

**How it works:**

- **Base = a frozen branch.** On the first submission that has a diff, the runner creates a `feedback` branch pointing at the student's **baseline commit** (the accept commit when it can be identified, otherwise the repo's root commit — see below), then never advances it. The PR is `base = feedback`, `head = the default branch`, so it always shows the full starter→latest-submission diff and auto-updates on every submission.
- **One PR, reused.** The runner opens the PR once and reuses it across submissions. It's titled **Feedback** and labeled **Individual Assignment** or **Group Assignment** (by the assignment's `mode`) so you can filter/spot them. If a student closes it without merging, the runner reopens it; a teacher **merge** is treated as the "grading done" signal and left alone.
- **Open by default, warn when untrusted.** The runner prefers the **trusted baseline** — the commit that introduced `.classroom50.yaml` — and opens the PR silently when it finds it. If no commit is detected as *adding* that marker (a repo not created by an accept flow, or rewritten history that dropped the add), the runner **still opens the PR** against the repo's **root commit** and emits a workflow **warning** that the baseline is *untrusted* (the diff may include starter/plumbing files). Only when **no baseline resolves at all** — git can't read history (e.g. a container's "dubious ownership" guard) or the workspace isn't a git repo — does it **skip**, with a warning naming the cause. It also warns if the `feedback` branch already exists at a commit other than the expected baseline (a sign someone pre-created it). *Rationale: a reviewable diff against the root beats no review surface; the warning tells you to verify.*

> **How the baseline is identified (the accept-commit contract).** The runner resolves the baseline as **the commit that introduced `.classroom50.yaml`** — a structural marker, not the commit's subject line. Every accept client (`gh student accept`, the web GUI, any future client) creates `.classroom50.yaml` in its accept commit, so the baseline resolves regardless of how that commit is worded, localized, or squashed, and a student can't move it by reusing a subject. The single source of the path is `classroomcfg.MetadataPath` (Go side) / `runner.ACCEPT_MARKER_PATH` (Python side).
- **Observable.** The runner posts a `classroom50/feedback-pr` commit status (`success` / `failure` / `error`) with the PR URL as the target, alongside the `classroom50/autograde` status — so a script or agent can poll whether the Feedback PR is in place without scraping the job log.

**Prerequisites (handled by `gh teacher init`):**

- The org setting **"Allow GitHub Actions to create and approve pull requests"** must be on — the workflow's `GITHUB_TOKEN` can't open the PR otherwise. `init` enables it. (GitHub couples "create" and "approve" in this single org setting; there is no create-only toggle. This is safe in the default Classroom 50 model because no branch requires PR review — but if you later add a required-review rule to a repo in this org, be aware a workflow token could self-approve.)
- Two org **rulesets** `init` installs: one blocks force-push/deletion on the default branch (so submission history can't be rewritten), one locks the `feedback` branch against updates/deletes by anyone but an org admin (so students can't move or merge the frozen base). Org admins (you) bypass both, so you can merge the Feedback PR.

If you enable `--feedback-pr` on an org that was set up before this feature, **re-run `gh teacher init`** to apply the org setting and rulesets. Re-running init **reconciles** the rulesets: an existing Classroom 50 ruleset is updated in place to the current definition, so a stale ruleset from an older CLI (e.g. one targeting the wrong branch pattern) is repaired rather than left behind.

**Student repos accepted before this feature shipped.** The autograde shim in each student repo is written at `gh student accept` time and is **not** updated by re-accepting (re-accept is a no-op on an existing repo). Older shims grant only `contents`/`statuses` to the reusable runner; the Feedback PR runner additionally needs `pull-requests: write`, and a reusable workflow whose caller grants less than it requires **fails to load** — GitHub reports a `startup_failure` ("This run likely failed because of a workflow file issue") with no job logs. Repos created with the current `gh student accept` grant the right scope and are unaffected; pre-existing repos must be re-created (delete + re-accept) to pick up the new shim. (Pre-launch, this affects only test repos.)

**Limitations:** the per-repo limit relies on the org rulesets being in place; on a plan or policy that rejects org rulesets, `init` warns and continues, and the protections silently don't apply. The Feedback PR opens only when there's a diff to show (a submission identical to the baseline produces no PR).

## Restricting which files a submission may contain (`allowed_files`)

An assignment can declare an **`allowed_files`** list in `assignments.json` — an ordered list of **`.gitignore`-style patterns** that defines which files belong to the submission. It is an *allowlist expressed in gitignore syntax*: write `*` to ignore everything, then `!hello.py` to re-include exactly the files you want.

```sh
gh teacher assignment add cs50-fall-2026 cs-principles hello \
    --name "Hello" --template cs50/hello-template \
    --allowed-files '*' --allowed-files '!hello.py'
```

persists:

```json
"allowed_files": ["*", "!hello.py"]
```

- **Syntax is git's own.** Ordering matters, last match wins, and `!` re-includes — exactly like a `.gitignore`. So `["*", "!hello.py"]` allows only `hello.py`, while `["node_modules/", "*.lock"]` just drops that noise and allows everything else.
- **Repeatable, order-preserving flag.** Pass `--allowed-files` once per pattern (do **not** comma-join them); order is preserved into the manifest because gitignore matching is order-dependent.
- **Optional and backward-compatible.** Omit it (or pass an empty list) and every file is allowed, exactly as before.
- **Re-running `add` rewrites the whole entry.** Like `--tests` and `--template`, omitting `--allowed-files` on a re-add drops a previously set allowlist (and warns loudly). Pass `--allowed-files` again to keep it; pass it with no value as a deliberate, silent clear.

### How it is enforced

Enforcement is **two-sided**. The autograde runner is the real enforcement point (a plain `git push` bypasses the submit-side filter, but never the runner) — though it deliberately **fails open**, so it is the *enforcement point*, not a guaranteed security boundary:

1. **`gh student submit`** filters the snapshot it pushes, leaving disallowed files out of the submission. This is best-effort convenience — a plain `git commit && git push` bypasses it.
2. **The autograde runner** (`runner.py`) is where enforcement actually happens. Immediately after checkout and **before** it runs the autograder, the runner removes every working-tree file the patterns disallow, so — **when git is available** — the autograder only ever sees allowed files, no matter how the student pushed. (On git/resource failure it fails open; see below.)

**Control files are always kept.** `.classroom50.yaml`, the `.github/` workflow shim, and the runner's own outputs are never removed, even under a bare `*` pattern — so enforcement can't break grading.

> **`allowed_files` gates what the autograder *reads*, not just what the student authors.** Removal happens *before* the autograder runs, so any file the grader needs — starter scaffolding, `helpers.py`, data fixtures, `requirements.txt` — must be inside the allowlist too, or it is deleted and grading fails with a confusing "file not found"/import error that looks like the student's bug. When in doubt, allowlist every file the grader touches (e.g. `--allowed-files '*' --allowed-files '!hello.py' --allowed-files '!helpers.py'`), or keep grader-only fixtures in the autograder bundle rather than the student repo. The release-body "Removed N file(s)" note lists exactly what was stripped, so a surprise removal is diagnosable there.

> **`.github/` is force-kept and cannot be constrained by `allowed_files`.** The whole `.github/` subtree (and `.classroom50.yaml`) survives the allowlist so the autograde shim keeps working. A student can therefore commit arbitrary files under `.github/` that the allowlist won't strip. This is inert today — the runner only executes the Pages-fetched entrypoint and `.classroom50.yaml` is re-validated before use — but do not point a custom autograder at student-controlled `.github/` content.

**It fails open.** Enforcement is a grading-scope/hygiene tool, not a secret-hiding security control, so if the runner cannot enforce a non-empty allowlist — git is unavailable or hangs, the matcher errors, the working tree can't be enumerated — it logs the failure, **skips enforcement, and grades the unfiltered submission** rather than blocking the grade. (Both sides are lenient: `gh student submit`'s pre-push filter is best-effort by design too.) An empty/absent allowlist has nothing to enforce and always grades normally. **Never use `allowed_files` to hide a solution or answer-key file from the autograder** — a student who forces a git failure (or just `git push`es) gets the unfiltered tree graded. If you later need the allowlist to be an authoritative boundary, `enforce_allowed_files` in `runner.py` documents how to flip it to fail-closed (publish an `error` result instead of grading).

**It does not rewrite history.** Removal happens in the working tree only, so the baseline commit, the review compare link, and the Feedback PR diff are unaffected; only the files the autograder *reads* change.

**Removals are reported.** When the runner strips files, it logs them and appends a "Removed N file(s) outside the assignment's allowed files" section to the submission's `release-body.md`, so a student whose required file is misnamed or missing can see why the autograder didn't find it.

## Custom runner workflow (rare)

The `--autograder <name>` flag on `gh teacher assignment add` exists for the rare case where you want an assignment to call a fundamentally different *reusable workflow* — not just a different `autograder.py`, but a different runner entirely. To opt in:

1. Drop a sibling shim at `<classroom>/autograders/<name>.yaml` in the config repo. Its `uses:` line points at your custom reusable workflow.
2. `gh teacher assignment add ... --autograder <name>`. The CLI verifies the file exists at write time.

`gh student accept` fetches the named shim from Pages instead of using the embedded default, so the student repo gets your custom shim. Most teachers never need this.

## Failure paths

Classroom 50 distinguishes an ordinary passing or failing grade from a grading or publication infrastructure error. Passing and failing grades publish the core submission Release; an infrastructure `error` posts an error status and does not update the Release.

| What failed | What surfaces |
|---|---|
| Invalid hand-edited `release_assets` configuration | Setup exits with a field-specific `::error::` before grading; no Release update |
| Grading/autograder infrastructure produces `status=error` | Grade posts `status=error`; no Release update |
| Configured extra is missing, unsafe, a directory/symlink, or over budget | Warning; valid core and other extras continue |
| Core Release creation or `result.json` upload | Grade job fails; latest does not move; an already-posted grade status is not rewritten |
| One extra Release upload | Warning; later extras continue; core Release stays published |
| Tests run and some fail | `status=failure`; core Release and valid extras publish |
| All tests pass | `status=success`; core Release and valid extras publish |

Failures that prevent the reusable workflow from loading do not appear in `scores.json`; collect-scores counts the student as not yet submitted. GitHub shows failures from a called reusable workflow as nested jobs in the student's Actions tab.

## No credentials required

Students never configure any tokens, secrets, or env vars. The full grading flow runs entirely on:

1. **Job-scoped `GITHUB_TOKEN` credentials.** `setup` uses its token to write the submit tag and acceptance status. `grade` checks out with `persist-credentials: false` and runs the autograder; later steps in that same job receive `GH_TOKEN` to post status, publish the Release, and maintain the Feedback PR. Because grading and publishing share one runner, this arrangement is not a credential or hostile-workflow isolation boundary. `set-latest` uses its job token to update the latest pointer.
2. **Unauthenticated GitHub Pages fetches** — the publish-pages allow-list keeps `assignments.json`, `autograder.py`, `autograders/*.yaml`, and the per-assignment bundles public even when the config repo is private.
3. **Reusable-workflow access** between the student repo and the `classroom50` config repo — both live in the teacher's org. `gh teacher init` configures this access automatically; teachers in orgs with restrictive Actions policies may need to enable it manually at Settings → Actions → General → Access on the `classroom50` repo.

The only personal access token in the entire system is `CLASSROOM50_SERVICE_TOKEN`, which is teacher-side, stored as an Actions secret on the config repo, used only by `collect-scores.yaml`. Students never see it.

## Operational notes

- **Every push grades, every push gets its own release.** Pushing 5 commits in 10 minutes produces 5 graded runs and 5 releases — `cancel-in-progress: false` on purpose. (See [Submission triggers](#submission-triggers) for the trigger contract.)
- **"Latest" pointer follows commit time.** The serialized `set-latest` job compares the committer timestamps of the new submission commit and the commit tagged by the current `submit/*` latest Release. It moves the pointer only when the new commit is newer. If either timestamp is unavailable, it leaves the pointer unchanged. When no current `submit/*` latest Release exists or GitHub cannot resolve its tag ref, the job marks the new Release latest.
- **CDN propagation:** GitHub Pages can take up to ~10 minutes to serve updated content after a push. If a student submits during that window, their workflow may fetch the previous version of `runner.py`, the default autograder, or the bundle.
- **Re-runs:** A workflow rerun grades the commit again. `gh release upload --clobber` replaces `result.json` and each successfully uploaded extra, but the workflow does not delete assets that are no longer configured or are skipped before upload.
- **Tag immutability:** Submit tags shouldn't be force-pushed or deleted -- in `scores.json` rows are bucketed by assignment slug and keyed within a bucket by the repo `owner`, so `collect-scores.yaml` would re-ingest the same key with new data on the next collect.
