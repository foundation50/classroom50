#!/usr/bin/env python3
"""Teacher-triggered regrade fan-out.

Re-runs the autograder across an assignment's student repos WITHOUT changing
each submission. For every targeted repo it re-runs the latest `autograde.yaml`
run via the Actions rerun API: grades the SAME commit again and re-fetches the
current autograder from Pages, so a teacher's fixed test / updated autograder
takes effect. Because the runner stamps the submission `datetime` from the
graded commit's committer date (not grade time), the submission time and `late`
flag are unchanged — only the score/`graded_at` move.

A re-run replays at ITS ORIGINAL submit/* commit, NOT the current `main` HEAD:
regrade refreshes the score for an EXISTING submission; it does not grade newer
un-submitted work. (Only the first-grade fallback below tags the current HEAD.)

A repo with a `main` HEAD but no prior autograde run (never graded) is
first-graded by pushing a fresh `submit/<UTC-timestamp>-<short-sha>` tag, which
fires its autograde workflow. Repos with no `main` HEAD (student hasn't
accepted/pushed) are skipped.

Grading then happens ASYNCHRONOUSLY inside each student repo, so refreshed
releases are ingested by the next `collect-scores.py` run (nightly or "Collect
now"). Until then the gradebook shows PRE-regrade scores — an eventual-
consistency window, by design (collecting here would race the still-running
grade jobs).

Team-driven (mirroring collect_scores.py): the (student, assignment) pairs come
from the classroom GitHub team x `<classroom>/assignments.json`. The classroom
team is the source of truth for enrollment. A single
`OWNER_FILTER` narrows to one repo (the per-row "Regrade" web action); empty
means the whole assignment.

Environment (set by `regrade.yaml`):
  CLASSROOM50_SERVICE_TOKEN — fine-grained PAT, Contents: Read and write AND
                              Actions: Read and write on the student repos, plus
                              Organization -> Members: Read to list the classroom
                              team. Actions: write re-runs a run; Contents: write
                              pushes a submit/* tag for the first-grade case.
  CLASSROOM_FILTER          — classroom short-name (required for regrade).
  ASSIGNMENT_FILTER         — assignment slug (required for regrade).
  OWNER_FILTER              — optional single repo-owner login; empty means
                              every rostered student for the assignment.
  GITHUB_REPOSITORY_OWNER   — org name (auto-set by Actions).
  GITHUB_API_URL            — API URL on GHES runners.
  GH_API_URL                — explicit override (test servers).

Exit codes:
  0 — success (every targeted repo re-run, first-graded, or had nothing to do).
  1 — operational failure (missing token/inputs, auth rejection, unrecoverable
      network error). Per-repo failures warn and skip.
"""

from __future__ import annotations

import datetime
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

# Schema sentinels — keep in lockstep with collect_scores.py and the Go
# constants in cli/gh-teacher/classroom.go / assignments_json.go.
CLASSROOM_SCHEMA_V1 = "classroom50/classroom/v1"
ASSIGNMENTS_SCHEMA_V1 = "classroom50/assignments/v1"

# Trigger contract: the autograde workflow fires on `submit/*` tags. Keep this
# prefix aligned with autograde-runner.yaml and collect_scores.py.
SUBMIT_TAG_PREFIX = "submit/"

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


# Top-level dispatch ----------------------------------------------------------


def main() -> int:
    base_dir = pathlib.Path(os.environ.get("GITHUB_WORKSPACE") or ".").resolve()

    classroom_filter = (os.environ.get("CLASSROOM_FILTER") or "").strip()
    assignment_filter = (os.environ.get("ASSIGNMENT_FILTER") or "").strip()
    owner_filter = (os.environ.get("OWNER_FILTER") or "").strip()

    # Regrade is always scoped to one classroom + assignment — unlike collect
    # (which can sweep all classrooms), there's no "regrade everything" mode, so
    # both inputs are required.
    if not classroom_filter:
        emit_error("CLASSROOM_FILTER is empty — regrade requires a classroom short-name")
        return 1
    if not assignment_filter:
        emit_error("ASSIGNMENT_FILTER is empty — regrade requires an assignment slug")
        return 1

    org = (os.environ.get("GITHUB_REPOSITORY_OWNER") or "").strip()
    if not org:
        emit_error(
            "GITHUB_REPOSITORY_OWNER is empty — this script must run inside a GitHub Actions workflow"
        )
        return 1

    service_token = (os.environ.get("CLASSROOM50_SERVICE_TOKEN") or "").strip()
    if not service_token:
        emit_error(
            "CLASSROOM50_SERVICE_TOKEN is empty — run `gh teacher rotate-service-token <org>` to provision it"
        )
        return 1

    api_url = (
        os.environ.get("GH_API_URL")
        or os.environ.get("GITHUB_API_URL")
        or "https://api.github.com"
    ).rstrip("/")

    classroom_dir = base_dir / classroom_filter
    try:
        roster = load_roster(classroom_dir, assignment_filter, api_url, org, service_token)
    except RegradeInputError as exc:
        emit_error(str(exc))
        return 1
    except urllib.error.HTTPError as exc:
        if is_hard_http_error(exc):
            emit_error(
                f"{classroom_filter}: could not list the classroom team — service token "
                f"rejected or network unavailable (HTTP {exc.code} {exc.reason or 'no reason'}). "
                f"Ensure CLASSROOM50_SERVICE_TOKEN has Organization -> Members: Read with "
                f"`gh teacher rotate-service-token {org}`"
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
        # uncaught traceback — mirrors collect_scores.py's handling of the same
        # raise.
        emit_error(
            f"{classroom_filter}: classroom team member listing malformed ({exc})"
        )
        return 1

    # An empty team (enrollment flux, or a team not yet populated) means there's
    # nothing to regrade — succeed, but warn so a green 0-repo run isn't mistaken
    # for a successful regrade. Mirrors collect_scores.py's empty-team warning. A
    # single-owner regrade surfaces its own "not a member" error below instead.
    if not roster and not owner_filter:
        emit_warning(
            f"{classroom_filter}: classroom team has no members — nothing to regrade "
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

    regraded = 0   # rerun an existing run (the true regrade)
    tagged = 0     # first-grade fallback (no prior run, tagged main HEAD)
    skipped = 0    # nothing to do (not accepted) or benign skip
    failed: list[str] = []
    total = len(targets)
    for index, username in enumerate(targets, start=1):
        repo_name = assignment_repo_name(classroom_filter, assignment_filter, username)
        try:
            outcome = regrade_repo(api_url, org, repo_name, service_token)
        except _SkipRepo:
            # Benign per-repo skip (e.g. the latest run can't be re-run right
            # now); already warned at the source.
            skipped += 1
            continue
        except urllib.error.HTTPError as exc:
            if is_hard_http_error(exc):
                emit_error(
                    f"{org}/{repo_name}: regrade aborted — service token rejected or network "
                    f"unavailable (HTTP {exc.code} {exc.reason or 'no reason'}). Re-scope the PAT "
                    f"to Contents: Read and write AND Actions: Read and write with "
                    f"`gh teacher rotate-service-token {org}`"
                )
                return 1
            emit_warning(
                f"{org}/{repo_name}: regrade failed: HTTP {exc.code} "
                f"({exc.reason or 'no reason'}); skipping"
            )
            failed.append(repo_name)
            continue
        except (json.JSONDecodeError, ValueError) as exc:
            emit_warning(f"{org}/{repo_name}: regrade failed ({exc}); skipping")
            failed.append(repo_name)
            continue

        if outcome == "rerun":
            regraded += 1
        elif outcome == "tagged":
            tagged += 1
        else:
            # "missing": the student hasn't accepted/pushed — nothing to grade.
            skipped += 1

        # Incremental progress checkpoint. The final summary below only prints
        # if the loop completes, so a job killed by the Actions timeout (a large
        # roster is a long sequential fan-out) would otherwise leave NO per-repo
        # accounting. Re-dispatching is safe (rerun is idempotent and the tag
        # path reuses an existing submit/* tag at HEAD), so a teacher can rerun.
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
        f"run ingests the new releases (nightly cron, or \"Collect now\")."
    )
    if failed:
        emit_error(
            f"regrade: {len(failed)} repo(s) could not be regraded and were skipped: "
            f"{', '.join(sorted(failed))} (the others were regraded)"
        )
        return 1
    return 0


# Per-repo regrade ------------------------------------------------------------


# The student-repo autograde workflow filename (the shim gh-student writes at
# accept time, `name: Autograde`). Re-running its latest run re-fetches the
# current autograder from Pages and re-grades the same commit. Cross-binary:
# keep aligned with cli/gh-student/embed/autograde-shim.yaml's filename.
AUTOGRADE_WORKFLOW = "autograde.yaml"


def regrade_repo(api_url: str, org: str, repo: str, token: str) -> str:
    """Re-run grading for `repo` on its existing latest submission, without
    creating a new one. Returns one of:

      "rerun"   — re-ran the latest autograde run: grades the SAME commit again
                  (re-fetching the current autograder), and because the runner
                  stamps `datetime` from the commit's committer date, the
                  submission time / late flag DON'T change — only the score.
      "tagged"  — no prior run, so a fresh submit/<ts>-<sha> tag was pushed to
                  first-grade the main HEAD. (Submission time is still the
                  commit's committer date; `graded_at` records the new run.)
      "missing" — no prior run and no main HEAD (student hasn't
                  accepted/pushed); nothing to do.

    Raises urllib.error.HTTPError / ValueError on a hard failure the caller
    classifies (auth/network abort; other per-repo errors warn-and-skip).
    """
    # Prefer re-running the existing run: a true "regrade the same commit" with
    # no new tag and no new submission event.
    run_id = latest_autograde_run_id(api_url, org, repo, token)
    if run_id is not None:
        rerun_workflow_run(api_url, org, repo, token, run_id)
        return "rerun"

    # No prior run. If the repo has a main HEAD, kick off a first grade by
    # tagging it; otherwise there's nothing to regrade.
    head_sha = main_head_sha(api_url, org, repo, token)
    if head_sha is None:
        return "missing"

    # A submit/* tag may already sit at HEAD (tagged but the run was deleted);
    # reuse it rather than stacking a duplicate.
    if existing_submit_tag_at(api_url, org, repo, token, head_sha) is not None:
        return "tagged"

    tag = build_submit_tag(head_sha)
    create_tag_ref(api_url, org, repo, token, tag, head_sha)
    return "tagged"


def latest_autograde_run_id(
    api_url: str, org: str, repo: str, token: str
) -> int | None:
    """The id of the most recent autograde run on `repo`, or None when it has
    never run (or doesn't exist yet). Run ids are newest-first from the API, so
    the first entry is the latest run — the one a regrade re-runs."""
    url = (
        f"{_repo_url(api_url, org, repo)}/actions/workflows/"
        f"{urllib.parse.quote(AUTOGRADE_WORKFLOW)}/runs?per_page=1"
    )
    try:
        body = _http_get(url, token, accept="application/vnd.github+json")
    except urllib.error.HTTPError as exc:
        # 404 = repo or workflow not present yet (never accepted / never ran).
        if exc.code == 404:
            return None
        raise
    data = json.loads(body.decode("utf-8"))
    runs = data.get("workflow_runs") if isinstance(data, dict) else None
    if not isinstance(runs, list) or not runs:
        return None
    run = runs[0]
    run_id = run.get("id") if isinstance(run, dict) else None
    if not isinstance(run_id, int):
        raise ValueError("workflow run object missing an integer id")
    return run_id


def rerun_workflow_run(
    api_url: str, org: str, repo: str, token: str, run_id: int
) -> None:
    """Re-run a completed workflow run via the Actions rerun API. Replays at
    the same commit; runtime-fetched resources (runner.py and the autograder
    bundle, both from Pages at grade time) are re-fetched, so a teacher's updated
    autograder takes effect. A 403 (not re-runnable — e.g. still in progress) is
    surfaced as a per-repo skip by the caller, not a hard auth failure, so one
    un-rerunnable repo doesn't abort the run."""
    url = f"{_repo_url(api_url, org, repo)}/actions/runs/{run_id}/rerun"
    try:
        _http_request("POST", url, token, body=b"{}", accept="application/vnd.github+json")
    except urllib.error.HTTPError as exc:
        # 403 here means "this run can't be re-run right now" (in progress, or
        # too old); treat as a benign per-repo skip rather than a token error.
        if exc.code == 403:
            emit_warning(
                f"{org}/{repo}: latest autograde run {run_id} can't be re-run "
                f"right now (in progress or expired); skipping"
            )
            raise _SkipRepo() from exc
        raise


class _SkipRepo(Exception):
    """A benign per-repo condition (e.g. a non-rerunnable run) that should be
    counted as skipped, not failed."""


def build_submit_tag(sha: str) -> str:
    """submit/<UTC-timestamp>-<short-sha>. The short-SHA suffix prevents
    collisions when two regrades land in the same UTC second. Mirrors the tag
    format autograde-runner.yaml writes for a branch push."""
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    return f"{SUBMIT_TAG_PREFIX}{stamp}-{sha[:7]}"


def repo_default_branch(api_url: str, org: str, repo: str, token: str) -> str | None:
    """The repo's default branch (which GitHub may have named `master`), or None
    when the repo doesn't exist (404) — the student hasn't accepted."""
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


def main_head_sha(api_url: str, org: str, repo: str, token: str) -> str | None:
    """The commit SHA at `repo`'s default-branch HEAD, or None when the repo
    or branch doesn't exist (404) — the student hasn't accepted/pushed.

    Resolves the repo's actual default branch first (it may be `master`), so a
    non-main repo is regraded off its real HEAD rather than a nonexistent
    `main`."""
    branch = repo_default_branch(api_url, org, repo, token)
    if branch is None:
        return None
    url = f"{_repo_url(api_url, org, repo)}/git/ref/heads/{urllib.parse.quote(branch)}"
    try:
        body = _http_get(url, token, accept="application/vnd.github+json")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    ref = json.loads(body.decode("utf-8"))
    obj = ref.get("object") if isinstance(ref, dict) else None
    sha = obj.get("sha") if isinstance(obj, dict) else None
    if not isinstance(sha, str) or not sha:
        raise ValueError(f"git/ref/heads/{branch} returned no object.sha")
    return sha


def existing_submit_tag_at(
    api_url: str, org: str, repo: str, token: str, sha: str
) -> str | None:
    """Return a submit/* tag name already pointing at `sha`, or None.

    Lists the repo's submit/* tag refs and matches on the pointed-at commit. A
    lightweight tag's ref points straight at the commit (object.type ==
    "commit"); an ANNOTATED tag's ref points at a tag object (object.type ==
    "tag"), so its object.sha is the tag's own sha — that case is dereferenced
    via git/tags/<sha> to recover the target commit before comparing. Resolving
    both keeps the first-grade fallback idempotent even when a prior submit tag
    was annotated (autograde-runner.yaml's set-latest step shows annotated
    submit tags occur), so a regrade reuses the existing tag instead of minting
    a duplicate that yields two releases for one commit."""
    url = (
        f"{_repo_url(api_url, org, repo)}/git/matching-refs/"
        f"tags/{urllib.parse.quote(SUBMIT_TAG_PREFIX, safe='')}"
    )
    try:
        body = _http_get(url, token, accept="application/vnd.github+json")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    refs = json.loads(body.decode("utf-8"))
    if not isinstance(refs, list):
        raise ValueError("git/matching-refs/tags did not return an array")
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
        if _ref_points_at_commit(api_url, org, repo, token, obj, sha):
            return ref_name[len("refs/tags/") :]
    return None


def _ref_points_at_commit(
    api_url: str, org: str, repo: str, token: str, obj: dict, sha: str
) -> bool:
    """Whether a tag ref's `object` ultimately points at commit `sha`.

    A lightweight tag's object IS the commit (type == "commit"); an annotated
    tag's object is a tag object (type == "tag") whose git/tags/<sha>
    target.object.sha is the commit. A failed dereference is treated
    conservatively as a non-match (worst case: a duplicate release, never a
    missed regrade)."""
    obj_sha = obj.get("sha")
    if not isinstance(obj_sha, str) or not obj_sha:
        return False
    if obj_sha == sha:
        return True
    # Annotated tag: the ref points at a tag object, so dereference it to the
    # commit it wraps. Lightweight tags (type "commit") already matched/failed
    # above, so only chase the tag-object case.
    if obj.get("type") != "tag":
        return False
    tag_url = f"{_repo_url(api_url, org, repo)}/git/tags/{urllib.parse.quote(obj_sha, safe='')}"
    try:
        body = _http_get(tag_url, token, accept="application/vnd.github+json")
    except urllib.error.HTTPError:
        return False
    try:
        tag_obj = json.loads(body.decode("utf-8"))
    except (json.JSONDecodeError, ValueError):
        return False
    target = tag_obj.get("object") if isinstance(tag_obj, dict) else None
    target_sha = target.get("sha") if isinstance(target, dict) else None
    return isinstance(target_sha, str) and target_sha == sha


def create_tag_ref(
    api_url: str, org: str, repo: str, token: str, tag: str, sha: str
) -> None:
    """Create a lightweight tag ref `refs/tags/<tag>` at `sha`. A 422 whose body
    says the ref already exists is benign — a concurrent regrade won the race —
    so it's swallowed; any OTHER 422 (invalid sha, unprocessable payload) is a
    real failure and propagates, so the caller records it as failed rather than
    mis-counting the repo as first-graded."""
    url = f"{_repo_url(api_url, org, repo)}/git/refs"
    payload = json.dumps({"ref": f"refs/tags/{tag}", "sha": sha}).encode("utf-8")
    try:
        _http_request("POST", url, token, body=payload, accept="application/vnd.github+json")
    except urllib.error.HTTPError as exc:
        # Only swallow the "reference already exists" 422 — GitHub returns that
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
    exists", ...}` for a duplicate ref. Match on that (case-insensitively) so a
    genuinely different 422 isn't mistaken for the benign race. An unreadable
    body falls back to False (treat as a real error) — failing safe toward
    surfacing the failure."""
    try:
        raw = exc.read()
    except (OSError, ValueError):
        return False
    if not raw:
        return False
    try:
        body = json.loads(raw.decode("utf-8", errors="replace"))
    except (json.JSONDecodeError, ValueError):
        return False
    message = body.get("message") if isinstance(body, dict) else None
    return isinstance(message, str) and "already exists" in message.lower()


# Roster / assignment loading -------------------------------------------------


class RegradeInputError(Exception):
    """A missing/malformed classroom dir, classroom.json, or assignments.json."""


def load_roster(
    classroom_dir: pathlib.Path,
    assignment_slug: str,
    api_url: str,
    org: str,
    token: str,
) -> list[str]:
    """Team members to regrade for an assignment registered in this classroom.

    Validates the assignments.json schema and that the target slug is
    registered (so a typo'd slug fails loudly rather than tagging nothing), then
    enumerates the classroom GitHub team — the source of truth for enrollment.
    Config problems raise RegradeInputError; a team-listing HTTP error
    propagates so main() can classify it (hard auth/network vs. transient).
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
    slugs = {
        e.get("slug")
        for e in (assignments.get("assignments") or [])
        if isinstance(e, dict) and isinstance(e.get("slug"), str) and e.get("slug")
    }
    if assignment_slug not in slugs:
        raise RegradeInputError(
            f"assignment {assignment_slug!r} is not registered in "
            f"{classroom_dir.name}/assignments.json"
        )

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
    return usernames


def resolve_team_slug(classroom_meta: dict[str, Any], classroom_short: str) -> str:
    """The classroom's GitHub team slug: persisted classroom.json `team.slug`
    when present (authoritative — GitHub may re-slug on a name collision, e.g.
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
    (body, response headers). Retries 5xx/429 with backoff (honoring Retry-After),
    wraps a read-phase stall into a synthetic 599 so is_hard_http_error aborts the
    run, and routes through _OPENER so a cross-host redirect strips Authorization.
    Mirrors collect_scores.py's transport."""
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
            if exc.code in (429, 500, 502, 503, 504) and attempt < _retries - 1:
                retry_after = exc.headers.get("Retry-After") if exc.headers else None
                delay = (
                    min(int(retry_after), 30)
                    if (retry_after or "").isdigit()
                    else 2**attempt
                )
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


def is_hard_http_error(exc: urllib.error.HTTPError) -> bool:
    """Hard failures that abort the whole run: 401/403 (bad/under-scoped
    token) and 599 (synthetic network-unavailable after retries). Mirrors
    collect_scores.py. A per-repo 404/422 is NOT hard — it warns and skips."""
    return exc.code in (401, 403, 599)


# Workflow-command output -----------------------------------------------------


def emit_error(message: str) -> None:
    print(f"::error::{message}", file=sys.stderr)


def emit_warning(message: str) -> None:
    print(f"::warning::{message}", file=sys.stderr)


# Entry point ----------------------------------------------------------------


if __name__ == "__main__":
    sys.exit(main())
