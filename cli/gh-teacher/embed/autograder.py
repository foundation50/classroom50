#!/usr/bin/env python3
"""classroom50 diagnostic-stub autograder.

Shipped inside `gh-teacher` and written to `<classroom>/autograder.py`
by `gh teacher autograder set-default <org> <classroom>` when no
`--from` is given. Useful for verifying that the runner pipeline,
runtime block, and Pages publishing are all wired up correctly
before authoring real grading logic.

The runner picks this stub when an assignment has no per-assignment
override at `<classroom>/autograders/<slug>/autograder.py`. Echoes
every env var the runner exposed (so teachers can confirm metadata
wires up correctly), writes a vacuous-pass `result.json` +
`release-body.md`, and exits 0.

To replace this stub with real grading logic, run:
  gh teacher autograder set-default <org> <classroom> --from <path>

Contract (see the Advanced-Autograding wiki page for full details):
  Reads env: CLASSROOM, ASSIGNMENT, ASSIGNMENT_TYPE, USERNAME, OWNER,
             SUBMISSION_TAG, COMMIT_URL, RELEASE_URL, REVIEW_URL,
             PAGES_BASE_URL, GITHUB_*
  Working dir: the student's repo checkout.
  Writes (in cwd):
    result.json       classroom50/result/v1 payload (REQUIRED). The runner
                      stamps owner + assignment_type (+ submitted_by)
                      authoritatively, so an autograder MAY omit them; this
                      stub sets them for clarity. There is no `usernames`
                      field.
    release-body.md   Markdown body for the GitHub Release (optional —
                      runner synthesizes from result.json if absent)
  Appends to $GITHUB_OUTPUT (optional — runner derives from
  result.json if absent):
    status=<success|failure|error>
    summary=<one-line description>
  Exit code:
    0  ran end-to-end (test pass/fail captured in result.json)
    !0 infrastructure failure (runner synthesizes status=error)
"""

from __future__ import annotations

import datetime
import json
import os
import pathlib

classroom = os.environ.get("CLASSROOM", "")
assignment = os.environ.get("ASSIGNMENT", "")
assignment_type = os.environ.get("ASSIGNMENT_TYPE", "") or "individual"
username = os.environ.get("USERNAME", "")
owner = os.environ.get("OWNER", "") or username
submission = os.environ.get("SUBMISSION_TAG", "")
commit_url = os.environ.get("COMMIT_URL", "")
release_url = os.environ.get("RELEASE_URL", "")
# REVIEW_URL is absent on older runners; fall back to the commit view.
review_url = os.environ.get("REVIEW_URL", "") or commit_url
pages_base_url = os.environ.get("PAGES_BASE_URL", "")
repository = os.environ.get("GITHUB_REPOSITORY", "")
sha = os.environ.get("GITHUB_SHA", "")
github_output = os.environ.get("GITHUB_OUTPUT")

# Echo metadata. The workflow log carries this verbatim, so a teacher
# debugging "did the runner pick up my classroom config?" can grep
# the log without writing any grading code yet.
print("=== classroom50 diagnostic-stub autograder ===")
print(f"  CLASSROOM         = {classroom}")
print(f"  ASSIGNMENT        = {assignment}")
print(f"  ASSIGNMENT_TYPE   = {assignment_type}")
print(f"  USERNAME          = {username}")
print(f"  OWNER             = {owner}")
print(f"  SUBMISSION_TAG    = {submission}")
print(f"  COMMIT_URL        = {commit_url}")
print(f"  RELEASE_URL       = {release_url}")
print(f"  REVIEW_URL        = {review_url}")
print(f"  PAGES_BASE_URL    = {pages_base_url}")
print(f"  GITHUB_REPOSITORY = {repository}")
print(f"  GITHUB_SHA        = {sha}")
print(f"  cwd               = {pathlib.Path.cwd()}")
print("===============================================")

# Empty tests array → vacuous pass. The runner derives
# status=success summary='submitted — no autograder configured for
# <slug>'; collect-scores ingests as "submitted, 0/0".
result = {
    "schema": "classroom50/result/v1",
    "classroom": classroom,
    "assignment": assignment,
    "assignment_type": assignment_type,
    "owner": owner,
    "submission": submission,
    "commit": commit_url,
    "release": release_url,
    "review": review_url,
    "datetime": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "score": 0,
    "max-score": 0,
    "tests": [],
}
pathlib.Path("result.json").write_text(json.dumps(result, indent=2) + "\n")

summary = f"classroom50 autograde: submitted — no autograder configured for {assignment}"
pathlib.Path("release-body.md").write_text(
    f"### classroom50 autograde: 0/0\n\n_{summary}_\n"
)

if github_output:
    # $GITHUB_OUTPUT is line-oriented (key=value); a stray newline in
    # the value would break the parser. Defensive scrub matches
    # runner.py::append_outputs.
    safe_summary = summary.replace("\n", " ").replace("\r", " ")
    with open(github_output, "a") as fh:
        fh.write("status=success\n")
        fh.write(f"summary={safe_summary}\n")

print(f"autograder: {summary}")
