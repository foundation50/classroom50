#!/usr/bin/env python3
"""Teacher-triggered scores collector.

Walks the classroom teams × assignment manifest: for each (team member,
assignment) pair, pages the canonical `<classroom>-<assignment>-<username>`
repo's `submit/*` releases, validates each `result.json` asset, and upserts
into `<classroom>/scores.json`. The polled members are the union of the
classroom's STUDENT team and its STAFF teams (teacher/hta/ta), so a staff
member who accepted an assignment to test the autograde flow is collected like
a student. Staff who never accepted have no assignment repo, so their poll
returns no releases and they produce no entry (the "accepted" gate is implicit
in the per-repo release read). The classroom GitHub teams are the source of
truth for enrollment; the roster (roster.csv) is only a
best-effort source of optional display metadata (name/section/email).

`scores.json` is keyed by assignment slug under root `assignments`: each value
is `{ "type": "individual"|"group", "entries": [...] }`. An `entry` is one
student repo's record (one per repo owner): identity/keying at the top
(`owner`; plus `member_usernames` for group — the credited collaborators) and
the full per-submission history in `submissions` (newest first). Each
`submissions` item is a validated `result.json` payload minus the redundant
`assignment` bucket key (it carries `owner` + `assignment_type` + optional
`submitted_by`, no `usernames`). When the assignment has a `due` date, each
record carries `"late": true|false` (its `datetime` vs. `due`) — advisory only;
late submissions are still collected and scored.

Single writer per scores.json. Re-runs are idempotent: unchanged submissions
are no-ops, and `"override": true` entries are preserved verbatim so teacher
corrections aren't overwritten. Per-classroom writes are atomic (tmp +
os.replace). A missing release is not an error (student hasn't
accepted/submitted); the per-assignment "X of Y submitted" log shows coverage.

Environment (set by `collect-scores.yaml`):
  CLASSROOM50_SERVICE_TOKEN — fine-grained PAT. Needs Organization ->
                              Members: Read (collection lists the classroom
                              team), Repository -> Contents: Read and write
                              (read scope used here; write scope shared with
                              regrade.yaml), and Repository -> Administration:
                              Read and write (grant staff teams repo access via
                              PUT teams/.../repos/...).
  CLASSROOM_FILTER          — optional single-classroom limit.
  GITHUB_REPOSITORY_OWNER   — org name (auto-set by Actions).
  GITHUB_API_URL            — API URL on GHES runners.
  GH_API_URL                — explicit override (test servers).

Exit codes:
  0 — success.
  1 — operational failure (missing token, malformed scores.json, unrecoverable
      network error). The run log points at `gh teacher rotate-service-token`
      for PAT issues.
"""

from __future__ import annotations

import csv
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
from typing import Any, Callable, Iterable

# Schema sentinels — keep in lockstep with the Go-side constants in
# `cli/gh-teacher/classroom.go` and `cli/gh-teacher/assignments_json.go`.
CLASSROOM_SCHEMA_V1 = "classroom50/classroom/v1"
ASSIGNMENTS_SCHEMA_V1 = "classroom50/assignments/v1"
SCORES_SCHEMA_V1 = "classroom50/scores/v1"
RESULT_SCHEMA_V1 = "classroom50/result/v1"

# Trigger contract: only `submit/*` tag releases count as submissions
# (created by autograde-runner.yaml on push to the repo's default branch).
SUBMIT_TAG_PREFIX = "submit/"

# Repo permission the grant gives each staff role's team. Hand-mirrored from Go
# StaffTeamRepoPermissions (source of truth; parity-tested) — keep in lockstep.
# The head-TA/TA-team template read is granted eagerly at assignment add/reuse
# (Go side, which hardcodes read there); this collect-time
# grant reads the value below and is the idempotent re-affirm. A role absent
# here gets nothing (the teacher team is an org owner with access via ownership,
# so only the non-owner staff teams — head-TA and TA — need a grant).
STAFF_TEAM_PERMISSIONS = {"hta": "pull", "ta": "pull"}

# Body markers that identify a rate-limit response, for the cases no header
# names: GitHub words the secondary limit and the abuse detector differently.
# "abuse" is the bare stem on purpose — it catches every "abuse detection
# mechanism" phrasing.
#
# The first two mirror Go's ghutil.IsRateLimited; "rate limit exceeded" is a
# DELIBERATE Python-only extra, a fallback for a primary-limit response whose
# headers a proxy stripped (Go relies on the header alone).
# TestRateLimitMarkersParity_GoVsInlinePython pins both sets exactly.
RATE_LIMIT_BODY_MARKERS = (
    "secondary rate limit",
    "rate limit exceeded",
    "abuse",
)

# Longest a single retry sleeps: GitHub documents a minute as the secondary
# limit's minimum wait.
MAX_RETRY_SLEEP_SECONDS = 60

# Retry-After cap for a plain transient. Tighter than the throttle cap on
# purpose: nothing about a 500 says a full minute is the right wait.
TRANSIENT_RETRY_CAP_SECONDS = 30

# How long the whole run may spend asleep waiting out throttles. A throttle that
# RECOVERS raises nothing, so without a ceiling a few dozen of them silently
# spend the workflow's `timeout-minutes` and the job is killed mid-run — no
# summary, no scores.json, no diagnosis. Spending the budget instead surfaces
# the throttle through the named THROTTLED path.
MAX_TOTAL_THROTTLE_SLEEP_SECONDS = 300

_throttle_sleep_spent = 0.0

# Bounded read for the error-body snippet: only 300 characters are kept, and a
# body can come from a proxy or the asset redirect rather than GitHub.
BODY_SNIPPET_READ_BYTES = 4096

# The vocabulary every HTTP error handler branches on. Plain strings, not an
# Enum, so the hand-mirrored copy in regrade_repos.py stays literal-for-literal.
THROTTLED = "throttled"
FATAL = "fatal"
SKIPPABLE = "skippable"

RFC3339_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d"
    r"(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$"
)

# Release asset name written by the autograde runner. Cross-binary
# contract — keep aligned with autograde-runner.yaml and download.go.
RESULT_ASSET_NAME = "result.json"

# Hard cap on result.json size. Real payloads sit well under 1 MiB; 10 MiB
# bounds a hostile asset without rejecting any plausible submission.
MAX_RESULT_BYTES = 10 * 1024 * 1024

# Required roster columns written by `gh teacher classroom add`. Mirrors
# RosterColumns in cli/gh-teacher/internal/configrepo/students_csv.go and the
# web app's STUDENT_CSV_FIELDS. Identity/metadata columns; the trailing `role`
# (teacher/ta/student, or "") is best-effort recorded metadata refreshed from
# the classroom's GitHub teams — the teams, not this column, remain the
# enrollment authority. role was added additively, so a file written before it
# still reads fine: DictReader is header-keyed and a missing column just
# yields "".
ROSTER_REQUIRED_COLUMNS = ("username", "first_name", "last_name", "email", "section", "github_id", "role")

# Per-classroom roster file. Mirrors contract.RosterFilename in
# cli/shared/contract/contract.go with NO compile-time link — keep
# byte-identical.
ROSTER_FILENAME = "roster.csv"

# The exact on-disk roster.csv header. Must equal FullRosterHeader in the Go
# students_csv.go (asserted by TestFullRosterHeader) and the web app's
# STUDENT_CSV_FIELDS header — a three-way lockstep. Retained as the Python leg
# of that lockstep (the Go download-metadata join and the web writer share it),
# pinned by test_full_roster_header_matches_go_constant.
FULL_ROSTER_HEADER = ",".join(ROSTER_REQUIRED_COLUMNS)


# Top-level dispatch ----------------------------------------------------------


def warn_grant_deferred(classroom_short: str, detail: str) -> None:
    """The one deferral verdict, for both throttle shapes the grant pass can
    raise: the run stays green and nothing suggests rotating a credential that
    is working."""
    emit_warning(
        f"{classroom_short}: {detail}. GitHub is throttling, not refusing: "
        f"the service token is fine, do NOT rotate it. The deferred repos "
        f"are granted by the next run."
    )


def main() -> int:
    base_dir = pathlib.Path(os.environ.get("GITHUB_WORKSPACE") or ".").resolve()
    classroom_filter = (os.environ.get("CLASSROOM_FILTER") or "").strip()
    assignment_filter = (os.environ.get("ASSIGNMENT_FILTER") or "").strip()

    org = (os.environ.get("GITHUB_REPOSITORY_OWNER") or "").strip()
    if not org:
        emit_error("GITHUB_REPOSITORY_OWNER is empty — this script must run inside a GitHub Actions workflow")
        return 1

    service_token = (os.environ.get("CLASSROOM50_SERVICE_TOKEN") or "").strip()
    if not service_token:
        emit_error("CLASSROOM50_SERVICE_TOKEN is empty — run `gh teacher rotate-service-token <org>` to provision it")
        return 1

    api_url = (
        os.environ.get("GH_API_URL")
        or os.environ.get("GITHUB_API_URL")
        or "https://api.github.com"
    ).rstrip("/")

    classroom_dirs = list(iter_classrooms(base_dir, classroom_filter))
    if not classroom_dirs:
        if classroom_filter:
            # An explicit filter matching nothing is a FAILED run (typo, or a
            # stale checkout) — a green run that collected nothing would read
            # as "collected" to the web app's freshness tracking.
            emit_error(
                f"no classroom in {base_dir} matches "
                f"CLASSROOM_FILTER={classroom_filter!r}"
            )
            return 1
        print(f"no classrooms found in {base_dir}")
        return 0

    # Read once, on first use, and handed to both passes below (see RepoIndex).
    repo_index = RepoIndex(api_url, org, service_token)

    total_changes = 0
    failed_classrooms: list[str] = []
    # Whether ASSIGNMENT_FILTER named a slug that exists in at least one
    # collected classroom's manifest — a no-match scoped run fails like a
    # no-match classroom filter.
    assignment_filter_matched = not assignment_filter
    for classroom_short, classroom_meta, assignments in classroom_dirs:
        if assignment_filter and any(
            entry.get("slug") == assignment_filter
            for entry in assignments.get("assignments") or []
            if isinstance(entry, dict)
        ):
            assignment_filter_matched = True
        scores_path = base_dir / classroom_short / "scores.json"
        try:
            scores = load_scores(scores_path)
        except ScoresFileError as exc:
            # A malformed/hand-edited scores.json is a per-CLASSROOM data
            # problem — isolate it (like iter_classrooms does for a bad
            # classroom.json) so one broken file can't deny collection to the
            # rest. The run still exits non-zero at the end so CI surfaces it.
            emit_error(f"{classroom_short}: {exc}")
            failed_classrooms.append(classroom_short)
            continue

        # One per classroom: both passes below ask for the same student team, and
        # a per-run cache could serve a stale roster to a later classroom sharing
        # a team slug.
        team_members = TeamMembers(api_url, org, service_token)

        # Staff-team grant is a SEPARATE, non-fatal pass: it needs Administration
        # (collection doesn't), so its failure must not abort the core job. On
        # failure, warn and mark the classroom failed (non-zero exit) but still
        # collect — here and for every later classroom.
        try:
            grant_classroom_team_access(
                api_url=api_url,
                org=org,
                classroom_short=classroom_short,
                classroom_meta=classroom_meta,
                assignments=assignments,
                service_token=service_token,
                repo_index=repo_index,
                team_members=team_members,
                assignment_filter=assignment_filter,
            )
        except GrantThrottled as exc:
            # NOT a failure: collection is untouched, the pass is idempotent, and
            # the token is healthy. Each classroom is still retried on its own —
            # a secondary limit clears in about a minute, so a later grant may
            # well succeed in this same run.
            warn_grant_deferred(classroom_short, str(exc))
        except urllib.error.HTTPError as exc:
            throttle_reason = rate_limit_reason(exc)
            if throttle_reason is not None:
                # Same verdict as GrantThrottled, for a throttle that hit the
                # pass before it reached its first repo (the team reads).
                warn_grant_deferred(
                    classroom_short,
                    f"staff-team access grant was throttled by GitHub "
                    f"(HTTP {exc.code}, {throttle_reason})",
                )
            else:
                grant_hint = (
                    f" — grant staff teams repo access needs a fine-grained PAT with "
                    f"Repository -> Administration: Read and write; run "
                    f"`gh teacher rotate-service-token {org}`"
                    if exc.code in (401, 403)
                    else ""
                )
                emit_error(
                    f"{classroom_short}: staff-team access grant failed with HTTP "
                    f"{exc.code} ({exc.reason or 'no reason'}){body_note(exc)}"
                    f"{grant_hint}. Score collection continues; TAs may not see "
                    f"student repos until this is fixed."
                )
                failed_classrooms.append(classroom_short)

        try:
            updates, mode_flip_assignments, collected, detected = collect_classroom(
                api_url=api_url,
                org=org,
                classroom_short=classroom_short,
                classroom_meta=classroom_meta,
                assignments=assignments,
                service_token=service_token,
                roster_meta=load_roster_metadata(base_dir / classroom_short),
                assignment_filter=assignment_filter,
                repo_index=repo_index,
                team_members=team_members,
            )
        except urllib.error.HTTPError as exc:
            # Auth (401/403) and synthetic-network (599) failures on COLLECTION
            # are GLOBAL — the token can't read repos/members or GitHub is
            # unreachable, so every remaining classroom would fail identically.
            # Abort the whole run loudly rather than warn-and-skip per classroom
            # (which would report a broken run as success that collected
            # nothing). The staff-grant pass above is excluded — its
            # Administration scope isn't needed to collect.
            throttle_reason = rate_limit_reason(exc)
            if throttle_reason is not None:
                # A throttle survived the transport's retries. Still fatal —
                # collection is incomplete — but naming the cause keeps the
                # operator from rotating a healthy token.
                emit_error(
                    f"{classroom_short}: collection was throttled by GitHub "
                    f"(HTTP {exc.code}, {throttle_reason}) and did not recover after "
                    f"retrying. The service token is fine, do NOT rotate it; "
                    f"re-run once the limit resets."
                )
            elif exc.code in (401, 403):
                emit_error(
                    f"{classroom_short}: service token was rejected with HTTP {exc.code} "
                    f"({exc.reason or 'no reason'}){body_note(exc)} — run "
                    f"`gh teacher rotate-service-token {org}` "
                    f"with a fine-grained PAT scoped to Organization -> Members: Read (collection "
                    f"lists the classroom team's members) AND Repository -> Contents: Read and write "
                    f"(read the student repos' releases; the write scope is shared with regrade)"
                )
            else:
                emit_error(
                    f"{classroom_short}: collect failed with HTTP {exc.code} "
                    f"({exc.reason or 'no reason'})"
                )
            return 1

        # A service token that can't read the student repos returns 404 for
        # every repo (GitHub hides existence), indistinguishable from "not
        # submitted" — so collect_classroom reports the whole team as
        # unsubmitted and the run exits cleanly (the 401/403 guard never trips).
        # A non-empty assignment set yielding zero readable submissions often
        # means the team has no members yet OR the token lacks repo access.
        # Warn, don't fail: an early-term run legitimately collects zero.
        #
        # Suppress this when collect_classroom already attributed the empty
        # result to a mode flip (releases present but all rejected): that has
        # its own loud warning, and blaming the token here would misdirect.
        # An assignment-scoped run only polls the filtered slug, so only that
        # slug counts toward the heuristic's denominator.
        collectable_slugs = [
            s
            for s in valid_assignment_slugs(assignments)
            if not assignment_filter or s == assignment_filter
        ]
        assignment_count = len(collectable_slugs)
        if assignment_count and not updates and not mode_flip_assignments:
            emit_warning(
                f"{classroom_short}: collected 0 submissions across "
                f"{assignment_count} assignment(s). If you expected submissions, "
                f"either the classroom team has no members yet, or the "
                f"CLASSROOM50_SERVICE_TOKEN lacks read access to the student repos "
                f"(a fine-grained PAT returns 404 for repos outside its scope, which "
                f'is indistinguishable from "not submitted"). Re-scope it to all '
                f"org repos: gh teacher rotate-service-token {org}"
            )

        n_changes = apply_updates(scores, updates)
        # Stamp the buckets this run actually walked (even when nothing changed)
        # so per-assignment freshness is knowable — an org-wide run timestamp
        # can't say whether a scoped run touched a given assignment. A bucket
        # with no submissions yet is created empty so the stamp has a home.
        collected_at = utc_now_iso()
        for slug, atype in collected.items():
            bucket = scores["assignments"].setdefault(
                slug, {"type": atype, "entries": []}
            )
            # Keep the bucket type in sync with the manifest-derived mode even
            # when no entry changed — apply_updates only syncs buckets it
            # touches, so a detected-only or update-less bucket would otherwise
            # keep a stale type across a mode flip.
            bucket["type"] = atype
            bucket["collected_at"] = collected_at
        # Detected (ungraded) submissions are MERGED per owner, not replaced
        # wholesale: a repo whose read failed this run isn't in `visited`, so its
        # prior record survives instead of a transient 500 silently deleting a
        # recorded submitter (the graded path keeps entries the same way). An
        # owner that WAS visited and detected nothing has its record dropped, so
        # a withdrawn submission still disappears. `entries` is left untouched —
        # these assignments never produce a graded entry.
        for slug, (atype, records, visited) in detected.items():
            bucket = scores["assignments"].setdefault(
                slug, {"type": atype, "entries": []}
            )
            before = bucket.get("detected")
            prior = before if isinstance(before, list) else []
            merged = [
                rec
                for rec in prior
                if isinstance(rec, dict)
                and isinstance(rec.get("owner"), str)
                and rec["owner"].lower() not in visited
            ]
            merged.extend(records)
            merged.sort(key=lambda rec: str(rec.get("owner", "")).lower())
            # Write [] rather than dropping the key when nothing is detected: the
            # web distinguishes "collected, nobody submitted" (honest 0 / N) from
            # "never collected" (absent key) — popping it here would make a real
            # collect that found no submitters look like no collect at all.
            bucket["detected"] = merged
            if bucket.get("detected") != before:
                n_changes += 1
        try:
            save_scores(scores_path, scores)
        except ScoresFileError as exc:
            # Per-classroom write failure — isolate like the load failure above.
            emit_error(f"{classroom_short}: {exc}")
            failed_classrooms.append(classroom_short)
            continue

        print(f"{classroom_short}: {n_changes} updated submission(s)")
        total_changes += n_changes

    print(
        f"collect: {total_changes} total submission(s) updated across "
        f"{len(classroom_dirs)} classroom(s)"
    )
    if not assignment_filter_matched:
        # Same contract as the classroom-filter no-match above: a scoped run
        # naming an assignment no collected classroom has must fail loudly.
        emit_error(
            f"no assignment matches ASSIGNMENT_FILTER={assignment_filter!r} in "
            f"the collected classroom(s) — check the slug, or pull the latest "
            f"config repo"
        )
        return 1
    if failed_classrooms:
        # Dedup (preserve order): a classroom can be recorded once for a
        # non-fatal staff-grant failure and again for a scores write failure.
        unique_failed = list(dict.fromkeys(failed_classrooms))
        emit_error(
            f"collect: {len(unique_failed)} classroom(s) had a failure (staff-team "
            f"grant and/or scores write): {', '.join(unique_failed)}. Score "
            f"collection ran for every classroom; a grant-only failure means TAs "
            f"may not yet have access."
        )
        return 1
    return 0


# Classroom enumeration -------------------------------------------------------


def iter_classrooms(
    base_dir: pathlib.Path, classroom_filter: str
) -> Iterable[tuple[str, dict[str, Any], dict[str, Any]]]:
    """Yield (short_name, classroom_meta, assignments) per classroom. Non-v1
    schemas skip with a workflow warning (forward-compat without crashing).

    Collection is TEAM-driven: the classroom GitHub team is the source of truth
    for enrollment, so this no longer reads the roster to decide who to poll
    (the team enumeration in collect_classroom drives the pairs). The roster
    (roster.csv) is only best-effort display metadata,
    joined onto collected results and also consumed elsewhere (the Go download
    scores.csv join and the web roster view).
    """
    if not base_dir.is_dir():
        return
    for entry in sorted(p for p in base_dir.iterdir() if p.is_dir()):
        if classroom_filter and entry.name != classroom_filter:
            continue
        classroom_path = entry / "classroom.json"
        assignments_path = entry / "assignments.json"
        if not classroom_path.is_file() or not assignments_path.is_file():
            continue
        try:
            classroom_meta = json.loads(classroom_path.read_text())
            assignments = json.loads(assignments_path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            emit_warning(f"{entry.name}: skipping (read/parse: {exc})")
            continue
        if classroom_meta.get("schema") != CLASSROOM_SCHEMA_V1:
            emit_warning(
                f"{entry.name}: classroom.json schema = "
                f"{classroom_meta.get('schema')!r}, want {CLASSROOM_SCHEMA_V1!r}; skipping"
            )
            continue
        if assignments.get("schema") != ASSIGNMENTS_SCHEMA_V1:
            emit_warning(
                f"{entry.name}: assignments.json schema = "
                f"{assignments.get('schema')!r}, want {ASSIGNMENTS_SCHEMA_V1!r}; skipping"
            )
            continue
        yield entry.name, classroom_meta, assignments


# Roster metadata (best-effort) -----------------------------------------------


def load_roster_metadata(classroom_dir: pathlib.Path) -> dict[str, dict[str, str]]:
    """Best-effort roster read for optional display metadata, keyed by
    lowercased username, from roster.csv. The classroom GitHub team — not this
    file — is authoritative for enrollment, so a missing/unreadable/malformed
    roster is NOT fatal: it just yields no metadata (blank name/section/email),
    never a crash or a dropped student.
    """
    path = classroom_dir / ROSTER_FILENAME
    if not path.is_file():
        return {}
    try:
        with path.open(newline="") as fh:
            reader = csv.DictReader(fh)
            meta: dict[str, dict[str, str]] = {}
            for row in reader:
                username = (row.get("username") or "").strip()
                if not username:
                    continue
                meta[username.lower()] = {
                    col: (row.get(col) or "").strip()
                    for col in ("first_name", "last_name", "email", "section")
                }
        return meta
    except (OSError, csv.Error):
        # Best-effort: a read/parse failure degrades to blank metadata.
        return {}


# Per-classroom collection ----------------------------------------------------


class RepoIndex:
    """The org's repos (lowercased name -> `private`), read once per run and only
    when something asks.

    Both passes walk the (team member × assignment) product — thousands of names
    for an ordinary course, of which only the accepted ones exist. Collection
    absorbs the misses quietly (a 404 on /releases reads as "not submitted"), but
    the grant pass spends two requests and a warning on each, which is what trips
    GitHub's secondary limit.

    Skipping a name absent from the listing is safe because a fine-grained PAT
    lists exactly the repos it is scoped to, so that name was going to 404. The
    premise is load-bearing: a listing that looks complete but omits a readable
    repo would read a real submission as "not submitted". Both detectable shapes
    fail open instead — empty reads as unknown, truncated raises
    IncompleteListing.
    """

    def __init__(self, api_url: str, org: str, token: str) -> None:
        self._api_url = api_url
        self._org = org
        self._token = token
        self._repos: dict[str, bool] | None = None
        self._loaded = False

    def _load(self) -> dict[str, bool] | None:
        """The repos, or None when the listing could not be read. Reads once; a
        soft failure warns once and stays None.

        A THROTTLED or FATAL failure propagates and leaves the read UNLATCHED, so
        a caller that survives it (the grant pass defers a throttle) retries
        rather than spending the run on the degraded answer."""
        if self._loaded:
            return self._repos
        self._repos = self._read()
        self._loaded = True
        return self._repos

    def _read(self) -> dict[str, bool] | None:
        """One attempt at the org listing."""
        try:
            repos = list_org_repos(self._api_url, self._org, self._token)
        except urllib.error.HTTPError as exc:
            if classify(exc) is not SKIPPABLE:
                raise
            emit_warning(
                f"{self._org}: could not list the org's repositories: HTTP "
                f"{exc.code} ({exc.reason or 'no reason'}); falling back to "
                f"probing every (member, assignment) repo name — slower, and "
                f"one warning per repo that has not been accepted yet."
            )
            return None
        except (json.JSONDecodeError, ValueError) as exc:
            emit_warning(
                f"{self._org}: org repository listing malformed ({exc}); "
                f"falling back to probing every (member, assignment) repo name."
            )
            return None
        # Unknown, not "nothing exists": a token scoped to zero repos must not
        # silently skip every poll.
        if not repos:
            return None
        print(f"{self._org}: {len(repos)} repo(s) visible to the service token")
        return repos

    def contains(self, repo_name: str) -> bool:
        """Whether `repo_name` exists — True whenever the listing is unknown, so
        an unreadable index never hides a repo from either pass."""
        repos = self._load()
        return repos is None or repo_name.lower() in repos

    def is_private(self, repo_name: str) -> bool | None:
        """Whether `repo_name` is private, or None when the index can't say (the
        listing was unreadable, or the name isn't in it). Answers from the
        listing already read, saving the caller a per-repo request."""
        repos = self._load()
        if repos is None:
            return None
        return repos.get(repo_name.lower())


def is_empty_repo(entry: dict[str, Any]) -> bool:
    """True only when empty_repo is the boolean `true`. The wire contract is a
    JSON boolean (schema type "boolean"; Go decodes into a strict `bool`), so a
    non-boolean value from a hand-edited manifest is not empty_repo — matching
    the Go and TypeScript readers (TS uses `=== true`). Every Python reader
    (collect/regrade/runner) MUST use this predicate so all tools agree."""
    return entry.get("empty_repo") is True


def is_no_autograder(entry: dict[str, Any]) -> bool:
    """True only when no_autograder is the boolean `true` (strict, like
    is_empty_repo). A templated no_autograder assignment commits no shim, so it
    never autogrades and produces no submit/* releases — collection and regrade
    skip it exactly as they skip empty_repo. Keep byte-identical across
    collect/regrade and the autograde-runner read step so every tool agrees."""
    return entry.get("no_autograder") is True


def is_init_shim(entry: dict[str, Any]) -> bool:
    """True only when init_shim is the boolean `true` (strict, like
    is_empty_repo). An init_shim assignment is a template-less repo initialized
    with only the marker + default shim — it DOES autograde and produces
    submit/* releases, so unlike empty_repo/no_autograder it is NOT part of
    skips_grading(): collection and regrade treat it as a normal grading
    assignment. Provided for symmetry and tests."""
    return entry.get("init_shim") is True


def skips_grading(entry: dict[str, Any]) -> bool:
    """True when the assignment never autogrades — either a bare empty_repo or a
    templated no_autograder (teacher-supplied CI). The "does not autograde"
    predicate family; collection/regrade poll neither. NOTE: init_shim is
    deliberately EXCLUDED — an init_shim repo commits the default shim and
    autogrades, so it must be collected/regraded like any built-in assignment."""
    return is_empty_repo(entry) or is_no_autograder(entry)


def valid_assignment_slugs(assignments: dict[str, Any]) -> list[str]:
    """Slugs worth collecting: non-empty strings, in manifest order, excluding
    assignments that never autograde (empty_repo or no_autograder — their repos
    produce no submit/* releases, so polling them would only produce dead
    gradebook rows). main()'s zero-submission guard counts these; the collect
    loop applies the same predicate inline (it also needs each entry's `due`),
    so both agree on what counts as collectable."""
    slugs: list[str] = []
    for entry in assignments.get("assignments") or []:
        slug = entry.get("slug")
        if isinstance(slug, str) and slug and not skips_grading(entry):
            slugs.append(slug)
    return slugs


def all_assignment_slugs(assignments: dict[str, Any]) -> list[str]:
    """Every valid slug including assignments that never autograde (empty_repo
    or no_autograder). Staff access grants use this instead of
    valid_assignment_slugs: these repos never autograde, but TAs still need read
    on them to review the student-built work."""
    slugs: list[str] = []
    for entry in assignments.get("assignments") or []:
        slug = entry.get("slug")
        if isinstance(slug, str) and slug:
            slugs.append(slug)
    return slugs


class TeamMembers:
    """Team member logins, read once per team per classroom.

    Both passes ask for the same student team — the grant pass to build its
    target product, collection to build the poll roster — and on a large course
    that listing is several paginated requests.

    Failures are not cached, so each caller still handles them on its own terms
    (the grant pass warns and skips; collection propagates a hard error)."""

    def __init__(self, api_url: str, org: str, token: str) -> None:
        self._api_url = api_url
        self._org = org
        self._token = token
        self._by_slug: dict[str, list[str]] = {}

    def logins(self, team_slug: str) -> list[str]:
        """`team_slug`'s members. Propagates whatever list_team_member_logins
        raises."""
        cached = self._by_slug.get(team_slug)
        if cached is not None:
            return list(cached)
        logins = list_team_member_logins(self._api_url, self._org, team_slug, self._token)
        self._by_slug[team_slug] = list(logins)
        return logins


def list_enrolled_logins(
    api_url: str,
    org: str,
    classroom_meta: dict[str, Any],
    classroom_short: str,
    service_token: str,
    team_members: "TeamMembers | None" = None,
) -> tuple[list[str], set[str]]:
    """Return (polled logins, student logins). The first is the case-insensitive
    dedup union of the student team and every staff team's members, first-seen
    order/casing preserved (student team first). The second is the lowercased
    set of STUDENT-team logins — used only so the per-assignment "X of Y
    submitted" denominator counts students (expected to submit) rather than
    every staffer polled (a non-accepting TA is a tester, not missing work).

    Collection polls staff (teacher/hta/ta) too so a staff member testing an
    assignment is graded like a student — but only when they've ACCEPTED: a
    staff member with no `<classroom>-<assignment>-<username>` repo returns no
    releases and so produces no entry (the accepted gate falls out of the
    per-repo poll; no explicit staff check is needed). A staff member on no
    team, or one who never accepted, never appears.

    A hard auth/network error (401/403/599) propagates so main() aborts; a soft
    per-team failure (e.g. a 404 on an uncreated staff team) is warned and that
    team contributes nobody, matching how the staff-grant pass tolerates a
    missing team."""
    student_slug = resolve_team_slug(classroom_meta, classroom_short)
    read = team_members.logins if team_members is not None else (
        lambda slug: list_team_member_logins(api_url, org, slug, service_token)
    )
    # Student team first so its casing wins in the dedup (the repo-name formula
    # lowercases anyway, so casing is cosmetic — but keep it deterministic).
    student_logins = read(student_slug)
    logins = list(student_logins)
    for role, staff_slug in resolve_staff_team_slugs(classroom_meta).items():
        try:
            logins.extend(read(staff_slug))
        except urllib.error.HTTPError as exc:
            if classify(exc) is not SKIPPABLE:
                raise
            emit_warning(
                f"{classroom_short}: could not read staff team {staff_slug!r} "
                f"({role}) members: HTTP {exc.code} ({exc.reason or 'no reason'}); "
                f"skipping that team's members for collection."
            )
        except (json.JSONDecodeError, ValueError) as exc:
            emit_warning(
                f"{classroom_short}: staff team {staff_slug!r} ({role}) member "
                f"listing malformed ({exc}); skipping that team's members."
            )
    return _dedupe_logins(logins), {u.strip().lower() for u in student_logins}


def collect_detected(
    *,
    api_url: str,
    org: str,
    classroom_short: str,
    slug: str,
    entry: dict[str, Any],
    team_usernames: list[str],
    repo_index: "RepoIndex | None",
    service_token: str,
) -> tuple[str, list[dict[str, Any]], set[str]]:
    """Detected submissions for one no_autograder assignment: walk its repos and
    record presence/count per submitter. Returns (mode, records, visited owners).

    Never records a score — these assignments are not graded. A repo with no
    detections is OMITTED, so the record list is exactly the submitter set. A
    per-repo failure warns and skips (same policy as the graded path) so one
    unreadable repo can't void the assignment; `visited` names the owners whose
    repo was actually read, so a failed read preserves rather than deletes a
    prior record.
    """
    raw_mode = entry.get("mode")
    is_group = (raw_mode or "").lower() == "group"
    assignment_type = "group" if is_group else "individual"

    submission_mode = entry.get("submission_mode")
    mode = "tag" if submission_mode == "tag" else "every-push"
    raw_tags = entry.get("submission_tags")
    submission_tags = [t for t in (raw_tags or []) if isinstance(t, str) and t]

    due_raw = entry.get("due")
    due = parse_rfc3339(due_raw) if due_raw else None
    if due_raw and due is None:
        # Same advisory warning as the graded path — lateness silently absent
        # would otherwise be indistinguishable from "no due date set".
        emit_warning(
            f"{classroom_short}/{slug}: due = {due_raw!r} is not an RFC 3339 "
            f"timestamp with timezone; skipping late-marking for this assignment"
        )

    records: list[dict[str, Any]] = []
    # Owners whose repo this run actually READ (successfully, or as a definite
    # "not accepted"). A repo skipped because its read FAILED is not here, so
    # main() can leave that owner's prior record intact rather than deleting a
    # recorded submitter over a transient 500 — the same warn-and-keep policy the
    # graded path applies to entries.
    visited: set[str] = set()
    # team_usernames arrives already case-insensitively deduped (the
    # list_enrolled_logins union), so each repo is polled exactly once.
    for username in team_usernames:
        repo_name = assignment_repo_name(classroom_short, slug, username)
        if repo_index is not None and not repo_index.contains(repo_name):
            # The index says the repo doesn't exist — a definite "not accepted",
            # not a failed read — so a stale record for it should go.
            visited.add(username.lower())
            continue
        try:
            detections = detect_repo_submissions(
                api_url,
                org,
                repo_name,
                service_token,
                mode,
                submission_tags,
            )
        except urllib.error.HTTPError as exc:
            if classify(exc) is not SKIPPABLE:
                raise
            emit_warning(
                f"{org}/{repo_name}: submission detection failed: HTTP {exc.code} "
                f"({exc.reason or 'no reason'}); skipping"
            )
            continue
        except (json.JSONDecodeError, ValueError) as exc:
            emit_warning(
                f"{org}/{repo_name}: submission detection malformed ({exc}); skipping"
            )
            continue
        visited.add(username.lower())
        if not detections:
            continue
        record = detected_record(username, detections, due, trust_times=mode != "tag")
        record["kind"] = "tag" if mode == "tag" else "commit"
        records.append(record)

    return assignment_type, records, visited


def collect_classroom(
    *,
    api_url: str,
    org: str,
    classroom_short: str,
    classroom_meta: dict[str, Any],
    assignments: dict[str, Any],
    service_token: str,
    roster_meta: dict[str, dict[str, str]] | None = None,
    assignment_filter: str = "",
    repo_index: RepoIndex | None = None,
    team_members: "TeamMembers | None" = None,
) -> tuple[
    list[dict[str, Any]],
    int,
    dict[str, str],
    dict[str, tuple[str, list[dict[str, Any]], set[str]]],
]:
    """Return (validated result payloads for every (student, assignment) pair,
    count of assignments whose only submissions were rejected by validation,
    slug -> mode map of the assignments actually walked, slug -> (mode, detected
    records) for assignments that skip grading).
    Per-repo failures warn and skip; hard failures (auth 401/403; network 599)
    propagate and main() converts them to exit 1. The second tuple element lets
    main() distinguish a mode-flip-induced empty result (which has its own loud
    warning) from a token-access problem. The third records which buckets this
    run refreshed — main() stamps their `collected_at` — and stays empty when
    collection was skipped wholesale (team unreadable/empty), so a skipped
    classroom never reads as freshly collected. The fourth carries DETECTED
    submissions for no_autograder assignments (presence/count, never a score):
    those repos publish no submit/* release, so this is their only signal.

    `roster_meta` is the best-effort roster join (username -> display metadata,
    see load_roster_metadata); when a collected owner has a matching row its
    name/section/email are attached to the entry. Absent/blank is fine — the
    join never gates collection.

    `assignment_filter` (an assignment slug, empty for all) narrows the walk to
    one assignment — the web app's per-assignment "Sync now" scope. Sibling
    assignments' buckets in scores.json are untouched (apply_updates upserts).
    """
    roster_meta = roster_meta or {}
    results: list[dict[str, Any]] = []
    group_attribution_degraded = 0
    # Assignments this run actually walked (slug -> mode), for `collected_at`
    # stamping. Populated only past the team-read gate below.
    collected: dict[str, str] = {}
    # Detected (ungraded) submissions per no_autograder assignment:
    # slug -> (mode, records). Separate from `results` because these carry no
    # score and must never enter the graded `entries` path.
    detected: dict[str, tuple[str, list[dict[str, Any]], set[str]]] = {}
    # (assignment) buckets where every present submission was rejected by
    # validation (the mode-flip symptom). Returned so main() can suppress its
    # "rotate token" heuristic, which would otherwise misread this as a
    # token-access problem.
    mode_flip_assignments = 0

    # Team-driven username source: the classroom GitHub teams are authoritative
    # for enrollment. The roster (roster.csv) is only
    # best-effort display metadata, so the (username, assignment) pairs come
    # from the team member lists, NOT the CSV. The set is the union of the
    # STUDENT team and every STAFF team (teacher/hta/ta) so a staff member who
    # accepted an assignment (to test the autograde flow) is collected like a
    # student — staff who never accepted have no repo, hence no releases, hence
    # no entry (the accepted gate is implicit in the per-repo poll). A 404
    # (student team missing) or empty union yields no pairs (warn + return). A
    # hard auth/network error propagates so main() aborts the whole run loudly.
    team_slug = resolve_team_slug(classroom_meta, classroom_short)
    try:
        team_usernames, student_logins = list_enrolled_logins(
            api_url, org, classroom_meta, classroom_short, service_token,
            team_members=team_members,
        )
    except urllib.error.HTTPError as exc:
        if classify(exc) is not SKIPPABLE:
            raise
        emit_warning(
            f"{classroom_short}: could not read team {team_slug!r} members: "
            f"HTTP {exc.code} ({exc.reason or 'no reason'}); skipping collection for "
            f"this classroom. Ensure CLASSROOM50_SERVICE_TOKEN has Organization -> "
            f"Members: Read (a fine-grained PAT permission) — rotate it with "
            f"`gh teacher rotate-service-token {org}`."
        )
        return results, mode_flip_assignments, collected, detected
    except (json.JSONDecodeError, ValueError) as exc:
        emit_warning(
            f"{classroom_short}: team {team_slug!r} member listing malformed "
            f"({exc}); skipping collection for this classroom."
        )
        return results, mode_flip_assignments, collected, detected

    if not team_usernames:
        emit_warning(
            f"{classroom_short}: teams {team_slug!r} (and staff teams) have no "
            f"members — no (username, assignment) pairs to poll; skipping."
        )
        return results, mode_flip_assignments, collected, detected

    # Group attribution credits a collaborator only if on a classroom team
    # (owner always credited) — same trust model, team-sourced set. Staff are in
    # the union, so a staff collaborator on a group repo can be credited too.
    roster_logins = {u.lower() for u in team_usernames}
    for entry in assignments.get("assignments") or []:
        slug = entry.get("slug")
        if not isinstance(slug, str) or not slug:
            continue
        if assignment_filter and slug != assignment_filter:
            continue
        # Assignments that never autograde (empty_repo or no_autograder) —
        # same predicate as valid_assignment_slugs, kept in lockstep. There are
        # no submit/* releases to ingest and no scores to record, but a
        # submission still HAPPENED, so detect it from repo state instead
        # (presence/count only, never a grade) — issue #659. An empty_repo
        # assignment has no submission definition at all, so it stays skipped.
        if skips_grading(entry):
            if is_empty_repo(entry):
                print(
                    f"{classroom_short}/{slug}: empty_repo assignment — "
                    f"autograding is disabled; skipping collection"
                )
                continue
            detected_type, detected_records, detected_visited = collect_detected(
                api_url=api_url,
                org=org,
                classroom_short=classroom_short,
                slug=slug,
                entry=entry,
                team_usernames=team_usernames,
                repo_index=repo_index,
                service_token=service_token,
            )
            detected[slug] = (detected_type, detected_records, detected_visited)
            collected[slug] = detected_type
            print(
                f"{classroom_short}/{slug}: no_autograder assignment — "
                f"autograding is disabled; detected "
                f"{len(detected_records)} submitter(s) from repo state"
            )
            continue

        due_raw = entry.get("due")
        due = parse_rfc3339(due_raw) if due_raw else None
        if due_raw and due is None:
            emit_warning(
                f"{classroom_short}/{slug}: due = {due_raw!r} is not an RFC 3339 "
                f"timestamp with timezone; skipping late-marking for this assignment"
            )

        raw_mode = entry.get("mode")
        is_group = (raw_mode or "").lower() == "group"
        if isinstance(raw_mode, str) and raw_mode and raw_mode.lower() not in (
            "individual",
            "group",
        ):
            # A typo'd mode would silently collect as individual and reject
            # every group submission via the owner-identity check (reading as
            # a mode flip) — name the real cause up front.
            emit_warning(
                f"{classroom_short}/{slug}: unknown mode {raw_mode!r} — "
                f"expected 'individual' or 'group'; collecting as individual"
            )
        assignment_type = "group" if is_group else "individual"
        collected[slug] = assignment_type

        # One-shot pre-rename slug (see validate_result): a non-string or empty
        # value reads as absent, matching the additive-schema tolerance rule.
        raw_renamed_from = entry.get("renamed_from")
        renamed_from = (
            raw_renamed_from
            if isinstance(raw_renamed_from, str) and raw_renamed_from
            else None
        )

        submitted = 0
        # Staff (non-student-team) members who actually submitted this
        # assignment. They count toward the "X of Y" denominator only when they
        # submitted — a non-accepting staffer is a tester, not missing work, so
        # counting every polled staffer in Y would understate student coverage.
        staff_submitted = 0
        # Repos under THIS assignment whose only submissions were rejected by
        # validation (mode-flip symptom); reported once per assignment below.
        mode_flip_repos: list[str] = []
        for username in team_usernames:
            repo_name = assignment_repo_name(classroom_short, slug, username)
            # A name the index doesn't know has no repo, so its release poll
            # would 404 and read as "not submitted" anyway — same outcome, one
            # request less.
            if repo_index is not None and not repo_index.contains(repo_name):
                continue

            try:
                releases = all_submit_releases(api_url, org, repo_name, service_token)
            except urllib.error.HTTPError as exc:
                if classify(exc) is not SKIPPABLE:
                    raise
                emit_warning(
                    f"{org}/{repo_name}: release listing failed: HTTP {exc.code} "
                    f"({exc.reason or 'no reason'}); skipping"
                )
                continue
            except (json.JSONDecodeError, ValueError) as exc:
                emit_warning(f"{org}/{repo_name}: release listing malformed ({exc}); skipping")
                continue
            if not releases:
                # Student hasn't submitted/accepted/finished grading. Individual
                # misses are quiet; the per-assignment summary reports the gap.
                continue

            # Collect EVERY submission, newest first. Each release's result.json
            # is downloaded and validated independently; a single bad/missing one
            # warns and is skipped without dropping the others. `validation_rejected`
            # counts releases present and downloaded but FAILED validate_result
            # (the mode-flip / identity-mismatch symptom) — kept distinct from a
            # benign download error or missing asset, so the "mode flipped"
            # warning below only fires on the real symptom.
            history: list[dict[str, Any]] = []
            validation_rejected = 0
            for release in releases:
                try:
                    candidate = download_result_asset(api_url, release, service_token)
                except urllib.error.HTTPError as exc:
                    if classify(exc) is not SKIPPABLE:
                        raise
                    emit_warning(
                        f"{org}/{repo_name}: result.json download failed for "
                        f"{release.get('tag_name')!r}: HTTP {exc.code} "
                        f"({exc.reason or 'no reason'}); skipping that submission"
                    )
                    continue
                except AssetMissingError as exc:
                    emit_warning(
                        f"{org}/{repo_name}: {release.get('tag_name')!r}: {exc}; "
                        f"skipping that submission"
                    )
                    continue
                except (json.JSONDecodeError, ValueError) as exc:
                    emit_warning(
                        f"{org}/{repo_name}: result.json malformed for "
                        f"{release.get('tag_name')!r} ({exc}); skipping that submission"
                    )
                    continue

                # validate_result enforces identity (owner == repo owner) AND
                # that `assignment_type` matches the manifest mode (is_group), so
                # a mode-flipped or mis-typed result is rejected here — no
                # separate assignment_type cross-check needed afterward.
                try:
                    validate_result(
                        candidate,
                        classroom_short,
                        slug,
                        username,
                        is_group=is_group,
                        renamed_from=renamed_from,
                    )
                except ValueError as exc:
                    emit_warning(
                        f"{org}/{repo_name}: invalid result.json for "
                        f"{release.get('tag_name')!r} ({exc}); skipping that submission"
                    )
                    validation_rejected += 1
                    continue

                # Lateness is advisory, marked per submission on the record
                # itself (each carries its own datetime).
                if due is not None and not mark_late(candidate, due):
                    emit_warning(
                        f"{org}/{repo_name}: result.json datetime = "
                        f"{candidate.get('datetime')!r} is not an RFC 3339 timestamp; "
                        f"cannot mark lateness"
                    )
                # The stored record is the validated payload minus the bucket-key
                # `assignment`. Keeps result/v1 shape: owner + assignment_type +
                # submitted_by, no usernames.
                history.append({k: v for k, v in candidate.items() if k != "assignment"})

            if not history:
                # The repo had submit-tag releases but no creditable history.
                # When releases were rejected specifically by validation (not a
                # missing asset / transient download error), that's the symptom
                # of an assignment whose `mode` was switched individual<->group
                # mid-term: every prior release's assignment_type now mismatches
                # and is rejected, silently reverting graded students to "not
                # submitted". Count it for the consolidated warning below (rather
                # than one per repo), and so main() can distinguish this from a
                # token-access problem. A benign asset-missing / transient repo
                # does NOT count here.
                if validation_rejected:
                    mode_flip_repos.append(repo_name)
                continue

            # Group attribution: the runner emits owner-only (it can't read
            # collaborators). Collection is authoritative — list the repo's
            # collaborators intersected with the roster and credit them all via
            # `member_usernames`. On a read failure, force owner-only (never
            # trust student-supplied data) and warn, so a scope/transient issue
            # degrades gracefully. Individual entries carry no member list.
            # Resolved BEFORE building the entry so `member_usernames` sits
            # right after `owner` in the written JSON key order.
            members: list[str] | None = None
            if is_group:
                try:
                    members, degraded_warning = attribute_group_members(
                        api_url, org, repo_name, username, service_token, roster_logins
                    )
                except IncompleteListing as exc:
                    # A partial list must not be written as if it were whole:
                    # skipping the repo leaves its previous gradebook entry (and
                    # its credited teammates) intact.
                    emit_warning(
                        f"{org}/{repo_name}: group collaborator listing is "
                        f"incomplete ({exc}); skipping this repo so its existing "
                        f"member credit is preserved. Re-run to collect it."
                    )
                    continue
                if degraded_warning is not None:
                    group_attribution_degraded += 1
                    emit_warning(degraded_warning)
                elif len(members) == 1:
                    # Read succeeded but credited only the owner — no other
                    # rostered collaborator found. Often expected (a solo group
                    # submission), but also the symptom of a real misconfig
                    # (teammates not on the roster, or not added as
                    # collaborators), which would otherwise be silent.
                    emit_warning(
                        f"{org}/{repo_name}: group submission credited to the owner "
                        f"{username!r} only — no other team member is a collaborator "
                        f"on the repo. If this is a team submission, ensure each teammate "
                        f"is on the {classroom_short} classroom team AND a collaborator on "
                        f"the repo (added via `gh student invite`)."
                    )

            # Build the gradebook entry: identity/keying at the top, the full
            # per-submission detail ONLY inside `submissions` (newest first).
            # `owner` is the stable per-bucket key (repo owner from the
            # <classroom>-<assignment>-<username> formula), invariant across
            # re-collects even when a group's member set changes, so apply_updates
            # replaces the entry in place. For a group entry `member_usernames`
            # sits right after `owner`. `_assignment` / `_type` are transport-only
            # hints for apply_updates (bucket slug + type), stripped on store.
            entry_row: dict[str, Any] = {
                "_assignment": slug,
                "_type": assignment_type,
                "owner": username,
            }
            if members is not None:
                entry_row["member_usernames"] = list(members)
            # Best-effort roster join: attach non-blank display metadata for the
            # owner when the roster carries a row. Missing/blank is fine (the
            # team, not the roster, drives enrollment).
            meta = roster_meta.get(username.lower())
            if meta:
                for field in ("first_name", "last_name", "email", "section"):
                    value = meta.get(field)
                    if value:
                        entry_row[field] = value
            entry_row["submissions"] = history

            results.append(entry_row)
            submitted += 1
            if username.strip().lower() not in student_logins:
                staff_submitted += 1

        # Denominator: students (expected to submit) + staff who actually
        # submitted. Non-accepting staff (polled but no repo) are excluded so
        # the coverage line reads as student coverage, not inflated by testers.
        expected = len(student_logins) + staff_submitted
        print(f"{classroom_short}/{slug}: {submitted}/{expected} submitted")

        if mode_flip_repos:
            mode_flip_assignments += 1
            emit_warning(
                f"{classroom_short}/{slug}: {len(mode_flip_repos)} repo(s) had submit-tag "
                f"release(s) but NONE were creditable — every present submission was rejected "
                f"by validation. This is the symptom of switching this assignment's mode "
                f"(individual<->group): prior submissions' assignment_type no longer matches "
                f"{assignment_type!r}, so affected students show as not-submitted until they "
                f"re-submit under the new mode. Affected repos: "
                f"{', '.join(sorted(mode_flip_repos))}."
            )

    if group_attribution_degraded:
        emit_warning(
            f"{classroom_short}: {group_attribution_degraded} group submission(s) "
            f"credited to the repo owner only because the collaborator read failed "
            f"(teammates not credited). This usually means CLASSROOM50_SERVICE_TOKEN "
            f"lacks the collaborator-read permission — rotate it with `gh teacher rotate-service-token`."
        )

    return results, mode_flip_assignments, collected, detected


def assignment_repo_name(classroom: str, assignment: str, username: str) -> str:
    """Canonical student-repo name. Mirrors the formula single-sourced in
    cli/shared/contract (AssignmentRepoName); keep byte-identical or the
    collect loop misidentifies submissions."""
    return f"{classroom.lower()}-{assignment.lower()}-{username.lower()}"


def resolve_team_slug(classroom_meta: dict[str, Any], classroom_short: str) -> str:
    """The classroom's GitHub team slug: persisted classroom.json `team.slug`
    when present (authoritative — GitHub may re-slug on a name collision, e.g.
    `classroom50-cs-1`), else the derived `classroom50-<short>`. Mirrors the web
    app's resolveClassroomTeam and Go's ResolveClassroomTeam so all three target
    the same team."""
    team = classroom_meta.get("team")
    if isinstance(team, dict):
        slug = team.get("slug")
        if isinstance(slug, str) and slug.strip():
            return slug.strip()
    return f"classroom50-{classroom_short}"


def resolve_staff_team_slugs(classroom_meta: dict[str, Any]) -> dict[str, str]:
    """Map each staff role present in classroom.json `teams` to its authoritative
    slug (role -> slug). Only roles with a non-empty slug are returned; a
    classroom with no `teams` block yields {}. The slug is authoritative — never
    re-derived — mirroring resolve_team_slug's contract for the student team."""
    teams = classroom_meta.get("teams")
    if not isinstance(teams, dict):
        return {}
    out: dict[str, str] = {}
    for role, ref in teams.items():
        if not isinstance(ref, dict):
            continue
        slug = ref.get("slug")
        if isinstance(slug, str) and slug.strip():
            out[role] = slug.strip()
    return out


def get_repo(api_url: str, owner: str, repo: str, token: str) -> dict[str, Any] | None:
    """GET /repos/{owner}/{repo} → the repo object, or None on 404. Used to read
    a template's `private` flag before granting a staff team access to it. A hard
    error (401/403/599) propagates so main() aborts."""
    url = _repo_url(api_url, owner, repo)
    try:
        body = _http_get(url, token, accept="application/vnd.github+json")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    parsed = json.loads(body.decode("utf-8"))
    return parsed if isinstance(parsed, dict) else None


def assignment_template_ref(entry: dict[str, Any]) -> tuple[str, str] | None:
    """(owner, repo) of an assignment's `template` block, or None when absent or
    malformed. Mirrors the `template` shape in assignments-v1 ({owner, repo,
    branch})."""
    template = entry.get("template")
    if not isinstance(template, dict):
        return None
    owner = template.get("owner")
    repo = template.get("repo")
    if isinstance(owner, str) and owner and isinstance(repo, str) and repo:
        return owner, repo
    return None


class GrantThrottled(Exception):
    """The staff-team grant pass hit GitHub's rate limiter.

    Distinct from an HTTPError so main() can tell throttling from refusal: it
    carries how far the pass got, the run stays green, and nothing suggests
    rotating a credential that is working. The pass is idempotent, so whatever
    is deferred is granted by the next run."""

    def __init__(self, reason: str, team_slug: str, granted: int, deferred: int) -> None:
        super().__init__(
            f"staff-team grant for {team_slug!r} was throttled by GitHub "
            f"({reason}) after {granted} new grant(s); {deferred} target(s) "
            f"deferred to the next run"
        )
        self.reason = reason
        self.team_slug = team_slug
        self.granted = granted
        self.deferred = deferred


def grant_classroom_team_access(
    *,
    api_url: str,
    org: str,
    classroom_short: str,
    classroom_meta: dict[str, Any],
    assignments: dict[str, Any],
    service_token: str,
    repo_index: RepoIndex | None = None,
    team_members: "TeamMembers | None" = None,
    assignment_filter: str = "",
) -> None:
    """Grant each classroom staff team its mapped repo permission (see
    STAFF_TEAM_PERMISSIONS) on every EXISTING student assignment repo and on each
    private, in-org assignment template. Additive + idempotent, so re-running
    collection re-affirms access cheaply.

    Student-repo targets are the (team member × assignment) product — the same
    set collect_classroom polls — narrowed to the repos that exist when
    `repo_index` can say (thousands of names per classroom, two wasted requests
    each). A per-repo 404/422 (repo not accepted yet, or template not
    org-owned) is warned-and-skipped; a hard error (401/403/599) propagates so
    main() aborts; a throttle raises GrantThrottled, which main() reports as a
    deferral rather than a failure. A classroom with no mapped staff team is a
    no-op.

    A staff team with no members is skipped per-slug (its grants would benefit
    nobody), so an empty ta team still lets a populated hta team grant.

    `assignment_filter` scopes the grant to one assignment (its student repos
    and its private template); blank grants every assignment as before.
    """
    role_slugs = resolve_staff_team_slugs(classroom_meta)
    grant_slugs = [
        (slug, STAFF_TEAM_PERMISSIONS[role])
        for role, slug in role_slugs.items()
        if role in STAFF_TEAM_PERMISSIONS
    ]
    if not grant_slugs:
        return

    # ALL slugs, not just the collectable subset: empty_repo assignments are
    # skipped by collection but their student repos still exist and staff
    # still need access to review them.
    slugs = all_assignment_slugs(assignments)
    if assignment_filter:
        # Skip a classroom lacking the slug silently, like collect_classroom:
        # main()'s run-level guard owns the single loud "no such slug" error,
        # so warning here would spam once per non-matching classroom.
        if assignment_filter not in slugs:
            return
        slugs = [assignment_filter]
    if not slugs:
        return

    student_team_slug = resolve_team_slug(classroom_meta, classroom_short)
    try:
        team_logins = (
            team_members.logins(student_team_slug)
            if team_members is not None
            else list_team_member_logins(api_url, org, student_team_slug, service_token)
        )
    except urllib.error.HTTPError as exc:
        if classify(exc) is not SKIPPABLE:
            raise
        emit_warning(
            f"{classroom_short}: could not read team {student_team_slug!r} members for "
            f"staff-access grant: HTTP {exc.code} ({exc.reason or 'no reason'}); skipping grant."
        )
        return
    except (json.JSONDecodeError, ValueError) as exc:
        emit_warning(
            f"{classroom_short}: team {student_team_slug!r} member listing malformed "
            f"({exc}); skipping staff-access grant."
        )
        return

    usernames = _dedupe_logins(team_logins)

    # Resolved once rather than per staff role. Knowing the full list up front is
    # also what lets a throttled pass say how much is left for the next run.
    targets: list[tuple[str, str]] = []
    for slug in slugs:
        for username in usernames:
            repo_name = assignment_repo_name(classroom_short, slug, username)
            if repo_index is not None and not repo_index.contains(repo_name):
                continue
            targets.append((org, repo_name))
    targets.extend(
        private_template_targets(
            api_url, org, assignments, service_token, repo_index=repo_index,
            assignment_filter=assignment_filter,
        )
    )
    if not targets:
        return

    for team_slug, permission in grant_slugs:
        # Read this staff team's members to skip it when empty (see docstring).
        # Same SKIPPABLE-warn-and-skip contract as the student read above: any
        # non-401/403/599/throttle (404 = team not created yet, 422, …) skips
        # this team for the run; the add-only pass re-affirms it next run.
        try:
            staff_logins = (
                team_members.logins(team_slug)
                if team_members is not None
                else list_team_member_logins(api_url, org, team_slug, service_token)
            )
        except urllib.error.HTTPError as exc:
            if classify(exc) is not SKIPPABLE:
                raise
            emit_warning(
                f"{classroom_short}: could not read staff team {team_slug!r} members: "
                f"HTTP {exc.code} ({exc.reason or 'no reason'}); skipping its grant this run."
            )
            continue
        except (json.JSONDecodeError, ValueError) as exc:
            emit_warning(
                f"{classroom_short}: staff team {team_slug!r} member listing malformed "
                f"({exc}); skipping its grant this run."
            )
            continue
        if not staff_logins:
            continue

        # One bulk read replaces grant_team_repo's per-repo access check: after
        # the first run nearly every target is already granted, so that check —
        # not the PUT — is the request that dominates. None means "unknown".
        known_repos = known_team_repos(
            api_url, org, team_slug, service_token, classroom_short
        )
        granted = 0
        for index, (t_owner, t_repo) in enumerate(targets):
            try:
                if grant_team_repo(
                    api_url,
                    org,
                    team_slug,
                    t_owner,
                    t_repo,
                    permission,
                    service_token,
                    known_repos=known_repos,
                ):
                    granted += 1
            except urllib.error.HTTPError as exc:
                # One ladder walk: the tuple already carries the reason
                # GrantThrottled needs, typed as str.
                throttle = rate_limit_verdict(exc)
                if throttle is not None:
                    raise GrantThrottled(
                        throttle[0], team_slug, granted, len(targets) - index
                    ) from exc
                if classify(exc) is FATAL:
                    raise
                # 404 = repo not accepted yet; 422 = not org-owned. Neither is
                # a token problem — skip that repo.
                emit_warning(
                    f"{t_owner}/{t_repo}: could not grant {team_slug!r} {permission}: "
                    f"HTTP {exc.code} ({exc.reason or 'no reason'}){body_note(exc)}; skipping"
                )

        if granted:
            print(f"{classroom_short}: granted {team_slug} {permission} on {granted} repo(s)")


def private_template_targets(
    api_url: str,
    org: str,
    assignments: dict[str, Any],
    service_token: str,
    repo_index: RepoIndex | None = None,
    assignment_filter: str = "",
) -> list[tuple[str, str]]:
    """The private, in-org assignment templates (starter code the staff team
    should also be able to read), as (owner, repo) pairs.

    Public templates need no grant and an out-of-org private template can't be
    granted to this org's team, so both are skipped; a template that can't be
    read is warned about and dropped, while a hard error propagates. Resolved
    once for all staff roles — the read doesn't depend on the team.

    `repo_index` already knows each in-org repo's `private` flag from the org
    listing, so the per-template read only happens when it can't say.

    `assignment_filter` scopes to one assignment's template; blank keeps all."""
    targets: list[tuple[str, str]] = []
    # Deduped on the REF, not the kept targets: assignments commonly share one
    # starter template, and only private ones are kept — so deduping on the
    # output would re-read every public template once per assignment.
    seen: set[tuple[str, str]] = set()
    for entry in assignments.get("assignments") or []:
        if not isinstance(entry, dict):
            continue
        if assignment_filter and entry.get("slug") != assignment_filter:
            continue
        ref = assignment_template_ref(entry)
        if ref is None:
            continue
        t_owner, t_repo = ref
        if t_owner.lower() != org.lower() or ref in seen:
            continue
        seen.add(ref)
        private = repo_index.is_private(t_repo) if repo_index is not None else None
        if private is None:
            try:
                repo = get_repo(api_url, t_owner, t_repo, service_token)
            except urllib.error.HTTPError as exc:
                if classify(exc) is not SKIPPABLE:
                    raise
                emit_warning(
                    f"{t_owner}/{t_repo}: could not read template for the staff-team "
                    f"grant: HTTP {exc.code} ({exc.reason or 'no reason'}); skipping"
                )
                continue
            private = repo is not None and repo.get("private") is True
        if not private:
            continue
        targets.append((t_owner, t_repo))
    return targets


def known_team_repos(
    api_url: str, org: str, team_slug: str, token: str, classroom_short: str
) -> set[str] | None:
    """Lowercased `owner/repo` of every repo `team_slug` already has access to,
    or None when the listing failed. None means "unknown", which makes callers
    fall back to the per-repo access check — never to "not granted", which
    would re-PUT every repo on every run."""
    try:
        return list_team_repo_full_names(api_url, org, team_slug, token)
    except urllib.error.HTTPError as exc:
        if classify(exc) is not SKIPPABLE:
            raise
        emit_warning(
            f"{classroom_short}: could not list team {team_slug!r} repos: HTTP "
            f"{exc.code} ({exc.reason or 'no reason'}); checking access per repo."
        )
    except (json.JSONDecodeError, ValueError) as exc:
        emit_warning(
            f"{classroom_short}: team {team_slug!r} repo listing malformed "
            f"({exc}); checking access per repo."
        )
    return None


def _dedupe_logins(logins: list[str]) -> list[str]:
    """Case-insensitive dedupe of team logins, preserving first-seen order and
    casing. Same normalization collect_classroom applies to its team roster."""
    seen: set[str] = set()
    out: list[str] = []
    for login in logins:
        key = login.strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(login.strip())
    return out


# Due-date / lateness ---------------------------------------------------------


def utc_now_iso() -> str:
    """Now in the schema's timestamp shape (UTC, seconds, trailing Z)."""
    return datetime.datetime.now(datetime.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def parse_rfc3339(value: Any) -> datetime.datetime | None:
    """Parse an RFC 3339 timestamp into an aware datetime, or None when it
    isn't one (non-string, unparseable, or missing a timezone offset). Naive
    timestamps are rejected rather than guessed — lateness is a cross-timezone
    comparison, so an ambiguous wall-clock time must not silently pick one.
    """
    if not isinstance(value, str) or not value:
        return None
    if not RFC3339_RE.fullmatch(value):
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed


def mark_late(payload: dict[str, Any], due: datetime.datetime) -> bool:
    """Set payload["late"] by comparing the runner's submission `datetime`
    against the assignment's due date. Submitting exactly at the deadline is on
    time. Returns False — leaving the payload unmarked — when the timestamp
    doesn't parse; lateness is advisory and must never drop a submission.
    """
    submitted = parse_rfc3339(payload.get("datetime"))
    if submitted is None:
        return False
    payload["late"] = submitted > due
    return True


# scores.json read / write ----------------------------------------------------


class ScoresFileError(Exception):
    """Raised on a malformed scores.json or a write that can't be persisted."""


class AssetMissingError(Exception):
    """Raised when a submit release has no result.json asset."""


def strict_json_loads(raw: str) -> Any:
    """Parse JSON rejecting NaN/Infinity. Python's json accepts them by default
    but Go's encoding/json doesn't, and scores.json is read by both.
    """

    def reject_constant(value: str) -> None:
        raise ValueError(f"non-finite JSON number {value!r} is not allowed")

    return json.loads(raw, parse_constant=reject_constant)


def load_scores(path: pathlib.Path) -> dict[str, Any]:
    """Read scores.json. Missing or empty returns the v1 skeleton. Malformed
    raises so the workflow fails instead of overwriting the teacher's work.

    `assignments` must be the canonical object keyed by slug, each value an
    object `{ "type": ..., "entries": [...] }`. Legacy shapes are not migrated
    (see normalize_assignments) — a non-canonical file hard-fails.
    """
    if not path.is_file():
        return {"schema": SCORES_SCHEMA_V1, "assignments": {}}
    try:
        raw = path.read_text()
    except OSError as exc:
        raise ScoresFileError(f"{path}: read failed: {exc}") from exc
    if not raw.strip():
        return {"schema": SCORES_SCHEMA_V1, "assignments": {}}
    try:
        scores = strict_json_loads(raw)
    except (json.JSONDecodeError, ValueError) as exc:
        raise ScoresFileError(f"{path}: malformed JSON ({exc})") from exc
    if not isinstance(scores, dict):
        raise ScoresFileError(f"{path}: top-level value must be an object, got {type(scores).__name__}")
    if scores.get("schema") != SCORES_SCHEMA_V1:
        raise ScoresFileError(
            f"{path}: schema = {scores.get('schema')!r}, want {SCORES_SCHEMA_V1!r}"
        )
    try:
        scores["assignments"] = normalize_assignments(scores.get("assignments"))
    except ValueError as exc:
        raise ScoresFileError(f"{path}: {exc}") from exc
    # Drop the legacy root field if a hand-edit left it — `assignments` is
    # authoritative.
    scores.pop("submissions", None)
    return scores


def normalize_assignments(assignments: Any) -> dict[str, dict[str, Any]]:
    """Validate the `assignments` field as the canonical slug-keyed map.
    Accepted: None/missing -> {}; object -> each value an object
    `{ "type": <"individual"|"group">, "entries": [...] }`.

    Anything else hard-fails. Legacy shapes (flat array, "{}" string wrapper,
    the old `submissions`-keyed map) are NOT migrated — backward compat is
    intentionally dropped, so a non-canonical file fails loudly.
    """
    if assignments is None:
        return {}
    if not isinstance(assignments, dict):
        raise ValueError(
            f"assignments field must be an object keyed by assignment slug, "
            f"got {type(assignments).__name__}"
        )
    normalized: dict[str, dict[str, Any]] = {}
    for slug, bucket in assignments.items():
        if not isinstance(bucket, dict):
            raise ValueError(
                f"assignments[{slug!r}] must be an object {{type, entries}}, "
                f"got {type(bucket).__name__}"
            )
        atype = bucket.get("type")
        if atype not in ("individual", "group"):
            raise ValueError(
                f"assignments[{slug!r}].type must be 'individual' or 'group', got {atype!r}"
            )
        entries = bucket.get("entries")
        if entries is None:
            entries = []
        elif not isinstance(entries, list):
            raise ValueError(
                f"assignments[{slug!r}].entries must be a list, got {type(entries).__name__}"
            )
        # Spread the whole bucket so unknown fields (e.g. `collected_at`, or
        # anything a newer writer added) survive this read-modify-write instead
        # of being silently dropped on the next save.
        normalized[slug] = {**bucket, "type": atype, "entries": entries}
    return normalized


def save_scores(path: pathlib.Path, scores: dict[str, Any]) -> None:
    """Atomic write: encode → parse-back sanity check → tmp + replace.
    On any exception the original is untouched and the tmp is removed.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        payload = json.dumps(scores, indent=2, allow_nan=False) + "\n"
    except ValueError as exc:
        raise ScoresFileError(f"{path}: encode failed: {exc}") from exc
    # Re-parse to catch silent corruption (e.g., NaN in a score) before touching
    # the destination file.
    strict_json_loads(payload)
    tmp_path = path.with_name(path.name + ".tmp")
    try:
        tmp_path.write_text(payload)
        os.replace(tmp_path, path)
    except OSError as exc:
        # Clean up the tmp so a retry doesn't trip over a stale .tmp.
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise ScoresFileError(f"{path}: atomic write failed: {exc}") from exc


# Upsert / override-respect ---------------------------------------------------


def apply_updates(scores: dict[str, Any], updates: Iterable[dict[str, Any]]) -> int:
    """Merge incoming gradebook entries into the slug-keyed
    `scores["assignments"]` map; return the number of entries added or replaced.
    Each incoming entry carries transport hints `_assignment` (bucket slug) and
    `_type` (mode), plus the canonical fields (`owner`, optional
    `member_usernames`, `submissions[]`). The hints are stripped before storage
    (entry_from_result).

    Each bucket is `{ "type": ..., "entries": [...] }`. Existing entries with
    `"override": true` are preserved verbatim. Entries within a bucket are keyed
    by the repo OWNER (`row_key`), invariant for a repo — so a group entry whose
    member set changes between collects REPLACES its prior entry instead of
    orphaning it and appending a duplicate. Entries without an `owner` are not
    keyable and are skipped — no legacy migration.
    """
    assignments: dict[str, Any] = scores["assignments"]
    # Per-bucket index: assignment slug -> {row_key: entry index}.
    index: dict[str, dict[str, int]] = {}
    for slug, bucket in assignments.items():
        bucket_index: dict[str, int] = {}
        for i, ent in enumerate(bucket.get("entries", [])):
            if not isinstance(ent, dict):
                continue
            key = row_key(ent)
            if key is not None:
                bucket_index[key] = i
        index[slug] = bucket_index

    changes = 0
    for update in updates:
        slug = update.get("_assignment")
        atype = update.get("_type")
        key = row_key(update)
        # Require a valid slug, valid bucket type, and a keyable owner.
        # Validating `atype` here (not just below) means a missing/garbage
        # `_type` can never be persisted as a new bucket's `type` via
        # setdefault. Collection always supplies a valid type; defensive.
        if (
            not isinstance(slug, str) or not slug
            or atype not in ("individual", "group")
            or key is None
        ):
            continue
        entry = entry_from_result(update)
        bucket = assignments.setdefault(slug, {"type": atype, "entries": []})
        # Keep the bucket type in sync with the manifest-derived type.
        bucket["type"] = atype
        bucket.setdefault("entries", [])
        entries = bucket["entries"]
        bucket_index = index.setdefault(slug, {})
        idx = bucket_index.get(key)
        if idx is None:
            entries.append(entry)
            bucket_index[key] = len(entries) - 1
            changes += 1
            continue

        existing = entries[idx]
        if existing.get("override") is True:
            continue
        if same_submission(existing, entry):
            continue
        # A group re-collect that drops a previously-credited member (e.g., a
        # teammate who left the classroom team but is still a repo collaborator)
        # replaces the entry in place, silently revoking their shared credit.
        # The owner-only warning in collect_classroom only fires on collapse to
        # just the owner; a shrink still leaving >=2 members would be invisible.
        # Surface any dropped member so the teacher can confirm.
        dropped = _dropped_group_members(existing, entry)
        if dropped:
            emit_warning(
                f"{slug}: group entry owned by {row_key(entry)!r} lost previously-"
                f"credited member(s) {', '.join(sorted(dropped))} on re-collect. A "
                f"teammate is credited only while on the classroom team; verify the "
                f"drop is intended (e.g., an unenrollment) and not a team-vs-roster "
                f"divergence, since the shared score is now revoked for them."
            )
        # Preserve an explicit "override": false on replacement — the teacher's
        # "I reviewed this, keep refreshing" signal.
        if "override" in existing and "override" not in entry:
            entry = dict(entry)
            entry["override"] = existing["override"]
        entries[idx] = entry
        changes += 1
    return changes


def _dropped_group_members(
    existing: dict[str, Any], incoming: dict[str, Any]
) -> set[str]:
    """Members credited on the existing group entry but absent from the incoming
    one (case-insensitive), i.e., teammates whose shared credit a re-collect
    would silently revoke. Empty for individual entries or when the credited set
    didn't shrink."""
    def credited(entry: dict[str, Any]) -> set[str]:
        members = entry.get("member_usernames")
        if not isinstance(members, list):
            return set()
        return {
            m.strip().lower()
            for m in members
            if isinstance(m, str) and m.strip()
        }

    return credited(existing) - credited(incoming)


def entry_from_result(payload: dict[str, Any]) -> dict[str, Any]:
    """The stored gradebook entry, minus the transport-only hints.

    An entry is the shape collection builds: identity/keying at the top
    (`owner`, optional `member_usernames` for group) and the full per-submission
    detail inside `submissions` (newest first). The `_assignment` and `_type`
    hints drive bucket placement in apply_updates and are dropped here.
    """
    return {k: v for k, v in payload.items() if k not in ("_assignment", "_type")}


def row_key(record: dict[str, Any]) -> str | None:
    """The stable per-bucket key: the repo OWNER login, lowercased.

    Requires the explicit `owner` field (set by collection from the repo-name
    formula). Returns None when `owner` is missing or not a non-empty string —
    such a record is unkeyable and apply_updates skips it. No sole-username
    fallback and no legacy migration: every canonical row carries `owner`.

    Keying on the owner — not the credited `usernames` set — is what makes a
    group re-collect replace its row instead of duplicating it when the member
    set changes.

    Cross-binary tie: the owner is the `<username>` of the
    `<classroom>-<assignment>-<username>` repo-name formula (see
    `assignment_repo_name` here and `assignmentRepoName` in
    cli/gh-student/accept.go); persisted as the row `owner` field, which
    download.go reads tolerantly (rows decode as map[string]any).
    """
    owner = record.get("owner")
    if isinstance(owner, str) and owner:
        return owner.lower()
    return None


def same_submission(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """Field-equal comparison ignoring `override` (collect-side only)."""
    a_copy = {k: v for k, v in a.items() if k != "override"}
    b_copy = {k: v for k, v in b.items() if k != "override"}
    return a_copy == b_copy


# Result schema validation ----------------------------------------------------


_REQUIRED_STR_FIELDS = ("submission", "commit", "release", "review", "datetime")


def validate_result(
    payload: Any,
    expected_classroom: str,
    expected_assignment: str,
    expected_username: str,
    *,
    is_group: bool = False,
    renamed_from: str | None = None,
) -> None:
    """Raise ValueError if the payload fails the v1 contract. The
    classroom/assignment/owner checks defend against a hostile result.json
    trying to land in someone else's scores.json — the triple must match the
    source repo's expected identity.

    `owner` (repo owner, the identity anchor) must equal `expected_username`
    (the roster/repo-name-derived owner). `assignment_type` must be
    "individual"/"group" and match the mode implied by `is_group`. No
    `usernames` field: who pushed is `submitted_by`; the credited member list
    is resolved by collection after this check.

    `renamed_from` is the manifest entry's pre-rename slug (one-shot, so a
    single value): a historical release published before the rename carries it
    in the immutable result.json, and is accepted so old grades survive the
    rename. Exactly that value — never an arbitrary third slug.
    """
    if not isinstance(payload, dict):
        raise ValueError(f"top-level value must be an object, got {type(payload).__name__}")
    if payload.get("schema") != RESULT_SCHEMA_V1:
        raise ValueError(f"schema = {payload.get('schema')!r}, want {RESULT_SCHEMA_V1!r}")

    classroom = payload.get("classroom")
    if classroom != expected_classroom:
        raise ValueError(f"classroom = {classroom!r}, want {expected_classroom!r}")

    assignment = payload.get("assignment")
    if assignment != expected_assignment and (
        renamed_from is None or assignment != renamed_from
    ):
        want = repr(expected_assignment)
        if renamed_from is not None:
            want += f" (or pre-rename {renamed_from!r})"
        raise ValueError(f"assignment = {assignment!r}, want {want}")

    owner = payload.get("owner")
    if not isinstance(owner, str) or not owner:
        raise ValueError(f"owner must be a non-empty string, got {owner!r}")
    if owner.lower() != expected_username.lower():
        raise ValueError(
            f"owner = {owner!r}, want {expected_username!r} (derived from the repo name)"
        )

    expected_type = "group" if is_group else "individual"
    assignment_type = payload.get("assignment_type")
    if assignment_type != expected_type:
        raise ValueError(
            f"assignment_type = {assignment_type!r}, want {expected_type!r}"
        )

    submission = payload.get("submission")
    if not isinstance(submission, str) or not submission.startswith(SUBMIT_TAG_PREFIX):
        raise ValueError(f"submission must start with {SUBMIT_TAG_PREFIX!r}, got {submission!r}")

    for field in _REQUIRED_STR_FIELDS:
        value = payload.get(field)
        if not isinstance(value, str) or not value:
            raise ValueError(f"{field} must be a non-empty string, got {value!r}")

    score = payload.get("score")
    max_score = payload.get("max-score")
    if not isinstance(score, int) or isinstance(score, bool) or score < 0:
        raise ValueError(f"score must be a non-negative integer, got {score!r}")
    if not isinstance(max_score, int) or isinstance(max_score, bool) or max_score < 0:
        raise ValueError(f"max-score must be a non-negative integer, got {max_score!r}")
    if score > max_score:
        raise ValueError(f"score ({score}) > max-score ({max_score})")

    tests = payload.get("tests")
    if not isinstance(tests, list):
        raise ValueError(f"tests must be a list, got {type(tests).__name__}")
    for i, test in enumerate(tests):
        if not isinstance(test, dict):
            raise ValueError(f"tests[{i}] must be an object, got {type(test).__name__}")
        if not isinstance(test.get("test-name"), str) or not test["test-name"]:
            raise ValueError(f"tests[{i}].test-name must be a non-empty string")
        if not isinstance(test.get("passed"), bool):
            raise ValueError(f"tests[{i}].passed must be a boolean")
        for field in ("score", "max-score"):
            value = test.get(field)
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise ValueError(f"tests[{i}].{field} must be a non-negative integer, got {value!r}")
        if test["score"] > test["max-score"]:
            raise ValueError(
                f"tests[{i}].score ({test['score']}) > tests[{i}].max-score ({test['max-score']})"
            )

    # submitted_by is optional (older results omit it). When present, validate
    # its shape so a hand-edited result.json can't store a malformed identity.
    submitted_by = payload.get("submitted_by")
    if submitted_by is not None:
        if not isinstance(submitted_by, dict):
            raise ValueError(f"submitted_by must be an object, got {type(submitted_by).__name__}")
        uname = submitted_by.get("username")
        if not isinstance(uname, str) or not uname:
            raise ValueError("submitted_by.username must be a non-empty string")
        sid = submitted_by.get("id")
        if sid is not None and (isinstance(sid, bool) or not isinstance(sid, int)):
            raise ValueError(f"submitted_by.id must be an integer or null, got {sid!r}")


# GitHub API helpers ----------------------------------------------------------


class _AuthStrippingRedirect(urllib.request.HTTPRedirectHandler):
    """Drop Authorization on redirect so the GitHub token doesn't leak to the
    S3-signed asset URL GitHub redirects asset reads to.
    """

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


def _repo_url(api_url: str, owner: str, repo: str) -> str:
    return (
        f"{api_url}/repos/{urllib.parse.quote(owner, safe='')}/"
        f"{urllib.parse.quote(repo, safe='')}"
    )


# --- Detected submissions (assignments that skip grading) -------------------
#
# An assignment with autograding disabled publishes no submit/* release, so the
# graded path above has nothing to ingest. These helpers derive submissions from
# repo state instead — presence and count only, never a score — mirroring the
# web app's src/domain/assignments/submissionDetection.ts. Keep the two in step:
# a divergence makes the assignments list and the submissions page disagree.

# The commit subjects the tool itself authors onto a student's default branch
# (accept's Feedback-PR commit and the submission-mode shim retrofit). Neither is
# student work, so neither counts as a submission. Hand-mirrored with
# cli/shared/contract's PrefixCommit forms and the web's TOOL_COMMIT_SUBJECTS.
TOOL_COMMIT_SUBJECTS = frozenset(
    {
        "[Classroom 50] Open Feedback PR (gh student accept)",
        "[Classroom 50] Update autograder trigger to every-push (submission-mode)",
        "[Classroom 50] Update autograder trigger to tag (submission-mode)",
    }
)

# The in-repo accept marker; its OLDEST commit is the baseline that separates
# accept-time setup (including the template's own commits, which are its
# ancestors) from student work. Mirrors contract.MetadataPath.
ACCEPT_MARKER_PATH = ".classroom50.yaml"

# The canonical submission-tag namespace the shim always triggers on, unioned
# with any milestone patterns (see SUBMIT_TAG_PREFIX at the top of the file).

_SUBMIT_TAG_TIME_RE = re.compile(
    r"^submit/(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3])-([0-5]\d)-([0-5]\d)Z-"
)


def commit_subject(message: Any) -> str:
    """A commit message's first line, trimmed."""
    if not isinstance(message, str):
        return ""
    return message.split("\n", 1)[0].strip()


def submit_tag_datetime(tag_name: str) -> str | None:
    """The instant encoded in a canonical `submit/<UTC-ts>-<short-sha>` tag name
    (buildSubmitTag replaces the timestamp's colons with dashes to keep the ref
    valid). None for a milestone or malformed name — the caller then has no free
    time source and leaves the record dateless."""
    match = _SUBMIT_TAG_TIME_RE.match(tag_name or "")
    if not match:
        return None
    day, hour, minute, second = match.groups()
    return f"{day}T{hour}:{minute}:{second}Z"


# Compiled-pattern cache for _compile_tag_pattern: detect_tag_submissions
# re-evaluates each pattern against every tag, and compilation is the pricey
# half. Output-neutral, so the regrade/web matcher parity is untouched.
_COMPILED_TAG_PATTERNS: dict[str, "re.Pattern[str] | None"] = {}


def _compile_tag_pattern(pattern: str) -> "re.Pattern[str] | None":
    """One Actions tag-filter pattern -> an anchored regex, or None when it
    can't compile (fail closed: matches nothing). Character by character so
    `.` and other regex metacharacters in the pattern stay literal. Supported
    subset: literal names, `*` (not crossing `/`), `**` (crossing), `?`/`+`
    (zero-or-one / one-or-more of the preceding element), `[abc]` classes.
    """
    if pattern in _COMPILED_TAG_PATTERNS:
        return _COMPILED_TAG_PATTERNS[pattern]
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
        compiled = re.compile("".join(out))
    except re.error:
        compiled = None
    _COMPILED_TAG_PATTERNS[pattern] = compiled
    return compiled


# The safe-pattern charset — literal-name characters plus the glob
# metacharacters GitHub Actions tag filters support. Keep in lockstep with Go
# contract.SubmissionTagCharsetRE and the web SUBMISSION_TAG_PATTERN_RE.
_TAG_PATTERN = re.compile(r"^[A-Za-z0-9._/*?+\[\]-]+$")

# A leading `?`/`+` (nothing to repeat) or a `+` stacked on another quantifier
# (`v*+`, `a++`). LOAD-BEARING in a Python mirror: those translate to POSSESSIVE
# quantifiers, which Python 3.11+ compiles (and matches!) while Go RE2 and JS
# reject — without this guard the matcher copies diverge on exactly these
# patterns. Keep in lockstep with Go contract.stackedQuantifierRE and the web.
_STACKED_QUANTIFIER = re.compile(r"^[?+]|[*?+]\+")


def matches_submission_tag(patterns: Iterable[str], tag_name: str) -> bool:
    """Whether `tag_name` matches ANY of the Actions tag-filter `patterns`; an
    empty list matches nothing. By-value copy of Go's
    contract.MatchesSubmissionTag, the web matchesSubmissionTag, and
    regrade_repos.py's copy — all pinned to identical output by the shared
    golden fixture cli/shared/testdata/submission_tag_match_cases.json. The same
    strings are rendered into the shim's on.push.tags, so this matcher and
    GitHub's own filter evaluation must agree on what fires. Keep in lockstep."""
    for pattern in patterns:
        if not isinstance(pattern, str) or not pattern:
            continue
        if not _TAG_PATTERN.fullmatch(pattern) or _STACKED_QUANTIFIER.search(pattern):
            continue  # fail closed, matching the Go/JS charset+compile guards
        compiled = _compile_tag_pattern(pattern)
        if compiled is not None and compiled.fullmatch(tag_name or "") is not None:
            return True
    return False


def detect_branch_submissions(
    commits: list[dict[str, Any]], baseline_sha: str | None
) -> list[dict[str, Any]]:
    """Branch mode: every default-branch commit past the accept baseline that the
    tool didn't author is one submission. `commits` is newest-first (GitHub's
    order), so the baseline's index is the cut point — everything at or before it
    is accept-time setup, including the template's ancestor commits."""
    cut = len(commits)
    if baseline_sha:
        for index, commit in enumerate(commits):
            if commit.get("sha") == baseline_sha:
                cut = index
                break
    detected: list[dict[str, Any]] = []
    for commit in commits[:cut]:
        payload = commit.get("commit") if isinstance(commit.get("commit"), dict) else {}
        if commit_subject(payload.get("message")) in TOOL_COMMIT_SUBJECTS:
            continue
        committer = payload.get("committer") if isinstance(payload.get("committer"), dict) else {}
        author = payload.get("author") if isinstance(payload.get("author"), dict) else {}
        detected.append(
            {
                "sha": commit.get("sha"),
                "datetime": committer.get("date") or author.get("date"),
            }
        )
    return detected


def detect_tag_submissions(
    tags: list[dict[str, Any]], submission_tags: list[str]
) -> list[dict[str, Any]]:
    """Tag mode: an EXACT pattern yields one submission per matching tag; a GLOB
    groups all its matches into one submission set. A tag claimed by an earlier
    pattern is never double-counted. Mirrors detectTagSubmissions."""
    detected: list[dict[str, Any]] = []
    claimed: set[str] = set()
    for pattern in submission_tags:
        matches = [
            tag
            for tag in tags
            if isinstance(tag.get("name"), str)
            and tag["name"] not in claimed
            and matches_submission_tag([pattern], tag["name"])
        ]
        if not matches:
            continue
        for tag in matches:
            claimed.add(tag["name"])
        if any(ch in pattern for ch in "*?+[]"):
            # A group's time comes from its newest member by encoded submit/*
            # timestamp; a milestone glob has no parseable name, so it stays
            # dateless rather than guessing. (Encoded times share one fixed
            # `YYYY-MM-DDTHH:MM:SSZ` shape, so max() on the strings is
            # chronological.)
            dated = [
                encoded
                for tag in matches
                if (encoded := submit_tag_datetime(tag["name"])) is not None
            ]
            detected.append(
                {"count": len(matches), "datetime": max(dated) if dated else None}
            )
        else:
            for tag in matches:
                detected.append(
                    {"count": 1, "datetime": submit_tag_datetime(tag["name"])}
                )
    return detected


def list_default_branch_commits(
    api_url: str, owner: str, repo: str, branch: str, token: str,
    stop_at_sha: str | None = None,
) -> list[dict[str, Any]]:
    """A repo's default-branch commits, newest first. With `stop_at_sha` (the
    accept baseline) the walk ends on the page that contains it — everything at
    or past the baseline is accept-time setup the caller cuts anyway, so paging
    through the rest of a long history would be pure waste."""
    return _paginate_objects(
        lambda page: (
            f"{_repo_url(api_url, owner, repo)}/commits"
            f"?sha={urllib.parse.quote(branch, safe='')}&per_page=100&page={page}"
        ),
        api_url,
        token,
        f"{owner}/{repo} commits",
        stop_after=(
            (lambda commit: commit.get("sha") == stop_at_sha)
            if stop_at_sha
            else None
        ),
    )


def oldest_commit_sha_for_path(
    api_url: str, owner: str, repo: str, path: str, token: str
) -> str | None:
    """The oldest commit touching a path — the accept-marker baseline. None when
    the path has no history (a bare repo), which trims nothing."""
    commits = _paginate_objects(
        lambda page: (
            f"{_repo_url(api_url, owner, repo)}/commits"
            f"?path={urllib.parse.quote(path, safe='')}&per_page=100&page={page}"
        ),
        api_url,
        token,
        f"{owner}/{repo} marker history",
    )
    if not commits:
        return None
    sha = commits[-1].get("sha")
    return sha if isinstance(sha, str) and sha else None


def list_repo_tags(
    api_url: str, owner: str, repo: str, token: str
) -> list[dict[str, Any]]:
    """Every tag on a repo (lightweight refs; carries no dates)."""
    return _paginate_objects(
        lambda page: (
            f"{_repo_url(api_url, owner, repo)}/tags?per_page=100&page={page}"
        ),
        api_url,
        token,
        f"{owner}/{repo} tags",
    )


def detect_repo_submissions(
    api_url: str,
    org: str,
    repo_name: str,
    token: str,
    mode: str,
    submission_tags: list[str],
) -> list[dict[str, Any]]:
    """One repo's detected submissions. Branch mode reads the default branch, its
    accept-marker baseline and its commit log; tag mode reads its tags. Returns
    [] for a repo that isn't accepted or is commitless."""
    if mode == "tag":
        tags = list_repo_tags(api_url, org, repo_name, token)
        patterns = [*submission_tags, f"{SUBMIT_TAG_PREFIX}*"]
        return detect_tag_submissions(tags, patterns)

    info = get_repo(api_url, org, repo_name, token)
    branch = (info or {}).get("default_branch")
    if not isinstance(branch, str) or not branch:
        return []  # not accepted, or no commits yet
    baseline = oldest_commit_sha_for_path(
        api_url, org, repo_name, ACCEPT_MARKER_PATH, token
    )
    commits = list_default_branch_commits(
        api_url, org, repo_name, branch, token, stop_at_sha=baseline
    )
    return detect_branch_submissions(commits, baseline)


def detected_record(
    owner: str,
    detections: list[dict[str, Any]],
    due: datetime.datetime | None,
    trust_times: bool = True,
) -> dict[str, Any]:
    """Fold one repo's detections into the scores/v1 `detected` record: a count,
    the newest instant, and the late flag derived from it. Carries no score —
    these assignments are never graded.

    `trust_times` is False in TAG mode, where the only available instant is
    decoded from the `submit/<ts>` tag NAME. That name is student-authored, so a
    student could backdate it to dodge a late flag or forge a "last submitted"
    time. The web side refuses tag times for lateness for exactly this reason
    (see latestCommitDetectedAt), so neither `latest_datetime` nor `late` is
    recorded from one — the count still is, since tag EXISTENCE isn't forgeable.
    """
    count = sum(int(d.get("count", 1) or 1) for d in detections)
    record: dict[str, Any] = {"owner": owner, "count": count}
    if not trust_times:
        return record
    # Latest by PARSED time, not lexicographic max: a commit date carrying a
    # non-Z offset would missort as a string, and an unparseable string must
    # not shadow a parseable older one — mirrors the web's latestDetectedAt.
    times = [
        parsed
        for d in detections
        if isinstance(d.get("datetime"), str)
        and (parsed := parse_rfc3339(d["datetime"])) is not None
    ]
    if times:
        latest = max(times)
        record["latest_datetime"] = latest.astimezone(
            datetime.timezone.utc
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
        if due is not None:
            record["late"] = latest > due
    return record


def all_submit_releases(
    api_url: str, owner: str, repo: str, token: str
) -> list[dict[str, Any]]:
    """Every submit-tag release for a repo, newest first, walking the full
    /releases pagination — the complete submission history (a student who pushed
    N times has N submit/* releases, all returned). Non-submit releases (e.g., a
    hand-created tag) are filtered out. A 404 (no releases, or repo not
    accepted) yields an empty list.

    Pagination is _paginate_objects', so an incompletable walk (looping Link
    chain or the page cap) raises IncompleteListing rather than returning a
    truncated history — a partial list would replace the student's prior entry
    with fewer submissions, and the caller's warn-and-skip preserves it instead.
    """
    base = f"{_repo_url(api_url, owner, repo)}/releases"
    try:
        releases = _paginate_objects(
            lambda page: f"{base}?per_page=100&page={page}",
            api_url,
            token,
            f"repos/{owner}/{repo}/releases",
        )
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return []
        raise
    return [
        release
        for release in releases
        if (release.get("tag_name") or "").startswith(SUBMIT_TAG_PREFIX)
        # A read-write token also lists draft releases. The runner never
        # publishes drafts, so a draft submit/* tag is hand-made noise whose
        # assets aren't downloadable anyway — skip it.
        and release.get("draft") is not True
    ]


class IncompleteListing(ValueError):
    """A paginated walk that could not be completed — a looping `Link` chain or
    the page cap. Distinct from a malformed body so callers can tell a partial
    list from a non-list: a partial list must never be persisted as the whole
    set."""


def _next_page_link(link_header: str | None) -> str | None:
    """The `rel="next"` URL from a GitHub `Link` header, or None when there's no
    next page (or no header). GitHub's guidance is to follow this URL rather
    than synthesize page numbers, since page size and next-page presence are the
    server's to decide. Mirrors NextPageLink in cli/shared/ghutil/ghutil.go.
    """
    if not link_header:
        return None
    m = re.search(r'<([^>]+)>\s*;\s*[^,]*rel="next"', link_header)
    return m.group(1) if m else None


def _assert_same_host(next_url: str, api_url: str) -> str:
    """Return next_url only if its scheme+host match api_url's; else raise
    ValueError. The pagination loop attaches `Authorization: Bearer <token>` to
    whatever URL it follows, so a malicious/MITM'd `Link: rel="next"` pointing
    off-host would otherwise pivot the token. The redirect path defends this via
    _AuthStrippingRedirect; this is the fail-closed guard on the Link-follow
    path. A legitimate api.github.com / GHES next page passes unchanged.
    """
    api = urllib.parse.urlsplit(api_url)
    nxt = urllib.parse.urlsplit(next_url)
    if (nxt.scheme, nxt.netloc) != (api.scheme, api.netloc):
        raise ValueError(
            f"pagination Link points off-host "
            f"({nxt.scheme}://{nxt.netloc} != {api.scheme}://{api.netloc}); "
            f"refusing to send the service token to a different host"
        )
    return next_url


def _paginate_objects(
    page_url: Callable[[int], str],
    api_url: str,
    token: str,
    resource_label: str,
    stop_after: Callable[[dict[str, Any]], bool] | None = None,
) -> list[dict[str, Any]]:
    """Walk a paginated GitHub list endpoint, returning every object it yields.

    `page_url(page)` builds the request URL for a 1-based page (caller owns
    per_page/page formatting). Only the first page uses it; subsequent pages
    follow GitHub's `Link: rel="next"`, host-pinned via _assert_same_host so a
    crafted Link can't pivot the token. When no Link header is present, falls
    back to page+1 and stops on a short page (len < per_page).

    `stop_after` (optional) ends the walk once any object on the current page
    satisfies it — for callers that only need the prefix up to a sentinel (the
    accept-baseline commit), sparing the rest of a long history. The whole page
    is still returned, so the caller cuts precisely.

    Raises urllib.error.HTTPError on any non-2xx (including 404) so the caller
    can choose soft fallback vs. hard failure; raises ValueError on a non-array
    body, and IncompleteListing (a ValueError) when the walk can't be completed
    — a self/looping rel="next" or the page cap.
    """
    per_page = 100
    max_pages = 100
    items: list[dict[str, Any]] = []
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
        page_items = [item for item in batch if isinstance(item, dict)]
        items.extend(page_items)
        if stop_after is not None and any(stop_after(item) for item in page_items):
            return items
        link_header = headers.get("Link") if headers else None
        next_url = _next_page_link(link_header)
        if next_url:
            next_url = _assert_same_host(next_url, api_url)
            # A truncated listing would be indistinguishable from a complete
            # one. Raise instead; callers turn it into "unknown", failing open.
            if next_url in seen_next:
                raise IncompleteListing(
                    f"{resource_label}: pagination Link loops back to a page "
                    f"already fetched ({next_url}); the listing is incomplete"
                )
            seen_next.add(next_url)
            url = next_url
            continue
        if link_header or len(batch) < per_page:
            return items
        url = page_url(page + 1)
    raise IncompleteListing(
        f"{resource_label}: too many entries to enumerate "
        f"(hit the {max_pages}-page cap)"
    )


def _paginate_field_list(
    page_url: Callable[[int], str],
    api_url: str,
    token: str,
    resource_label: str,
    field: str = "login",
) -> list[str]:
    """Every object's `field` from a paginated endpoint (accounts by `login`,
    repos by `name`/`full_name`). The one-field view of _paginate_objects, which
    owns the walk and its error contract."""
    values: list[str] = []
    for item in _paginate_objects(page_url, api_url, token, resource_label):
        value = item.get(field)
        if isinstance(value, str) and value:
            values.append(value)
    return values


def list_repo_collaborator_logins(
    api_url: str, owner: str, repo: str, token: str
) -> list[str]:
    """Logins of every direct collaborator on owner/repo, walking pagination.

    Returns ALL collaborators regardless of permission level. The crediting gate
    is NOT permission level — it's classroom-team membership, applied by the
    caller (group_member_usernames intersects with the team). Filtering on
    `role_name == "admin"` here was a bug: a group teammate who is also an org
    owner (admin on every repo), or a founder kept as repo `admin` to invite
    teammates, is `admin` yet a legitimate student — the old filter dropped
    them, crediting only the owner. Non-student teachers/TAs/org-owners are
    excluded downstream because they're not on the roster, so dropping the admin
    filter here loses no protection.

    Pagination follows GitHub's `Link: rel="next"` header (short-page heuristic
    only as fallback); the followed next URL is host-pinned to api_url so the
    token can't be pivoted off-host.

    Raises urllib.error.HTTPError on any non-2xx (including 404) so the caller
    can choose owner-only fallback vs. hard failure.
    """
    per_page = 100
    base = f"{_repo_url(api_url, owner, repo)}/collaborators"
    return _paginate_field_list(
        page_url=lambda page: f"{base}?per_page={per_page}&page={page}",
        api_url=api_url,
        token=token,
        resource_label=f"repos/{owner}/{repo}/collaborators",
    )


def list_team_member_logins(
    api_url: str, org: str, team_slug: str, token: str
) -> list[str]:
    """Logins of every member of the classroom team, walking pagination. The
    team-driven username source for collection: the classroom GitHub team is
    authoritative for enrollment (the roster is only best-effort display
    metadata). Hits GET /orgs/{org}/teams/{slug}/members.

    Pagination follows GitHub's `Link: rel="next"` header, host-pinned to
    api_url (same defense as list_repo_collaborator_logins). Raises
    urllib.error.HTTPError on any non-2xx (including 404 when the team doesn't
    exist) so the caller can warn-and-skip vs. hard-fail."""
    per_page = 100
    base = (
        f"{api_url}/orgs/{urllib.parse.quote(org, safe='')}/teams/"
        f"{urllib.parse.quote(team_slug, safe='')}/members"
    )
    return _paginate_field_list(
        page_url=lambda page: f"{base}?per_page={per_page}&page={page}",
        api_url=api_url,
        token=token,
        resource_label=f"orgs/{org}/teams/{team_slug}/members",
    )


def list_org_repos(api_url: str, org: str, token: str) -> dict[str, bool]:
    """Lowercased name -> `private` flag for every repo in `org` the token can
    see, walking pagination. Hits GET /orgs/{org}/repos.

    Read once per run — see RepoIndex, which documents why a name absent here
    can be skipped. The `private` flag rides along from the same response
    bodies, so the staff-team grant doesn't re-read each template to learn it.

    Raises urllib.error.HTTPError on any non-2xx so the caller can fall back to
    per-repo probing."""
    per_page = 100
    base = f"{api_url}/orgs/{urllib.parse.quote(org, safe='')}/repos"
    repos = _paginate_objects(
        page_url=lambda page: f"{base}?per_page={per_page}&page={page}&type=all",
        api_url=api_url,
        token=token,
        resource_label=f"orgs/{org}/repos",
    )
    visible: dict[str, bool] = {}
    for repo in repos:
        name = repo.get("name")
        if isinstance(name, str) and name:
            visible[name.lower()] = repo.get("private") is True
    return visible


def list_team_repo_full_names(
    api_url: str, org: str, team_slug: str, token: str
) -> set[str]:
    """Lowercased `owner/repo` of every repo `team_slug` has access to, walking
    pagination. Hits GET /orgs/{org}/teams/{slug}/repos — the bulk form of
    team_has_repo_access, read once instead of once per candidate repo.

    Raises urllib.error.HTTPError on any non-2xx (including 404 when the team
    doesn't exist) so the caller can warn-and-skip vs. hard-fail."""
    per_page = 100
    base = (
        f"{api_url}/orgs/{urllib.parse.quote(org, safe='')}/teams/"
        f"{urllib.parse.quote(team_slug, safe='')}/repos"
    )
    full_names = _paginate_field_list(
        page_url=lambda page: f"{base}?per_page={per_page}&page={page}",
        api_url=api_url,
        token=token,
        resource_label=f"orgs/{org}/teams/{team_slug}/repos",
        field="full_name",
    )
    return {name.lower() for name in full_names}


def group_member_usernames(
    api_url: str, org: str, repo: str, owner_username: str, token: str, roster_logins: set[str]
) -> list[str]:
    """Member list for a group submission: the repo's collaborators (any
    permission) **intersected with the classroom team** (case-insensitive),
    sorted and deduped, owner guaranteed present. Crediting is gated on team
    membership, NOT collaborator permission: a teammate on the classroom team is
    credited whether push or admin (an org owner is admin everywhere; a founder
    is kept admin to invite). A collaborator not on the team (teacher, TA,
    non-student org owner, or an account added out-of-band) is never credited.
    Raises on the underlying HTTP/parse error so the caller can fall back to
    owner-only.

    (`roster_logins` is the case-folded set of classroom-team logins the caller
    passes in — the team is authoritative for enrollment; the name is legacy.)

    TRUST ASSUMPTION (F6, documented residual): every teammate on the classroom
    team who is a collaborator on the repo is credited. GitHub doesn't record HOW
    a collaborator was added, so collection can't distinguish a teammate the
    founder invited via `gh student invite` from one a student added via the UI.
    The team intersection bounds the blast radius to classmates on the team — a
    stranger can never be credited — but a student could add a teammate on the
    team and credit them this score. Treating that as acceptable (classmates on
    the team are mutually trusted within a classroom) is the deliberate, simple
    model; see wiki/Autograders.md. Tightening it would require a teacher-approved
    group manifest, out of scope.
    """
    logins = list_repo_collaborator_logins(api_url, org, repo, token)
    seen: dict[str, str] = {}
    owner_key = owner_username.lower()
    for login in [owner_username, *logins]:
        key = login.lower()
        # Owner always credited; other collaborators only if on the team.
        if key != owner_key and key not in roster_logins:
            continue
        if key not in seen:
            # Store the OWNER under its own (repo-derived) casing, but normalize
            # every other member to lowercase. GitHub's /collaborators can return
            # a login under different casing between collects; storing that raw
            # casing made the member list (and same_submission) churn and rewrite
            # the entry every run. Lowercasing non-owner members is deterministic
            # (crediting is case-insensitive anyway), so an unchanged group
            # submission compares equal and is left alone.
            seen[key] = owner_username if key == owner_key else key
    return [seen[k] for k in sorted(seen)]


def attribute_group_members(
    api_url: str, org: str, repo: str, owner_username: str, token: str, roster_logins: set[str]
) -> tuple[list[str], str | None]:
    """Resolve the member list to credit for a group submission.

    Returns (usernames, warning). On success `usernames` is the rostered
    collaborator list (owner always included) and `warning` is None. On a
    collaborator-read failure `usernames` is forced to [owner] — never the
    runner/student-supplied list — and `warning` is a message the caller should
    emit and count as a degraded attribution.

    Two failures are NOT degraded but propagated, because degrading here
    PERSISTS an owner-only member list into scores.json — silently uncrediting
    real teammates and then blaming the token in the aggregate warning:

      * a THROTTLE (a rate-limit burst mid-run), and
      * an INCOMPLETE listing (looping Link / page cap), where the collaborator
        set we hold is partial and indistinguishable from a complete one.

    A malformed body still degrades: there is no usable list to be partial
    about, and the owner is the only defensible credit.
    """
    try:
        return group_member_usernames(api_url, org, repo, owner_username, token, roster_logins), None
    except urllib.error.HTTPError as exc:
        if classify(exc) is THROTTLED:
            raise
        return [owner_username], (
            f"{org}/{repo}: could not read group collaborators "
            f"(HTTP {exc.code} {exc.reason or 'no reason'}); crediting the "
            f"repo owner {owner_username!r} only. Ensure CLASSROOM50_SERVICE_TOKEN "
            f"can read repository collaborators (see the service-token wiki)."
        )
    except IncompleteListing:
        raise
    except (json.JSONDecodeError, ValueError) as exc:
        return [owner_username], (
            f"{org}/{repo}: group collaborator listing malformed "
            f"({exc}); crediting the repo owner {owner_username!r} only."
        )


def download_result_asset(
    api_url: str, release: dict[str, Any], token: str
) -> dict[str, Any]:
    """Find the `result.json` asset on `release` and return the parsed JSON.

    Raises:
        urllib.error.HTTPError if the asset endpoint refuses the request.
        AssetMissingError if no `result.json` asset is found.
        json.JSONDecodeError if the bytes don't parse as JSON.
        ValueError if the asset is too large.
    """
    matches = [
        c for c in (release.get("assets") or [])
        if (c.get("name") or "").lower() == RESULT_ASSET_NAME
    ]
    # Runs once per release in the history walk, so errors name THIS release.
    release_label = release.get("tag_name") or release.get("url") or "release"
    if not matches:
        raise AssetMissingError(
            f"{RESULT_ASSET_NAME} asset missing from {release_label}"
        )
    if len(matches) > 1:
        raise ValueError(
            f"{release_label} has {len(matches)} {RESULT_ASSET_NAME} assets"
        )

    asset_url = matches[0].get("url")
    if not asset_url:
        raise ValueError("asset record missing url field")

    asset_url = rewrite_asset_url(asset_url, api_url)

    body = _http_get(
        asset_url,
        token,
        accept="application/octet-stream",
        max_bytes=MAX_RESULT_BYTES + 1,
    )
    if len(body) > MAX_RESULT_BYTES:
        raise ValueError(f"asset exceeds {MAX_RESULT_BYTES} byte ceiling ({len(body)} bytes)")
    return json.loads(body.decode("utf-8"))


def rewrite_asset_url(asset_url: str, api_url: str) -> str:
    """Rewrite an asset API URL to the configured API host. Asset records still
    carry api.github.com URLs even when GH_API_URL points at a test server or
    GHES — parse and swap scheme+netloc rather than string-slice a hardcoded
    prefix. Preserves a GHES-style /api/v3 prefix when the asset URL lacks it.
    """
    parsed_asset = urllib.parse.urlsplit(asset_url)
    parsed_api = urllib.parse.urlsplit(api_url)
    if not parsed_asset.scheme or not parsed_asset.netloc:
        return asset_url
    if not parsed_api.scheme or not parsed_api.netloc:
        return asset_url
    path = parsed_asset.path
    api_prefix = parsed_api.path.rstrip("/")
    if api_prefix and not (path == api_prefix or path.startswith(api_prefix + "/")):
        path = api_prefix + (path if path.startswith("/") else "/" + path)
    return urllib.parse.urlunsplit(
        (
            parsed_api.scheme,
            parsed_api.netloc,
            path,
            parsed_asset.query,
            parsed_asset.fragment,
        )
    )


def _http_get(
    url: str, token: str, *, accept: str, max_bytes: int | None = None, _retries: int = 3
) -> bytes:
    """GET `url` with bearer auth; return the body. Thin wrapper over
    `_http_get_with_headers` for callers that don't need response headers
    (release/asset reads)."""
    body, _headers = _http_get_with_headers(
        url, token, accept=accept, max_bytes=max_bytes, _retries=_retries
    )
    return body


def _http_get_with_headers(
    url: str, token: str, *, accept: str, max_bytes: int | None = None, _retries: int = 3
) -> tuple[bytes, Any]:
    """GET `url` with bearer auth; return (body, response headers). Headers are
    returned so paginated callers can follow GitHub's `Link: rel="next"` rather
    than guessing the next page from page length. Retry/backoff and the
    synthetic-599 contract live in _http_request."""
    _status, body, headers = _http_request(
        "GET", url, token, accept=accept, max_bytes=max_bytes, _retries=_retries
    )
    return body, headers


def _http_send(
    method: str,
    url: str,
    token: str,
    *,
    accept: str,
    body: bytes | None,
    _retries: int = 3,
) -> tuple[int, bytes]:
    """Issue `method url` with bearer auth; return (status, body). The
    write-side view of _http_request; used only for the team-repo grant
    PUT/GET. Mirrors regrade_repos.py's transport."""
    status, resp_body, _headers = _http_request(
        method, url, token, accept=accept, body=body, _retries=_retries
    )
    return status, resp_body


def _http_request(
    method: str,
    url: str,
    token: str,
    *,
    accept: str,
    body: bytes | None = None,
    max_bytes: int | None = None,
    _retries: int = 3,
) -> tuple[int, bytes, Any]:
    """The one transport: issue `method url` with bearer auth and return
    (status, body, response headers). Retries 5xx/429 and throttled 403s with
    backoff (see retry_delay). The custom redirect handler strips Authorization
    before following GitHub's asset-download redirect to S3 (otherwise the
    signed URL rejects the forwarded token)."""
    headers = {
        "Accept": accept,
        "Authorization": f"Bearer {token}",
        "User-Agent": "classroom50-collect-scores",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    for attempt in range(_retries):
        req = urllib.request.Request(url, method=method, data=body, headers=headers)
        try:
            with _OPENER.open(req, timeout=30) as resp:
                resp_body = (
                    resp.read(max_bytes) if max_bytes is not None else resp.read()
                )
                return resp.status, resp_body, resp.headers
        except urllib.error.HTTPError as exc:
            delay = retry_delay(exc, attempt)
            if delay is not None and attempt < _retries - 1:
                time.sleep(delay)
                continue
            raise
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            # A connect-phase failure is wrapped in URLError, but a timeout/reset
            # during resp.read() raises socket.timeout (= TimeoutError, an
            # OSError) which is NOT a URLError — so a stalled response body would
            # otherwise escape this retry path and crash past main()'s HTTPError
            # handler. Catch all three so a read-phase stall retries and wraps
            # into the synthetic 599 that classify() treats as FATAL.
            if attempt < _retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise urllib.error.HTTPError(
                url=url,
                code=599,
                msg=f"network error: {exc}",
                hdrs=None,  # type: ignore[arg-type]
                fp=None,
            ) from exc
    raise RuntimeError(f"_http_request called with _retries={_retries}")


def team_has_repo_access(
    api_url: str, org: str, team_slug: str, repo_owner: str, repo: str, token: str
) -> bool:
    """Whether `team_slug` already has any access to <repo_owner>/<repo> (2xx =
    yes, 404 = no). Keeps grant_team_repo idempotent. Mirrors Go's
    teamHasRepoAccess."""
    url = (
        f"{api_url}/orgs/{urllib.parse.quote(org, safe='')}/teams/"
        f"{urllib.parse.quote(team_slug, safe='')}/repos/"
        f"{urllib.parse.quote(repo_owner, safe='')}/{urllib.parse.quote(repo, safe='')}"
    )
    try:
        _http_send("GET", url, token, accept="application/vnd.github+json", body=None)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return False
        raise
    return True


def grant_team_repo(
    api_url: str,
    org: str,
    team_slug: str,
    repo_owner: str,
    repo: str,
    permission: str,
    token: str,
    *,
    known_repos: set[str] | None = None,
) -> bool:
    """Grant `team_slug` `permission` on <repo_owner>/<repo> via
    PUT /orgs/{org}/teams/{slug}/repos/{owner}/{repo}, skipping the write when
    the team already has any access (idempotent). Returns whether a new grant was
    applied. Mirrors Go's grantTeamRepo. A 403 (token lacks Administration) or
    599 propagates so main() aborts the run (classify -> FATAL); a 404/422 (repo
    absent / not org-owned) is left for the caller to warn-and-skip.

    `known_repos` is the team's repos already read in bulk (lowercased
    `owner/repo`, see list_team_repo_full_names), which answers the idempotence
    check without a request; None means unknown and costs the per-repo check."""
    if known_repos is not None:
        already_granted = f"{repo_owner}/{repo}".lower() in known_repos
    else:
        already_granted = team_has_repo_access(
            api_url, org, team_slug, repo_owner, repo, token
        )
    if already_granted:
        return False
    url = (
        f"{api_url}/orgs/{urllib.parse.quote(org, safe='')}/teams/"
        f"{urllib.parse.quote(team_slug, safe='')}/repos/"
        f"{urllib.parse.quote(repo_owner, safe='')}/{urllib.parse.quote(repo, safe='')}"
    )
    _http_send(
        "PUT",
        url,
        token,
        accept="application/vnd.github+json",
        body=json.dumps({"permission": permission}).encode("utf-8"),
    )
    return True


def error_body_snippet(exc: urllib.error.HTTPError) -> str:
    """First 300 characters of an error response body, whitespace-collapsed
    and cached on the exception so later readers (the retry decision, then the
    log line) still see it after the stream is consumed. Empty when the body
    can't be read.

    Worth logging: a 403 without its body leaves "throttled or under-scoped?"
    unanswerable."""
    cached = getattr(exc, "_body_snippet", None)
    if cached is None:
        try:
            # Bounded: only 300 chars survive, and the body can come from a
            # proxy or the asset redirect rather than GitHub's small errors.
            raw = exc.read(BODY_SNIPPET_READ_BYTES) or b""
        except (OSError, ValueError, AttributeError):
            raw = b""
        cached = " ".join(raw.decode("utf-8", "replace").split())[:300]
        setattr(exc, "_body_snippet", cached)
    return cached


def body_note(exc: urllib.error.HTTPError) -> str:
    """error_body_snippet formatted for appending to a log line."""
    snippet = error_body_snippet(exc)
    return f" — response: {snippet}" if snippet else ""


def rate_limit_verdict(
    exc: urllib.error.HTTPError,
) -> tuple[str, float | None] | None:
    """`(reason, seconds-to-wait)` when the response says GitHub is THROTTLING
    rather than refusing, else None. `seconds` is None for a throttle that must
    NOT be waited out.

    A rate limit arrives as 403 as often as 429, and only the response tells it
    apart from an under-scoped token: a Retry-After header, an exhausted
    X-RateLimit-Remaining, or a body naming the limit. One ladder decides reason
    and delay together so they cannot disagree; rate_limit_reason and retry_delay
    are its two views."""
    if exc.code not in (403, 429):
        return None
    headers = exc.headers or {}
    retry_after = _retry_after_seconds(headers)
    if retry_after is not None:
        # Bounded, so a mistaken or hostile header can't park the job.
        return (
            f"Retry-After: {retry_after}s",
            min(int(retry_after), MAX_RETRY_SLEEP_SECONDS),
        )
    if (headers.get("X-RateLimit-Remaining") or "").strip() == "0":
        # The primary hourly budget: its window runs up to an hour, so a named
        # error beats a sleeping job.
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
    the raw value when it doesn't name a representable time.

    `.isdigit()` is not guard enough: GitHub occasionally sends a MILLISECOND
    epoch, which overflows datetime. This runs inside an `except HTTPError`
    block, so raising here would surface the throttle as a traceback."""
    try:
        return datetime.datetime.fromtimestamp(
            int(value), tz=datetime.timezone.utc
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (ValueError, OverflowError, OSError):
        return value


def throttle_sleep_budget_spent(delay: float) -> bool:
    """Whether waiting `delay` would exceed the run's throttle-sleep budget;
    charges it when it fits.

    A recovering throttle raises nothing, so the sleeps stay invisible until the
    job timeout kills the run. This ceiling converts that into the named
    THROTTLED error instead."""
    global _throttle_sleep_spent
    if _throttle_sleep_spent + delay > MAX_TOTAL_THROTTLE_SLEEP_SECONDS:
        return True
    _throttle_sleep_spent += delay
    return False


def _retry_after_seconds(headers: Any) -> str | None:
    """The Retry-After header when it names plain delta-seconds, else None.
    Callers apply their own cap."""
    value = (headers.get("Retry-After") or "").strip() if headers else ""
    return value if value.isdigit() else None


def retry_delay(exc: urllib.error.HTTPError, attempt: int) -> float | None:
    """Seconds to wait before retrying `exc`, or None when it must not be
    retried.

    A throttle waits what rate_limit_verdict decided, while the run's sleep
    budget lasts. Anything else keeps the previous contract: 5xx and a
    signal-less 429 honour Retry-After (capped) or back off exponentially; any
    other status is terminal."""
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
        return 2 ** attempt
    return None


def classify(exc: urllib.error.HTTPError) -> str:
    """The ONE verdict every error handler branches on, throttle checked FIRST.

    THROTTLED — GitHub is rate limiting. The token is healthy and the work is
        deferrable; never report it as a scope problem.
    FATAL     — 401/403 (bad or under-scoped token) or 599 (synthetic
        network-unavailable after retries). Aborts the run: treating these as
        per-student "not submitted" would report a broken run as success.
    SKIPPABLE — everything else (404 = not accepted yet, 422 = not org-owned).

    NOTE a throttle is NOT fatal, so this alone is not a "propagate?" test:
    handlers that warn-and-skip must re-raise a throttle too, which is why they
    ask `classify(exc) is not SKIPPABLE`.
    """
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
