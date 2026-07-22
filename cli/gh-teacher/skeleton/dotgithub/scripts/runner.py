#!/usr/bin/env python3
"""classroom50 runner.

Fetched from the teacher's Pages site by the autograde-runner workflow on
every submission. Reads env, resolves an entrypoint (per-assignment
autograder.py > per-assignment tests.json > classroom-default autograder.py
> vacuous pass), execs it in the student checkout, then reads/synthesizes
result.json + release-body.md + $GITHUB_OUTPUT so downstream steps always
have a v1-shaped payload. Per-assignment grading lives in autograder.py —
see the Autograders wiki page.

Exits 0 for EVERY grading outcome, including failures (reported via a
synthetic error result + status=error) so the release/commit-status steps
still fire and the gradebook ingests the submission. Only missing required
identity env (PAGES_BASE_URL, CLASSROOM, ASSIGNMENT, SUBMISSION_TAG) fails
fast with exit 1 — those are needed to synthesize a v1 result.json, and
this only happens when run outside the workflow.

Environment (set by the autograde-runner workflow):
  PAGES_BASE_URL    org-level Pages URL of the classroom50 config repo
  CLASSROOM         classroom short-name
  ASSIGNMENT        assignment slug
  SUBMISSION_TAG    submit/<UTC-timestamp>-<short-sha>
  GITHUB_REPOSITORY <owner>/<repo>
  GITHUB_SHA        commit SHA
  GITHUB_SERVER_URL https://github.com (or GHES base)
  GITHUB_ACTOR      fallback username when the repo name doesn't follow
                    <classroom>-<assignment>-<username>
  GITHUB_OUTPUT     workflow-step output sink

Passed through to the entrypoint: USERNAME, COMMIT_URL, RELEASE_URL,
REVIEW_URL (full baseline...graded diff; falls back to COMMIT_URL when
history is unavailable or baseline == commit).
"""

from __future__ import annotations

import datetime
import errno
import importlib.util
import io
import json
import os
import pathlib
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

# Schema sentinel — keep in lockstep with collect_scores.py::validate_result
# (cli/gh-teacher/skeleton/dotgithub/scripts/collect_scores.py).
RESULT_SCHEMA_V1 = "classroom50/result/v1"

# result.json is required; release-body.md optional (synthesized when
# missing). Lockstep with contract.ResultFilename / contract.ReleaseBodyFilename
# (cli/shared/contract/contract.go); test_runner.py pins these literals.
RESULT_FILENAME = "result.json"
RELEASE_BODY_FILENAME = "release-body.md"
RELEASE_ASSETS_DIRNAME = "classroom50-release-assets"
RELEASE_ASSETS_MAX_FILES = 50
RELEASE_ASSETS_MAX_PATH_BYTES = 8_192
RELEASE_ASSETS_MAX_BYTES = 104_857_600
RELEASE_ASSET_BASENAME = re.compile(
    r"^[A-Za-z0-9_-](?:[A-Za-z0-9._-]{0,253}[A-Za-z0-9_-])?$",
    re.ASCII,
)

# Name of both the per-assignment override and classroom-default entrypoint.
ENTRYPOINT_FILENAME = "autograder.py"

# Bundled declarative tests (materialized from assignments.json by
# publish-pages.yaml), graded by the built-in interpreter below. Schema in
# tests.go; contract in the wiki.
TESTS_FILENAME = "tests.json"
TESTS_SCHEMA_V1 = "classroom50/tests/v1"

# Default per-test timeout (s) when `timeout` is omitted/0; setup and run
# commands are each bounded by it independently.
DEFAULT_TEST_TIMEOUT = 10

# Cap captured stdout/stderr in the release body so a runaway program can't
# bloat the published release.
MAX_CAPTURED_CHARS = 2000

# Test types and io comparison modes -- mirror the allow-lists in tests.go.
TEST_TYPE_IO = "io"
TEST_TYPE_RUN = "run"
TEST_TYPE_PYTHON = "python"
TEST_TYPES = (TEST_TYPE_IO, TEST_TYPE_RUN, TEST_TYPE_PYTHON)

COMPARISON_INCLUDED = "included"
COMPARISON_EXACT = "exact"
COMPARISON_REGEX = "regex"
COMPARISONS = (COMPARISON_INCLUDED, COMPARISON_EXACT, COMPARISON_REGEX)

# Bounded retry for Pages fetches: 1s then 2s between attempts (final attempt
# raises) on transient network errors / HTTP 5xx. 404 is NOT retried — for the
# bundle URL it means "no per-assignment override"; for the classroom-default
# URL it means the classroom hasn't run `gh teacher autograder set-default`
# (falls back to a vacuous-pass result).
FETCH_ATTEMPTS = 3

# Hard cap on bundle / classroom-default fetches. 10 MB covers all realistic
# test suites and bounds a hostile asset.
MAX_FETCH_BYTES = 10 * 1024 * 1024

# The accept commit creates the repo's `.classroom50.yaml`. Resolving the
# baseline from this structural marker (not the commit subject) is stable
# across clients/rewording and removes the subject-reuse spoof. The baseline
# still can't be moved *forward* (to hide pre-baseline work) only because the
# default-branch force-push/delete ruleset protects the accept commit -- on a
# plan that rejects org rulesets that protection silently doesn't apply, so
# this is a robustness win over subject-matching, not a guarantee. Path mirrors
# classroomcfg.MetadataPath (cli/gh-student/internal/classroomcfg/metadata.go)
# -- keep in lockstep.
ACCEPT_MARKER_PATH = ".classroom50.yaml"

# Full set of paths the accept commit lands atomically in one Tree commit.
# Mirrors classroomcfg.DropFiles (cli/gh-student/internal/classroomcfg/
# metadata.go), which commits exactly MetadataPath + AutogradeWorkflowPath --
# keep in lockstep. is_acceptance_commit uses this to fail open when the tip
# accept commit also adds non-setup files (e.g. amended/squashed real work),
# so that work is graded rather than silently skipped.
ACCEPT_COMMIT_PATHS = frozenset(
    {
        ACCEPT_MARKER_PATH,
        ".github/workflows/autograde.yaml",
    }
)

# `_baseline_scan` source discriminator. SOURCE_OPENABLE yields a usable
# Feedback PR base (accept commit or root fallback); the others skip.
SOURCE_ACCEPT = "accept"
SOURCE_ROOT = "root"
SOURCE_GIT_ERROR = "git-error"
SOURCE_NONE = "none"
SOURCE_OPENABLE = (SOURCE_ACCEPT, SOURCE_ROOT)

# Control paths allowed_files enforcement never removes, even under a bare `*`.
# Lockstep with submit.go's isControlPath, pinned from both sides by the shared
# fixture cli/shared/testdata/control_path_cases.json. Directory controls match
# by prefix; file controls match exactly, so a sibling like `result.json.bak`
# stays subject to the allowlist.
ALLOWED_FILES_KEEP_PREFIXES = (
    ".github/",
    ".git/",
)
ALLOWED_FILES_KEEP_EXACT = (
    ACCEPT_MARKER_PATH,
    ".github",
    ".git",
    RESULT_FILENAME,
    RELEASE_BODY_FILENAME,
)


def runtime_root() -> pathlib.Path:
    """Writable scratch dir for bundle extraction + entrypoint fetches.
    Prefers `$RUNNER_TEMP` (Actions temp, cleaned between jobs), else
    `tempfile.mkdtemp()` for local dev. Hard-coded `/tmp/` would break on
    Windows runners (which runtime.go's allow-list admits)."""
    base = os.environ.get("RUNNER_TEMP", "").strip()
    if base:
        return pathlib.Path(base) / "classroom50-runtime"
    return pathlib.Path(tempfile.mkdtemp(prefix="classroom50-runtime-"))


# ---------------------------------------------------------------------------
# Pure helpers (no I/O — fully unit-testable)
# ---------------------------------------------------------------------------


def username_from_repo(repository: str, classroom: str, assignment: str, actor: str) -> str:
    """Derive the student username from `<owner>/<classroom>-<assignment>-<username>`.

    Mirrors the naming formula single-sourced in cli/shared/contract
    (AssignmentRepoName); keep byte-identical. Falls back to GITHUB_ACTOR when
    the repo name doesn't follow the convention (e.g. hand-created test repos).
    """
    if "/" in repository:
        _, repo = repository.split("/", 1)
    else:
        repo = repository
    prefix = f"{classroom.lower()}-{assignment.lower()}-"
    if repo.lower().startswith(prefix):
        return repo[len(prefix):]
    return actor


def commit_url(server_url: str, repository: str, sha: str) -> str:
    return f"{server_url}/{repository}/commit/{sha}"


def release_url(server_url: str, repository: str, submission_tag: str) -> str:
    return f"{server_url}/{repository}/releases/tag/{urllib.parse.quote(submission_tag, safe='')}"


def compare_url(server_url: str, repository: str, base_sha: str, head_sha: str) -> str:
    return f"{server_url}/{repository}/compare/{base_sha}...{head_sha}"


def review_url(server_url: str, repository: str, base_sha: str | None, head_sha: str) -> str:
    """Full baseline...graded diff; commit view when there's no usable
    baseline (history unavailable, or baseline == head)."""
    if base_sha and head_sha and base_sha != head_sha:
        return compare_url(server_url, repository, base_sha, head_sha)
    return commit_url(server_url, repository, head_sha)


def _classroom_segment(classroom: str, secret: str) -> str:
    """Per-classroom Pages path segment. A protected classroom carries a
    capability-URL secret and serves everything under `<classroom>/<secret>`;
    otherwise plain `<classroom>`. Both parts are URL-quoted by callers."""
    safe_classroom = urllib.parse.quote(classroom, safe="")
    if not secret:
        return safe_classroom
    return f"{safe_classroom}/{urllib.parse.quote(secret, safe='')}"


def bundle_url(pages_base_url: str, classroom: str, assignment: str, secret: str = "") -> str:
    """Pages URL for an assignment's bundle (autograder.py + sibling fixtures,
    packaged by publish-pages.yaml). Secret-aware."""
    safe_slug = urllib.parse.quote(assignment, safe="")
    return f"{pages_base_url}/{_classroom_segment(classroom, secret)}/autograders/{safe_slug}.tar.gz"


def classroom_default_autograder_url(pages_base_url: str, classroom: str, secret: str = "") -> str:
    """Pages URL for a classroom's default autograder.py.

    Published verbatim by publish-pages.yaml from `<classroom>/autograder.py`.
    Optional — classrooms that haven't run `gh teacher autograder set-default`
    won't have one, and the runner falls back to a vacuous-pass result.
    """
    return f"{pages_base_url}/{_classroom_segment(classroom, secret)}/{ENTRYPOINT_FILENAME}"


def actor_identity() -> dict[str, Any] | None:
    """The GitHub actor who pushed this submission. Returns {"username":
    <login>, "id": <numeric id|None>} or None when the login is unavailable.

    For a GROUP submission the graded repo is the founder's but any teammate
    can push; `submitted_by` records who actually pushed while the shared
    score is credited to every member. From GITHUB_ACTOR / GITHUB_ACTOR_ID
    (id parsed as int when present, else null).
    """
    login = (os.environ.get("GITHUB_ACTOR") or "").strip()
    if not login:
        return None
    raw_id = (os.environ.get("GITHUB_ACTOR_ID") or "").strip()
    actor_id: int | None = None
    if raw_id.isdigit():
        actor_id = int(raw_id)
    return {"username": login, "id": actor_id}


def make_result(
    *,
    classroom: str,
    assignment: str,
    username: str,
    submission: str,
    commit_link: str,
    release_link: str,
    when: datetime.datetime,
    score: int,
    max_score: int,
    tests: list[dict[str, Any]],
    assignment_type: str,
    review_link: str | None = None,
    submitted_by: dict[str, Any] | None = None,
    graded_at: datetime.datetime | None = None,
) -> dict[str, Any]:
    """Build a v1-shaped result.json payload. Single source of the field
    layout shared by the error/vacuous paths (empty_result) and the
    declarative grader. `review` falls back to the commit view when
    review_link is None.

    `username` is the repo OWNER, emitted as `owner` (the identity anchor
    the collector validates). `assignment_type` ("individual"|"group")
    records the mode. No `usernames` field: who pushed is `submitted_by`,
    who owns the repo is `owner`, the credited member list is resolved by
    collection.

    `when` is the SUBMISSION instant (graded commit's committer date), emitted
    as `datetime`; invariant across regrades, so collect-scores' `late` marking
    never changes on a re-run. `graded_at` is THIS run's wall clock (defaults
    to now), purely informational."""
    result: dict[str, Any] = {
        "schema": RESULT_SCHEMA_V1,
        "classroom": classroom,
        "assignment": assignment,
        "assignment_type": assignment_type,
        "owner": username,
        "submission": submission,
        "commit": commit_link,
        "release": release_link,
        "review": review_link or commit_link,
        "datetime": when.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "graded_at": (graded_at or now_utc()).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "score": score,
        "max-score": max_score,
        "tests": tests,
    }
    if submitted_by is not None:
        result["submitted_by"] = submitted_by
    return result


def empty_result(
    *,
    classroom: str,
    assignment: str,
    username: str,
    submission: str,
    commit_link: str,
    release_link: str,
    when: datetime.datetime,
    assignment_type: str,
    review_link: str | None = None,
    submitted_by: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """A v1-valid result.json payload with no tests (score 0/0). Used for
    every error path — collect-scores ingests it as "submitted, error"; the
    workflow log carries the actual failure reason.
    """
    return make_result(
        classroom=classroom,
        assignment=assignment,
        username=username,
        submission=submission,
        commit_link=commit_link,
        release_link=release_link,
        when=when,
        score=0,
        max_score=0,
        tests=[],
        assignment_type=assignment_type,
        review_link=review_link,
        submitted_by=submitted_by,
    )


def derive_status_and_summary(result: dict[str, Any]) -> tuple[str, str]:
    """Map a result.json payload to a commit-status state + summary line.

    `success` when all tests pass (or zero tests — vacuous pass, "no
    autograder configured"). `failure` when any test failed. The error path
    is set explicitly by the runner, never derived here.
    """
    tests = result.get("tests") or []
    score = int(result.get("score") or 0)
    max_score = int(result.get("max-score") or 0)
    assignment = result.get("assignment") or "assignment"

    if not tests:
        return (
            "success",
            f"classroom50 autograde: submitted — no autograder configured for {assignment}",
        )

    passed = sum(1 for t in tests if t.get("passed"))
    total = len(tests)
    if passed == total:
        return "success", f"classroom50 autograde: {score}/{max_score} (all tests passed)"
    return "failure", f"classroom50 autograde: {score}/{max_score} ({passed}/{total} tests passed)"


def render_release_body(result: dict[str, Any], summary: str) -> str:
    """Render the Markdown body for the submit-tag release: the score line,
    then a per-test table (or just the summary when `tests` is empty). `|` in
    test names is escaped so it can't break the Markdown table.
    """
    score = int(result.get("score") or 0)
    max_score = int(result.get("max-score") or 0)
    tests = result.get("tests") or []

    lines = [f"### classroom50 autograde: {score}/{max_score}", ""]
    if tests:
        lines.append("| Test | Result | Score |")
        lines.append("|---|---|---|")
        for t in tests:
            ok = "PASS" if t.get("passed") else "FAIL"
            test_name = (t.get("test-name") or "").replace("|", "\\|")
            lines.append(
                f"| {test_name} | {ok} | "
                f"{int(t.get('score') or 0)} / {int(t.get('max-score') or 0)} |"
            )
        lines.append("")
        lines.append(f"Status: {summary}")
    else:
        lines.append(f"_{summary}_")
    return "\n".join(lines) + "\n"


def validate_result(
    data: Any, *, classroom: str, assignment: str, is_group: bool = False,
    owner: str | None = None,
) -> str | None:
    """None if `data` is v1-shaped for the given identity, else a
    human-readable error string.

    Mirrors collect_scores.py::validate_result so a payload passing here also
    passes gradebook ingest. Without parity, a malformed result.json (missing
    `owner`, non-int score, non-dict test entry, ...) would silently pass the
    runner, get published, and only be rejected on the next collect-scores run
    — the student appears not-yet-submitted with no signal in the log.

    `owner` (repo owner login) is the identity anchor: when provided it must
    equal `data["owner"]`. `assignment_type` must be "individual"/"group" and
    match the run's mode. No `usernames` field: who pushed is `submitted_by`,
    who owns is `owner`, the credited member list is resolved by collection.
    """
    if not isinstance(data, dict):
        return f"{RESULT_FILENAME} is not a JSON object"
    if data.get("schema") != RESULT_SCHEMA_V1:
        return f"{RESULT_FILENAME} schema is {data.get('schema')!r}, want {RESULT_SCHEMA_V1!r}"
    if data.get("classroom") != classroom:
        return (
            f"{RESULT_FILENAME} classroom is {data.get('classroom')!r}, "
            f"want {classroom!r}"
        )
    if data.get("assignment") != assignment:
        return (
            f"{RESULT_FILENAME} assignment is {data.get('assignment')!r}, "
            f"want {assignment!r}"
        )

    result_owner = data.get("owner")
    if not isinstance(result_owner, str) or not result_owner:
        return f"{RESULT_FILENAME} 'owner' must be a non-empty string"
    if owner is not None and result_owner.lower() != owner.lower():
        return (
            f"{RESULT_FILENAME} 'owner' is {result_owner!r}, want {owner!r} "
            f"(derived from the repo name)"
        )

    expected_type = "group" if is_group else "individual"
    assignment_type = data.get("assignment_type")
    if assignment_type != expected_type:
        return (
            f"{RESULT_FILENAME} 'assignment_type' is {assignment_type!r}, "
            f"want {expected_type!r}"
        )

    submission = data.get("submission")
    if not isinstance(submission, str) or not submission.startswith("submit/"):
        return f"{RESULT_FILENAME} 'submission' must be a 'submit/*' string"

    for field in ("commit", "release", "review", "datetime"):
        v = data.get(field)
        if not isinstance(v, str) or not v:
            return f"{RESULT_FILENAME} {field!r} must be a non-empty string"

    score = data.get("score")
    max_score = data.get("max-score")
    # Reject bool (an int subclass in Python) so True/False can't pass as scores.
    if isinstance(score, bool) or not isinstance(score, int) or score < 0:
        return f"{RESULT_FILENAME} 'score' must be a non-negative integer"
    if isinstance(max_score, bool) or not isinstance(max_score, int) or max_score < 0:
        return f"{RESULT_FILENAME} 'max-score' must be a non-negative integer"
    if score > max_score:
        return f"{RESULT_FILENAME} score ({score}) > max-score ({max_score})"

    tests = data.get("tests")
    if not isinstance(tests, list):
        return f"{RESULT_FILENAME} 'tests' is not a list"
    for i, t in enumerate(tests):
        if not isinstance(t, dict):
            return f"{RESULT_FILENAME} 'tests[{i}]' is not an object"
        name = t.get("test-name")
        if not isinstance(name, str) or not name:
            return f"{RESULT_FILENAME} 'tests[{i}].test-name' must be a non-empty string"
        if not isinstance(t.get("passed"), bool):
            return f"{RESULT_FILENAME} 'tests[{i}].passed' must be a boolean"
        ts, tm = t.get("score"), t.get("max-score")
        if isinstance(ts, bool) or not isinstance(ts, int) or ts < 0:
            return f"{RESULT_FILENAME} 'tests[{i}].score' must be a non-negative integer"
        if isinstance(tm, bool) or not isinstance(tm, int) or tm < 0:
            return f"{RESULT_FILENAME} 'tests[{i}].max-score' must be a non-negative integer"
        if ts > tm:
            return f"{RESULT_FILENAME} 'tests[{i}].score' ({ts}) > 'tests[{i}].max-score' ({tm})"

    # submitted_by is optional (older results omit it). When present: object
    # with a non-empty string username and int-or-null id — stamped by the
    # runner from GITHUB_ACTOR/GITHUB_ACTOR_ID.
    err = validate_submitted_by(data.get("submitted_by"), RESULT_FILENAME)
    if err is not None:
        return err
    return None


def validate_submitted_by(value: Any, filename: str) -> str | None:
    """Validate the optional `submitted_by` block (pusher identity). None/absent
    is allowed (older results omit it). When present: {"username": <non-empty
    str>, "id": <int|null>}. Shared shape so runner and collector agree. Returns
    an error string or None.
    """
    if value is None:
        return None
    if not isinstance(value, dict):
        return f"{filename} 'submitted_by' must be an object"
    uname = value.get("username")
    if not isinstance(uname, str) or not uname:
        return f"{filename} 'submitted_by.username' must be a non-empty string"
    sid = value.get("id")
    if sid is not None and (isinstance(sid, bool) or not isinstance(sid, int)):
        return f"{filename} 'submitted_by.id' must be an integer or null"
    return None


# ---------------------------------------------------------------------------
# I/O helpers
# ---------------------------------------------------------------------------


def _baseline_scan(workspace: pathlib.Path) -> tuple[str | None, str]:
    """Resolve the student's baseline commit and how it was found.

    Returns (sha, source) where source is one of the SOURCE_* constants:
      - SOURCE_ACCEPT:    the commit that introduced `.classroom50.yaml`
        (ACCEPT_MARKER_PATH). A trusted baseline.
      - SOURCE_ROOT:      the repo's root commit (no commit added the marker)
        -- a best-effort baseline.
      - SOURCE_GIT_ERROR: git ran but failed (e.g. "dubious ownership" in a
        container, or an un-deepenable shallow clone). History might exist; we
        couldn't read it. Distinct from SOURCE_NONE so the caller warns right.
      - SOURCE_NONE:      no history to resolve -- git unavailable or not a repo.
    sha is None for everything except SOURCE_ACCEPT / SOURCE_ROOT.
    """

    def git(*args: str) -> subprocess.CompletedProcess[str]:
        # `-c safe.directory=*` keeps the scan independent of the runner
        # OS/container: in a container the checkout is owned by the host runner
        # user but git runs as a different UID over a bind mount, tripping git's
        # "dubious ownership" guard. actions/checkout's exception is under a
        # temporary HOME restored before runner.py runs, so it's invisible here.
        return subprocess.run(
            ["git", "-c", "safe.directory=*", "-C", str(workspace), *args],
            capture_output=True, text=True, timeout=120, check=False,
        )

    try:
        # Is this a git repo at all? A git-less tarball checkout is
        # SOURCE_NONE; a real repo git refuses to read is SOURCE_GIT_ERROR.
        inside = git("rev-parse", "--git-dir")
        if inside.returncode != 0:
            low = inside.stderr.lower()
            if "not a git repository" in low or "no such file" in low:
                return None, SOURCE_NONE
            # Repo exists but git won't read it (dubious ownership, corruption,
            # locked index): history may exist.
            return None, SOURCE_GIT_ERROR
        shallow = git("rev-parse", "--is-shallow-repository")
        if shallow.returncode != 0:
            return None, SOURCE_GIT_ERROR
        if shallow.stdout.strip() == "true":
            # Depth-1 checkout (workflows predating fetch-depth: 0): deepen, or
            # the graft boundary would pose as the root. checkout's persisted
            # credentials authenticate the fetch.
            if git("fetch", "--quiet", "--unshallow", "origin").returncode != 0:
                return None, SOURCE_GIT_ERROR
        # Earliest commit that ADDED the marker wins, so a later re-add (delete
        # then restore) can't move the baseline forward and hide work from the
        # review diff. --diff-filter=A selects additions, --reverse oldest-first,
        # --first-parent stays on mainline. Run before the root-commit fallback.
        added = git(
            "log", "--reverse", "--first-parent", "--diff-filter=A",
            "--format=%H", "HEAD", "--", ACCEPT_MARKER_PATH,
        )
        # A failed marker query is history-unreadable, not "marker absent" --
        # SOURCE_GIT_ERROR so a transient git error doesn't degrade to root.
        if added.returncode != 0:
            return None, SOURCE_GIT_ERROR
        for line in added.stdout.splitlines():
            sha = line.strip()
            if sha:
                return sha, SOURCE_ACCEPT
        # No commit added the marker (hand-created repo): fall back to the root
        # commit for the best-effort review link.
        log = git("log", "--reverse", "--first-parent", "--format=%H", "HEAD")
        if log.returncode != 0:
            return None, SOURCE_GIT_ERROR
        for line in log.stdout.splitlines():
            sha = line.strip()
            if sha:
                return sha, SOURCE_ROOT
        return None, SOURCE_NONE
    except (OSError, subprocess.SubprocessError):
        return None, SOURCE_NONE


def baseline_sha(workspace: pathlib.Path) -> str | None:
    """SHA the student started from: the accept commit (which introduced
    `.classroom50.yaml`) when present, else the root commit. None when history
    is unavailable (no git, no .git, or an un-deepenable shallow clone) and the
    caller falls back to the commit view. Used for the review compare link,
    which tolerates the root fallback."""
    return _baseline_scan(workspace)[0]


def is_acceptance_commit(workspace: pathlib.Path, head_sha: str) -> bool:
    """Whether head_sha is the bare acceptance commit: the commit that
    introduced `.classroom50.yaml` (SOURCE_ACCEPT) with nothing on top.

    The setup job calls this to skip tagging/grading/release for a student's
    accept (nothing to grade yet). True only when the trusted accept commit is
    the tip; a submission stacks a fresh commit (submit uses `--allow-empty`),
    so head_sha != accept_sha. Fails open (False) on root fallback, git error,
    empty head_sha, or no accept commit.

    Final guard: the tip accept commit must touch ONLY the known setup paths
    (`ACCEPT_COMMIT_PATHS`). A student can rewrite history so the marker commit
    is the tip yet carries real work (amend + force-push, or a squash); skipping
    it would silently drop gradeable work, so an accept commit touching anything
    outside the setup set fails open (grade). A git error reading its paths also
    fails open.
    """
    if not head_sha:
        return False
    accept_sha, source = _baseline_scan(workspace)
    if not (source == SOURCE_ACCEPT and accept_sha == head_sha):
        return False
    return _accept_commit_is_setup_only(workspace, head_sha)


def _accept_commit_is_setup_only(workspace: pathlib.Path, head_sha: str) -> bool:
    """True only when every path the commit touches is in the known setup set
    (`ACCEPT_COMMIT_PATHS`). Fails open (False -> grade) on any git error or an
    empty path list, so a commit we can't fully inspect is treated as a
    submission rather than silently skipped.
    """

    def git(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", "-c", "safe.directory=*", "-C", str(workspace), *args],
            capture_output=True, text=True, timeout=120, check=False,
        )

    try:
        # Names of every path the commit changed vs its parent (root commit:
        # vs the empty tree). -r recurses, --no-renames keeps paths literal,
        # -z NUL-delimits so unusual filenames survive.
        changed = git(
            "show", "--no-renames", "--name-only", "--format=", "-r", "-z",
            head_sha,
        )
        if changed.returncode != 0:
            return False
        paths = [p for p in changed.stdout.split("\0") if p]
        if not paths:
            return False
        return all(p in ACCEPT_COMMIT_PATHS for p in paths)
    except (OSError, subprocess.SubprocessError):
        return False


def feedback_base_outcome(
    workspace: pathlib.Path,
    scan: tuple[str | None, str] | None = None,
) -> tuple[str | None, str]:
    """(feedback-PR-base-sha, scan-source) for `main()`, which needs both the
    base AND the trust signal. Same (sha, source) as `_baseline_scan`, but
    forces a null sha for non-openable sources so the caller's gate is a simple
    `sha is not None`: SOURCE_ACCEPT / SOURCE_ROOT open (root warns it's
    untrusted), SOURCE_GIT_ERROR / SOURCE_NONE skip.

    A reviewable diff against the root commit beats no Feedback PR at all, and
    the untrusted-baseline warning tells the teacher to verify.

    `scan` lets a caller that already ran `_baseline_scan` (e.g. main(), which
    also needs the review-link baseline) reuse it instead of re-walking history
    -- the scan issues several sequential git calls, so a second walk doubles
    the worst-case time against the job ceiling.
    """
    sha, source = scan if scan is not None else _baseline_scan(workspace)
    return (sha, source) if source in SOURCE_OPENABLE else (None, source)


def _is_control_path(rel: str) -> bool:
    """Whether rel is a control path allowed_files must never remove."""
    if rel in ALLOWED_FILES_KEEP_EXACT:
        return True
    return any(rel.startswith(p) for p in ALLOWED_FILES_KEEP_PREFIXES)


def parse_allowed_files(raw: str | None) -> list[str]:
    """Parse the ALLOWED_FILES env (JSON array of patterns). Empty, absent, or
    malformed -> [] so a bad value never strips files."""
    if not raw or not raw.strip():
        return []
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        print("runner: ALLOWED_FILES is not valid JSON; skipping allowed_files enforcement", file=sys.stderr)
        return []
    if not isinstance(value, list) or not all(isinstance(p, str) and p.strip() for p in value):
        print("runner: ALLOWED_FILES must be a JSON array of non-empty strings; skipping enforcement", file=sys.stderr)
        return []
    return value


def _ascii_fold(value: str) -> str:
    return value.translate(str.maketrans(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"
    ))


def validate_release_asset_paths(value: Any) -> list[str]:
    if not isinstance(value, list):
        raise ValueError("release_assets must be an array")
    if len(value) > RELEASE_ASSETS_MAX_FILES:
        raise ValueError(
            f"release_assets has {len(value)} paths "
            f"(max {RELEASE_ASSETS_MAX_FILES})"
        )

    seen_paths: set[str] = set()
    seen_basenames: set[str] = set()
    total_path_bytes = 0
    for index, configured_path in enumerate(value):
        where = f"release_assets[{index}]"
        if not isinstance(configured_path, str) or not configured_path.strip():
            raise ValueError(f"{where} must be a non-empty string")
        if any(0xD800 <= ord(char) <= 0xDFFF for char in configured_path):
            raise ValueError(f"{where} must not contain Unicode surrogates")
        total_path_bytes += len(configured_path.encode("utf-8"))
        if total_path_bytes > RELEASE_ASSETS_MAX_PATH_BYTES:
            raise ValueError(
                f"release_assets paths exceed {RELEASE_ASSETS_MAX_PATH_BYTES} "
                "UTF-8 bytes"
            )
        if configured_path.startswith("/") or re.match(
            r"^[A-Za-z]:", configured_path, re.ASCII
        ):
            raise ValueError(f"{where} must be relative")
        if "\\" in configured_path:
            raise ValueError(f"{where} must use '/' separators")
        if any(ord(char) < 0x20 or 0x7F <= ord(char) <= 0x9F
               for char in configured_path):
            raise ValueError(f"{where} must not contain control characters")

        segments = configured_path.split("/")
        if any(segment in ("", ".", "..") for segment in segments):
            raise ValueError(f"{where} has an invalid path segment")
        if _ascii_fold(segments[0]) == ".git":
            raise ValueError(f"{where} must not select the root .git tree")

        basename = segments[-1]
        folded_basename = _ascii_fold(basename)
        if not RELEASE_ASSET_BASENAME.fullmatch(basename) or ".." in basename:
            raise ValueError(f"{where} basename {basename!r} is not Release-safe")
        if folded_basename in ("result.json", "release-body.md"):
            raise ValueError(f"{where} basename {basename!r} is reserved")
        if configured_path in seen_paths:
            raise ValueError(f"{where} duplicates path {configured_path!r}")
        if basename in seen_basenames:
            raise ValueError(f"{where} duplicates basename {basename!r}")
        seen_paths.add(configured_path)
        seen_basenames.add(basename)
    return list(value)


def parse_release_assets(raw: str | None) -> list[str]:
    if raw is None or not raw.strip():
        return []
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("RELEASE_ASSETS is not valid JSON") from exc
    return validate_release_asset_paths(value)


def _workflow_warning(message: str) -> None:
    escaped = "".join(
        char if 0x20 <= ord(char) < 0x7F else f"\\u{ord(char):04x}"
        for char in message
    ).replace("%", "%25")
    print(f"::warning::{escaped}")


def open_release_asset_source(
    workspace: pathlib.Path, configured_path: str
) -> int:
    """Open the configured leaf for reading WITHOUT following any symlink, and
    return the pinned file descriptor. Every segment is opened with
    O_NOFOLLOW/O_DIRECTORY so a symlink swapped onto a parent or the leaf after
    validation (a student process double-forked during grading survives into
    post-grade staging) is rejected at open time — closing the validate-then-
    reopen TOCTOU. The returned fd is what _copy_release_asset reads from, so
    the copy can never re-resolve the path against a mutated tree. Caller owns
    closing the fd."""
    validate_release_asset_paths([configured_path])
    segments = configured_path.split("/")
    dir_fd = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    leaf_fd = -1
    try:
        for index, segment in enumerate(segments):
            is_leaf = index == len(segments) - 1
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
            if not is_leaf:
                flags |= os.O_DIRECTORY
            try:
                next_fd = os.open(segment, flags, dir_fd=dir_fd)
            except OSError as exc:
                # O_NOFOLLOW rejects a symlink with ELOOP; O_DIRECTORY on a
                # symlink-to-dir can surface as ENOTDIR first. lstat the segment
                # (relative to the current dir fd, no follow) to report a
                # symlinked segment precisely rather than as a plain non-dir.
                if exc.errno in (errno.ELOOP, errno.ENOTDIR):
                    try:
                        seg_info = os.lstat(segment, dir_fd=dir_fd)
                    except OSError:
                        seg_info = None
                    if seg_info is not None and stat.S_ISLNK(seg_info.st_mode):
                        raise ValueError(
                            f"{configured_path!r} contains a symlink"
                        ) from exc
                    if not is_leaf and exc.errno == errno.ENOTDIR:
                        raise ValueError(
                            f"{configured_path!r} has a non-directory parent"
                        ) from exc
                raise
            if is_leaf:
                info = os.fstat(next_fd)
                if not stat.S_ISREG(info.st_mode):
                    os.close(next_fd)
                    raise ValueError(
                        f"{configured_path!r} is not a regular file"
                    )
                leaf_fd = next_fd
            else:
                os.close(dir_fd)
                dir_fd = next_fd
        return leaf_fd
    except BaseException:
        if leaf_fd >= 0:
            os.close(leaf_fd)
        raise
    finally:
        os.close(dir_fd)


def _copy_release_asset(
    source_fd: int, destination: pathlib.Path, max_bytes: int
) -> int:
    """Copy from an already-open, symlink-free source fd (see
    open_release_asset_source) to `destination`, capped at max_bytes. Reading
    the pinned fd — never re-opening by path — is what makes this copy immune to
    a symlink swapped in after validation."""
    copied = 0
    created = False
    try:
        with os.fdopen(source_fd, "rb", closefd=False) as input_file, \
                destination.open("xb") as output_file:
            created = True
            while chunk := input_file.read(1024 * 1024):
                if copied + len(chunk) > max_bytes:
                    raise ValueError(
                        f"{destination.name!r} exceeds the remaining byte budget"
                    )
                output_file.write(chunk)
                copied += len(chunk)
    except (OSError, ValueError):
        if created:
            try:
                destination.unlink(missing_ok=True)
            except OSError:
                pass
        raise
    return copied


def stage_release_assets(
    workspace: pathlib.Path,
    destination: pathlib.Path,
    configured_paths: list[str],
) -> list[str]:
    configured_paths = validate_release_asset_paths(configured_paths)
    try:
        existing = destination.lstat()
    except FileNotFoundError:
        pass
    else:
        if stat.S_ISDIR(existing.st_mode) and not stat.S_ISLNK(existing.st_mode):
            shutil.rmtree(destination)
        else:
            destination.unlink()
    destination.mkdir(parents=True)

    accepted: list[str] = []
    total = 0
    for configured_path in configured_paths:
        basename = configured_path.split("/")[-1]
        target = destination / basename
        copy_attempted = False
        try:
            try:
                target.lstat()
            except FileNotFoundError:
                pass
            else:
                raise FileExistsError(
                    f"release asset {basename!r} has a runtime destination collision"
                )
            source_fd = open_release_asset_source(workspace, configured_path)
            copy_attempted = True
            try:
                copied = _copy_release_asset(
                    source_fd, target, RELEASE_ASSETS_MAX_BYTES - total
                )
            finally:
                os.close(source_fd)
        except (OSError, ValueError) as exc:
            if copy_attempted:
                try:
                    target.unlink(missing_ok=True)
                except OSError:
                    pass
            _workflow_warning(f"release_assets: {configured_path!r} skipped ({exc})")
            continue
        total += copied
        accepted.append(basename)
    return accepted


def _stage_release_assets_and_emit(
    workspace: pathlib.Path, github_output: str | None, rc: int
) -> int:
    """Stage the configured release assets after grading and emit the staged
    dir + accepted basenames + skipped count to $GITHUB_OUTPUT. Fail-open: any
    staging error only warns and never changes `rc` (the grade result). Split
    out of main() so the staging/output contract the workflow upload step
    depends on is unit-testable without the full grading pipeline."""
    accepted_assets: list[str] = []
    configured_asset_count = 0
    staging_dir = (
        pathlib.Path(
            os.environ.get("RUNNER_TEMP")
            or tempfile.mkdtemp(prefix="classroom50-")
        )
        / RELEASE_ASSETS_DIRNAME
    )
    try:
        configured_paths = parse_release_assets(os.environ.get("RELEASE_ASSETS"))
        configured_asset_count = len(configured_paths)
        accepted_assets = stage_release_assets(
            workspace, staging_dir, configured_paths
        )
    except (OSError, ValueError) as exc:
        _workflow_warning(f"release_assets: staging disabled ({exc})")

    skipped = configured_asset_count - len(accepted_assets)
    if skipped > 0:
        # Machine-readable signal so a teacher can tell a fully-published
        # Release from a partial one without scraping ::warning:: annotations.
        print(
            f"::notice::release_assets: attached {len(accepted_assets)} of "
            f"{configured_asset_count} configured file(s); {skipped} skipped"
        )

    if github_output:
        try:
            with open(github_output, "a") as output:
                # release-assets-dir is the absolute staged dir the workflow
                # upload step reads (see STAGED_RELEASE_DIR in the workflow).
                output.write(f"release-assets={','.join(accepted_assets)}\n")
                output.write(f"release-assets-dir={staging_dir}\n")
                output.write(f"release-assets-skipped={skipped}\n")
        except OSError as exc:
            _workflow_warning(f"release_assets: could not emit staged names ({exc})")
    return rc


def _isolated_git_env() -> dict[str, str]:
    """Environment that ignores the host's git config so allowed_files patterns
    classify identically on every runner. Paired with `-c core.excludesFile`.
    Mirrors Go's isolatedGitEnv."""
    env = dict(os.environ)
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    return env


def _walk_workspace_files(workspace: pathlib.Path) -> list[str]:
    """All regular-file relative paths (forward-slash) under `workspace`,
    skipping `.git` at any depth. Unlike `git ls-files`, recurses into nested
    git repos so files hidden inside one can't escape the allowlist. Symlinks
    are reported as their own path."""
    results: list[str] = []
    for dirpath, dirnames, filenames in os.walk(workspace):
        dirnames[:] = [d for d in dirnames if d != ".git"]
        rel_dir = os.path.relpath(dirpath, workspace)
        for name in filenames:
            rel = name if rel_dir == "." else os.path.join(rel_dir, name)
            results.append(pathlib.PurePath(rel).as_posix())
    return results


def _classify_disallowed(patterns: list[str], paths: list[str]) -> list[str] | None:
    """Subset of `paths` the `patterns` disallow, or None when the matcher
    couldn't run (caller then skips enforcement — fail open). Delegates to `git
    check-ignore` against a throwaway, config-isolated repo. Mirrors Go's
    ignorematch.Disallowed; both pinned by the shared fixture
    cli/shared/testdata/allowed_files_matcher_cases.json."""
    if not patterns or not paths:
        return []
    git_env = _isolated_git_env()
    # A hung git raises subprocess.TimeoutExpired (a SubprocessError, not an
    # OSError); a missing git binary raises OSError. Both must surface as
    # "matcher couldn't run" (return None), not an uncaught traceback —
    # mirroring _baseline_scan's SubprocessError handling.
    try:
        with tempfile.TemporaryDirectory(prefix="classroom50-ignore-") as tmp:
            tmp_path = pathlib.Path(tmp)
            init = subprocess.run(
                ["git", "-C", tmp, "init", "-q"],
                capture_output=True, text=True, timeout=60, check=False, env=git_env,
            )
            if init.returncode != 0:
                print("runner: allowed_files enforcement skipped (could not init matcher repo)", file=sys.stderr)
                return None
            (tmp_path / ".gitignore").write_text("\n".join(patterns) + "\n")
            checked = subprocess.run(
                ["git", "-c", f"core.excludesFile={os.devnull}", "-C", tmp,
                 "check-ignore", "--no-index", "--stdin", "-z"],
                input="\x00".join(paths) + "\x00",
                capture_output=True, text=True, timeout=120, check=False, env=git_env,
            )
    except (subprocess.SubprocessError, OSError) as exc:
        print(f"runner: allowed_files enforcement skipped (matcher failed: {exc})", file=sys.stderr)
        return None
    # check-ignore: 0 = >=1 ignored, 1 = none, >1 = error.
    if checked.returncode not in (0, 1):
        print(f"runner: allowed_files enforcement skipped (check-ignore rc={checked.returncode}: "
              f"{checked.stderr.strip()})", file=sys.stderr)
        return None
    return [p for p in checked.stdout.split("\x00") if p]


def enforce_allowed_files(workspace: pathlib.Path, patterns: list[str]) -> list[str]:
    """Remove every working-tree file the allowed_files patterns disallow so
    the autograder only sees allowed files. Control files are always kept.
    Working-tree-only, so the baseline and review/Feedback-PR links are
    unaffected. Returns the sorted removed paths; no-ops when patterns is empty.

    Fails OPEN: if the matcher can't run for a non-empty allowlist (tree
    enumeration failure, git init/check-ignore error, or timeout), returns []
    (skip enforcement, grade the unfiltered tree) rather than blocking the
    grade. The submit-side filter is best-effort too.

    To fail CLOSED instead (treat the allowlist as an authoritative security
    boundary), change the two `return []` failure branches below to raise and
    have main() route it through finalize.error(...) so the submission lands as
    an `error` result. The decision is intentionally fail-open: allowed_files
    is a grading-scope/hygiene tool, not a secret-hiding control.
    """
    if not patterns:
        return []

    # Walk the tree directly: `git ls-files` won't recurse into a nested repo,
    # so a student could hide disallowed files there. The walk skips every
    # `.git` so git metadata is never enumerated or removed.
    try:
        candidates = _walk_workspace_files(workspace)
    except OSError as exc:
        # Fail open (see docstring); to fail closed, raise here instead.
        print(f"runner: allowed_files enforcement skipped (walk failed: {exc})", file=sys.stderr)
        return []

    candidates = [p for p in candidates if not _is_control_path(p)]
    if not candidates:
        return []

    # None = matcher couldn't run. Fail open (see docstring); to fail closed,
    # raise here and surface via finalize.error in main().
    disallowed = _classify_disallowed(patterns, candidates)
    if disallowed is None:
        return []

    removed: list[str] = []
    for rel in disallowed:
        if _is_control_path(rel):
            continue
        target = workspace / rel
        try:
            target.unlink()
            removed.append(rel)
        except FileNotFoundError:
            continue
        except OSError as exc:
            print(f"runner: could not remove disallowed file {rel}: {exc}", file=sys.stderr)

    removed.sort()
    if removed:
        print(f"runner: removed {len(removed)} file(s) outside the assignment's allowed_files set: "
              f"{', '.join(removed)}")
    return removed


def render_removed_files_note(removed: list[str]) -> str:
    """Markdown section listing files stripped by allowed_files, appended to
    release-body.md so a renamed/missing required file is visible."""
    lines = [
        "",
        f"### Removed {len(removed)} file(s) outside the assignment's allowed files",
        "",
        "These files are not in this assignment's `allowed_files` set, so the "
        "autograder did not see them:",
        "",
    ]
    lines.extend(f"- `{rel}`" for rel in removed)
    lines.append("")
    return "\n".join(lines)


def append_removed_files_note(workspace: pathlib.Path, removed: list[str]) -> None:
    """Append the removed-files note to release-body.md. Best-effort: a
    missing body or write error must not fail the grade."""
    if not removed:
        return
    body_path = workspace / RELEASE_BODY_FILENAME
    try:
        existing = body_path.read_text() if body_path.exists() else ""
        body_path.write_text(existing + render_removed_files_note(removed))
    except OSError as exc:
        print(f"runner: could not append removed-files note to {RELEASE_BODY_FILENAME}: {exc}", file=sys.stderr)


def no_baseline_warning(source: str = SOURCE_NONE) -> str:
    """GitHub workflow annotation when no baseline resolves and the Feedback
    PR step will SKIP. A pure helper so the `::warning::` prefix (which routes
    it to GitHub's annotation stream) is unit-testable.

    Only unopenable sources reach here (SOURCE_ROOT opens the PR with
    `untrusted_baseline_warning` instead). SOURCE_GIT_ERROR = git couldn't read
    history (a baseline may exist); SOURCE_NONE = not a git repo / no history.
    """
    prefix = "::warning title=classroom50 Feedback PR::"
    if source == SOURCE_GIT_ERROR:
        return (
            f"{prefix}could not read git history to resolve the Feedback PR "
            "baseline; a baseline may exist but git could not read it (e.g. a "
            "container's 'dubious ownership' guard). The Feedback PR step will "
            "skip. See the runner log above for the git error."
        )
    return (
        f"{prefix}no git history found to anchor the Feedback PR baseline "
        "(not a git repository), so the Feedback PR step will skip. Was this "
        "repo created by an accept flow?"
    )


def untrusted_baseline_warning() -> str:
    """GitHub workflow annotation when the Feedback PR opens against the repo's
    root commit instead of the trusted accept commit (no commit detected adding
    `.classroom50.yaml`). The PR is still useful; the teacher gets a heads-up
    that the frozen base may include starter/plumbing work, so the diff could
    be larger than usual.

    A `::warning::` annotation (not a plain log) so it shows in the run summary.
    Pure helper for the same testability reason as `no_baseline_warning`."""
    return (
        "::warning title=classroom50 Feedback PR::opened the Feedback PR "
        f"against the repo's root commit -- no commit was detected as adding "
        f"{ACCEPT_MARKER_PATH}, so this baseline is UNTRUSTED and the review "
        "diff may include starter/plumbing files. Verify the repo was created "
        "by an accept flow if the diff looks larger than expected."
    )



def fetch_url(url: str) -> bytes | None:
    """GET `url`. 200 → bytes (≤ MAX_FETCH_BYTES), 404 → None,
    transient 5xx/network failures retried with exponential backoff."""
    last_exc: Exception | None = None
    for attempt in range(FETCH_ATTEMPTS):
        req = urllib.request.Request(url, headers={"User-Agent": "classroom50-autograde"})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read(MAX_FETCH_BYTES + 1)
                if len(body) > MAX_FETCH_BYTES:
                    raise ValueError(f"response from {url} exceeds {MAX_FETCH_BYTES}-byte ceiling")
                return body
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            last_exc = exc
            if exc.code < 500 or attempt == FETCH_ATTEMPTS - 1:
                raise
        except urllib.error.URLError as exc:
            last_exc = exc
            if attempt == FETCH_ATTEMPTS - 1:
                raise
        time.sleep(2 ** attempt)
    raise RuntimeError(f"fetch_url exhausted retries: {last_exc!r}")


def extract_tarball(data: bytes, dest: pathlib.Path) -> None:
    """Safe-extract a gzipped tar archive into `dest`.

    Prefers `tarfile.extractall(filter='data')` (Python 3.12+) to block
    path-traversal and unsafe member types. Falls back to a manual prefix
    check on older interpreters, since `runtime.python` lets teachers pin
    3.10/3.11 and the container path inherits the image's python.
    """
    dest.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        if sys.version_info >= (3, 12):
            tar.extractall(path=dest, filter="data")
            return
        _safe_extractall_legacy(tar, dest)


def _safe_extractall_legacy(tar: tarfile.TarFile, dest: pathlib.Path) -> None:
    """Path-traversal-safe extraction for Python < 3.12. Mirrors the
    rejections `filter='data'` enforces upstream: no absolute paths, no `..`
    escaping `dest`, no symlinks/hard links, no device/FIFO/char-special
    members. Sane bundles (git archive / tar -czf) extract identically both
    ways.
    """
    dest_real = pathlib.Path(os.path.realpath(dest))
    for m in tar.getmembers():
        if m.issym() or m.islnk() or m.isdev() or m.ischr() or m.isfifo():
            raise ValueError(f"unsupported tar member type: {m.name!r}")
        if not m.name or os.path.isabs(m.name) or m.name.startswith(".."):
            raise ValueError(f"unsafe tar path: {m.name!r}")
        target = pathlib.Path(os.path.realpath(dest_real / m.name))
        if target != dest_real and dest_real not in target.parents:
            raise ValueError(f"unsafe tar path: {m.name!r}")
    tar.extractall(path=dest)


def output_has_status(github_output_path: str | None) -> bool:
    """Did the autograder write a status= line to $GITHUB_OUTPUT?"""
    if not github_output_path:
        return False
    p = pathlib.Path(github_output_path)
    if not p.is_file():
        return False
    return any(line.startswith("status=") for line in p.read_text().splitlines())


def append_outputs(github_output_path: str | None, status: str, summary: str) -> None:
    if not github_output_path:
        return
    safe_summary = summary.replace("\n", " ").replace("\r", " ")
    with open(github_output_path, "a") as fh:
        fh.write(f"status={status}\n")
        fh.write(f"summary={safe_summary}\n")


def append_sha_outputs(
    github_output_path: str | None, base_sha: str | None, head_sha: str
) -> None:
    """Write `baseline-sha` and `head-sha` to $GITHUB_OUTPUT for the Feedback
    PR step. `baseline-sha` is omitted (empty) when there's no usable baseline,
    which the step treats as "skip". SHAs are `[0-9a-f]{40}` so they can't
    inject extra output lines."""
    if not github_output_path:
        return
    with open(github_output_path, "a") as fh:
        fh.write(f"head-sha={head_sha}\n")
        if base_sha:
            fh.write(f"baseline-sha={base_sha}\n")


def now_utc() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def commit_submitted_at(sha: str, workspace: pathlib.Path) -> datetime.datetime:
    """The SUBMISSION instant for a graded commit: its committer date, read
    from git in the (full-depth) checkout and normalized to aware UTC. Invariant
    for a given commit, so re-grading it reproduces the identical `datetime` in
    result.json — the submission time and `late` flag never move.

    Falls back to now_utc() when the SHA is empty or git can't read the committer
    date (shallow clone, detached state, git error): lateness is advisory and a
    regrade must never fail or drop a submission over an unreadable timestamp. A
    normal full-depth checkout always resolves.
    """
    if not sha:
        return now_utc()
    try:
        proc = subprocess.run(
            ["git", "show", "-s", "--format=%cI", sha],
            cwd=str(workspace),
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return now_utc()
    if proc.returncode != 0:
        return now_utc()
    raw = (proc.stdout or "").strip()
    if not raw:
        return now_utc()
    try:
        # %cI is strict ISO-8601 with an offset (e.g. 2026-06-30T12:00:00+01:00).
        parsed = datetime.datetime.fromisoformat(raw)
    except ValueError:
        return now_utc()
    if parsed.tzinfo is None:
        return now_utc()
    # Normalize to UTC so the YYYY-MM-DDTHH:MM:SSZ format (and the late
    # comparison) is timezone-correct regardless of the committer's offset.
    return parsed.astimezone(datetime.timezone.utc)


def mode_is_group(mode: str | None) -> bool:
    """True only when the assignment mode is exactly 'group' (case- and
    whitespace-insensitive). Anything else — None, '', or unrecognized — is
    individual, so a missing/typo'd MODE env can never loosen validation (only
    require the stricter individual `assignment_type`). Mirrors the setup job's
    mode normalization."""
    return (mode or "").strip().lower() == "group"


# ---------------------------------------------------------------------------
# Error finalizer
# ---------------------------------------------------------------------------


class Finalizer:
    """Synthesizes a v1 result.json + release body + GITHUB_OUTPUT entries on
    any error path. The runner calls `.error(message)` instead of returning a
    non-zero exit code so the downstream publish step still has something to
    upload."""

    def __init__(
        self,
        *,
        workspace: pathlib.Path,
        github_output: str | None,
        classroom: str,
        assignment: str,
        username: str,
        submission: str,
        commit_link: str,
        release_link: str,
        review_link: str | None = None,
        submitted_by: dict[str, Any] | None = None,
        assignment_type: str = "individual",
        submitted_at: datetime.datetime | None = None,
    ):
        self.workspace = workspace
        self.github_output = github_output
        self.classroom = classroom
        self.assignment = assignment
        self.username = username
        self.submission = submission
        self.commit_link = commit_link
        self.release_link = release_link
        self.review_link = review_link
        self.submitted_by = submitted_by
        self.assignment_type = assignment_type
        # The graded commit's committer date — the invariant submission instant
        # written as `datetime`. Defaults to now only when a caller didn't
        # resolve it (keeps older call sites / tests working).
        self.submitted_at = submitted_at or now_utc()

    def error(self, message: str) -> int:
        print(f"::error::{message}", file=sys.stderr)
        result = empty_result(
            classroom=self.classroom,
            assignment=self.assignment,
            username=self.username,
            submission=self.submission,
            commit_link=self.commit_link,
            release_link=self.release_link,
            when=self.submitted_at,
            review_link=self.review_link,
            submitted_by=self.submitted_by,
            assignment_type=self.assignment_type,
        )
        summary = f"classroom50 autograde: {message}"
        (self.workspace / RESULT_FILENAME).write_text(json.dumps(result, indent=2) + "\n")
        (self.workspace / RELEASE_BODY_FILENAME).write_text(render_release_body(result, summary))
        # Always overwrite — the autograder may have written a stale
        # status= before exiting non-zero or producing bad output.
        append_outputs(self.github_output, "error", summary)
        return 0

    def no_autograder(self) -> int:
        """Vacuous-pass synthesis for classrooms with no autograder configured
        yet. Distinct from `error()` because "no autograder configured" is a
        valid mid-setup state, not a failure: the student submitted, the
        workflow tagged, and the gradebook records 0/0 success rather than an
        error. Reuses derive_status_and_summary's empty-tests branch."""
        result = empty_result(
            classroom=self.classroom,
            assignment=self.assignment,
            username=self.username,
            submission=self.submission,
            commit_link=self.commit_link,
            release_link=self.release_link,
            when=self.submitted_at,
            review_link=self.review_link,
            submitted_by=self.submitted_by,
            assignment_type=self.assignment_type,
        )
        status, summary = derive_status_and_summary(result)
        print(f"runner: {summary}")
        (self.workspace / RESULT_FILENAME).write_text(json.dumps(result, indent=2) + "\n")
        (self.workspace / RELEASE_BODY_FILENAME).write_text(render_release_body(result, summary))
        append_outputs(self.github_output, status, summary)
        return 0


# ---------------------------------------------------------------------------
# Declarative test grading (GitHub Classroom-style io / run / python tests)
# ---------------------------------------------------------------------------
#
# Grades a bundled tests.json with a built-in interpreter. The specs are DATA,
# never code: `run`/`setup` strings are teacher-authored shell, executed in the
# student checkout at the same privilege as an autograder.py. They arrive via
# the Pages bundle — never interpolated into workflow YAML — and students can't
# edit assignments.json. The interpreter re-validates spec shape because the
# file is hand-editable. Write-time validator: tests.go; trust-boundary
# rationale: the Autograders wiki page.


class TestsConfigError(Exception):
    """tests.json is missing, malformed, or fails runtime re-validation.
    Surfaced to the workflow via Finalizer.error."""


class TestFixtureError(Exception):
    """A test references an input-file/expected-file that is missing or escapes
    the bundle directory."""


def compare_output(actual: str, expected: str, mode: str) -> bool:
    """Compare program stdout against expected output, GitHub Classroom-style.

    - included: expected appears anywhere in actual (raw substring).
    - exact: equal ignoring leading/trailing whitespace (the trailing-newline
      footgun otherwise fails almost every test).
    - regex: `re.search` with re.MULTILINE (^/$ anchor at line boundaries).
      Raises re.error on a bad pattern so the caller reports a failing test.
    """
    if mode == COMPARISON_INCLUDED:
        return expected in actual
    if mode == COMPARISON_EXACT:
        return actual.strip() == expected.strip()
    if mode == COMPARISON_REGEX:
        return re.search(expected, actual, re.MULTILINE) is not None
    raise ValueError(f"unknown comparison mode {mode!r}")


def _clip(text: str | None) -> str:
    """Truncate captured output for the release body."""
    text = text or ""
    if len(text) > MAX_CAPTURED_CHARS:
        return text[:MAX_CAPTURED_CHARS] + "\n... (truncated)"
    return text


def _fence(text: str) -> str:
    """A backtick fence longer than any backtick run inside `text`, so student
    output containing ``` can't break out of the code block and inject Markdown
    into the release body."""
    longest = max((len(m.group(0)) for m in re.finditer(r"`+", text)), default=0)
    return "`" * max(3, longest + 1)


def _make_outcome(name: str, points: int, passed: bool, detail: str,
                  *, score: int | None = None) -> dict[str, Any]:
    """One test's outcome. Carries the v1 result-row fields plus a `detail`
    string used only for the release body (stripped before result.json)."""
    if score is None:
        score = points if passed else 0
    return {
        "test-name": name,
        "passed": passed,
        "score": score,
        "max-score": points,
        "detail": detail,
    }


def _read_fixture(rel: str, fixtures_dir: pathlib.Path) -> str:
    """Read a bundled fixture file, rejecting any path that escapes the bundle
    directory (a hand-edited expected-file '../../etc/passwd' must not be
    readable)."""
    base = pathlib.Path(os.path.realpath(fixtures_dir))
    target = pathlib.Path(os.path.realpath(base / rel))
    if target != base and base not in target.parents:
        raise TestFixtureError(f"fixture path escapes the bundle: {rel!r}")
    if not target.is_file():
        raise TestFixtureError(f"fixture file not found: {rel!r}")
    return target.read_text(encoding="utf-8", errors="replace")


def _resolve_stdin(spec: dict[str, Any], fixtures_dir: pathlib.Path) -> str:
    """stdin for an io test: the bundled input-file if set, else the inline
    `input`, else empty (always a string so the child never inherits the
    parent's stdin and hangs on a terminal)."""
    if spec.get("input-file"):
        return _read_fixture(spec["input-file"], fixtures_dir)
    return spec.get("input") or ""


def _resolve_expected(spec: dict[str, Any], fixtures_dir: pathlib.Path) -> str:
    if spec.get("expected-file"):
        return _read_fixture(spec["expected-file"], fixtures_dir)
    return spec.get("expected") or ""


def _run_command(command: str, cwd: pathlib.Path, timeout: int,
                 stdin: str = "") -> subprocess.CompletedProcess[str]:
    """Run a shell command in the student checkout with captured text output
    and an empty-by-default stdin."""
    return subprocess.run(
        command,
        shell=True,
        cwd=str(cwd),
        input=stdin,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def _run_setup(setup: str, cwd: pathlib.Path, timeout: int) -> str | None:
    """Run a test's setup command. Returns an error string if it times out or
    exits non-zero, else None."""
    try:
        sp = _run_command(setup, cwd, timeout)
    except subprocess.TimeoutExpired:
        return f"setup timed out after {timeout}s"
    except OSError as exc:
        return f"setup failed to start: {exc}"
    if sp.returncode != 0:
        return f"setup exited {sp.returncode}\n{_clip(sp.stderr or sp.stdout)}"
    return None


# import name -> pip package for the pytest deps bare setup-python omits (#212).
_PYTEST_DEPS = {"pytest": "pytest", "pytest_jsonreport": "pytest-json-report"}

# Floor for the auto-install budget: the 10s default per-test timeout is too
# small for a cold install, which would silently no-op the #212 fix.
PIP_INSTALL_TIMEOUT = 120


def _ensure_pytest(cwd: pathlib.Path, timeout: int) -> None:
    """Best-effort, idempotent install of the pytest deps missing from the
    grading interpreter; never raises (offline runner falls back to #212)."""
    missing = [package for module, package in _PYTEST_DEPS.items()
               if importlib.util.find_spec(module) is None]
    if not missing:
        return
    install = (f"{shlex.quote(sys.executable)} -m pip install --quiet "
               + " ".join(shlex.quote(p) for p in missing))
    try:
        # Own budget, not the per-test timeout: the 10s default is too small
        # for a cold install and would leave the deps missing.
        _run_command(install, cwd, max(timeout, PIP_INSTALL_TIMEOUT))
    except (subprocess.SubprocessError, OSError):
        pass


def _grade_python(spec: dict[str, Any], cwd: pathlib.Path, timeout: int,
                  points: int, name: str) -> dict[str, Any]:
    """Split `points` across cases via pytest-json-report (deps auto-installed
    by _ensure_pytest), falling back to exit-code scoring when no report."""
    _ensure_pytest(cwd, timeout)
    report_dir = pathlib.Path(tempfile.mkdtemp(prefix="classroom50-pytest-"))
    report = report_dir / "report.json"
    # Skip appending when the teacher's command already configures the plugin
    # (duplicate flags make pytest exit with a usage error).
    if "--json-report" in spec["run"]:
        cmd = spec["run"]
    else:
        cmd = f"{spec['run']} --json-report --json-report-file={shlex.quote(str(report))}"
    try:
        rp = _run_command(cmd, cwd, timeout)
    except subprocess.TimeoutExpired:
        shutil.rmtree(report_dir, ignore_errors=True)
        return _make_outcome(name, points, False, f"timed out after {timeout}s")
    except OSError as exc:
        shutil.rmtree(report_dir, ignore_errors=True)
        return _make_outcome(name, points, False, f"failed to start: {exc}")

    passed_n = total_n = None
    if report.is_file():
        try:
            summary = (json.loads(report.read_text(encoding="utf-8", errors="replace"))
                       .get("summary") or {})
            total_n = int(summary.get("total") or 0)
            passed_n = int(summary.get("passed") or 0)
        except (json.JSONDecodeError, ValueError, TypeError, AttributeError):
            passed_n = total_n = None
    shutil.rmtree(report_dir, ignore_errors=True)

    if total_n:
        score = max(0, min(points, round(points * passed_n / total_n)))
        passed = passed_n == total_n
        # Full credit is reserved for an all-pass run: with small point values
        # round() could otherwise award points/points to a FAIL row (e.g.
        # points=1, 2/3 cases passed).
        if not passed:
            score = min(score, max(0, points - 1))
        detail = f"pytest: {passed_n}/{total_n} cases passed"
        if not passed:
            detail += "\n" + _clip(rp.stdout or rp.stderr)
        return _make_outcome(name, points, passed, detail, score=score)

    # Fallback: no parseable report -> all-or-nothing on the exit code
    # (e.g. an offline runner couldn't load pytest-json-report).
    passed = rp.returncode == 0
    detail = (f"pytest exit {rp.returncode} "
              f"(no JSON report from pytest-json-report; scored on exit code)")
    if not passed:
        detail += "\n" + _clip(rp.stdout or rp.stderr)
    return _make_outcome(name, points, passed, detail)


def execute_test(spec: dict[str, Any], *, cwd: pathlib.Path,
                 fixtures_dir: pathlib.Path) -> dict[str, Any]:
    """Run one declarative test and return its outcome dict. Never raises for a
    test failure -- a timeout, crash, bad fixture, or bad regex all map to a
    failing outcome with a diagnostic `detail`."""
    name = spec["name"]
    points = int(spec.get("points") or 0)
    ttype = spec["type"]
    timeout = int(spec.get("timeout") or 0) or DEFAULT_TEST_TIMEOUT

    setup = spec.get("setup") or ""
    if setup:
        err = _run_setup(setup, cwd, timeout)
        if err:
            return _make_outcome(name, points, False, err)

    if ttype == TEST_TYPE_PYTHON:
        return _grade_python(spec, cwd, timeout, points, name)

    try:
        stdin = _resolve_stdin(spec, fixtures_dir)
    except TestFixtureError as exc:
        return _make_outcome(name, points, False, str(exc))

    try:
        rp = _run_command(spec["run"], cwd, timeout, stdin=stdin)
    except subprocess.TimeoutExpired:
        return _make_outcome(name, points, False, f"timed out after {timeout}s")
    except OSError as exc:
        return _make_outcome(name, points, False, f"failed to start: {exc}")

    if ttype == TEST_TYPE_RUN:
        want = spec.get("exit-code")
        want = 0 if want is None else int(want)
        passed = rp.returncode == want
        detail = f"exit {rp.returncode} (wanted {want})"
        if not passed:
            detail += "\n" + _clip(rp.stderr or rp.stdout)
        return _make_outcome(name, points, passed, detail)

    # io test.
    try:
        expected = _resolve_expected(spec, fixtures_dir)
    except TestFixtureError as exc:
        return _make_outcome(name, points, False, str(exc))
    comparison = spec["comparison"]
    try:
        passed = compare_output(rp.stdout, expected, comparison)
    except re.error as exc:
        return _make_outcome(name, points, False, f"invalid regex in expected: {exc}")
    detail = f"exit {rp.returncode}; comparison={comparison}"
    if not passed:
        detail += (f"\n--- expected ({comparison}) ---\n{_clip(expected)}"
                   f"\n--- actual stdout ---\n{_clip(rp.stdout)}")
        if rp.stderr.strip():
            detail += f"\n--- stderr ---\n{_clip(rp.stderr)}"
    return _make_outcome(name, points, passed, detail)


def _validate_test_spec(t: Any) -> str | None:
    """Re-validate one spec at grade time — a lower bar than tests.go that
    keeps a hand-edited assignments.json from crashing the grader."""
    if not isinstance(t, dict):
        return "not an object"
    name = t.get("name")
    if not isinstance(name, str) or not name:
        return "name must be a non-empty string"
    if t.get("type") not in TEST_TYPES:
        return f"type {t.get('type')!r} must be one of {list(TEST_TYPES)}"
    if not isinstance(t.get("run"), str) or not t.get("run"):
        return "run must be a non-empty string"
    points = t.get("points", 0)
    if isinstance(points, bool) or not isinstance(points, int) or points < 0:
        return "points must be a non-negative integer"
    timeout = t.get("timeout", 0)
    if isinstance(timeout, bool) or not isinstance(timeout, int) or timeout < 0 or timeout > 600:
        return "timeout must be an integer between 0 and 600"
    # Type-check the optional string fields execute_test consumes so a malformed
    # tests.json fails with a clear message, not a mid-run TypeError.
    for key in ("setup", "input", "input-file", "expected", "expected-file"):
        v = t.get(key)
        if v is not None and not isinstance(v, str):
            return f"{key} must be a string"
    if t.get("type") == TEST_TYPE_IO and t.get("comparison") not in COMPARISONS:
        return f"comparison must be one of {list(COMPARISONS)}"
    # exit-code feeds `int(...)` and an equality check in execute_test.
    exit_code = t.get("exit-code")
    if exit_code is not None and (isinstance(exit_code, bool) or not isinstance(exit_code, int)):
        return "exit-code must be an integer"
    return None


def load_tests(path: pathlib.Path) -> list[dict[str, Any]]:
    """Parse + re-validate a materialized tests.json. Raises TestsConfigError
    on any structural problem."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise TestsConfigError(f"{TESTS_FILENAME} is not a JSON object")
    if data.get("schema") != TESTS_SCHEMA_V1:
        raise TestsConfigError(
            f"{TESTS_FILENAME} schema is {data.get('schema')!r}, want {TESTS_SCHEMA_V1!r}")
    tests = data.get("tests")
    if not isinstance(tests, list) or not tests:
        raise TestsConfigError(f"{TESTS_FILENAME} 'tests' must be a non-empty list")
    seen = set()
    for i, t in enumerate(tests):
        err = _validate_test_spec(t)
        if err:
            raise TestsConfigError(f"{TESTS_FILENAME} tests[{i}]: {err}")
        # Names are row identities in result.json; duplicates make the
        # gradebook ambiguous.
        if t["name"] in seen:
            raise TestsConfigError(f"{TESTS_FILENAME} tests[{i}]: duplicate test name {t['name']!r}")
        seen.add(t["name"])
    return tests


def render_declarative_body(result: dict[str, Any], outcomes: list[dict[str, Any]],
                            summary: str) -> str:
    """Release-body Markdown for a declaratively-graded submission: the score
    line, a per-test table, and a collapsible failure-detail section with
    captured output for any failing test."""
    lines = [f"### classroom50 autograde: {result['score']}/{result['max-score']}", ""]
    lines.append("| Test | Result | Score |")
    lines.append("|---|---|---|")
    for o in outcomes:
        ok = "PASS" if o["passed"] else "FAIL"
        name = o["test-name"].replace("|", "\\|")
        lines.append(f"| {name} | {ok} | {o['score']} / {o['max-score']} |")
    lines.append("")

    failed = [o for o in outcomes if not o["passed"]]
    if failed:
        lines.append("<details><summary>Failure details</summary>")
        lines.append("")
        for o in failed:
            detail = (o.get("detail") or "").rstrip()
            fence = _fence(detail)
            lines.append(f"**{o['test-name']}**")
            lines.append("")
            lines.append(fence)
            lines.append(detail)
            lines.append(fence)
            lines.append("")
        lines.append("</details>")
        lines.append("")

    lines.append(f"Status: {summary}")
    return "\n".join(lines) + "\n"


class DeclarativeGrader:
    """Runs a list of declarative test specs and builds the v1 result.json.
    Constructed with the same identity context the Finalizer carries."""

    def __init__(self, *, workspace: pathlib.Path, fixtures_dir: pathlib.Path,
                 classroom: str, assignment: str, username: str, submission: str,
                 commit_link: str, release_link: str,
                 review_link: str | None = None,
                 submitted_by: dict[str, Any] | None = None,
                 assignment_type: str = "individual",
                 submitted_at: datetime.datetime | None = None):
        self.workspace = workspace
        self.fixtures_dir = fixtures_dir
        self.classroom = classroom
        self.assignment = assignment
        self.username = username
        self.submission = submission
        self.commit_link = commit_link
        self.release_link = release_link
        self.review_link = review_link
        self.submitted_by = submitted_by
        self.assignment_type = assignment_type
        # The graded commit's committer date (invariant submission instant),
        # written as `datetime`; defaults to now when not supplied.
        self.submitted_at = submitted_at or now_utc()

    def grade(self, tests: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """Run every test. Returns (result.json dict, outcomes) where the
        outcomes carry per-test `detail` for the release body."""
        outcomes = [execute_test(t, cwd=self.workspace, fixtures_dir=self.fixtures_dir)
                    for t in tests]
        rows = [{k: o[k] for k in ("test-name", "passed", "score", "max-score")}
                for o in outcomes]
        result = make_result(
            classroom=self.classroom,
            assignment=self.assignment,
            username=self.username,
            submission=self.submission,
            commit_link=self.commit_link,
            release_link=self.release_link,
            when=self.submitted_at,
            score=sum(o["score"] for o in outcomes),
            max_score=sum(o["max-score"] for o in outcomes),
            tests=rows,
            review_link=self.review_link,
            submitted_by=self.submitted_by,
            assignment_type=self.assignment_type,
        )
        return result, outcomes


def run_declarative(tests_path: pathlib.Path, finalize: Finalizer,
                    fixtures_dir: pathlib.Path) -> int:
    """Grade a per-assignment tests.json: load + re-validate, run each test,
    then write result.json / release-body.md / GITHUB_OUTPUT. A malformed
    tests.json routes through Finalizer.error so the submission still publishes
    as 'submitted, error'. Always returns 0 -- a grading outcome (even all-fail)
    never fails the runner."""
    try:
        tests = load_tests(tests_path)
    except (json.JSONDecodeError, TestsConfigError, OSError) as exc:
        return finalize.error(f"{TESTS_FILENAME}: {exc}")

    grader = DeclarativeGrader(
        workspace=finalize.workspace,
        fixtures_dir=fixtures_dir,
        classroom=finalize.classroom,
        assignment=finalize.assignment,
        username=finalize.username,
        submission=finalize.submission,
        commit_link=finalize.commit_link,
        release_link=finalize.release_link,
        review_link=finalize.review_link,
        submitted_by=finalize.submitted_by,
        assignment_type=finalize.assignment_type,
        submitted_at=finalize.submitted_at,
    )
    # Backstop: execute_test/load_tests handle expected failures; the broad
    # catch guarantees the "grading outcomes always exit 0" invariant — an
    # unexpected exception becomes a published error result, never a crash.
    try:
        result, outcomes = grader.grade(tests)
    except Exception as exc:  # noqa: BLE001 - grading must never crash the runner
        return finalize.error(f"declarative grader crashed: {exc}")

    # Should always pass (the grader controls every field), but validating
    # keeps parity with collect_scores ingest and catches drift early.
    err = validate_result(
        result, classroom=finalize.classroom, assignment=finalize.assignment,
        is_group=(finalize.assignment_type == "group"), owner=finalize.username,
    )
    if err is not None:
        return finalize.error(f"declarative grader produced invalid result: {err}")

    status, summary = derive_status_and_summary(result)
    print(f"runner: {summary}")
    (finalize.workspace / RESULT_FILENAME).write_text(json.dumps(result, indent=2) + "\n")
    (finalize.workspace / RELEASE_BODY_FILENAME).write_text(
        render_declarative_body(result, outcomes, summary))
    append_outputs(finalize.github_output, status, summary)
    return 0


# ---------------------------------------------------------------------------
# Pipeline stages (called in order by main(); each a named step so the flow
# reads as a narrative with explicit precedence/early-exit). They call the
# module-level fetch_url / subprocess.run so the test harness's monkeypatches
# still apply.
# ---------------------------------------------------------------------------


def fetch_bundle(finalize: Finalizer, *, pages_base_url: str, classroom: str,
                 assignment: str, runtime_dir: pathlib.Path, secret: str = "") -> int | None:
    """Download the per-assignment bundle from Pages and extract it into
    `runtime_dir`. A 404 means "no per-assignment override" — fine, the resolver
    falls through to the classroom default. Returns an rc (already finalized as
    an error) on a hard fetch/extract failure, or None to continue."""
    burl = bundle_url(pages_base_url, classroom, assignment, secret)
    print(f"runner: fetching bundle {burl}")
    try:
        bundle = fetch_url(burl)
    except (urllib.error.HTTPError, urllib.error.URLError, ValueError) as exc:
        return finalize.error(f"bundle fetch failed: {exc} — see workflow logs")

    if bundle is not None:
        print(f"runner: bundle size {len(bundle)} bytes")
        try:
            extract_tarball(bundle, runtime_dir)
        except (tarfile.TarError, OSError, ValueError) as exc:
            return finalize.error(f"bundle extraction failed: {exc} — see workflow logs")
    return None


def resolve_entrypoint(
    finalize: Finalizer, *, pages_base_url: str, classroom: str, assignment: str,
    runtime_dir: pathlib.Path, secret: str = "",
) -> tuple[pathlib.Path | None, int | None]:
    """Resolve the grading entrypoint, most-specific first:
        per-assignment autograder.py
        > per-assignment tests.json (declarative, graded in-process)
        > classroom default autograder.py
        > vacuous pass.
    A hand-written per-assignment autograder.py wins over declarative tests for
    the same slug (it's the escape hatch).

    Returns exactly one of two shapes (never both-set, never both-None):
      (entrypoint, None)  — a Python entrypoint to exec; main() continues.
      (None, rc)          — the step is TERMINAL and rc is main()'s return
                            value: declarative grader ran (run_declarative),
                            nothing configured (no_autograder), or the default
                            fetch failed (error).
    A missing autograder is NOT an error: "no autograder configured" is a valid
    mid-setup state, so finalize.no_autograder() synthesizes a vacuous-pass
    (0/0 success) and the gradebook records the submission.
    """
    per_assignment = runtime_dir / assignment / ENTRYPOINT_FILENAME
    per_assignment_tests = runtime_dir / assignment / TESTS_FILENAME
    if per_assignment.is_file():
        print(f"runner: using per-assignment entrypoint {per_assignment}")
        return per_assignment, None
    if per_assignment_tests.is_file():
        print(f"runner: grading per-assignment declarative tests {per_assignment_tests}")
        return None, run_declarative(per_assignment_tests, finalize, runtime_dir / assignment)

    durl = classroom_default_autograder_url(pages_base_url, classroom, secret)
    print(
        f"runner: no per-assignment {ENTRYPOINT_FILENAME}; "
        f"fetching classroom default from {durl}"
    )
    try:
        content = fetch_url(durl)
    except (urllib.error.HTTPError, urllib.error.URLError, ValueError) as exc:
        return None, finalize.error(f"classroom default {ENTRYPOINT_FILENAME} fetch failed: {exc}")
    if content is None:
        # "No autograder configured" is a valid mid-setup state, not an error:
        # synthesize a vacuous-pass result (0/0 success).
        return None, finalize.no_autograder()
    entrypoint = runtime_dir / ENTRYPOINT_FILENAME
    entrypoint.write_bytes(content)
    print(f"runner: using classroom default entrypoint {entrypoint}")
    return entrypoint, None


def run_entrypoint(
    finalize: Finalizer, entrypoint: pathlib.Path, workspace: pathlib.Path,
) -> int | None:
    """Exec the entrypoint with the helper env vars and cwd at the student's
    checkout. Returns an rc (already finalized as an error) on a failed
    invocation or a non-zero autograder exit, else None to continue.

    The USERNAME / *_URL helper env vars are read off `finalize` (the identity
    carrier), matching run_declarative, rather than re-threading them through
    the signature."""
    env = dict(os.environ)
    env["USERNAME"] = finalize.username
    env["OWNER"] = finalize.username
    env["ASSIGNMENT_TYPE"] = finalize.assignment_type
    env["COMMIT_URL"] = finalize.commit_link
    env["RELEASE_URL"] = finalize.release_link
    env["REVIEW_URL"] = finalize.review_link
    try:
        proc = subprocess.run(
            [sys.executable, str(entrypoint)],
            cwd=str(workspace),
            env=env,
            check=False,
        )
    except OSError as exc:
        return finalize.error(f"failed to invoke {ENTRYPOINT_FILENAME}: {exc}")
    if proc.returncode != 0:
        return finalize.error(f"autograder exited {proc.returncode}")
    return None


def finalize_result(finalize: Finalizer, *, is_group: bool) -> int:
    """Read + validate the autograder's result.json, then synthesize the release
    body and status/summary outputs it didn't write. Returns the runner's exit
    code (0 on success; an error rc when the result is missing/malformed/invalid).
    Identity/paths are read off `finalize`; `is_group` is the one stage-local
    input (it drives the `assignment_type` check in validate_result)."""
    workspace = finalize.workspace
    github_output = finalize.github_output
    result_path = workspace / RESULT_FILENAME
    if not result_path.is_file():
        return finalize.error(f"autograder did not produce {RESULT_FILENAME}")
    try:
        result = json.loads(result_path.read_text())
    except json.JSONDecodeError as exc:
        return finalize.error(f"{RESULT_FILENAME} is not valid JSON: {exc}")

    # Stamp the runner-authoritative identity fields BEFORE validation. A custom
    # autograder builds its own result.json and can't be trusted to set `owner`
    # (repo owner) or `assignment_type` (mode) — the runner knows both. Overwrite
    # so a student-influenced result.json can't claim a different owner/type.
    if isinstance(result, dict):
        result["owner"] = finalize.username
        result["assignment_type"] = finalize.assignment_type
        # Submission instant is runner-authoritative: the graded commit's
        # committer date, invariant across regrades and not student-influenced.
        # Overwrite any autograder-written `datetime`. `graded_at` (this run's
        # wall clock) is stamped fresh on every (re)grade.
        result["datetime"] = finalize.submitted_at.strftime("%Y-%m-%dT%H:%M:%SZ")
        result["graded_at"] = now_utc().strftime("%Y-%m-%dT%H:%M:%SZ")
        # The actual pusher (GITHUB_ACTOR), also runner-authoritative. Stamp
        # unconditionally: set it when known, DROP any autograder-written
        # `submitted_by` when the actor couldn't be resolved — never let a
        # custom result.json's self-asserted (student-influenced) pusher survive.
        if finalize.submitted_by is not None:
            result["submitted_by"] = finalize.submitted_by
        else:
            result.pop("submitted_by", None)
        result_path.write_text(json.dumps(result, indent=2) + "\n")

    err = validate_result(
        result, classroom=finalize.classroom, assignment=finalize.assignment,
        is_group=is_group, owner=finalize.username,
    )
    if err is not None:
        return finalize.error(err)

    # Synthesize release-body.md if the autograder didn't write one.
    body_path = workspace / RELEASE_BODY_FILENAME
    if not body_path.is_file():
        _, fallback = derive_status_and_summary(result)
        body_path.write_text(render_release_body(result, fallback))

    # Synthesize status / summary if the autograder didn't write them.
    if not output_has_status(github_output):
        status, summary = derive_status_and_summary(result)
        append_outputs(github_output, status, summary)
        print(f"runner: derived status={status} summary={summary!r}")
    else:
        print("runner: autograder set status/summary; using as-is")
    return 0


# ---------------------------------------------------------------------------
# main()
# ---------------------------------------------------------------------------


def detect_acceptance_mode() -> int:
    """`runner.py --detect-acceptance`: write is-acceptance=true|false to
    $GITHUB_OUTPUT for the setup job's skip gate. Always exits 0; fails open
    (False) on any uncertainty.
    """
    workspace = pathlib.Path.cwd()
    head_sha = os.environ.get("GITHUB_SHA", "").strip()
    is_acceptance = is_acceptance_commit(workspace, head_sha)
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a") as fh:
            fh.write(f"is-acceptance={'true' if is_acceptance else 'false'}\n")
    if is_acceptance:
        print(
            "::notice::acceptance commit detected — nothing to grade yet; "
            "submit work (gh student submit) to be graded"
        )
    else:
        print("runner: not an acceptance commit; grading proceeds")
    return 0


def main() -> int:
    if "--detect-acceptance" in sys.argv[1:]:
        return detect_acceptance_mode()

    pages_base_url = os.environ.get("PAGES_BASE_URL", "").strip()
    classroom = os.environ.get("CLASSROOM", "").strip()
    assignment = os.environ.get("ASSIGNMENT", "").strip()
    submission = os.environ.get("SUBMISSION_TAG", "").strip()
    if not (pages_base_url and classroom and assignment and submission):
        print(
            "::error::runner requires PAGES_BASE_URL, CLASSROOM, "
            "ASSIGNMENT, and SUBMISSION_TAG — running outside the autograde-runner workflow?",
            file=sys.stderr,
        )
        return 1

    # Optional capability-URL secret (from the student repo's .classroom50.yaml).
    # Present -> resources at <classroom>/<secret>/; absent -> plain path. The
    # setup job validates it; re-check here as defense-in-depth since it composes
    # into a URL.
    secret = os.environ.get("SECRET", "").strip()
    if secret and not re.fullmatch(r"[a-z0-9]{4,64}", secret):
        print(
            f"::error::SECRET {secret!r} is malformed (must be [a-z0-9]{{4,64}}) — "
            "re-run `gh student accept` to regenerate .classroom50.yaml",
            file=sys.stderr,
        )
        return 1

    repository = os.environ.get("GITHUB_REPOSITORY", "")
    sha = os.environ.get("GITHUB_SHA", "")
    server_url = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    actor = os.environ.get("GITHUB_ACTOR", "")
    # Assignment mode flows from assignments.json via the setup job's `mode`
    # output. Unknown/missing defaults to individual (the stricter
    # `assignment_type`) so a missing env can't loosen validation.
    is_group = mode_is_group(os.environ.get("MODE"))
    github_output = os.environ.get("GITHUB_OUTPUT")
    workspace = pathlib.Path.cwd()

    username = username_from_repo(repository, classroom, assignment, actor)
    commit_link = commit_url(server_url, repository, sha)
    release_link = release_url(server_url, repository, submission)
    # Submission instant is the graded commit's committer date — stable across
    # regrades, so re-grading the same commit never moves `datetime`/`late`.
    submitted_at = commit_submitted_at(sha, workspace)
    # Resolve the baseline once: both the review-compare link and the Feedback
    # PR gate need it, and the scan issues several sequential git calls, so a
    # second walk would double the worst-case time against the 15-min ceiling.
    baseline_scan = _baseline_scan(workspace)
    base_sha = baseline_scan[0]
    review_link = review_url(server_url, repository, base_sha, sha)
    if base_sha is None:
        print("runner: no baseline commit found; review link falls back to the commit view")

    # Hand the baseline + graded SHAs to the workflow so the post-grade step can
    # open/refresh the Feedback PR without recomputing git state. Emitted
    # unconditionally and early so the step runs even when grading fails
    # (teachers review failing work too). The step is the gate: it opens the PR
    # only when the assignment opted in (feedback-pr) and there's a diff. The
    # base is the accept commit when detected, else the root commit: a root
    # fallback still opens the PR but warns it's UNTRUSTED; only an unresolvable
    # baseline (git unreadable / not a repo) skips.
    fb_base_sha, fb_source = feedback_base_outcome(workspace, baseline_scan)
    append_sha_outputs(github_output, fb_base_sha, sha)
    if fb_source == SOURCE_ROOT:
        print(untrusted_baseline_warning())
    elif fb_base_sha is None:
        # No baseline -> the step skips. Visible annotation (not a plain log) so
        # a skipped Feedback PR is diagnosable. A warning, not an error: opt-in.
        print(no_baseline_warning(fb_source))

    print(
        f"runner: classroom={classroom!r} assignment={assignment!r} "
        f"submission={submission!r} username={username!r}"
    )
    print(f"runner: review link {review_link}")

    finalize = Finalizer(
        workspace=workspace,
        github_output=github_output,
        classroom=classroom,
        assignment=assignment,
        username=username,
        submission=submission,
        commit_link=commit_link,
        release_link=release_link,
        review_link=review_link,
        submitted_by=actor_identity(),
        assignment_type="group" if is_group else "individual",
        submitted_at=submitted_at,
    )

    # Reset the runtime root and clear stale outputs from any prior run.
    runtime_dir = runtime_root()
    if runtime_dir.exists():
        shutil.rmtree(runtime_dir)
    runtime_dir.mkdir(parents=True)
    for f in (workspace / RESULT_FILENAME, workspace / RELEASE_BODY_FILENAME):
        if f.exists():
            f.unlink()

    # Enforce allowed_files before grading so the autograder only sees allowed
    # files. Fails open — if the matcher can't run, returns [] and grading
    # proceeds on the unfiltered tree (see its docstring to flip to fail-closed).
    # The removed list is appended to release-body.md on every exit path below.
    removed_files = enforce_allowed_files(workspace, parse_allowed_files(os.environ.get("ALLOWED_FILES")))

    def _grade() -> int:
        # Pipeline: fetch bundle → resolve entrypoint → exec → validate.
        # Each stage returns an rc when terminal, else None to continue.
        rc = fetch_bundle(
            finalize, pages_base_url=pages_base_url, classroom=classroom,
            assignment=assignment, secret=secret, runtime_dir=runtime_dir,
        )
        if rc is not None:
            return rc

        entrypoint, rc = resolve_entrypoint(
            finalize, pages_base_url=pages_base_url, classroom=classroom,
            assignment=assignment, secret=secret, runtime_dir=runtime_dir,
        )
        if entrypoint is None:
            return rc  # declarative grader ran, vacuous pass, or fetch error

        rc = run_entrypoint(finalize, entrypoint, workspace)
        if rc is not None:
            return rc

        return finalize_result(finalize, is_group=is_group)

    # Append the removed-files note on every exit path (incl. an exception
    # in grading): the files were already deleted before _grade() ran.
    try:
        rc = _grade()
    finally:
        append_removed_files_note(workspace, removed_files)

    return _stage_release_assets_and_emit(workspace, github_output, rc)


if __name__ == "__main__":
    sys.exit(main())
