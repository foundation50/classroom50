"""Parity of the rate-limit classifier hand-mirrored across the embedded scripts.

collect_scores.py, regrade_repos.py and probe_token.py are standalone (each is
copied into a classroom repo and run by a workflow), so they hand-mirror the
throttle classifier with no shared module and no compile-time link. The Go leg
of that mirror is pinned by TestRateLimitMarkersParity_GoVsInlinePython, which
compares the RATE_LIMIT_BODY_MARKERS tuples against ghutil.IsRateLimited.

That leaves the rest of the mirror unguarded: the verdict ladder itself. This
module pins it BEHAVIORALLY — the same response must produce the same verdict,
reason and delay in every copy — so editing one script's ladder fails until the
edit is mirrored. The failure it prevents is silent and expensive in one
direction: a copy that stops recognizing a throttle reports it as an
under-scoped token and tells the operator to rotate a healthy credential.
"""

from __future__ import annotations

import pytest

from conftest import collect_scores as cs
from conftest import github_http_error
from conftest import probe_token as pt
from conftest import regrade_repos as rr

# Every module carrying the full ladder (verdict + reason + delay).
LADDER_MODULES = (("collect_scores", cs), ("regrade_repos", rr), ("probe_token", pt))

# The subset that also carries the three-way classify() verdict. probe_token
# only needs the throttle/no-throttle distinction for its scope report, so it
# deliberately has no classify().
CLASSIFY_MODULES = (("collect_scores", cs), ("regrade_repos", rr))

# Responses that must classify identically everywhere: each of the three
# throttle signals, the plain 403 that must stay a permission problem, and the
# transient/terminal statuses whose backoff the change had to preserve.
CASES = (
    ("retry_after_403", 403, {"Retry-After": "30"}, b""),
    ("retry_after_429", 429, {"Retry-After": "5"}, b""),
    ("retry_after_capped", 403, {"Retry-After": "9999"}, b""),
    ("primary_budget_exhausted", 403, {"X-RateLimit-Remaining": "0"}, b""),
    ("primary_budget_with_reset", 429,
     {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1787120877"}, b""),
    ("primary_budget_millisecond_reset", 403,
     {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1787120877000"}, b""),
    ("secondary_limit_body", 403, {}, b'{"message": "You have exceeded a secondary rate limit"}'),
    ("abuse_body", 403, {}, b'{"message": "triggered an abuse detection mechanism"}'),
    ("rate_limit_exceeded_body", 429, {}, b'{"message": "API rate limit exceeded for x"}'),
    ("plain_403_permission", 403, {}, b'{"message": "Resource not accessible by personal access token"}'),
    ("bare_401", 401, {}, b""),
    ("bare_404", 404, {}, b""),
    ("bare_429", 429, {}, b""),
    ("server_500", 500, {}, b""),
    ("server_503_retry_after", 503, {"Retry-After": "9999"}, b""),
    ("synthetic_599", 599, {}, b""),
)


def _case(code, headers, body):
    # A fresh exception per module: the body stream is one-shot and the scripts
    # cache the snippet on the exception object.
    return github_http_error(code, dict(headers), body)


@pytest.mark.parametrize("name,code,headers,body", CASES, ids=[c[0] for c in CASES])
def test_verdict_reason_and_delay_agree_across_scripts(name, code, headers, body):
    verdicts = {
        mod_name: module.rate_limit_verdict(_case(code, headers, body))
        for mod_name, module in LADDER_MODULES
    }
    assert len(set(map(repr, verdicts.values()))) == 1, (
        f"{name}: rate_limit_verdict disagrees across the mirrored scripts: {verdicts}. "
        f"Mirror the ladder change into every copy."
    )

    reasons = {
        mod_name: module.rate_limit_reason(_case(code, headers, body))
        for mod_name, module in LADDER_MODULES
    }
    assert len(set(map(repr, reasons.values()))) == 1, f"{name}: rate_limit_reason disagrees: {reasons}"

    for attempt in (0, 2):
        delays = {
            mod_name: module.retry_delay(_case(code, headers, body), attempt)
            for mod_name, module in LADDER_MODULES
        }
        assert len(set(map(repr, delays.values()))) == 1, (
            f"{name}: retry_delay(attempt={attempt}) disagrees: {delays}"
        )


@pytest.mark.parametrize("name,code,headers,body", CASES, ids=[c[0] for c in CASES])
def test_classify_agrees_across_scripts(name, code, headers, body):
    verdicts = {
        mod_name: module.classify(_case(code, headers, body))
        for mod_name, module in CLASSIFY_MODULES
    }
    assert len(set(verdicts.values())) == 1, (
        f"{name}: classify disagrees across the mirrored scripts: {verdicts}"
    )


def test_marker_tuples_are_identical():
    markers = {name: tuple(module.RATE_LIMIT_BODY_MARKERS) for name, module in LADDER_MODULES}
    assert len(set(markers.values())) == 1, f"RATE_LIMIT_BODY_MARKERS drifted: {markers}"


def test_retry_sleep_cap_is_identical():
    caps = {name: module.MAX_RETRY_SLEEP_SECONDS for name, module in LADDER_MODULES}
    assert len(set(caps.values())) == 1, f"MAX_RETRY_SLEEP_SECONDS drifted: {caps}"


def test_verdict_literals_are_identical():
    for literal in ("THROTTLED", "FATAL", "SKIPPABLE"):
        values = {name: getattr(module, literal) for name, module in CLASSIFY_MODULES}
        assert len(set(values.values())) == 1, f"{literal} drifted: {values}"


def test_epoch_to_iso_agrees_across_scripts():
    for value in ("1787120877", "1787120877000", "", "not-a-number"):
        rendered = {name: module.epoch_to_iso(value) for name, module in LADDER_MODULES}
        assert len(set(rendered.values())) == 1, f"epoch_to_iso({value!r}) drifted: {rendered}"


def test_body_snippet_agrees_across_scripts():
    body = b'{"message":   "You have   exceeded a secondary rate limit"}'
    snippets = {
        name: module.error_body_snippet(_case(403, {}, body)) for name, module in LADDER_MODULES
    }
    assert len(set(snippets.values())) == 1, f"error_body_snippet drifted: {snippets}"
    # Whitespace collapse is what keeps a server-controlled body from breaking
    # the ::warning:: workflow command it gets appended to.
    assert "  " not in next(iter(snippets.values()))
