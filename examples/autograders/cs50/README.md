# CS50 + check50 autograder

A drop-in autograder configuration for orgs running [CS50's problem sets](https://cs50.harvard.edu/x/). Maps the assignment slug to a [check50](https://cs50.readthedocs.io/projects/check50/) spec under `cs50/problems/<year>/x/<slug>`, runs check50 in `--local` mode inside the [`cs50/cli`](https://hub.docker.com/r/cs50/cli) container, and translates the JSON output into a `classroom50/result/v1` payload.

## Files

| File | Where it goes |
|---|---|
| `autograder.py` | `<classroom>/autograder.py` in your config repo. Install via `gh teacher autograder set-default <org> <classroom> --from autograder.py`. One file grades every assignment in the classroom. |
| `runtime.json` | Pass to `gh teacher assignment add --runtime <path>`. Configures the grade job to run inside `cs50/cli` so check50, clang, and libcs50 are preinstalled. |

## Usage

```sh
# 1. Install the classroom default autograder.
gh teacher autograder set-default cs50-fall-2026 cs-principles \
    --from examples/autograders/cs50/autograder.py
# Commit lands in the config repo automatically. Wait ~30s for the
# next publish-pages.yaml run to deploy.

# 2. Register a CS50 problem-set assignment.
gh teacher assignment add cs50-fall-2026 cs-principles tideman \
    --name "Tideman" \
    --template cs50/tideman-template \
    --runtime examples/autograders/cs50/runtime.json
```

The assignment slug **must match** the CS50 problem-set leaf name (`tideman`, `mario`, `cash`, ...) so it composes correctly into the check50 spec.

## How it works

On every submission, the autograde-runner workflow fetches `runner.py` (the runner-side bootstrap), which then fetches this `autograder.py` from your Pages site at `<classroom>/autograder.py` (or picks up a per-assignment override if the bundle contains one). Inside the `cs50/cli` container:

1. Reads `ASSIGNMENT` (set by the runner from `assignments.json`), composes `spec = "cs50/problems/2026/x/<slug>"`.
2. Runs `check50 --local --output=json <spec>`. The `--output=json` is glued (not `--output json <spec>`) because check50's `--output` flag is `nargs="+"` and would otherwise greedily consume the slug as a second output format.
3. Parses check50's JSON output, building one `tests` row per check. Test names use the check's docstring (`description` field) when present, falling back to the function identifier (`name`) when a check has no docstring — so the gradebook reads "vote returns true for a valid candidate" rather than `vote_returns_true`.
4. Writes `result.json`. The runner-side bootstrap synthesizes `release-body.md` and the `status`/`summary` lines in `$GITHUB_OUTPUT` from `result.json` automatically — no need to write either yourself.

## Maintenance

- **Year rollover**: edit `CHECK50_SPEC_PREFIX` at the top of `autograder.py` when CS50 advances `cs50/problems/<year>` (e.g., `2026` → `2027`). After editing, re-run `gh teacher autograder set-default --from ./autograder.py` to push the change.
- **Per-assignment exceptions**: drop a per-assignment override at `<classroom>/autograders/<slug>/autograder.py` for any assignment that needs grading logic outside the check50 model (e.g., a project, a non-CS50 problem set). The runner picks per-assignment overrides over the classroom default automatically.

## Why `user: root`

The `cs50/cli` image runs as the `ubuntu` user (uid 1000) by default. GitHub Actions' temp directory at `/__w/_temp/` is owned by the host runner, so `actions/checkout` hits `EACCES: permission denied` when it tries to write `_runner_file_commands/save_state_*`. Setting `runtime.container.user: "root"` is the standard fix — the framework translates it to `container.options: --user root` in the emitted workflow YAML.

## See also

- [Autograders](../../../wiki/Autograders.md) — full architecture, the `result.json` v1 contract, runtime block schema, failure paths.
- [cs50/check50](https://github.com/cs50/check50) — the upstream tool.
- [cs50/problems](https://github.com/cs50/problems) — where the check50 specs live.
