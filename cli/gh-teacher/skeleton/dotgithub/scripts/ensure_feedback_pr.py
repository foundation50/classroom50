#!/usr/bin/env python3
"""classroom50 Feedback PR maintainer.

Fetched from the teacher's Pages site by the autograde-runner workflow's
"Ensure Feedback PR" step (like runner.py). Lives here (not inline in the
workflow) so the ~160 lines of control flow are unit-testable with a stubbed
`gh`; the workflow step is a thin curl+exec shim.

Opt-in per assignment (the workflow only invokes this when feedback-pr is on
and there's a diff). Maintains ONE long-lived PR per repo:
  base = the frozen `feedback` branch at the baseline commit
  head = the repo's default branch
so the teacher reviews the full starter->latest diff with inline comments, and
it auto-updates on every submission. PRs opened by GITHUB_TOKEN don't retrigger
workflows, so there's no loop.

Since issue #228 the accept clients (gh student accept / the web GUI) create
the PR at accept time with the student's own token — same base/head, title,
labels, and body (byte-mirrored via cli/shared/contract) — so it exists even
with Actions disabled. find_pr matches by base+head only, so this script
ADOPTS that PR; this create path remains the fallback for pre-feature repos
and accepts whose best-effort PR step failed.

Behavior (ported verbatim from the former inline bash):
  1. Freeze the base: create the `feedback` branch at BASE_SHA once, never
     advance it. If it already exists at a DIFFERENT sha, a student may have
     pre-created it (ruleset leaves creation open) -> refuse to open/refresh the
     PR against an unverified base, post a failure status, and stop.
  2. Find the single PR (any state). If none, create it (labeled by mode); on a
     create race lost to a concurrent run, re-query and treat the existing PR as
     success. If one exists, reopen only a student's *unmerged* close (a teacher
     merge is the grading-done signal).
  3. Always post a machine-readable `classroom50/feedback-pr` commit status
     (success | failure | error), mirroring `classroom50/autograde`. It defaults
     to `error` and is promoted to `success` only at the verified-good end, so
     an early failure reports error, not false success.

Environment (set by the autograde-runner workflow's grade job):
  GH_TOKEN            token for `gh` (Actions GITHUB_TOKEN)
  GITHUB_REPOSITORY   <owner>/<repo>
  GITHUB_SHA          graded commit SHA (the status target)
  GITHUB_SERVER_URL   https://github.com (or GHES base)
  GITHUB_RUN_ID       for the fallback status target_url
  BASE_SHA            the trusted baseline commit to freeze the base at
  MODE                assignment mode (individual | group), for the PR label
  FEEDBACK_PR_TEMPLATE  "true" when the assignment opts the Feedback PR body
                        into the template repo's pull_request_template.md
  TEMPLATE_REPO         <owner>/<repo> of the assignment's template (for the
                        template-body read; empty when template-less)
  TEMPLATE_BRANCH       the template branch to read the PR-body file from

Exits 0 for every outcome (like runner.py): the status carries success vs
failure vs error. Exits non-zero only on missing required env (invoked outside
the workflow).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

# Lockstep with cli/gh-teacher/init_repo.go `feedbackBaseBranch` and the
# `classroom50-feedback-base-lock` org ruleset (pinned by a Go parity test).
BASE_BRANCH = "feedback"

# Commit-status context, mirroring classroom50/autograde so an agent can poll
# whether the Feedback PR is in place.
STATUS_CONTEXT = "classroom50/feedback-pr"

# Mode -> (PR label, color). Mirrors GitHub Classroom's Individual/Group
# feedback labels so a teacher can tell them apart.
_LABELS = {
    "group": ("Group Assignment", "5319E7"),
    "individual": ("Individual Assignment", "0E8A16"),
}


class GhError(Exception):
    """A `gh` invocation exited non-zero. Carries combined output for logs."""

    def __init__(self, args: list[str], returncode: int, output: str):
        super().__init__(f"gh {' '.join(args)} exited {returncode}: {output}")
        self.args_list = args
        self.returncode = returncode
        self.output = output


def gh(*args: str, check: bool = True) -> str:
    """Run `gh` and return stdout (stripped). The single seam tests stub.

    On a non-zero exit, raises GhError when check=True (carrying stderr), else
    returns "". A subprocess timeout is converted to a GhError so callers treat
    it uniformly rather than crashing past the "always exit 0" contract. `gh`
    reads GH_TOKEN from env.
    """
    try:
        proc = subprocess.run(
            ["gh", *args],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except subprocess.SubprocessError as exc:  # TimeoutExpired, etc.
        if check:
            raise GhError(list(args), -1, f"gh invocation failed: {exc}") from exc
        return ""
    if proc.returncode != 0:
        if check:
            raise GhError(list(args), proc.returncode, (proc.stderr or proc.stdout).strip())
        return ""
    return proc.stdout.strip()


# ---------------------------------------------------------------------------
# Pure-ish helpers (each wraps one gh call; tests stub `gh`)
# ---------------------------------------------------------------------------


def head_branch(repo: str) -> str:
    """The repo's default branch (the Feedback PR head)."""
    return gh("repo", "view", repo, "--json", "defaultBranchRef",
              "--jq", ".defaultBranchRef.name")


def existing_base_sha(repo: str) -> str | None:
    """SHA the `feedback` branch points at, or None if it doesn't exist.

    Uses the API (not `git ls-remote`) so this runs without a config-repo
    checkout — the reusable workflow only checks out the student repo.

    A genuine 404 (branch absent) returns None -> caller creates it. Any OTHER
    failure (403/429/5xx/network) RAISES GhError rather than masquerading as
    "absent": treating an unreadable base as absent would let the caller open a
    PR over a base it couldn't verify, defeating the poisoned-base guard (a
    student can pre-create the branch at a wrong SHA).
    """
    try:
        out = gh("api", f"repos/{repo}/git/ref/heads/{BASE_BRANCH}",
                 "--jq", ".object.sha")
    except GhError as exc:
        # `gh api` exits 1 on any HTTP error; distinguish 404 (absent) from the
        # rest via the error text gh prints (it includes "HTTP 404").
        if "HTTP 404" in exc.output or "Not Found" in exc.output:
            return None
        raise
    return out or None


def create_base(repo: str, base_sha: str) -> bool:
    """Create the frozen `feedback` branch at base_sha. Returns True on success.
    A failure is non-fatal (logged as a notice) — the ruleset leaves creation
    open to GITHUB_TOKEN, but a transient error shouldn't abort; the next
    submission retries."""
    try:
        gh("api", "-X", "POST", f"repos/{repo}/git/refs",
           "-f", f"ref=refs/heads/{BASE_BRANCH}", "-f", f"sha={base_sha}")
        return True
    except GhError as exc:
        print(f"::notice::could not create feedback-base at {base_sha}: {exc.output}")
        return False


def find_pr(repo: str, head: str) -> dict[str, str] | None:
    """The single base<-head PR (any state) as {number, state, mergedAt}, or
    None. Matching any state means a previously closed/merged PR is never
    duplicated.

    Parses the JSON array directly (not a @tsv line): a tab-joined row is
    fragile because an empty leading field (no PR number) survives gh's output
    but is lost to strip()+split, fabricating a phantom PR. JSON is unambiguous.
    """
    out = gh("pr", "list", "--repo", repo,
             "--base", BASE_BRANCH, "--head", head, "--state", "all",
             "--json", "number,state,mergedAt", check=False)
    if not out:
        return None
    try:
        rows = json.loads(out)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(rows, list) or not rows or not isinstance(rows[0], dict):
        return None
    row = rows[0]
    number = row.get("number")
    if number is None or number == "":
        return None
    return {
        "number": str(number),
        "state": str(row.get("state") or ""),
        "mergedAt": str(row.get("mergedAt") or ""),
    }


def label_for_mode(mode: str) -> tuple[str, str]:
    """(label, color) for the assignment mode; unknown -> individual."""
    return _LABELS.get((mode or "").strip().lower(), _LABELS["individual"])


def pr_body(head: str, release_url: str) -> str:
    """The Feedback PR body (GitHub Classroom-style).

    release_url is the static `.../releases/latest` link (not a pinned tag), so
    it self-updates as new submissions publish even though this body is written
    once at PR creation and only refreshed to backfill a missing link.
    """
    return "\n".join([
        ":wave:! Classroom 50 opened this pull request as a place for your "
        "teacher to leave feedback on your work. It stays up to date "
        "automatically as you push. "
        "**Don't close or merge this pull request** unless your teacher tells you to.",
        "",
        f"Each commit is automatically graded — the latest autograding result "
        f"is [here]({release_url}).",
        "",
        "Your teacher can leave comments and feedback on your code here. Click "
        "the **Subscribe** button to be notified when that happens.",
        "",
        f"Open the **Files changed** or **Commits** tab to see everything "
        f"you've pushed to `{head}` since you accepted the assignment — your "
        f"teacher sees the same view.",
        "",
        "<details>",
        "<summary><strong>Notes for teachers</strong></summary>",
        "",
        "Use this PR to leave feedback:",
        "",
        f"- **Files changed** shows the full diff on `{head}` since the student "
        f"accepted. Hover a line and click the blue **+** to leave a line comment.",
        "- **Commits** lists each pushed commit; open one to see its changes.",
        "- Autograde results appear as the `classroom50/autograde` commit "
        "status / check on each submission.",
        f"- The [latest autograding result]({release_url}) has the per-test "
        f"detail behind that status.",
        "- This page is an overview — commits, line comments, and a general "
        "comment box below.",
        "",
        f"The base branch (`{BASE_BRANCH}`) is frozen at the starter so the diff "
        f"always reflects the full body of work. The PR is kept up to date "
        f"automatically; merging it is the teacher-side "
        f"\"grading done\" signal.",
        "</details>",
    ])


def create_pr(repo: str, head: str, mode: str, body: str) -> str:
    """Create the Feedback PR with the given body, returning its URL.
    Best-effort labels it first. Raises GhError on a create failure (caller
    handles the race)."""
    label, color = label_for_mode(mode)
    # Best-effort label; never block PR creation on label setup.
    gh("label", "create", label, "--repo", repo, "--color", color,
       "--description", "Classroom 50 teacher-managed feedback PR", check=False)
    return gh("pr", "create", "--repo", repo,
              "--base", BASE_BRANCH, "--head", head,
              "--title", "Feedback", "--body", body,
              "--label", label)


def existing_pr_url(repo: str, head: str) -> str:
    """URL of the existing base<-head PR (any state), or "". Used to
    recover from a lost create race."""
    return gh("pr", "list", "--repo", repo, "--base", BASE_BRANCH,
              "--head", head, "--state", "all", "--json", "url",
              "--jq", "(.[0] // {}).url // \"\"", check=False)


# Native GitHub pull request template paths, probed in this order. Mirrors the
# accept clients (cli/gh-student/feedback_pr.go, web feedbackPr.ts).
_TEMPLATE_PR_BODY_PATHS = (
    ".github/pull_request_template.md",
    "pull_request_template.md",
    "docs/pull_request_template.md",
)

# Cap the template read so an oversized/binary file can't blow up the PR
# create (GitHub caps a PR body near 65_536 chars); over-limit falls back to
# the built-in body, like a missing file.
_TEMPLATE_PR_BODY_MAX_BYTES = 60_000


def read_template_pr_body(template_repo: str, template_branch: str) -> str | None:
    """The teacher-supplied PR body from the template repo, or None.

    Reads the first existing of the native pull_request_template.md paths from
    template_repo at template_branch, VERBATIM (no placeholder substitution).
    Best-effort: a missing file, an empty-after-trim file, an over-size file,
    or any read error (403 on a private template the runner token can't read,
    5xx, timeout) returns None so the caller falls back to the built-in body.
    """
    if not (template_repo and template_branch):
        return None
    for path in _TEMPLATE_PR_BODY_PATHS:
        content = gh("api",
                     f"repos/{template_repo}/contents/{path}",
                     "-H", "Accept: application/vnd.github.raw+json",
                     "-f", f"ref={template_branch}", check=False)
        if not content:
            continue  # missing (404) or unreadable — try the next path
        if len(content.encode("utf-8")) > _TEMPLATE_PR_BODY_MAX_BYTES:
            print(f"::warning::template PR body {path} exceeds "
                  f"{_TEMPLATE_PR_BODY_MAX_BYTES} bytes; using the built-in body")
            return None
        if not content.strip():
            continue  # empty/whitespace-only — not a usable body
        return content
    return None


def resolve_pr_body(head: str, release_url: str, use_template: bool,
                    template_repo: str, template_branch: str) -> str:
    """The Feedback PR body to create: the teacher template when the assignment
    opted in (feedback_pr_template) and the template file is readable, else the
    built-in body. The runner token (Actions GITHUB_TOKEN) may be unable to
    read an external/private template, so this is best-effort by design."""
    if use_template:
        body = read_template_pr_body(template_repo, template_branch)
        if body is not None:
            return body
        # The assignment opted into the template but the runner token couldn't
        # read it (a private/external template the Actions GITHUB_TOKEN can't
        # reach, or the file is absent). Surface it so a teacher can see this
        # repo's Feedback PR diverges from the teacher-authored body the accept
        # clients use, and reconcile via `gh teacher assignment feedback-pr`.
        print(f"::warning::feedback_pr_template is set but the runner could not "
              f"read a pull request template from {template_repo or '(no template)'}; "
              f"using the built-in Feedback PR body for this repo")
    return pr_body(head, release_url)


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def ensure_feedback_pr(repo: str, base_sha: str, mode: str, server_url: str,
                       run_id: str, use_template: bool = False,
                       template_repo: str = "", template_branch: str = "",
                       ) -> tuple[str, str, str]:
    """Maintain the one Feedback PR. Returns (state, description, url) where
    state is success | failure | error.

    The runner ADOPTS an accept-time PR (find_pr matches by base+head) and never
    rewrites its body, so a teacher-supplied full-replace body survives. On the
    fallback create path (no PR exists) it honors the assignment settings: when
    use_template is set and the template file is readable it uses the teacher
    body, else the built-in body (best-effort — the runner token may not read an
    external/private template).
    """
    run_url = f"{server_url}/{repo}/actions/runs/{run_id}"
    # Static "latest" pointer (set-latest job keeps it current), not a pinned
    # submit-tag URL — the body is written once at creation, so a tag would go
    # stale but /releases/latest self-updates. See #262.
    release_url = f"{server_url}/{repo}/releases/latest"

    head = head_branch(repo)  # GhError here -> main() reports error (no false success)

    # 1) Freeze the base.
    existing = existing_base_sha(repo)
    if not existing:
        create_base(repo, base_sha)
    elif existing != base_sha:
        print(
            f"::warning::feedback-base ({BASE_BRANCH}) is at {existing}, not the "
            f"expected baseline {base_sha}; not opening/updating the Feedback PR. "
            f"If a student created this branch, an org admin should delete it so "
            f"the next submission re-freezes it correctly."
        )
        return ("failure",
                "feedback-base is at the wrong commit; an org admin must delete "
                "the 'feedback' branch",
                run_url)

    # 2) Find or create the single PR.
    pr = find_pr(repo, head)
    if pr is None:
        body = resolve_pr_body(head, release_url, use_template,
                               template_repo, template_branch)
        try:
            url = create_pr(repo, head, mode, body)
        except GhError as exc:
            # A concurrent run (submit/* tag vs main push use different
            # concurrency groups) can win the create race; re-query before
            # reporting the "org setting off" case.
            race_url = existing_pr_url(repo, head)
            if race_url:
                print("Feedback PR already present (created concurrently); nothing to do")
                return ("success", "Feedback PR in place (created concurrently)", race_url)
            print(f"::warning::could not open Feedback PR (base={BASE_BRANCH} head={head}): {exc.output}")
            print("::warning::if this reports that Actions is not permitted to create "
                  "pull requests, the org setting is off — re-run 'gh teacher init', or "
                  "enable Settings → Actions → 'Allow GitHub Actions to create and approve "
                  "pull requests'")
            return ("error",
                    "could not open Feedback PR (often: org Actions-PR setting off)",
                    run_url)
        print(f"Feedback PR opened: {url}")
        return ("success", "Feedback PR opened", url)

    # Existing PR: reopen only a student's unmerged close.
    url = f"{server_url}/{repo}/pull/{pr['number']}"
    if pr["state"] == "CLOSED" and not pr["mergedAt"]:
        # A failed reopen must NOT report success (F8). Trust `gh pr reopen`'s
        # own exit: if it raises, the reopen genuinely failed -> failure. If it
        # succeeds, a follow-up `pr view` only DOWNGRADES to failure when it
        # *confirms* the PR is still CLOSED — a transient/empty view is treated
        # as success, so a flaky read can't flip a reopened PR to a false failure.
        try:
            gh("pr", "reopen", pr["number"], "--repo", repo)
        except GhError as exc:
            print(f"::warning::could not reopen Feedback PR #{pr['number']}: {exc.output}")
            return ("failure", "could not reopen the closed Feedback PR", url)
        state_now = gh("pr", "view", pr["number"], "--repo", repo,
                       "--json", "state", "--jq", ".state", check=False)
        if state_now == "CLOSED":
            print(f"::warning::Feedback PR #{pr['number']} still CLOSED after reopen")
            return ("failure", "could not reopen the closed Feedback PR", url)
        print(f"Reopened Feedback PR #{pr['number']} (was closed unmerged)")
        return ("success", "Feedback PR reopened", url)

    # Adopt-only: never edit an existing body. The accept-time creator (or a
    # prior run) authored it; the runner leaves it untouched so a teacher
    # full-replace body survives. The release link self-updates, so a body
    # written once at creation needs no refresh.
    print(f"Feedback PR #{pr['number']} already present "
          f"(state={pr['state']} merged={pr['mergedAt'] or 'none'}); nothing to do")
    return ("success", "Feedback PR in place", url)


def emit_status(repo: str, sha: str, state: str, description: str, url: str) -> None:
    """Post the classroom50/feedback-pr commit status. Best-effort: a failed
    status POST is logged, never fatal (mirrors the former trap's `|| true`,
    but surfaced rather than silenced)."""
    try:
        gh("api", f"repos/{repo}/statuses/{sha}",
           "-f", f"state={state}", "-f", f"context={STATUS_CONTEXT}",
           "-f", f"description={description}", "-f", f"target_url={url}")
    except (GhError, OSError) as exc:
        # Last best-effort action; never let a status-POST failure (gh error,
        # timeout-as-GhError, missing gh binary) mask the real outcome.
        print(f"::warning::could not post {STATUS_CONTEXT} status: {exc}")


def main() -> int:
    repo = os.environ.get("GITHUB_REPOSITORY", "").strip()
    sha = os.environ.get("GITHUB_SHA", "").strip()
    base_sha = os.environ.get("BASE_SHA", "").strip()
    server_url = os.environ.get("GITHUB_SERVER_URL", "https://github.com").strip()
    run_id = os.environ.get("GITHUB_RUN_ID", "").strip()
    mode = os.environ.get("MODE", "").strip()
    # Feedback-PR-template opt-in (feedback_pr_template) + the template ref, so
    # the fallback create path can honor the assignment settings. All three come
    # from assignments.json via the setup job; absent/empty means "built-in body".
    use_template = os.environ.get("FEEDBACK_PR_TEMPLATE", "").strip().lower() == "true"
    template_repo = os.environ.get("TEMPLATE_REPO", "").strip()
    template_branch = os.environ.get("TEMPLATE_BRANCH", "").strip()

    if not (repo and sha and base_sha):
        print("::error::ensure_feedback_pr requires GITHUB_REPOSITORY, GITHUB_SHA, "
              "and BASE_SHA — running outside the autograde-runner workflow?",
              file=sys.stderr)
        return 1

    # Default to error so any uncaught failure reports error (never false
    # success), mirroring the former `trap emit_status EXIT` design.
    state, description = "error", "Feedback PR step did not complete"
    url = f"{server_url}/{repo}/actions/runs/{run_id}"
    try:
        state, description, url = ensure_feedback_pr(
            repo, base_sha, mode, server_url, run_id,
            use_template=use_template,
            template_repo=template_repo,
            template_branch=template_branch,
        )
    except GhError as exc:
        print(f"::warning::Feedback PR step failed: {exc}")
    finally:
        emit_status(repo, sha, state, description, url)
    return 0


if __name__ == "__main__":
    sys.exit(main())
