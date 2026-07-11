#!/usr/bin/env python3
"""Teacher-triggered scores collector.

Walks the classroom team × assignment manifest: for each (team member,
assignment) pair, pages the canonical `<classroom>-<assignment>-<username>`
repo's `submit/*` releases, validates each `result.json` asset, and upserts
into `<classroom>/scores.json`. The classroom GitHub team is the source of
truth for enrollment; the roster (roster.csv, or the legacy name) is only a
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
                              team) and Repository -> Contents: Read and write
                              (read scope only used here; write scope shared
                              with regrade.yaml).
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
# (created by autograde-runner.yaml on push to `main`).
SUBMIT_TAG_PREFIX = "submit/"

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
# web app's STUDENT_CSV_FIELDS. Identity/metadata columns; `role`
# (instructor/ta/student, or "") is best-effort recorded metadata refreshed from
# the classroom's GitHub teams — the teams, not this column, remain the
# enrollment authority. A pre-role file (ending at github_id) still reads fine:
# DictReader is header-keyed and a missing column just yields "".
ROSTER_REQUIRED_COLUMNS = ("username", "first_name", "last_name", "email", "section", "github_id", "role")

# Per-classroom roster file. ROSTER_FILENAME is the current name; a reader
# falls back to LEGACY_ROSTER_FILENAME for classrooms bootstrapped before the
# rename (writers always target roster.csv). Mirrors contract.RosterFilename /
# contract.LegacyRosterFilename in cli/shared/contract/contract.go with NO
# compile-time link — keep byte-identical.
ROSTER_FILENAME = "roster.csv"
LEGACY_ROSTER_FILENAME = "students.csv"

# The exact on-disk roster.csv header. Must equal FullRosterHeader in the Go
# students_csv.go (asserted by TestFullRosterHeader) and the web app's
# STUDENT_CSV_FIELDS header — a three-way lockstep. Retained as the Python leg
# of that lockstep (the Go download-metadata join and the web writer share it),
# pinned by test_full_roster_header_matches_go_constant.
FULL_ROSTER_HEADER = ",".join(ROSTER_REQUIRED_COLUMNS)


# Top-level dispatch ----------------------------------------------------------


def main() -> int:
    base_dir = pathlib.Path(os.environ.get("GITHUB_WORKSPACE") or ".").resolve()
    classroom_filter = (os.environ.get("CLASSROOM_FILTER") or "").strip()

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
        msg = f"no classrooms found in {base_dir}"
        if classroom_filter:
            msg += f" matching CLASSROOM_FILTER={classroom_filter!r}"
        print(msg)
        return 0

    total_changes = 0
    failed_classrooms: list[str] = []
    for classroom_short, classroom_meta, assignments in classroom_dirs:
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

        try:
            updates, mode_flip_assignments = collect_classroom(
                api_url=api_url,
                org=org,
                classroom_short=classroom_short,
                classroom_meta=classroom_meta,
                assignments=assignments,
                service_token=service_token,
                roster_meta=load_roster_metadata(base_dir / classroom_short),
            )
        except urllib.error.HTTPError as exc:
            # Auth (401/403) and synthetic-network (599) failures are GLOBAL —
            # the token is bad or GitHub is unreachable, so every remaining
            # classroom would fail identically. Abort the whole run loudly
            # rather than warn-and-skip per classroom (which would report a
            # broken run as success that collected nothing).
            if exc.code in (401, 403):
                emit_error(
                    f"{classroom_short}: service token was rejected with HTTP {exc.code} "
                    f"({exc.reason or 'no reason'}) — run `gh teacher rotate-service-token {org}` "
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
        assignment_count = len(valid_assignment_slugs(assignments))
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
    if failed_classrooms:
        emit_error(
            f"collect: {len(failed_classrooms)} classroom(s) failed and were skipped: "
            f"{', '.join(failed_classrooms)} (the other classrooms were collected)"
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
    (roster.csv, or the legacy name) is only best-effort display metadata,
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
    lowercased username. Tries roster.csv first, then the legacy name
    (classrooms bootstrapped before the rename); writers always target
    roster.csv. The classroom GitHub team — not this file — is authoritative
    for enrollment, so a missing/unreadable/malformed roster is NOT fatal: it
    just yields no metadata (blank name/section/email), never a crash or a
    dropped student.
    """
    for filename in (ROSTER_FILENAME, LEGACY_ROSTER_FILENAME):
        path = classroom_dir / filename
        if not path.is_file():
            continue
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
    return {}


# Per-classroom collection ----------------------------------------------------


def valid_assignment_slugs(assignments: dict[str, Any]) -> list[str]:
    """Slugs worth collecting: non-empty strings, in manifest order. main()'s
    zero-submission guard counts these; the collect loop applies the same
    predicate inline (it also needs each entry's `due`), so both agree on what
    counts as collectable."""
    slugs: list[str] = []
    for entry in assignments.get("assignments") or []:
        slug = entry.get("slug")
        if isinstance(slug, str) and slug:
            slugs.append(slug)
    return slugs


def collect_classroom(
    *,
    api_url: str,
    org: str,
    classroom_short: str,
    classroom_meta: dict[str, Any],
    assignments: dict[str, Any],
    service_token: str,
    roster_meta: dict[str, dict[str, str]] | None = None,
) -> tuple[list[dict[str, Any]], int]:
    """Return (validated result payloads for every (student, assignment) pair,
    count of assignments whose only submissions were rejected by validation).
    Per-repo failures warn and skip; hard failures (auth 401/403; network 599)
    propagate and main() converts them to exit 1. The second tuple element lets
    main() distinguish a mode-flip-induced empty result (which has its own loud
    warning) from a token-access problem.

    `roster_meta` is the best-effort roster join (username -> display metadata,
    see load_roster_metadata); when a collected owner has a matching row its
    name/section/email are attached to the entry. Absent/blank is fine — the
    join never gates collection.
    """
    roster_meta = roster_meta or {}
    results: list[dict[str, Any]] = []
    group_attribution_degraded = 0
    # (assignment) buckets where every present submission was rejected by
    # validation (the mode-flip symptom). Returned so main() can suppress its
    # "rotate token" heuristic, which would otherwise misread this as a
    # token-access problem.
    mode_flip_assignments = 0

    # Team-driven username source: the classroom GitHub team is authoritative
    # for enrollment. The roster (roster.csv, or the legacy name) is only
    # best-effort display metadata, so the (student, assignment) pairs come from
    # the team member list, NOT the CSV. A 404 (team missing) or empty team
    # yields no pairs (warn + return), replacing the old "roster missing" skip.
    # A hard auth/network error propagates so main() aborts the whole run loudly.
    team_slug = resolve_team_slug(classroom_meta, classroom_short)
    try:
        team_logins = list_team_member_logins(api_url, org, team_slug, service_token)
    except urllib.error.HTTPError as exc:
        if is_hard_http_error(exc):
            raise
        emit_warning(
            f"{classroom_short}: could not read team {team_slug!r} members: "
            f"HTTP {exc.code} ({exc.reason or 'no reason'}); skipping collection for "
            f"this classroom. Ensure CLASSROOM50_SERVICE_TOKEN has Organization -> "
            f"Members: Read (a fine-grained PAT permission) — rotate it with "
            f"`gh teacher rotate-service-token {org}`."
        )
        return results, mode_flip_assignments
    except (json.JSONDecodeError, ValueError) as exc:
        emit_warning(
            f"{classroom_short}: team {team_slug!r} member listing malformed "
            f"({exc}); skipping collection for this classroom."
        )
        return results, mode_flip_assignments

    if not team_logins:
        emit_warning(
            f"{classroom_short}: team {team_slug!r} has no members — no "
            f"(student, assignment) pairs to poll; skipping."
        )
        return results, mode_flip_assignments

    # Deduplicate case-insensitively, preserving first-seen order/casing.
    seen_logins: set[str] = set()
    team_usernames: list[str] = []
    for login in team_logins:
        key = login.strip().lower()
        if not key or key in seen_logins:
            continue
        seen_logins.add(key)
        team_usernames.append(login.strip())

    # Group attribution credits a collaborator only if on the team (owner always
    # credited) — same trust model, team-sourced set.
    roster_logins = set(seen_logins)
    for entry in assignments.get("assignments") or []:
        slug = entry.get("slug")
        if not isinstance(slug, str) or not slug:
            continue

        due_raw = entry.get("due")
        due = parse_rfc3339(due_raw) if due_raw else None
        if due_raw and due is None:
            emit_warning(
                f"{classroom_short}/{slug}: due = {due_raw!r} is not an RFC 3339 "
                f"timestamp with timezone; skipping late-marking for this assignment"
            )

        is_group = (entry.get("mode") or "").lower() == "group"
        assignment_type = "group" if is_group else "individual"

        submitted = 0
        # Repos under THIS assignment whose only submissions were rejected by
        # validation (mode-flip symptom); reported once per assignment below.
        mode_flip_repos: list[str] = []
        for username in team_usernames:
            repo_name = assignment_repo_name(classroom_short, slug, username)

            try:
                releases = all_submit_releases(api_url, org, repo_name, service_token)
            except urllib.error.HTTPError as exc:
                if is_hard_http_error(exc):
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
                    if is_hard_http_error(exc):
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
                    validate_result(candidate, classroom_short, slug, username, is_group=is_group)
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
                members, degraded_warning = attribute_group_members(
                    api_url, org, repo_name, username, service_token, roster_logins
                )
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

        print(f"{classroom_short}/{slug}: {submitted}/{len(team_usernames)} submitted")

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

    return results, mode_flip_assignments


def assignment_repo_name(classroom: str, assignment: str, username: str) -> str:
    """Canonical student-repo name. Cross-binary contract — mirrors
    `assignmentRepoName` in cli/gh-student/accept.go; changing the shape here
    without updating Go silently breaks the collect loop."""
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



# Due-date / lateness ---------------------------------------------------------


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
    """Raised when the latest submit release has no result.json asset."""


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
        normalized[slug] = {"type": atype, "entries": entries}
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
    # Re-parse to catch silent corruption (e.g. NaN in a score) before touching
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
        # A group re-collect that drops a previously-credited member (e.g. a
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
                f"drop is intended (e.g. an unenrollment) and not a team-vs-roster "
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
    one (case-insensitive), i.e. teammates whose shared credit a re-collect
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
    """
    if not isinstance(payload, dict):
        raise ValueError(f"top-level value must be an object, got {type(payload).__name__}")
    if payload.get("schema") != RESULT_SCHEMA_V1:
        raise ValueError(f"schema = {payload.get('schema')!r}, want {RESULT_SCHEMA_V1!r}")

    classroom = payload.get("classroom")
    if classroom != expected_classroom:
        raise ValueError(f"classroom = {classroom!r}, want {expected_classroom!r}")

    assignment = payload.get("assignment")
    if assignment != expected_assignment:
        raise ValueError(f"assignment = {assignment!r}, want {expected_assignment!r}")

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


def all_submit_releases(
    api_url: str, owner: str, repo: str, token: str
) -> list[dict[str, Any]]:
    """Every submit-tag release for a repo, newest first, walking the full
    /releases pagination — the complete submission history (a student who pushed
    N times has N submit/* releases, all returned). Non-submit releases (e.g. a
    hand-created tag) are filtered out. A 404 (no releases, or repo not
    accepted) yields an empty list.

    Pagination follows GitHub's `Link: rel="next"` header (host-pinned to
    api_url so the token can't be pivoted off-host), falling back to the
    short-page heuristic when no Link header is present — mirrors
    list_repo_collaborator_logins.
    """
    per_page = 100
    max_pages = 100
    releases: list[dict[str, Any]] = []
    url = f"{_repo_url(api_url, owner, repo)}/releases?per_page={per_page}&page=1"
    seen_next: set[str] = set()
    for page in range(1, max_pages + 1):
        try:
            body, headers = _http_get_with_headers(
                url, token, accept="application/vnd.github+json"
            )
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return []
            raise
        batch = json.loads(body.decode("utf-8"))
        if not isinstance(batch, list):
            raise ValueError(f"GET {url}: expected JSON array, got {type(batch).__name__}")
        for i, release in enumerate(batch):
            if not isinstance(release, dict):
                raise ValueError(
                    f"GET {url}: expected release object at index {i}, got {type(release).__name__}"
                )
            if (release.get("tag_name") or "").startswith(SUBMIT_TAG_PREFIX):
                releases.append(release)
        link_header = headers.get("Link") if headers else None
        next_url = _next_page_link(link_header)
        if next_url:
            next_url = _assert_same_host(next_url, api_url)
            if next_url in seen_next:
                return releases
            seen_next.add(next_url)
            url = next_url
            continue
        if link_header or len(batch) < per_page:
            return releases
        url = f"{_repo_url(api_url, owner, repo)}/releases?per_page={per_page}&page={page + 1}"
    raise ValueError(
        f"repos/{owner}/{repo}/releases: too many releases to enumerate "
        f"(hit the {max_pages}-page cap)"
    )


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


def _paginate_login_list(
    page_url: Callable[[int], str],
    api_url: str,
    token: str,
    resource_label: str,
) -> list[str]:
    """Walk a paginated GitHub list-of-accounts endpoint, returning every
    `login`. Shared core for list_repo_collaborator_logins and
    list_team_member_logins — the only per-caller differences are the URL
    builder and the cap-error label.

    `page_url(page)` builds the request URL for a 1-based page (caller owns
    per_page/page formatting). Only the first page uses it; subsequent pages
    follow GitHub's `Link: rel="next"`, host-pinned via _assert_same_host so a
    crafted Link can't pivot the token. When no Link header is present, falls
    back to page+1 and stops on a short page (len < per_page). A self/looping
    rel="next" is bounded by seen_next.

    Raises urllib.error.HTTPError on any non-2xx (including 404) so the caller
    can choose soft fallback vs. hard failure; raises ValueError on a non-array
    body or on hitting the page cap.
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
            # Stop if the server points back at an already-fetched page
            # (self/looping rel="next"): bounds a crafted or buggy Link chain
            # to the pages actually seen instead of running out the cap.
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
    them, crediting only the owner. Non-student instructors/TAs/org-owners are
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
    return _paginate_login_list(
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
    return _paginate_login_list(
        page_url=lambda page: f"{base}?per_page={per_page}&page={page}",
        api_url=api_url,
        token=token,
        resource_label=f"orgs/{org}/teams/{team_slug}/members",
    )


def group_member_usernames(
    api_url: str, org: str, repo: str, owner_username: str, token: str, roster_logins: set[str]
) -> list[str]:
    """Member list for a group submission: the repo's collaborators (any
    permission) **intersected with the classroom team** (case-insensitive),
    sorted and deduped, owner guaranteed present. Crediting is gated on team
    membership, NOT collaborator permission: a teammate on the classroom team is
    credited whether push or admin (an org owner is admin everywhere; a founder
    is kept admin to invite). A collaborator not on the team (instructor, TA,
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
    """
    try:
        return group_member_usernames(api_url, org, repo, owner_username, token, roster_logins), None
    except urllib.error.HTTPError as exc:
        return [owner_username], (
            f"{org}/{repo}: could not read group collaborators "
            f"(HTTP {exc.code} {exc.reason or 'no reason'}); crediting the "
            f"repo owner {owner_username!r} only. Ensure CLASSROOM50_SERVICE_TOKEN "
            f"can read repository collaborators (see the service-token wiki)."
        )
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
    if not matches:
        raise AssetMissingError(f"{RESULT_ASSET_NAME} asset missing from latest submit release")
    if len(matches) > 1:
        raise ValueError(f"latest submit release has {len(matches)} {RESULT_ASSET_NAME} assets")

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
    """GET `url` with bearer auth; return (body, response headers). Retries
    5xx/429 with exponential backoff. The custom redirect handler strips
    Authorization before following GitHub's asset-download redirect to S3
    (otherwise the signed URL rejects the forwarded token).

    Headers are returned so paginated callers can follow GitHub's `Link:
    rel="next"` rather than guessing the next page from page length.
    """
    for attempt in range(_retries):
        req = urllib.request.Request(
            url,
            method="GET",
            headers={
                "Accept": accept,
                "Authorization": f"Bearer {token}",
                "User-Agent": "classroom50-collect-scores",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with _OPENER.open(req, timeout=30) as resp:
                body = resp.read(max_bytes) if max_bytes is not None else resp.read()
                return body, resp.headers
        except urllib.error.HTTPError as exc:
            if exc.code in (429, 500, 502, 503, 504) and attempt < _retries - 1:
                # Honor Retry-After (capped at 30s); else exp backoff.
                retry_after = exc.headers.get("Retry-After") if exc.headers else None
                delay = min(int(retry_after), 30) if (retry_after or "").isdigit() else 2 ** attempt
                time.sleep(delay)
                continue
            raise
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            # A connect-phase failure is wrapped in URLError, but a timeout/reset
            # during resp.read() raises socket.timeout (= TimeoutError, an
            # OSError) which is NOT a URLError — so a stalled response body would
            # otherwise escape this retry path and crash past main()'s HTTPError
            # handler. Catch all three so a read-phase stall retries and wraps
            # into the synthetic 599 that is_hard_http_error treats as hard.
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
    raise RuntimeError(f"_http_get_with_headers called with _retries={_retries}")


def is_hard_http_error(exc: urllib.error.HTTPError) -> bool:
    """Hard failures that should fail the whole run: 401/403 (bad/under-scoped
    token) and 599 (synthetic "network unavailable" after retries). Treating
    these as per-student "not submitted" would make a broken run report success
    while collecting nothing.
    """
    return exc.code in (401, 403, 599)


# Workflow-command output -----------------------------------------------------


def emit_error(message: str) -> None:
    print(f"::error::{message}", file=sys.stderr)


def emit_warning(message: str) -> None:
    print(f"::warning::{message}", file=sys.stderr)


# Entry point ----------------------------------------------------------------


if __name__ == "__main__":
    sys.exit(main())
