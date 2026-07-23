#!/usr/bin/env python3
"""Teacher-triggered service-token probe.

Exercises EVERY GitHub API scope the CLASSROOM50_SERVICE_TOKEN needs, so a
teacher runs one workflow after provisioning/rotating and gets a single
green/red signal covering scopes the pre-provisioning validators (`gh teacher
init` / the web "validate & save") can't cheaply check — the org-team read and
the repo-level Actions permission that only surface at collect/regrade time.

SIDE-EFFECT FREE by design. Never pushes a tag, re-runs a workflow, writes a
secret, or mutates a repo. Write scopes are proven with read-only PROXIES that
GitHub gates behind the write permission:

  - Contents: write  -> GET /repos/{org}/classroom50 reports
                        `permissions.push == true` only with contents-write
                        (same signal the CLI/web validators use).
  - Administration: write -> the same GET reports `permissions.admin == true`
                        only with the Administration permission (collect grants
                        staff teams repo access via PUT teams/.../repos/...).
  - Actions:  write  -> GET /repos/{org}/classroom50/actions/permissions is
                        reachable only with the Actions permission; a
                        fine-grained PAT's Actions permission is a single
                        read/write pair, so reachability establishes the grant
                        regrade's rerun API needs. No run is re-run.

Scope -> probe (mirrors the wiki REST table):
  Organization Members: R   -> GET /orgs/{org}/members      (+ per-team read)
  Repository Contents: R    -> GET /repos/{org}/classroom50 (config repo)
  Repository Contents: W    -> permissions.push on the config repo
  Repository Administration: W -> permissions.admin on the config repo
  Repository Actions:  R/W  -> GET /repos/{org}/classroom50/actions/permissions
  Repository Metadata: R    -> GET /repos/{org}/classroom50/collaborators

Config + org scopes are ALWAYS probed. Per-classroom, the probe also reads the
classroom team's members (the exact call collect-scores makes), which exercises
team VISIBILITY — a secret team the token can't see 404/403s here even when the
org-members proxy passes. It additionally reads each STAFF team (classroom.json
`teams`, e.g., `classroom50-<short>-ta`) the collect-time grant targets, so a
secret/invisible staff team fails RED here rather than silently granting TAs no
access at cron. A team that doesn't exist yet (404) is a PASS with a note (an
early-term classroom legitimately has no team), never a failure.

Environment (set by `probe-token.yaml`):
  CLASSROOM50_SERVICE_TOKEN — the fine-grained PAT to probe.
  GITHUB_REPOSITORY_OWNER   — org name (auto-set by Actions).
  GITHUB_WORKSPACE          — checkout root (holds the per-classroom dirs).
  GITHUB_API_URL            — API URL on GHES runners.
  GH_API_URL                — explicit override (test servers).

Exit codes:
  0 — every required scope present (a per-classroom team read may be skipped
      with a note when the team doesn't exist yet).
  1 — at least one required scope missing, or the token is invalid/expired.
"""

from __future__ import annotations

import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

# Config repo name. Cross-binary contract — mirrors ConfigRepoName in
# cli/gh-teacher/internal/configrepo and the collect/regrade scripts.
CONFIG_REPO = "classroom50"

# Schema sentinel for a classroom.json — keep aligned with collect_scores.py.
CLASSROOM_SCHEMA_V1 = "classroom50/classroom/v1"


# GitHub API transport --------------------------------------------------------


def _api_url() -> str:
    return (
        os.environ.get("GH_API_URL")
        or os.environ.get("GITHUB_API_URL")
        or "https://api.github.com"
    ).rstrip("/")


def http_get(url: str, token: str, *, _retries: int = 3) -> tuple[int, bytes]:
    """GET `url` with bearer auth. Returns (status, body) for a 2xx; raises
    urllib.error.HTTPError for a non-2xx so callers can classify. Retries
    5xx/429 with exponential backoff (honoring Retry-After), mirroring the
    collect/regrade transport. The token lives only in the Authorization header
    — never logged or interpolated into output."""
    for attempt in range(_retries):
        req = urllib.request.Request(
            url,
            method="GET",
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {token}",
                "User-Agent": "classroom50-probe-token",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status, resp.read()
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
                url=url, code=599, msg=f"network error: {exc}", hdrs=None, fp=None  # type: ignore[arg-type]
            ) from exc
    raise RuntimeError(f"http_get called with _retries={_retries}")


def _repo_url(api_url: str, owner: str, repo: str) -> str:
    return (
        f"{api_url}/repos/{urllib.parse.quote(owner, safe='')}/"
        f"{urllib.parse.quote(repo, safe='')}"
    )


# Individual scope checks -----------------------------------------------------
#
# Each returns a Check: ok True/False and a human message. A check that can't
# run for a benign reason (no student repos yet) is `skipped` — a pass with a
# note, not a failure.


class Check:
    __slots__ = ("name", "ok", "skipped", "message")

    def __init__(self, name: str, ok: bool, message: str, *, skipped: bool = False):
        self.name = name
        self.ok = ok
        self.skipped = skipped
        self.message = message


def _classify_repo_read(exc: urllib.error.HTTPError) -> str:
    """Short human cause for a failed repo/org read."""
    if exc.code == 401:
        return "token is invalid, expired, or revoked (401)"
    if exc.code in (403, 404):
        return f"HTTP {exc.code} — the scope is missing or the resource is out of the token's reach"
    return f"HTTP {exc.code} ({exc.reason or 'no reason'})"


def check_config_contents_and_write(api_url: str, org: str, token: str) -> list[Check]:
    """Contents: Read (config repo readable), Contents: Write
    (permissions.push true), AND Administration: Write (permissions.admin true —
    collect grants staff teams repo access). One request establishes all three."""
    url = _repo_url(api_url, org, CONFIG_REPO)
    try:
        _status, body = http_get(url, token)
    except urllib.error.HTTPError as exc:
        cause = _classify_repo_read(exc)
        return [
            Check("Contents: Read (config repo)", False, f"GET {org}/{CONFIG_REPO}: {cause}"),
            Check("Contents: Write (config repo)", False, "not checked — the config-repo read failed above"),
            Check("Administration: Write (config repo)", False, "not checked — the config-repo read failed above"),
        ]
    try:
        repo = json.loads(body.decode("utf-8"))
    except (json.JSONDecodeError, ValueError) as exc:
        return [
            Check("Contents: Read (config repo)", False, f"GET {org}/{CONFIG_REPO}: malformed JSON ({exc})"),
            Check("Contents: Write (config repo)", False, "not checked — the config-repo read failed above"),
            Check("Administration: Write (config repo)", False, "not checked — the config-repo read failed above"),
        ]
    permissions = repo.get("permissions") if isinstance(repo, dict) else None
    permissions = permissions if isinstance(permissions, dict) else {}
    push = bool(permissions.get("push"))
    admin = bool(permissions.get("admin"))
    return [
        Check("Contents: Read (config repo)", True, f"{org}/{CONFIG_REPO} is readable"),
        Check(
            "Contents: Write (config repo)",
            push,
            "permissions.push is true (regrade can push submit/* tags)"
            if push
            else "permissions.push is false — the token is read-only; regrade needs Contents: Read and write",
        ),
        Check(
            "Administration: Write (config repo)",
            admin,
            "permissions.admin is true (collect can grant staff teams repo access) — "
            "note this proves admin on the config repo only; the grant targets student "
            "repos + templates, so the token must be scoped to All repositories"
            if admin
            else "permissions.admin is false — collect grants staff teams (e.g., TAs) repo access, which needs Administration: Read and write",
        ),
    ]


def check_actions(api_url: str, org: str, token: str) -> Check:
    """Actions: Read/Write — GET .../actions/permissions is reachable only with
    the Actions permission (a fine-grained Actions permission is a single
    read/write pair, so reachability establishes the grant regrade's rerun API
    needs). Read-only: no run is re-run."""
    url = f"{_repo_url(api_url, org, CONFIG_REPO)}/actions/permissions"
    try:
        http_get(url, token)
    except urllib.error.HTTPError as exc:
        return Check(
            "Actions: Read and write (config repo)",
            False,
            f"GET {org}/{CONFIG_REPO}/actions/permissions: {_classify_repo_read(exc)} — "
            f"regrade re-runs student autograde workflows and needs Actions: Read and write",
        )
    return Check(
        "Actions: Read and write (config repo)",
        True,
        "actions/permissions is reachable (regrade can re-run autograde workflows)",
    )


def check_metadata(api_url: str, org: str, token: str) -> Check:
    """Metadata: Read — /collaborators is a Metadata endpoint, what group
    attribution reads. Metadata is auto-included on every fine-grained PAT, so
    this is expected to pass; a failure means the token is scoped to the wrong
    resource owner or a repo subset."""
    url = f"{_repo_url(api_url, org, CONFIG_REPO)}/collaborators?per_page=1"
    try:
        http_get(url, token)
    except urllib.error.HTTPError as exc:
        return Check(
            "Metadata: Read (collaborators)",
            False,
            f"GET {org}/{CONFIG_REPO}/collaborators: {_classify_repo_read(exc)} — "
            f"group attribution reads repo collaborators via Metadata: Read",
        )
    return Check(
        "Metadata: Read (collaborators)",
        True,
        "repo collaborators are readable (group attribution works)",
    )


def check_org_members(api_url: str, org: str, token: str) -> Check:
    """Members: Read — GET /orgs/{org}/members. The org-wide proxy for the
    per-team read collect-scores makes; both need the same Members permission.
    The per-classroom team read below is the stronger, exact check."""
    url = f"{api_url}/orgs/{urllib.parse.quote(org, safe='')}/members?per_page=1"
    try:
        http_get(url, token)
    except urllib.error.HTTPError as exc:
        return Check(
            "Members: Read (org members)",
            False,
            f"GET orgs/{org}/members: {_classify_repo_read(exc)} — "
            f"collection is team-driven and lists the classroom team; add "
            f"Organization permissions -> Members: Read",
        )
    return Check(
        "Members: Read (org members)",
        True,
        "org members are listable (collection can read the classroom team)",
    )


# Per-classroom checks --------------------------------------------------------


def resolve_team_slug(classroom_meta: dict[str, Any], classroom_short: str) -> str:
    """The classroom's GitHub team slug — persisted `team.slug` when present,
    else the derived `classroom50-<short>`. Mirrors collect_scores.py's
    resolve_team_slug so the probe reads the EXACT team collection reads."""
    team = classroom_meta.get("team")
    if isinstance(team, dict):
        slug = team.get("slug")
        if isinstance(slug, str) and slug.strip():
            return slug.strip()
    return f"classroom50-{classroom_short}"


def resolve_staff_team_slugs(classroom_meta: dict[str, Any]) -> dict[str, str]:
    """role -> slug for each staff team present in classroom.json `teams`.
    Mirrors collect_scores.py's resolve_staff_team_slugs so the probe reads the
    EXACT staff teams the grant pass targets."""
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


def iter_classroom_meta(base_dir: pathlib.Path):
    """Yield (short_name, classroom_meta) for each v1 classroom dir. Non-v1 or
    unreadable dirs are skipped silently (the probe is about the token, not the
    config's validity — collect-scores validates that)."""
    if not base_dir.is_dir():
        return
    for entry in sorted(p for p in base_dir.iterdir() if p.is_dir()):
        classroom_path = entry / "classroom.json"
        if not classroom_path.is_file():
            continue
        try:
            meta = json.loads(classroom_path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(meta, dict) and meta.get("schema") == CLASSROOM_SCHEMA_V1:
            yield entry.name, meta


def check_classroom_team(
    api_url: str, org: str, token: str, classroom_short: str, team_slug: str
) -> Check:
    """The EXACT read collect-scores makes: GET the classroom team's members.
    Stronger than the org-members proxy because it also exercises team
    VISIBILITY (a secret team not visible to the token would 404/403 here even
    when the org-members proxy passes — the visibility-asymmetry gap)."""
    url = (
        f"{api_url}/orgs/{urllib.parse.quote(org, safe='')}/teams/"
        f"{urllib.parse.quote(team_slug, safe='')}/members?per_page=1"
    )
    try:
        http_get(url, token)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            # The team may not exist yet (classroom created but team not
            # provisioned), which is not a token problem — note and pass.
            return Check(
                f"Team members: {classroom_short} ({team_slug})",
                True,
                "team not found (404) — not created yet, or renamed; not a token scope problem",
                skipped=True,
            )
        return Check(
            f"Team members: {classroom_short} ({team_slug})",
            False,
            f"GET orgs/{org}/teams/{team_slug}/members: {_classify_repo_read(exc)} — "
            f"the token can't read this classroom team (Members: Read, and the team must be visible)",
        )
    return Check(
        f"Team members: {classroom_short} ({team_slug})",
        True,
        "classroom team members are readable",
    )


def check_staff_team_visible(
    api_url: str, org: str, token: str, classroom_short: str, role: str, team_slug: str
) -> Check:
    """Staff-team visibility for the collect-time grant. `PUT .../teams/{slug}/
    repos/...` needs the token to SEE the team — a scope the config-repo admin
    check can't prove. Without this probe, a secret/invisible staff team passes
    every other check, then the grant soft-skips its 404 and TAs silently get NO
    access while the run reports success. Reading the team's members is the same
    visibility proxy used for the student team, against the exact grant slug."""
    url = (
        f"{api_url}/orgs/{urllib.parse.quote(org, safe='')}/teams/"
        f"{urllib.parse.quote(team_slug, safe='')}/members?per_page=1"
    )
    label = f"Staff team visible: {classroom_short} {role} ({team_slug})"
    try:
        http_get(url, token)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            # Staff team not provisioned yet (or renamed) — not a token problem,
            # and the grant simply skips a role whose team is absent.
            return Check(
                label,
                True,
                "staff team not found (404) — not created yet, or renamed; not a token scope problem",
                skipped=True,
            )
        return Check(
            label,
            False,
            f"GET orgs/{org}/teams/{team_slug}/members: {_classify_repo_read(exc)} — "
            f"the grant can't see this staff team, so it would silently grant TAs no "
            f"access (Members: Read, and the team must be visible to the token)",
        )
    return Check(
        label,
        True,
        "staff team is visible (the collect-time grant can target it)",
    )


# Workflow-command output -----------------------------------------------------


def emit_error(message: str) -> None:
    print(f"::error::{message}", file=sys.stderr)


def emit_notice(message: str) -> None:
    print(f"::notice::{message}", file=sys.stderr)


def print_check(check: Check) -> None:
    if check.skipped:
        mark = "SKIP"
    elif check.ok:
        mark = "PASS"
    else:
        mark = "FAIL"
    print(f"  [{mark}] {check.name}: {check.message}")


# Top-level dispatch ----------------------------------------------------------


def main() -> int:
    org = (os.environ.get("GITHUB_REPOSITORY_OWNER") or "").strip()
    if not org:
        emit_error(
            "GITHUB_REPOSITORY_OWNER is empty — this script must run inside a GitHub Actions workflow"
        )
        return 1

    token = (os.environ.get("CLASSROOM50_SERVICE_TOKEN") or "").strip()
    if not token:
        emit_error(
            "CLASSROOM50_SERVICE_TOKEN is empty — run `gh teacher rotate-service-token <org>` to provision it"
        )
        return 1

    api_url = _api_url()
    base_dir = pathlib.Path(os.environ.get("GITHUB_WORKSPACE") or ".").resolve()

    checks: list[Check] = []

    print("Probing org- and config-repo-level scopes:")
    org_scope_checks = [
        check_org_members(api_url, org, token),
        *check_config_contents_and_write(api_url, org, token),
        check_actions(api_url, org, token),
        check_metadata(api_url, org, token),
    ]
    for check in org_scope_checks:
        print_check(check)
    checks.extend(org_scope_checks)

    # Per-classroom: read the exact team collect-scores reads. Catches the
    # team-visibility gap the org-members proxy can miss.
    classrooms = list(iter_classroom_meta(base_dir))
    if classrooms:
        print("\nProbing per-classroom team reads:")
        for classroom_short, meta in classrooms:
            team_slug = resolve_team_slug(meta, classroom_short)
            check = check_classroom_team(api_url, org, token, classroom_short, team_slug)
            print_check(check)
            checks.append(check)
            # Probe each staff team the grant targets (see check_staff_team_visible).
            for role, staff_slug in resolve_staff_team_slugs(meta).items():
                staff_check = check_staff_team_visible(
                    api_url, org, token, classroom_short, role, staff_slug
                )
                print_check(staff_check)
                checks.append(staff_check)
    else:
        print("\nNo classrooms found in the config repo yet — skipping per-team reads.")

    failed = [c for c in checks if not c.ok and not c.skipped]
    passed = [c for c in checks if c.ok and not c.skipped]
    skipped = [c for c in checks if c.skipped]

    print(
        f"\nprobe-token: {len(passed)} passed, {len(failed)} failed, "
        f"{len(skipped)} skipped"
    )

    if failed:
        emit_error(
            f"service token probe FAILED: {len(failed)} scope check(s) did not pass "
            f"({', '.join(c.name for c in failed)}). Re-create the fine-grained PAT with "
            f"Contents: Read and write, Actions: Read and write, Administration: Read and "
            f"write, and Organization -> Members: Read, then "
            f"`gh teacher rotate-service-token {org}`."
        )
        return 1

    emit_notice(
        f"service token probe PASSED: all {len(passed)} required scope check(s) present"
        + (f" ({len(skipped)} skipped as not-applicable)" if skipped else "")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
