#!/usr/bin/env python3
"""Teacher-triggered regrade fan-out.

Re-runs the autograder across an assignment's student repos WITHOUT changing
each submission. For every targeted repo it re-runs the latest `autograde.yaml`
run via the Actions rerun API: grades the SAME commit again and re-fetches the
current autograder from Pages, so a teacher's fixed test / updated autograder
takes effect. Because the runner stamps the submission `datetime` from the
graded commit's committer date (not grade time), the submission time and `late`
flag are unchanged; only the score/`graded_at` move.

A re-run replays at ITS ORIGINAL submit/* commit, NOT the current `main` HEAD:
regrade refreshes the score for an EXISTING submission; it does not grade newer
un-submitted work. Only a run that actually graded is replayed (see
latest_autograde_run_id for what qualifies).

A repo with pushed work but no graded run is first-graded at the student's
latest commit (see first_gradeable_commit and regrade_repo). Repos with nothing
pushed since the acceptance commit (or not accepted at all) are skipped.

Grading then happens ASYNCHRONOUSLY inside each student repo, so refreshed
releases are ingested by the next `collect-scores.py` run ("Collect
now", or a manual dispatch). Until then the gradebook shows PRE-regrade scores, an eventual-
consistency window, by design (collecting here would race the still-running
grade jobs).

Team-driven (mirroring collect_scores.py): the (student, assignment) pairs come
from the classroom GitHub team x `<classroom>/assignments.json`. The classroom
team is the source of truth for enrollment. A single
`OWNER_FILTER` narrows to one repo (the per-row "Regrade" web action); empty
means the whole assignment.

Environment (set by `regrade.yaml`):
  CLASSROOM50_SERVICE_TOKEN: fine-grained PAT, Contents: Read and write AND
                             Actions: Read and write on the student repos, plus
                             Organization -> Members: Read to list the classroom
                             team. Actions: write re-runs a run; Contents: write
                             pushes a submit/* tag for the first-grade case.
                             Workflows: Read and write is needed only to
                             first-grade a commit pushed before a submission-mode
                             change (GitHub's workflow-file rule; the failure
                             names it).
  CLASSROOM_FILTER:          classroom short-name (required for regrade).
  ASSIGNMENT_FILTER:         assignment slug (required for regrade).
  OWNER_FILTER:              optional single repo-owner login; empty means
                             every rostered student for the assignment.
  GITHUB_REPOSITORY_OWNER:   org name (auto-set by Actions).
  GITHUB_API_URL:            API URL on GHES runners.
  GH_API_URL:                explicit override (test servers).

Exit codes:
  0: success (every targeted repo re-run, first-graded, or had nothing to do).
  1: operational failure (missing token/inputs, auth rejection, unrecoverable
     network error). Per-repo failures warn and skip.
"""

from __future__ import annotations

import datetime
import functools
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

# Schema sentinels; keep in lockstep with collect_scores.py and the Go
# constants in cli/gh-teacher/classroom.go / assignments_json.go.
CLASSROOM_SCHEMA_V1 = "classroom50/classroom/v1"
ASSIGNMENTS_SCHEMA_V1 = "classroom50/assignments/v1"

# Trigger contract: the autograde workflow fires on `submit/*` tags. Keep this
# prefix aligned with autograde-runner.yaml and collect_scores.py.
SUBMIT_TAG_PREFIX = "submit/"

# The accept marker both accept clients commit; the commit that adds it is the
# acceptance commit. Mirrors contract.MetadataPath (pinned by
# test_contract_parity.py alongside runner.py and collect_scores.py).
ACCEPT_MARKER_PATH = ".classroom50.yaml"

# GitHub fires no workflow for a push whose head commit message carries one of
# these (tag pushes included), so a submit/* tag at such a commit grades nothing.
# Matched case-insensitively: erring toward "won't fire" costs at most one older
# commit graded, while the opposite error silently grades nothing.
CI_SKIP_MARKERS = ("[skip ci]", "[ci skip]", "[no ci]", "[skip actions]", "[actions skip]")
_SKIP_CHECKS_TRAILER = re.compile(r"^skip-checks:\s*true\s*$", re.MULTILINE)

# How far back the first-grade fallback looks for a commit a tag can fire on.
# Bookkeeping commits stack a few deep at most; one page is plenty.
COMMIT_SCAN_PAGE_SIZE = 100

# Git-data reads answer 404 for a missing repo/ref and 409 for a repo whose git
# database is still empty (accept created it, nothing pushed yet). Both mean
# "nothing there", not an error.
EMPTY_OR_MISSING_GIT_DATA = (404, 409)

# Throttle classifier constants, hand-mirrored from collect_scores.py, which
# documents each one and the marker set's relationship to Go's
# ghutil.IsRateLimited. This file shares that transport.
RATE_LIMIT_BODY_MARKERS = (
    "secondary rate limit",
    "rate limit exceeded",
    "abuse",
)
# Rerun-endpoint 403 bodies, lower-cased substrings. Run-side: "This workflow
# is already running", "Unable to retry this workflow run because it was
# created over a month ago". Token-side: "Resource not accessible by personal
# access token" (or "by integration"), "Must have admin rights to Repository".
RERUN_REFUSED_FOR_RUN_MARKERS = ("already running", "created over a month ago")
RERUN_REFUSED_FOR_TOKEN_MARKERS = ("not accessible", "must have", "permission", "bad credentials")
MAX_RETRY_SLEEP_SECONDS = 60
TRANSIENT_RETRY_CAP_SECONDS = 30
MAX_TOTAL_THROTTLE_SLEEP_SECONDS = 300
BODY_SNIPPET_READ_BYTES = 4096
THROTTLED = "throttled"
FATAL = "fatal"
SKIPPABLE = "skippable"

_throttle_sleep_spent = 0.0

# Fallback submission branch when a repo's default branch can't be read.
# Submissions grade off the repo's default branch (the autograde shim's
# `on.push.branches`); `main` is only the fallback for a repo with no default.
SUBMISSION_BRANCH = "main"

# How often (every N repos) the fan-out logs incremental progress, so a run
# killed by the Actions job timeout still leaves per-repo accounting in the log
# rather than only the final summary.
PROGRESS_EVERY = 25

# Coarse filter for obviously-bogus usernames so they don't get formatted
# into a URL. Mirrors collect_scores.py; not a strict GitHub validator.
_USERNAME_BAD_CHARS = re.compile(r"[^A-Za-z0-9-]")


def _compile_tag_pattern(pattern: str) -> re.Pattern[str] | None:
    """One Actions tag-filter pattern -> an anchored regex, or None when it
    can't compile (fail closed: matches nothing). Character by character so
    `.` and other regex metacharacters in the pattern stay literal. Supported
    subset: literal names, `*` (not crossing `/`), `**` (crossing), `?`/`+`
    (zero-or-one / one-or-more of the preceding element), `[abc]` classes.
    """
    out = ["^"]
    i = 0
    while i < len(pattern):
        ch = pattern[i]
        if ch == "*":
            if i + 1 < len(pattern) and pattern[i + 1] == "*":
                out.append(".*")  # ** crosses /
                i += 1
            else:
                out.append("[^/]*")  # * stops at /
        elif ch in ("?", "+"):
            out.append(ch)
        elif ch == "[":
            close = pattern.find("]", i + 1)
            if close != -1:
                out.append(pattern[i : close + 1])  # class verbatim
                i = close
            else:
                out.append(re.escape(ch))  # unclosed [ is literal
        else:
            out.append(re.escape(ch))
        i += 1
    out.append("$")
    try:
        return re.compile("".join(out))
    except re.error:
        return None


# The safe-pattern charset: literal-name characters plus the glob
# metacharacters GitHub Actions tag filters support. Keep in lockstep with Go
# contract.SubmissionTagCharsetRE and the web SUBMISSION_TAG_PATTERN_RE.
_TAG_PATTERN = re.compile(r"^[A-Za-z0-9._/*?+\[\]-]+$")

# A leading `?`/`+` (nothing to repeat) or a `+` stacked on another
# quantifier (`v*+`, `a++`). LOAD-BEARING here in the Python mirror: those
# translate to POSSESSIVE quantifiers, which Python 3.11+ compiles (and
# matches!) while Go RE2 and JS reject. Without this guard the four matcher
# copies would diverge on exactly these patterns. Keep in lockstep with Go
# contract.stackedQuantifierRE and the web copies.
_STACKED_QUANTIFIER = re.compile(r"^[?+]|[*?+]\+")


def matches_submission_tag(patterns: list[str], tag: str) -> bool:
    """Whether `tag` matches ANY of the Actions tag-filter `patterns`; an
    empty list matches nothing. By-value copy of Go's
    contract.MatchesSubmissionTag and the web matchesSubmissionTag, all
    pinned to identical output by the shared golden fixture
    cli/shared/testdata/submission_tag_match_cases.json. The same strings are
    rendered into the shim's on.push.tags, so this matcher and GitHub's own
    filter evaluation must agree on what fires. Keep in lockstep."""
    for pattern in patterns:
        if not _TAG_PATTERN.fullmatch(pattern) or _STACKED_QUANTIFIER.search(pattern):
            continue  # fail closed, matching the Go/JS charset+compile guards
        compiled = _compile_tag_pattern(pattern)
        if compiled is not None and compiled.fullmatch(tag) is not None:
            return True
    return False


# Top-level dispatch ----------------------------------------------------------


def main() -> int:
    base_dir = pathlib.Path(os.environ.get("GITHUB_WORKSPACE") or ".").resolve()

    classroom_filter = (os.environ.get("CLASSROOM_FILTER") or "").strip()
    assignment_filter = (os.environ.get("ASSIGNMENT_FILTER") or "").strip()
    owner_filter = (os.environ.get("OWNER_FILTER") or "").strip()

    # Regrade is always scoped to one classroom + assignment. Unlike collect
    # (which can sweep all classrooms), there's no "regrade everything" mode, so
    # both inputs are required.
    if not classroom_filter:
        emit_error("CLASSROOM_FILTER is empty: regrade requires a classroom short-name")
        return 1
    if not assignment_filter:
        emit_error("ASSIGNMENT_FILTER is empty: regrade requires an assignment slug")
        return 1

    org = (os.environ.get("GITHUB_REPOSITORY_OWNER") or "").strip()
    if not org:
        emit_error(
            "GITHUB_REPOSITORY_OWNER is empty: this script must run inside a GitHub Actions workflow"
        )
        return 1

    service_token = (os.environ.get("CLASSROOM50_SERVICE_TOKEN") or "").strip()
    if not service_token:
        emit_error(
            "CLASSROOM50_SERVICE_TOKEN is empty: run `gh teacher rotate-service-token <org>` to provision it"
        )
        return 1

    api_url = (
        os.environ.get("GH_API_URL")
        or os.environ.get("GITHUB_API_URL")
        or "https://api.github.com"
    ).rstrip("/")

    classroom_dir = base_dir / classroom_filter
    try:
        roster, entry = load_roster(classroom_dir, assignment_filter, api_url, org, service_token)
    except EmptyRepoAssignment:
        # Successful no-op, not a failure: the teacher (or a stale button)
        # targeted an assignment that never autogrades (empty_repo, or a
        # no_autograder without the built-in autograder).
        print(
            f"regrade {classroom_filter}/{assignment_filter}: assignment does "
            f"not autograde (empty_repo or no_autograder), so there is nothing to regrade."
        )
        return 0
    except RegradeInputError as exc:
        emit_error(str(exc))
        return 1
    except urllib.error.HTTPError as exc:
        verdict = classify(exc)
        if verdict is THROTTLED:
            emit_error(
                f"{classroom_filter}: could not list the classroom team. GitHub "
                f"is throttling (HTTP {exc.code}, {rate_limit_reason(exc)}) and the "
                f"request did not recover after retrying. The service token is fine, "
                f"do NOT rotate it; re-run once the limit resets."
            )
            return 1
        if verdict is FATAL:
            emit_error(
                f"{classroom_filter}: could not list the classroom team: service token "
                f"rejected or network unavailable (HTTP {exc.code} {exc.reason or 'no reason'})"
                f"{body_note(exc)}. Ensure CLASSROOM50_SERVICE_TOKEN has Organization -> "
                f"Members: Read with `gh teacher rotate-service-token {org}`"
            )
            return 1
        emit_error(
            f"{classroom_filter}: listing the classroom team failed with HTTP {exc.code} "
            f"({exc.reason or 'no reason'})"
        )
        return 1
    except (json.JSONDecodeError, ValueError) as exc:
        # A non-array team-listing body or the pagination page cap raises here
        # (see _paginate_login_list). Surface it as a loud error rather than an
        # uncaught traceback; mirrors collect_scores.py's handling of the same
        # raise.
        emit_error(
            f"{classroom_filter}: classroom team member listing malformed ({exc})"
        )
        return 1

    # An empty team (enrollment flux, or a team not yet populated) means there's
    # nothing to regrade: succeed, but warn so a green 0-repo run isn't mistaken
    # for a successful regrade. Mirrors collect_scores.py's empty-team warning. A
    # single-owner regrade surfaces its own "not a member" error below instead.
    if not roster and not owner_filter:
        emit_warning(
            f"{classroom_filter}: classroom team has no members, so there is nothing to regrade "
            f"for assignment {assignment_filter!r}."
        )

    # Narrow to a single owner for the per-row regrade action. A filter matching
    # no team member is a teacher mistake (typo / off-team student), so fail
    # loudly rather than silently tagging nothing.
    targets = roster
    if owner_filter:
        targets = [u for u in roster if u.lower() == owner_filter.lower()]
        if not targets:
            emit_error(
                f"OWNER_FILTER={owner_filter!r} is not a member of the {classroom_filter} "
                f"classroom team for assignment {assignment_filter!r}; nothing to regrade"
            )
            return 1

    # Which run counts as "the latest submission" depends on the mode: in tag
    # mode a branch push is a suppressed run, so only submission-tag runs are
    # candidates there. Milestone submission_tags runs are real graded runs,
    # so the patterns ride along for the run filter.
    tag_mode = is_tag_submission_mode(entry)
    submission_tags = entry.get("submission_tags") or []
    if not isinstance(submission_tags, list):
        submission_tags = []

    regraded = 0   # re-ran an existing run (a graded run, or a suppressed run at the latest commit)
    tagged = 0     # first-grade fallback (no graded run, tagged the latest commit)
    skipped = 0    # nothing to do (not accepted) or benign skip
    failed: list[str] = []
    total = len(targets)
    for index, username in enumerate(targets, start=1):
        repo_name = assignment_repo_name(classroom_filter, assignment_filter, username)
        try:
            outcome = regrade_repo(
                api_url, org, repo_name, service_token, tag_mode, submission_tags
            )
        except _SkipRepo:
            # Benign per-repo skip (e.g., the latest run can't be re-run right
            # now); already warned at the source.
            skipped += 1
        except _RepoFailed as exc:
            emit_error(str(exc))
            failed.append(repo_name)
        except urllib.error.HTTPError as exc:
            verdict = classify(exc)
            if verdict is THROTTLED:
                emit_error(
                    f"{org}/{repo_name}: regrade aborted. GitHub is throttling "
                    f"(HTTP {exc.code}, {rate_limit_reason(exc)}) and the request did "
                    f"not recover after retrying. The service token is fine, do NOT "
                    f"rotate it; re-run once the limit resets."
                )
                return 1
            if verdict is FATAL:
                emit_error(
                    f"{org}/{repo_name}: regrade aborted: service token rejected or network "
                    f"unavailable (HTTP {exc.code} {exc.reason or 'no reason'}){body_note(exc)}. "
                    f"Re-scope the PAT to Contents: Read and write, Actions: Read and write, "
                    f"AND Workflows: Read and write with `gh teacher rotate-service-token {org}`"
                )
                return 1
            emit_warning(
                f"{org}/{repo_name}: regrade failed: HTTP {exc.code} "
                f"({exc.reason or 'no reason'}); skipping"
            )
            failed.append(repo_name)
        except (json.JSONDecodeError, ValueError) as exc:
            emit_warning(f"{org}/{repo_name}: regrade failed ({exc}); skipping")
            failed.append(repo_name)
        else:
            if outcome == "rerun":
                regraded += 1
            elif outcome == "tagged":
                tagged += 1
            else:
                # "missing": not accepted, or nothing pushed since acceptance, so
                # there is no submission to grade. Logged per repo so a teacher
                # who expected a grade can see why none will appear.
                print(f"{org}/{repo_name}: no submission to grade (not accepted, or nothing pushed since accepting)")
                skipped += 1

        # Incremental progress checkpoint, on every outcome including skips and
        # failures. The final summary below only prints if the loop completes,
        # so a job killed by the Actions timeout (a large roster is a long
        # sequential fan-out) would otherwise leave NO per-repo accounting.
        # Re-dispatching is safe (rerun is idempotent and a re-pushed tag is
        # swallowed as already existing), so a teacher can rerun.
        if index % PROGRESS_EVERY == 0 or index == total:
            print(
                f"regrade {classroom_filter}/{assignment_filter}: progress "
                f"{index}/{total} (re-ran {regraded}, first-graded {tagged}, "
                f"skipped {skipped}, failed {len(failed)})"
            )

    print(
        f"regrade {classroom_filter}/{assignment_filter}: re-ran {regraded}, "
        f"first-graded {tagged}, skipped {skipped} across {total} repo(s). "
        f"Grading runs asynchronously inside each student repo and can take "
        f"minutes; refreshed scores are NOT visible until the next collect-scores "
        f"run ingests the new releases (\"Collect now\", or a manual dispatch)."
    )
    if failed:
        emit_error(
            f"regrade: {len(failed)} repo(s) could not be regraded and were skipped: "
            f"{', '.join(sorted(failed))} (the others were regraded)"
        )
        return 1
    return 0


# Per-repo regrade ------------------------------------------------------------


# The student-repo autograde workflow filename (the shim the accept clients
# write, `name: Autograde`). Re-running its latest run re-fetches the current
# autograder from Pages and re-grades the same commit. Cross-binary: keep
# aligned with cli/shared/contract/autograde-shim.yaml's filename
# (contract.AutogradeShimPath).
AUTOGRADE_WORKFLOW = "autograde.yaml"
AUTOGRADE_SHIM_PATH = f".github/workflows/{AUTOGRADE_WORKFLOW}"

# Subject of the commit that adds the shim to a repo accepted while the
# built-in autograder was off (`gh teacher assignment enable-autograder` / the
# gradebook's "Add autograding workflow"). Every commit beneath it predates the
# workflow, so no tag there can fire, and a marker it introduced is not an
# accept (acceptance_commit_sha). Mirrors contract.ShimBackfillCommitSubject and
# the runner.py / collect_scores.py constant of the same name; keep
# byte-identical.
SHIM_BACKFILL_COMMIT_SUBJECT = "[Classroom 50] Add autograde workflow (enable-autograder)"


class _RepoLookups:
    """One repo's GitHub reads, each fetched at most once per regrade and only
    when a decision needs it. Every regrade_repo step shares one instance, so
    the run list, the submit/* tag map, and the acceptance commit are never
    fetched twice for the same repo inside a rate-limited fan-out."""

    def __init__(self, api_url: str, org: str, repo: str, token: str) -> None:
        self.api_url = api_url
        self.org = org
        self.repo = repo
        self.token = token

    @functools.cached_property
    def runs(self) -> list[Any]:
        return list_autograde_runs(self.api_url, self.org, self.repo, self.token)

    @functools.cached_property
    def tagged_shas(self) -> dict[str, str]:
        return submit_tags_by_commit(self.api_url, self.org, self.repo, self.token)

    @functools.cached_property
    def default_branch(self) -> str | None:
        return repo_default_branch(self.api_url, self.org, self.repo, self.token)

    @functools.cached_property
    def accept_sha(self) -> str | None:
        if self.default_branch is None:
            return None
        return acceptance_commit_sha(
            self.api_url, self.org, self.repo, self.token, self.default_branch
        )


def regrade_repo(
    api_url: str,
    org: str,
    repo: str,
    token: str,
    tag_mode: bool,
    submission_tags: list[str] | None = None,
) -> str:
    """Re-run grading for `repo` on its existing latest submission, without
    creating a new one. Returns one of:

      "rerun":   re-ran an existing run: the latest GRADED autograde run, or
                 (first grade) a branch run the runner suppressed at the
                 student's latest commit. Grades the SAME commit again
                 (re-fetching the current autograder), and because the runner
                 stamps `datetime` from the commit's committer date, the
                 submission time / late flag DON'T change, only the score.
      "tagged":  no graded run, so a fresh submit/<ts>-<sha> tag was pushed at
                 the student's latest commit to first-grade it. (Submission
                 time is still the commit's committer date; `graded_at` records
                 the new run.)
      "missing": nothing to grade: the student hasn't accepted, or has pushed
                 nothing since the acceptance commit.

    latest_autograde_run_id decides which run counts as graded;
    first_gradeable_commit decides which commit a first grade targets.

    Raises urllib.error.HTTPError / ValueError on a hard failure the caller
    classifies (auth/network abort; other per-repo errors warn-and-skip).
    """
    lookups = _RepoLookups(api_url, org, repo, token)

    # Prefer re-running the existing run: a true "regrade the same commit" with
    # no new tag and no new submission event.
    run_id = latest_autograde_run_id(
        api_url, org, repo, token, tag_only=tag_mode, submission_tags=submission_tags,
        lookups=lookups,
    )
    if run_id is not None:
        rerun_workflow_run(api_url, org, repo, token, run_id)
        return "rerun"

    # No graded run. Find the student's latest commit a tag push can fire on;
    # None means nothing has been pushed since acceptance (or no repo at all).
    found = first_gradeable_commit(api_url, org, repo, token, lookups=lookups)
    if found is None:
        return "missing"
    sha, branch = found

    # A push suppressed under tag mode left a green no-op run at this very
    # commit. Re-running it grades now (every-push) without a new tag and,
    # unlike tagging, without GitHub's workflow-file rule (see below). A run
    # still in flight is about to grade this commit itself, so the repo is
    # skipped rather than graded twice; a completed run that can't be re-run
    # (past GitHub's rerun window) falls through to the tag path.
    if not tag_mode:
        suppressed = _branch_run_at(lookups.runs, sha, branch)
        if suppressed is not None:
            if suppressed.get("status") != "completed":
                emit_warning(
                    f"{org}/{repo}: an autograde run for commit {sha[:7]} is already "
                    f"in progress and will grade it; skipping"
                )
                raise _SkipRepo()
            try:
                rerun_workflow_run(api_url, org, repo, token, _run_id_of(suppressed))
                return "rerun"
            except _SkipRepo:
                pass

    # A submit/* tag may already sit at that commit without a run that graded
    # it: its run was deleted or expired, or the runner minted it while the
    # assignment was in every-push mode (a tag pushed with the Actions token
    # fires nothing, and after a switch to tag mode that branch run would
    # re-suppress). GitHub fires nothing for a tag that already exists, so
    # reusing it would report "first-graded" while nothing runs. Push a fresh
    # tag instead: a second release at one commit is the lesser cost, and the
    # newest release is the one collection reports.
    existing = existing_submit_tag_at(api_url, org, repo, token, sha, lookups=lookups)
    if existing is not None:
        print(
            f"{org}/{repo}: {existing} already points at commit {sha[:7]} but no "
            f"autograde run graded it; pushing a fresh submit tag to grade it"
        )

    tag = build_submit_tag(sha)
    try:
        create_tag_ref(api_url, org, repo, token, tag, sha)
    except urllib.error.HTTPError as exc:
        # GitHub refuses to create a ref whose .github/workflows/* content
        # exists on no branch unless the token holds Workflows: write (the
        # classic `workflow` scope rule). A submission-mode retrofit rewrites
        # the shim on the default branch, so every pre-retrofit commit trips
        # that check, and the service token was never asked for Workflows.
        if (
            exc.code == 403
            and classify(exc) is not THROTTLED
            and shim_differs_from_default_branch(api_url, org, repo, token, sha, branch)
        ):
            raise _RepoFailed(
                f"{org}/{repo}: can't start grading commit {sha[:7]}: its autograde "
                f"workflow differs from the default branch's (the submission mode "
                f"changed since it was pushed), and GitHub only lets a token with "
                f"Workflows: Read and write tag such a commit. Either have the "
                f"student push once (the push itself grades), or re-create the "
                f"service token with Workflows: Read and write added to its usual "
                f"permissions (`gh teacher rotate-service-token {org}`) and regrade "
                f"again."
            ) from exc
        raise
    return "tagged"


def _branch_run_at(runs: list[Any], sha: str, branch: str) -> dict | None:
    """The newest run at commit `sha` triggered by a push to `branch`, or None.
    Tag runs and other branches are excluded: only a default-branch push can
    be the suppressed run worth replaying."""
    for run in runs:
        if not isinstance(run, dict) or run.get("head_sha") != sha:
            continue
        if run.get("head_branch") != branch:
            continue
        return run
    return None


class _RepoFailed(Exception):
    """A per-repo failure with a teacher-facing explanation; counted as
    failed (exit 1) without aborting the rest of the fan-out."""


def shim_differs_from_default_branch(
    api_url: str, org: str, repo: str, token: str, sha: str, branch: str
) -> bool:
    """Whether the autograde shim at `sha` differs from `branch`'s (the default
    branch). Conservative: a read that fails for any reason other than a
    throttle reports False so the caller falls back to the generic 403
    handling; a throttle propagates so main() prints the do-not-rotate message
    instead of blaming the token."""
    blobs = []
    for ref in (sha, branch):
        url = (
            f"{_repo_url(api_url, org, repo)}/contents/"
            f"{urllib.parse.quote(AUTOGRADE_SHIM_PATH)}?ref={urllib.parse.quote(ref, safe='')}"
        )
        try:
            body = _http_get(url, token, accept="application/vnd.github+json")
        except urllib.error.HTTPError as exc:
            if classify(exc) is THROTTLED:
                raise
            return False
        data = json.loads(body.decode("utf-8"))
        blob_sha = data.get("sha") if isinstance(data, dict) else None
        if not isinstance(blob_sha, str):
            return False
        blobs.append(blob_sha)
    return blobs[0] != blobs[1]


def list_autograde_runs(api_url: str, org: str, repo: str, token: str) -> list[Any]:
    """One newest-first page of `repo`'s autograde runs; [] when the repo or
    workflow doesn't exist yet (404: never accepted / never ran). No pagination:
    a graded run that scrolled past 100 skipped ones is treated as absent and
    the caller's first-grade fallback covers it, acceptable for that degenerate
    case."""
    url = (
        f"{_repo_url(api_url, org, repo)}/actions/workflows/"
        f"{urllib.parse.quote(AUTOGRADE_WORKFLOW)}/runs?per_page=100"
    )
    try:
        body = _http_get(url, token, accept="application/vnd.github+json")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return []
        raise
    data = json.loads(body.decode("utf-8"))
    runs = data.get("workflow_runs") if isinstance(data, dict) else None
    return runs if isinstance(runs, list) else []


def latest_autograde_run_id(
    api_url: str,
    org: str,
    repo: str,
    token: str,
    *,
    tag_only: bool = False,
    submission_tags: list[str] | None = None,
    lookups: _RepoLookups | None = None,
) -> int | None:
    """The id of the most recent autograde run on `repo` that GRADED a
    submission, or None. `lookups` shares the per-repo reads with the caller
    (built here when not supplied).

    Only a graded run may be replayed: the runner skips the acceptance commit,
    a shim retrofit, and (in tag mode) a plain branch push, and a rerun of any
    of those skips again while regrade reports success. A run graded when:
      - GitHub set its head_branch to a real submission tag (the canonical
        submit/* namespace, or a teacher-named milestone pattern from
        `submission_tags`; the runner mints the canonical tag for those); or
      - every-push mode only: a submit/* tag points at its head commit (the
        runner mints one for every branch push it grades and none it skips),
        or the run ended red (every skip path ends green, so a red run is one
        that tried to grade and failed before or after minting the tag). A red
        run at the acceptance commit or at a `[skip ci]` commit is the
        exception: the runner's skip detection failed open that time (Pages
        outage) and a rerun skips again, so those are passed over.
    tag_only=True (tag-mode assignments) never replays a branch run: there a
    branch push is a suppressed no-op even when the same commit was later
    tagged, and its tag run is the candidate instead.
    """
    if lookups is None:
        lookups = _RepoLookups(api_url, org, repo, token)
    patterns = submission_tags or []
    for candidate in lookups.runs:
        if not isinstance(candidate, dict):
            continue
        head_branch = candidate.get("head_branch")
        if isinstance(head_branch, str) and (
            head_branch.startswith(SUBMIT_TAG_PREFIX)
            or matches_submission_tag(patterns, head_branch)
        ):
            return _run_id_of(candidate)
        if tag_only:
            continue
        head_sha = candidate.get("head_sha")
        if not isinstance(head_sha, str) or not head_sha:
            continue
        if candidate.get("status") == "completed" and candidate.get("conclusion") not in (
            "success",
            "skipped",
            None,
        ):
            head_commit = candidate.get("head_commit")
            message = head_commit.get("message") if isinstance(head_commit, dict) else None
            if isinstance(message, str) and has_ci_skip_marker(message):
                continue
            if head_sha != lookups.accept_sha:
                return _run_id_of(candidate)
        if head_sha in lookups.tagged_shas:
            return _run_id_of(candidate)
    return None


def _run_id_of(run: dict) -> int:
    run_id = run.get("id")
    if not isinstance(run_id, int):
        raise ValueError("workflow run object missing an integer id")
    return run_id


def rerun_workflow_run(
    api_url: str, org: str, repo: str, token: str, run_id: int
) -> None:
    """Re-run a completed workflow run via the Actions rerun API. Replays at
    the same commit; runtime-fetched resources (runner.py and the autograder
    bundle, both from Pages at grade time) are re-fetched, so a teacher's updated
    autograder takes effect."""
    url = f"{_repo_url(api_url, org, repo)}/actions/runs/{run_id}/rerun"
    try:
        _http_request("POST", url, token, body=b"{}", accept="application/vnd.github+json")
    except urllib.error.HTTPError as exc:
        if exc.code != 403 or classify(exc) is THROTTLED:
            raise
        # One status, three causes; only the body tells them apart. A token that
        # can list runs but not re-run them must not pass as a run that merely
        # can't be re-run right now (#1051).
        body = error_body_snippet(exc).lower()
        if any(marker in body for marker in RERUN_REFUSED_FOR_RUN_MARKERS):
            emit_warning(
                f"{org}/{repo}: latest autograde run {run_id} can't be re-run "
                f"right now{body_note(exc)}; skipping"
            )
            raise _SkipRepo() from exc
        if any(marker in body for marker in RERUN_REFUSED_FOR_TOKEN_MARKERS):
            raise  # main() classifies it FATAL and prints the rotate-token advice
        raise _RepoFailed(
            f"{org}/{repo}: GitHub refused to re-run autograde run {run_id} "
            f"(HTTP 403){body_note(exc)}. Open the run on GitHub to see why, "
            f"then regrade again."
        ) from exc


class _SkipRepo(Exception):
    """A benign per-repo condition (e.g., a non-rerunnable run) that should be
    counted as skipped, not failed."""


def build_submit_tag(sha: str) -> str:
    """submit/<UTC-timestamp>-<short-sha>. The short-SHA suffix prevents
    collisions when two regrades land in the same UTC second. Mirrors the tag
    format autograde-runner.yaml writes for a branch push."""
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    return f"{SUBMIT_TAG_PREFIX}{stamp}-{sha[:7]}"


def repo_default_branch(api_url: str, org: str, repo: str, token: str) -> str | None:
    """The repo's default branch (which GitHub may have named `master`), or None
    when the repo doesn't exist (404), meaning the student hasn't accepted."""
    try:
        body = _http_get(
            _repo_url(api_url, org, repo), token, accept="application/vnd.github+json"
        )
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    data = json.loads(body.decode("utf-8"))
    branch = data.get("default_branch") if isinstance(data, dict) else None
    if isinstance(branch, str) and branch:
        return branch
    return SUBMISSION_BRANCH


def first_gradeable_commit(
    api_url: str, org: str, repo: str, token: str, *, lookups: _RepoLookups | None = None
) -> tuple[str, str] | None:
    """(sha, default branch) of the newest default-branch commit a submit/* tag
    push can fire on, or None when there is nothing to first-grade: the repo
    doesn't exist (student hasn't accepted), or nothing was pushed since the
    acceptance commit.

    Walks the branch newest-first, skipping commits whose message carries a CI
    skip marker: GitHub fires no workflow for a tag whose commit says
    `[skip ci]`, so tagging one would report "first-graded" while nothing runs.
    The tool's own bookkeeping commits (submission-mode shim retrofit, Feedback
    PR open) are exactly such commits and touch no student work, so the commit
    under them is the same submission. The walk stops at the acceptance commit
    (the one that added .classroom50.yaml): a student who accepted but never
    pushed has no submission, and grading the starter code would publish a
    zero-score release the roster reads as "submitted".

    Raises _RepoFailed on reaching the shim backfill commit: the commits under
    it have no autograde workflow at all, so a tag at any of them fires nothing
    and the student's next push is the only way to grade that work."""
    if lookups is None:
        lookups = _RepoLookups(api_url, org, repo, token)
    branch = lookups.default_branch
    if branch is None:
        return None
    for commit in list_branch_commits(api_url, org, repo, token, branch):
        sha = commit.get("sha") if isinstance(commit, dict) else None
        if not isinstance(sha, str) or not sha:
            continue
        if sha == lookups.accept_sha:
            return None
        meta = commit.get("commit")
        message = meta.get("message") if isinstance(meta, dict) else None
        if isinstance(message, str) and is_shim_backfill_commit(message):
            raise _RepoFailed(
                f"{org}/{repo}: can't grade the work pushed before commit {sha[:7]}: "
                f"the autograde workflow was added to this repository after it "
                f"(the built-in autograder was turned on later), so a tag at an "
                f"earlier commit starts no run. Grading starts on the student's "
                f"next push. To grade now, have the student push once: "
                f"`git commit --allow-empty -m \"Grade\" && git push`."
            )
        if isinstance(message, str) and has_ci_skip_marker(message):
            continue
        return sha, branch
    return None


def _commit_subject(message: str) -> str:
    """A commit message's first line, trimmed (mirrors collect_scores.py)."""
    newline = message.find("\n")
    return (message if newline == -1 else message[:newline]).strip()


def is_shim_backfill_commit(message: str) -> bool:
    """Whether a commit is the enable-autograder backfill's: subject compared
    exactly after trimming, body ignored. Mirrors collect_scores.py and
    contract.IsShimBackfillCommit; pinned by baseline_source_cases.json."""
    return _commit_subject(message) == SHIM_BACKFILL_COMMIT_SUBJECT


def has_ci_skip_marker(message: str) -> bool:
    """Whether GitHub would skip workflows for a push headed by this commit."""
    lowered = message.lower()
    if any(marker in lowered for marker in CI_SKIP_MARKERS):
        return True
    return _SKIP_CHECKS_TRAILER.search(lowered) is not None


def list_branch_commits(
    api_url: str, org: str, repo: str, token: str, branch: str, *, path: str | None = None
) -> list[Any]:
    """One newest-first page of `branch`'s commits (optionally only those
    touching `path`); [] when the repo or branch doesn't exist (404) or the
    repo's git database is still empty (409)."""
    query = {"sha": branch, "per_page": str(COMMIT_SCAN_PAGE_SIZE)}
    if path is not None:
        query["path"] = path
    url = f"{_repo_url(api_url, org, repo)}/commits?{urllib.parse.urlencode(query)}"
    try:
        body = _http_get(url, token, accept="application/vnd.github+json")
    except urllib.error.HTTPError as exc:
        if exc.code in EMPTY_OR_MISSING_GIT_DATA:
            return []
        raise
    commits = json.loads(body.decode("utf-8"))
    if not isinstance(commits, list):
        raise ValueError("repos/.../commits did not return an array")
    return commits


def acceptance_commit_sha(
    api_url: str, org: str, repo: str, token: str, branch: str
) -> str | None:
    """The acceptance commit: the oldest commit on `branch` touching the accept
    marker (nothing touches it before accept creates it). None when the marker
    has no history on the branch, so the caller doesn't stop the walk. Also
    None when the enable-autograder backfill introduced the marker: that repo
    was accepted without one (no_autograder), so the backfill is not an accept
    sentinel; the walk in first_gradeable_commit must reach it and fail red
    instead of reporting "no submission". Mirrors collect_scores.marker_baseline.
    One page deep: more than 100 marker rewrites on one repo is out of scope."""
    commits = list_branch_commits(api_url, org, repo, token, branch, path=ACCEPT_MARKER_PATH)
    for commit in reversed(commits):
        sha = commit.get("sha") if isinstance(commit, dict) else None
        if not isinstance(sha, str) or not sha:
            continue
        meta = commit.get("commit")
        message = meta.get("message") if isinstance(meta, dict) else None
        if isinstance(message, str) and is_shim_backfill_commit(message):
            return None
        return sha
    return None


def existing_submit_tag_at(
    api_url: str,
    org: str,
    repo: str,
    token: str,
    sha: str,
    *,
    lookups: _RepoLookups | None = None,
) -> str | None:
    """Return a submit/* tag name already pointing at `sha`, or None."""
    if lookups is None:
        lookups = _RepoLookups(api_url, org, repo, token)
    return lookups.tagged_shas.get(sha)


def submit_tags_by_commit(api_url: str, org: str, repo: str, token: str) -> dict[str, str]:
    """The repo's submit/* tags keyed by the commit they point at (the first
    tag seen wins when several sit on one commit); {} when the repo has none.

    Lists the repo's submit/* tag refs and resolves each to a commit. A
    lightweight tag's ref points straight at the commit (object.type ==
    "commit"); an ANNOTATED tag's ref points at a tag object (object.type ==
    "tag"), so its object.sha is the tag's own sha; that case is dereferenced
    via git/tags/<sha> to recover the target commit. Resolving both keeps the
    first-grade fallback idempotent even when a prior submit tag was annotated
    (autograde-runner.yaml's tag step filters peeled refs because annotated
    submit tags occur), so a regrade reuses the existing tag instead of
    minting a duplicate that yields two releases for one commit."""
    url = (
        f"{_repo_url(api_url, org, repo)}/git/matching-refs/"
        f"tags/{urllib.parse.quote(SUBMIT_TAG_PREFIX, safe='')}"
    )
    try:
        body = _http_get(url, token, accept="application/vnd.github+json")
    except urllib.error.HTTPError as exc:
        if exc.code in EMPTY_OR_MISSING_GIT_DATA:
            return {}
        raise
    refs = json.loads(body.decode("utf-8"))
    if not isinstance(refs, list):
        raise ValueError("git/matching-refs/tags did not return an array")
    by_commit: dict[str, str] = {}
    for ref in refs:
        if not isinstance(ref, dict):
            continue
        obj = ref.get("object")
        ref_name = ref.get("ref") or ""
        if not (
            isinstance(obj, dict)
            and isinstance(ref_name, str)
            and ref_name.startswith(f"refs/tags/{SUBMIT_TAG_PREFIX}")
        ):
            continue
        commit_sha = _ref_commit_sha(api_url, org, repo, token, obj)
        if commit_sha is not None:
            by_commit.setdefault(commit_sha, ref_name[len("refs/tags/") :])
    return by_commit


def _ref_commit_sha(api_url: str, org: str, repo: str, token: str, obj: dict) -> str | None:
    """The commit a tag ref's `object` ultimately points at, or None.

    A lightweight tag's object IS the commit (type == "commit"); an annotated
    tag's object is a tag object (type == "tag") whose git/tags/<sha>
    target.object.sha is the commit. A failed dereference resolves to None
    (worst case: a duplicate release, never a missed regrade)."""
    obj_sha = obj.get("sha")
    if not isinstance(obj_sha, str) or not obj_sha:
        return None
    if obj.get("type") != "tag":
        return obj_sha
    tag_url = f"{_repo_url(api_url, org, repo)}/git/tags/{urllib.parse.quote(obj_sha, safe='')}"
    try:
        body = _http_get(tag_url, token, accept="application/vnd.github+json")
    except urllib.error.HTTPError:
        return None
    try:
        tag_obj = json.loads(body.decode("utf-8"))
    except (json.JSONDecodeError, ValueError):
        return None
    target = tag_obj.get("object") if isinstance(tag_obj, dict) else None
    target_sha = target.get("sha") if isinstance(target, dict) else None
    return target_sha if isinstance(target_sha, str) and target_sha else None


def create_tag_ref(
    api_url: str, org: str, repo: str, token: str, tag: str, sha: str
) -> None:
    """Create a lightweight tag ref `refs/tags/<tag>` at `sha`. A 422 whose body
    says the ref already exists is benign (a concurrent regrade won the race),
    so it's swallowed; any OTHER 422 (invalid sha, unprocessable payload) is a
    real failure and propagates, so the caller records it as failed rather than
    mis-counting the repo as first-graded."""
    url = f"{_repo_url(api_url, org, repo)}/git/refs"
    payload = json.dumps({"ref": f"refs/tags/{tag}", "sha": sha}).encode("utf-8")
    try:
        _http_request("POST", url, token, body=payload, accept="application/vnd.github+json")
    except urllib.error.HTTPError as exc:
        # Only swallow the "reference already exists" 422, which GitHub returns
        # for a duplicate ref. Any other 422 (invalid sha, malformed ref) must
        # NOT count as a successful tagging, so re-raise for warn-and-skip.
        if exc.code == 422 and _http_error_says_ref_exists(exc):
            emit_warning(
                f"{org}/{repo}: tag {tag} already exists (concurrent regrade?); leaving as-is"
            )
            return
        raise


def _http_error_says_ref_exists(exc: urllib.error.HTTPError) -> bool:
    """Whether a 422's response body reports the ref already exists.

    GitHub's git/refs endpoint returns `{"message": "Reference already
    exists", ...}` for a duplicate ref. Match on that phrase
    (case-insensitively) so a genuinely different 422 isn't mistaken for the
    benign race. An unreadable body falls back to False (treat as a real error),
    failing safe toward surfacing the failure.

    Reads through error_body_snippet rather than exc.read(): the body is a
    one-shot stream, so a second reader would get b"" and silently lose this
    detection. That widens the match from the `message` field to the whole
    300-char body, deliberately: a duplicate-ref 422 says "already exists"
    nowhere else, and matching the field alone would miss GitHub's other
    phrasings of the same race."""
    return "already exists" in error_body_snippet(exc).lower()


# Roster / assignment loading -------------------------------------------------


class RegradeInputError(Exception):
    """A missing/malformed classroom dir, classroom.json, or assignments.json."""


class EmptyRepoAssignment(Exception):
    """The target assignment never autogrades: empty_repo: true (bare repos)
    or no_autograder: true (no built-in autograder). Student repos carry
    no autograde workflow, so there is nothing to re-run and no HEAD worth
    tagging (the first-grade fallback would push submit/* tags that fire
    nothing). main() treats this as a successful no-op, not an error."""


def is_empty_repo(entry: dict[str, Any]) -> bool:
    """True only when empty_repo is the boolean `true`. The wire contract is a
    JSON boolean (Go decodes a strict `bool`; TS uses `=== true`), so a
    non-boolean value from a hand-edited manifest is not empty_repo. Keep this
    byte-identical to collect_scores.py / the autograde-runner so every tool
    agrees on the predicate."""
    return entry.get("empty_repo") is True


def is_no_autograder(entry: dict[str, Any]) -> bool:
    """True only when no_autograder is the boolean `true` (strict, like
    is_empty_repo). A no_autograder assignment commits no shim, so it
    never autogrades and produces no submit/* releases, so regrade has nothing to
    re-run and no HEAD worth tagging. Keep byte-identical to collect_scores.py /
    the autograde-runner so every tool agrees."""
    return entry.get("no_autograder") is True


def is_init_shim(entry: dict[str, Any]) -> bool:
    """True only when init_shim is the boolean `true` (strict, like
    is_empty_repo). An init_shim assignment initializes a template-less repo
    with only the marker + default shim. It DOES autograde, so unlike
    empty_repo/no_autograder it is NOT part of skips_grading(): regrade treats
    it as a normal grading assignment. Keep byte-identical to collect_scores.py."""
    return entry.get("init_shim") is True


def skips_grading(entry: dict[str, Any]) -> bool:
    """True when the assignment never autogrades: either a bare empty_repo or a
    no_autograder (no built-in autograder). The "does not autograde"
    predicate family shared with collect_scores.py. NOTE: init_shim is
    deliberately EXCLUDED; it commits the default shim and autogrades."""
    return is_empty_repo(entry) or is_no_autograder(entry)


def is_tag_submission_mode(entry: dict[str, Any]) -> bool:
    """Whether the assignment grades ONLY on submit/* tag pushes. Strict
    equality mirroring the Go Entry.IsTagSubmissionMode: absent, "every-push",
    and any junk value all read as every-push (fail open to today's regrade
    behavior; the runner polices invalid modes at grade time)."""
    return entry.get("submission_mode") == "tag"


def load_roster(
    classroom_dir: pathlib.Path,
    assignment_slug: str,
    api_url: str,
    org: str,
    token: str,
) -> tuple[list[str], dict[str, Any]]:
    """(team members to regrade, the assignment's manifest entry) for an
    assignment registered in this classroom.

    Validates the assignments.json schema and that the target slug is
    registered (so a typo'd slug fails loudly rather than tagging nothing), then
    enumerates the classroom GitHub team, the source of truth for enrollment.
    The entry rides along so main() can read submission_mode (regrade must not
    replay a suppressed tag-mode branch run; see regrade_repo). Config
    problems raise RegradeInputError; a team-listing HTTP error propagates so
    main() can classify it (hard auth/network vs. transient).
    """
    if not classroom_dir.is_dir():
        raise RegradeInputError(
            f"classroom {classroom_dir.name!r} not found in the config repo"
        )

    assignments_path = classroom_dir / "assignments.json"
    if not assignments_path.is_file():
        raise RegradeInputError(f"{classroom_dir.name}/assignments.json not found")
    try:
        assignments = json.loads(assignments_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise RegradeInputError(f"{classroom_dir.name}/assignments.json: {exc}") from exc
    if not isinstance(assignments, dict) or assignments.get("schema") != ASSIGNMENTS_SCHEMA_V1:
        raise RegradeInputError(
            f"{classroom_dir.name}/assignments.json schema = "
            f"{assignments.get('schema')!r}, want {ASSIGNMENTS_SCHEMA_V1!r}"
        )
    entries = {
        e["slug"]: e
        for e in (assignments.get("assignments") or [])
        if isinstance(e, dict) and isinstance(e.get("slug"), str) and e.get("slug")
    }
    if assignment_slug not in entries:
        raise RegradeInputError(
            f"assignment {assignment_slug!r} is not registered in "
            f"{classroom_dir.name}/assignments.json"
        )
    # Assignments that never autograde (empty_repo, or a
    # no_autograder without the built-in autograder) commit no autograde workflow, so
    # skip before the team listing; otherwise the first-grade fallback would
    # push useless submit/* tags into every student repo.
    if skips_grading(entries[assignment_slug]):
        raise EmptyRepoAssignment(assignment_slug)

    # Resolve the classroom team slug: classroom.json's authoritative team.slug
    # (GitHub may re-slug on a name collision), else the derived slug.
    classroom_meta: dict[str, Any] = {}
    classroom_path = classroom_dir / "classroom.json"
    if classroom_path.is_file():
        try:
            loaded = json.loads(classroom_path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise RegradeInputError(
                f"{classroom_dir.name}/classroom.json: {exc}"
            ) from exc
        if isinstance(loaded, dict):
            classroom_meta = loaded
    team_slug = resolve_team_slug(classroom_meta, classroom_dir.name)

    logins = list_team_member_logins(api_url, org, team_slug, token)

    # Dedupe case-insensitively (first-seen casing wins) and drop obviously-bogus
    # logins so they don't reach the repo-name/URL builder.
    seen: set[str] = set()
    usernames: list[str] = []
    for login in logins:
        username = login.strip()
        key = username.lower()
        if not username or key in seen:
            continue
        if _USERNAME_BAD_CHARS.search(username):
            emit_warning(
                f"{classroom_dir.name}: classroom team member with malformed login "
                f"{username!r}; skipping that student"
            )
            continue
        seen.add(key)
        usernames.append(username)
    return usernames, entries[assignment_slug]


def resolve_team_slug(classroom_meta: dict[str, Any], classroom_short: str) -> str:
    """The classroom's GitHub team slug: persisted classroom.json `team.slug`
    when present (authoritative, since GitHub may re-slug on a name collision, e.g.
    `classroom50-cs-1`), else the derived `classroom50-<short>`. Mirrors
    collect_scores.py's resolve_team_slug and the web/Go resolvers so all target
    the same team."""
    team = classroom_meta.get("team")
    if isinstance(team, dict):
        slug = team.get("slug")
        if isinstance(slug, str) and slug.strip():
            return slug.strip()
    return f"classroom50-{classroom_short}"


def list_team_member_logins(
    api_url: str, org: str, team_slug: str, token: str
) -> list[str]:
    """Logins of every member of the classroom team, walking pagination. The
    team-driven username source for regrade (mirrors collect_scores.py): the
    classroom GitHub team is authoritative for enrollment. Hits
    GET /orgs/{org}/teams/{slug}/members.

    Pagination follows GitHub's `Link: rel="next"` header, host-pinned to
    api_url so a crafted Link can't pivot the token. Raises
    urllib.error.HTTPError on any non-2xx (including 404 when the team doesn't
    exist) so the caller can classify hard vs. transient."""
    per_page = 100
    base = (
        f"{api_url}/orgs/{urllib.parse.quote(org, safe='')}/teams/"
        f"{urllib.parse.quote(team_slug, safe='')}/members"
    )
    return _paginate_login_list(
        page_url=lambda page: f"{base}?per_page={per_page}&page={page}",
        api_url=api_url,
        token=token,
        resource_label=f"orgs/{org}/teams/{team_slug}/members",
    )


def _paginate_login_list(
    page_url: Callable[[int], str],
    api_url: str,
    token: str,
    resource_label: str,
) -> list[str]:
    """Walk a paginated GitHub list-of-accounts endpoint, returning every
    `login`. Only the first page uses `page_url`; subsequent pages follow
    GitHub's `Link: rel="next"`, host-pinned via _assert_same_host so a crafted
    Link can't pivot the token. When no Link header is present, falls back to
    page+1 and stops on a short page. A self/looping rel="next" is bounded by
    seen_next. Mirrors collect_scores.py's helper of the same name.

    Raises urllib.error.HTTPError on any non-2xx (including 404) so the caller
    can classify; raises ValueError on a non-array body or on hitting the cap.
    """
    per_page = 100
    max_pages = 100
    logins: list[str] = []
    url = page_url(1)
    seen_next: set[str] = set()
    for page in range(1, max_pages + 1):
        body, headers = _http_get_with_headers(
            url, token, accept="application/vnd.github+json"
        )
        batch = json.loads(body.decode("utf-8"))
        if not isinstance(batch, list):
            raise ValueError(
                f"GET {url}: expected JSON array, got {type(batch).__name__}"
            )
        for item in batch:
            if not isinstance(item, dict):
                continue
            login = item.get("login")
            if isinstance(login, str) and login:
                logins.append(login)
        link_header = headers.get("Link") if headers else None
        next_url = _next_page_link(link_header)
        if next_url:
            next_url = _assert_same_host(next_url, api_url)
            if next_url in seen_next:
                return logins
            seen_next.add(next_url)
            url = next_url
            continue
        if link_header or len(batch) < per_page:
            return logins
        url = page_url(page + 1)
    raise ValueError(
        f"{resource_label}: too many entries to enumerate "
        f"(hit the {max_pages}-page cap)"
    )


def _next_page_link(link_header: str | None) -> str | None:
    """The `rel="next"` URL from a GitHub `Link` header, or None. Mirrors
    collect_scores.py's _next_page_link."""
    if not link_header:
        return None
    m = re.search(r'<([^>]+)>\s*;\s*[^,]*rel="next"', link_header)
    return m.group(1) if m else None


def _assert_same_host(next_url: str, api_url: str) -> str:
    """Return next_url only if its scheme+host match api_url's; else raise
    ValueError. The pagination loop attaches the bearer token to whatever URL it
    follows, so a malicious `Link: rel="next"` pointing off-host would pivot the
    token. Mirrors collect_scores.py's _assert_same_host."""
    api = urllib.parse.urlsplit(api_url)
    nxt = urllib.parse.urlsplit(next_url)
    if (nxt.scheme, nxt.netloc) != (api.scheme, api.netloc):
        raise ValueError(
            f"pagination Link points off-host "
            f"({nxt.scheme}://{nxt.netloc} != {api.scheme}://{api.netloc}); "
            f"refusing to send the service token to a different host"
        )
    return next_url


def assignment_repo_name(classroom: str, assignment: str, username: str) -> str:
    """Canonical student-repo name. Mirrors the formula single-sourced in
    cli/shared/contract (AssignmentRepoName); keep byte-identical or the
    regrade fan-out misidentifies submissions."""
    return f"{classroom.lower()}-{assignment.lower()}-{username.lower()}"


# GitHub API helpers ----------------------------------------------------------


def _repo_url(api_url: str, owner: str, repo: str) -> str:
    return (
        f"{api_url}/repos/{urllib.parse.quote(owner, safe='')}/"
        f"{urllib.parse.quote(repo, safe='')}"
    )


class _AuthStrippingRedirect(urllib.request.HTTPRedirectHandler):
    """Drop Authorization on redirect so the service token isn't forwarded to a
    redirect target on a different host. CPython's default handler replays every
    request header (including Authorization) across a cross-host 3xx, which would
    leak the fine-grained CLASSROOM50_SERVICE_TOKEN; _assert_same_host only pins
    the explicit Link-follow, not a transport-level redirect. Mirrors
    collect_scores.py's _AuthStrippingRedirect (kept in lockstep)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new_req = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new_req is None:
            return None
        for h in ("Authorization", "authorization"):
            new_req.headers.pop(h, None)
            if hasattr(new_req, "unredirected_hdrs"):
                new_req.unredirected_hdrs.pop(h, None)
        return new_req


_OPENER = urllib.request.build_opener(_AuthStrippingRedirect)


def _http_get(url: str, token: str, *, accept: str, _retries: int = 3) -> bytes:
    """GET `url`; return the body. Thin wrapper over _http_get_with_headers for
    callers that don't need response headers."""
    body, _headers = _http_get_with_headers(url, token, accept=accept, _retries=_retries)
    return body


def _http_get_with_headers(
    url: str, token: str, *, accept: str, _retries: int = 3
) -> tuple[bytes, Any]:
    """GET `url` with bearer auth; return (body, response headers). Headers are
    returned so paginated callers can follow `Link: rel="next"` (mirrors
    collect_scores.py's _http_get_with_headers)."""
    return _http_send("GET", url, token, accept=accept, body=None, _retries=_retries)


def _http_request(
    method: str,
    url: str,
    token: str,
    *,
    accept: str,
    body: bytes | None = None,
    _retries: int = 3,
) -> bytes:
    """Issue `method url` with bearer auth; return the body. Thin wrapper over
    the transport core for callers (the rerun/tag POSTs) that don't need the
    response headers."""
    result, _headers = _http_send(method, url, token, accept=accept, body=body, _retries=_retries)
    return result


def _http_send(
    method: str,
    url: str,
    token: str,
    *,
    accept: str,
    body: bytes | None,
    _retries: int = 3,
) -> tuple[bytes, Any]:
    """The single transport core: issue `method url` with bearer auth and return
    (body, response headers). Retries 5xx/429 and throttled 403s with backoff
    (see retry_delay), wraps a read-phase stall into a synthetic 599 so
    classify() reports FATAL and the run aborts, and routes through _OPENER so a
    cross-host redirect strips Authorization. Mirrors collect_scores.py's
    transport."""
    headers = {
        "Accept": accept,
        "Authorization": f"Bearer {token}",
        "User-Agent": "classroom50-regrade",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    # A body is always a JSON payload (the rerun/tag POSTs); GET carries none.
    if body is not None:
        headers["Content-Type"] = "application/json"
    for attempt in range(_retries):
        req = urllib.request.Request(url, method=method, data=body, headers=headers)
        try:
            with _OPENER.open(req, timeout=30) as resp:
                return resp.read(), resp.headers
        except urllib.error.HTTPError as exc:
            delay = retry_delay(exc, attempt)
            if delay is not None and attempt < _retries - 1:
                time.sleep(delay)
                continue
            raise
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            if attempt < _retries - 1:
                time.sleep(2**attempt)
                continue
            raise urllib.error.HTTPError(
                url=url,
                code=599,
                msg=f"network error: {exc}",
                hdrs=None,  # type: ignore[arg-type]
                fp=None,
            ) from exc
    raise RuntimeError(f"_http_send called with _retries={_retries}")


def error_body_snippet(exc: urllib.error.HTTPError) -> str:
    """First 300 characters of an error response body, whitespace-collapsed
    and cached on the exception so a later reader still sees it after the
    stream is consumed. Mirrors collect_scores.py."""
    cached = getattr(exc, "_body_snippet", None)
    if cached is None:
        try:
            raw = exc.read(BODY_SNIPPET_READ_BYTES) or b""
        except (OSError, ValueError, AttributeError):
            raw = b""
        cached = " ".join(raw.decode("utf-8", "replace").split())[:300]
        setattr(exc, "_body_snippet", cached)
    return cached


def body_note(exc: urllib.error.HTTPError) -> str:
    """error_body_snippet formatted for appending to a log line."""
    snippet = error_body_snippet(exc)
    return f", response: {snippet}" if snippet else ""


def rate_limit_verdict(
    exc: urllib.error.HTTPError,
) -> tuple[str, float | None] | None:
    """`(reason, seconds-to-wait)` when the response says GitHub is THROTTLING
    rather than refusing, else None; `seconds` is None for a throttle that must
    NOT be waited out. Mirrors collect_scores.py: a 403 is a rate limit as often
    as it is a scope problem, and only the response tells them apart.

    One ladder answers both questions, so the reason and the delay can't
    disagree; rate_limit_reason and retry_delay are its two views."""
    if exc.code not in (403, 429):
        return None
    headers = exc.headers or {}
    retry_after = _retry_after_seconds(headers)
    if retry_after is not None:
        return (
            f"Retry-After: {retry_after}s",
            min(int(retry_after), MAX_RETRY_SLEEP_SECONDS),
        )
    if (headers.get("X-RateLimit-Remaining") or "").strip() == "0":
        # The primary hourly budget: not waited out, because its window runs up to an
        # hour, so a named error beats a sleeping job.
        reset = (headers.get("X-RateLimit-Reset") or "").strip()
        window = f", resets at {epoch_to_iso(reset)}" if reset.isdigit() else ""
        return (f"X-RateLimit-Remaining: 0{window}", None)
    body = error_body_snippet(exc).lower()
    for marker in RATE_LIMIT_BODY_MARKERS:
        if marker in body:
            return (
                f'response body names the "{marker}"',
                MAX_RETRY_SLEEP_SECONDS,
            )
    return None


def rate_limit_reason(exc: urllib.error.HTTPError) -> str | None:
    """What in the response says GitHub is THROTTLING rather than refusing, or
    None when nothing does. The reason half of rate_limit_verdict."""
    verdict = rate_limit_verdict(exc)
    return verdict[0] if verdict is not None else None


def epoch_to_iso(value: str) -> str:
    """Unix epoch seconds (X-RateLimit-Reset) as an RFC 3339 UTC timestamp, or
    the raw value when it doesn't name a representable time. Mirrors
    collect_scores.py."""
    try:
        return datetime.datetime.fromtimestamp(
            int(value), tz=datetime.timezone.utc
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (ValueError, OverflowError, OSError):
        return value


def throttle_sleep_budget_spent(delay: float) -> bool:
    """Whether waiting `delay` would exceed the run's total throttle-sleep
    budget; charges it when it fits. Mirrors collect_scores.py, which documents
    why the ceiling exists."""
    global _throttle_sleep_spent
    if _throttle_sleep_spent + delay > MAX_TOTAL_THROTTLE_SLEEP_SECONDS:
        return True
    _throttle_sleep_spent += delay
    return False


def _retry_after_seconds(headers: Any) -> str | None:
    """The Retry-After header when it names plain delta-seconds, else None.
    Mirrors collect_scores.py."""
    value = (headers.get("Retry-After") or "").strip() if headers else ""
    return value if value.isdigit() else None


def retry_delay(exc: urllib.error.HTTPError, attempt: int) -> float | None:
    """Seconds to wait before retrying `exc`, or None when it must not be
    retried. Mirrors collect_scores.py."""
    verdict = rate_limit_verdict(exc)
    if verdict is not None:
        delay = verdict[1]
        if delay is not None and throttle_sleep_budget_spent(delay):
            return None
        return delay
    if exc.code in (429, 500, 502, 503, 504):
        retry_after = _retry_after_seconds(exc.headers)
        if retry_after is not None:
            return min(int(retry_after), TRANSIENT_RETRY_CAP_SECONDS)
        return 2**attempt
    return None


def classify(exc: urllib.error.HTTPError) -> str:
    """The ONE verdict every error handler branches on. Mirrors
    collect_scores.py.

    THROTTLED: GitHub is rate limiting; the token is healthy and the work is
        deferrable.
    FATAL:     401/403 (bad or under-scoped token) or 599 (synthetic
        network-unavailable after retries). Aborts the run.
    SKIPPABLE: everything else; a per-repo 404/422 warns and skips.

    The throttle is checked FIRST (see rate_limit_verdict)."""
    if rate_limit_verdict(exc) is not None:
        return THROTTLED
    if exc.code in (401, 403, 599):
        return FATAL
    return SKIPPABLE


# Workflow-command output -----------------------------------------------------


def emit_error(message: str) -> None:
    print(f"::error::{message}", file=sys.stderr)


def emit_warning(message: str) -> None:
    print(f"::warning::{message}", file=sys.stderr)


# Entry point ----------------------------------------------------------------


if __name__ == "__main__":
    sys.exit(main())
