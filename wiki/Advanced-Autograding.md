# Advanced Autograding

Custom grading beyond [declarative tests](Autograding-Basics#declarative-tests):
writing your own `autograder.py`, the `result.json` contract every autograder
must satisfy, the `runtime` block (toolchains, containers, self-hosted
runners), and swapping the grading pipeline entirely. For the grading model
and day-to-day results, see [Autograding Basics](Autograding-Basics).

In paths and commands on this page, replace `CLASSROOM` with the classroom's
short name and `ASSIGNMENT` with the assignment slug.

## Writing an `autograder.py`

When declarative tests aren't enough, write the grading logic yourself: the
autograder is a Python script the runner invokes once per submission. There are
two scopes:

| Path | Scope | Used when |
|---|---|---|
| `CLASSROOM/autograders/ASSIGNMENT/autograder.py` | One assignment | Present in the bundle. |
| `CLASSROOM/autograder.py` | One classroom | No per-assignment `autograder.py` and no declarative tests. |

Declarative tests sit between the two: the **Publish Pages** workflow generates
them into the bundle as `CLASSROOM/autograders/ASSIGNMENT/tests.json`. You
never create or commit that file. See
[Where tests live](Autograding-Basics#where-tests-live).

If none of the three exist, the runner emits a vacuous pass (score 0/0) and the
submission still lands as a tagged Release, a valid mid-setup state.

### Precedence

The runner resolves the grading entrypoint in this order:

1. Per-assignment `CLASSROOM/autograders/ASSIGNMENT/autograder.py` (an override
   always wins).
2. The assignment's declarative tests (the generated `tests.json`).
3. Classroom default `CLASSROOM/autograder.py`.
4. None of the above: vacuous pass.

To keep precedence from silently swallowing tests, the CLI refuses `assignment
test add` / `--tests` while a per-assignment `autograder.py` exists.

### Contract

The runner provides:

- **Environment variables:** `CLASSROOM`, `ASSIGNMENT`, `SUBMISSION_TAG`,
  `PAGES_BASE_URL`, `USERNAME`/`OWNER`, `ASSIGNMENT_TYPE`, `COMMIT_URL`,
  `RELEASE_URL`, `REVIEW_URL`, `CLASSROOM50_BUNDLE_DIR` (the directory the
  entrypoint was extracted to), and all standard `GITHUB_*`.
- **Working directory:** the student's checkout (relative paths resolve to
  student code).
- **Sibling files:** anything else under `CLASSROOM/autograders/ASSIGNMENT/` is
  bundled and lives at `Path(__file__).parent`. Students never receive these
  files in their repository, which makes this the place for test scripts and
  fixtures that must not be tampered with. Anyone who finds the GitHub Pages
  URL can read them, though. See
  [Teacher-only test files](Autograding-Basics#teacher-only-test-files).

The autograder must produce **`./result.json`** (required — see
[the `result.json` contract](#the-resultjson-contract)). Optionally
`./release-body.md` and `status=`/`summary=` in `$GITHUB_OUTPUT`; the runner
synthesizes them from `result.json` if absent. Exit **0** if it ran end-to-end
(pass/fail is in `result.json`); a **non-zero** exit is an infrastructure error
and the runner synthesizes a `status=error` result.

<details>
<summary>Template: pytest</summary>

Drop at `CLASSROOM/autograders/ASSIGNMENT/autograder.py` alongside your `test_*.py`
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

`gh teacher autograder set-default ORG CLASSROOM --from PATH` installs a
default that grades every assignment without its own autograder or tests. With no
`--from`, it installs a diagnostic stub (echoes the environment, emits a vacuous
pass) — useful for verifying the pipeline. Inspect it with `autograder show`, and
delete it outright with `autograder remove`.

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
  "commit":          "https://github.com/.../commit/SHA",
  "release":         "https://github.com/.../releases/tag/submit%2F...",
  "review":          "https://github.com/.../compare/BASELINE-SHA...SHA",
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
| `classroom` / `assignment` | string | Must match the source repository's identity (checked in code alongside `owner`). |
| `assignment_type` | string | `individual`, `group`, or `team`, stamped by the runner. |
| `owner` | string | The repository owner login — the identity anchor. |
| `submission` | string | The submit-tag name. |
| `commit` / `release` / `review` | string | URLs. `review` is the full diff from starter code to the graded commit. |
| `datetime` | string | The **submission instant**: the graded commit's committer date (UTC ISO 8601). Invariant across regrades, so late-marking never changes on a re-run. |
| `graded_at` | string | Optional. When this grading run produced the result — moves on every regrade. |
| `score` / `max-score` | int | Sum of test scores / max-scores. |
| `tests` | array | Per-test breakdown (`[]` is valid for a vacuous pass). Extra diagnostic fields on a test are preserved verbatim. |
| `submitted_by` | object | Optional. Who pushed: `username`, and `id` (which may be null or absent). |

`collect-scores` validates this before merging into `scores.json`. A payload
whose identity (classroom/assignment/`owner`) doesn't match the source repository is
rejected, and a mismatched `assignment_type` is warned-and-skipped, so a hostile
payload can't land in another student's collected scores.

<details>
<summary>scores.json shape</summary>

`scores.json` is keyed by assignment slug under a root `assignments` object;
each value is `{ "type": "individual"|"group"|"team", "entries": [...] }`. An `entry` is
one repository's record: `owner` (the stable key), `submissions` (full history, newest
first), and — for a group — `member_usernames` (credited members; a `team`
bucket's entries also carry the credited group team's `team_slug`). Each bucket
also carries a `collected_at` UTC timestamp stamped whenever a collection run
walks that assignment (even if nothing changed), so per-assignment freshness is
knowable — the web app's "Submission data collected" strip reads it.

</details>

## The `runtime` block

Per-assignment environment (runner OS, language toolchains, packages, container
image) lives as an optional `runtime` field on each `assignments.json` entry, or
under **Advanced settings** in the web assignment form. The runner reads it on
every submission, so changes propagate with no student-repository edit. Pass a JSON
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
| `rust` | Rustup toolchain (`stable`, `1.79`, …) through `dtolnay/rust-toolchain`. |
| `apt` | Debian/Ubuntu package names. Linux runners only. Mutually exclusive with `container`. |
| `container` | Escape hatch — see below. |

<details>
<summary>Custom and self-hosted runners</summary>

`runs-on` works exactly as in any GitHub Actions workflow. Multiple labels are AND-ed; a
misspelled label won't match a runner. A `container` needs a Linux
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
delivered safely in a student repository). Set `user` for any image that doesn't run
as root by default, or `actions/checkout` fails with a permission error. `image`
is required and injection-checked; `user` accepts `docker run --user` syntax.

</details>

> [!NOTE]
> `runtime` values are teacher-authored (from your `classroom50` repository), never student
> input, so a permissive `runs-on` doesn't widen what a student repository can request.

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
> boundary: a student who forces a git failure (or pushes directly with
> `git push`) gets the
> unfiltered tree graded. Never use it to hide an answer key. Removals are logged
> in the release body ("Removed N file(s)").

## Attaching files to submission Releases

Attach generated PDFs, plots, or logs to each submission's Release with the web
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
> the Release in place). To roll this out to an existing organization, run `gh teacher
> init`, approve the workflow-files refresh, and wait for `publish-pages` to
> finish.

## Custom runner workflow (rare)

Every earlier layer changes *what* grading does while keeping the built-in
runner. When you need a different grading *pipeline* entirely — a
[reusable workflow](https://docs.github.com/actions/using-workflows/reusing-workflows)
you author yourself — `--autograder NAME` swaps the caller workflow instead of
the autograder script. Most teachers never need this.

**How the swap works.** By default `gh student accept` writes a small caller
workflow to `.github/workflows/autograde.yaml` whose `uses:` points at the
built-in `autograde-runner.yaml`. With `--autograder NAME`, accept instead
fetches your caller from `CLASSROOM/autograders/NAME.yaml` and writes it
verbatim. Your caller owns its own `on:` triggers and `uses:` a reusable
workflow you control, so your grading logic runs in place of the runner.

**Set one up:**

1. **Add the reusable workflow** to your `classroom50` repository under `.github/workflows/`,
   with a name other than the reserved `autograde-runner.yaml`. It must be
   [callable](https://docs.github.com/actions/using-workflows/reusing-workflows#creating-a-reusable-workflow)
   (`on: workflow_call`). Non-reserved names are never touched by Classroom 50.
2. **Add a caller workflow** at `CLASSROOM/autograders/NAME.yaml`. Give it
   your trigger events and a `jobs.<id>.uses:` pointing at the workflow from
   step 1. Because it's written verbatim, template `ORG`/branch refs to your
   own values rather than relying on the built-in caller's substitution.
3. **Register the assignment** with `gh teacher assignment add ORG CLASSROOM
   ASSIGNMENT --autograder NAME`.

> [!NOTE]
> Once an assignment uses a custom autograder, `gh teacher assignment
> submission-mode` never rewrites its caller workflow — trigger changes are
> yours to make.

### Keeping a GitHub Classroom autograder

This is the intended path for keeping an `autograding.json`-driven workflow
from a classroom that originated in GitHub Classroom. Classroom 50 has no
`.github/classroom/autograding.json` of its own — the built-in runner reads a
[`tests` block](Autograding-Basics#declarative-tests) instead — but a custom runner workflow lets
you keep your existing format:

1. Put your grading action's workflow in the `classroom50` repository's `.github/workflows/`
   (any non-reserved name). Have it read `autograding.json` from the student
   repository as before.
2. Point a caller workflow at it as above, and register assignments with
   `--autograder NAME`.
3. Ship `autograding.json` (and any fixtures) in the **assignment template**, not
   the `classroom50` repository — it travels with each student's starter code.

> [!WARNING]
> The template must **not** contain `.github/workflows/autograde.yaml`; that
> name is reserved for the autograding caller and would be clobbered on accept
> and submit (see [Assignment Templates](Assignment-Templates#structure)). Use
> any other filename for template-side workflows.

## Writing `assignments.json` from another client

Anything that writes a valid `assignments.json` gets the whole pipeline for
free. A non-CLI client (such as a GUI) must:

1. Validate against
   [`schemas/assignments-v1.schema.json`](https://github.com/foundation50/classroom50/blob/main/schemas/assignments-v1.schema.json)
   (two rules it can't express: unique test names, and name length ≤ 100 UTF-8
   *bytes*).
2. Probe before writing tests: `CLASSROOM/autograders/ASSIGNMENT/autograder.py`
   must NOT exist, and `.github/scripts/materialize_tests.py` MUST exist.
3. Write with the git-data API and retry on a non-fast-forward rejection.

The CLI parses strictly (unknown fields rejected), so persist only schema fields.

## Where to customize

| To change… | Edit… | Propagates on… |
|---|---|---|
| Simple checks, no code | `tests` block (`assignment test add` / `--tests`) | Next Pages publish, then next submission |
| Grading logic for one assignment | `CLASSROOM/autograders/ASSIGNMENT/autograder.py` | Next submission |
| Grading logic for a classroom | `CLASSROOM/autograder.py` (`autograder set-default`) | Next submission |
| Runtime for one assignment | `runtime` block on the entry | Next submission |
| Files attached to Releases | `release_assets` (usually in the web form) | Next submission or regrade |

All layers live in the `classroom50` repository; none require a
student-repository change. Edit
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
between the student repository and the `classroom50` repository (both in the teacher's organization,
configured by `init`). The only PAT in the system is the teacher-side
`CLASSROOM50_SERVICE_TOKEN`, used only by the score-collection, regrade, and
token-probe workflows (`collect-scores.yaml`, `regrade.yaml`,
`probe-token.yaml`).

## Operational notes

- **The grade job stops after 15 minutes.** This includes managed runtime setup,
  the assignment Setup command, every test, and submission Release publishing.
  Per-command timeouts do not extend the job limit.
- **Every push grades, every push gets a Release** (in `every-push` mode). Five
  pushes in ten minutes produce five graded runs and five Releases.
- **Immutable-release rulesets freeze regrade Releases.** Orgs enforcing
  immutable releases (a GitHub ruleset) cannot refresh a submission's Release
  on regrade; the regraded score appears in the commit status and the GitHub Actions
  job summary, but the Release — and thus the collected score for
  that submission — keeps the pre-regrade result.
- **Pages CDN lag:** updated content can take ~10 minutes to serve, so a
  submission in that window may fetch the previous `runner.py` or bundle.
- **Don't force-push or delete submit tags** — collection keys on them.
