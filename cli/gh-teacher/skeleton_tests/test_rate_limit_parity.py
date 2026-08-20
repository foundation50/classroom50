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

# Every module carrying the classifier ladder (verdict + reason).
LADDER_MODULES = (("collect_scores", cs), ("regrade_repos", rr), ("probe_token", pt))

# The subset that also carries the run-level throttle-sleep ceiling. A probe
# issues a handful of requests, so it cannot pile up enough recovered throttles
# to threaten its own job timeout — the budget would be ceremony there, and
# demanding uniformity is how a mirror starts dictating the design.
BUDGET_MODULES = (("collect_scores", cs), ("regrade_repos", rr))

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


@pytest.fixture(autouse=True)
def _reset_throttle_budget():
    """retry_delay charges a run-level sleep budget, so every case starts from a
    fresh one — otherwise the first module to ask would spend it for the rest."""
    for _name, module in BUDGET_MODULES:
        module._throttle_sleep_spent = 0.0
    yield
    for _name, module in BUDGET_MODULES:
        module._throttle_sleep_spent = 0.0


def _delay(module, code, headers, body, attempt):
    """`retry_delay` for one module with the budget reset, so the comparison
    across modules isn't order-dependent."""
    if hasattr(module, "_throttle_sleep_spent"):
        module._throttle_sleep_spent = 0.0
    return module.retry_delay(_case(code, headers, body), attempt)


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
            mod_name: _delay(module, code, headers, body, attempt)
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


def test_body_snippet_read_cap_is_identical():
    caps = {name: module.BODY_SNIPPET_READ_BYTES for name, module in LADDER_MODULES}
    assert len(set(caps.values())) == 1, f"BODY_SNIPPET_READ_BYTES drifted: {caps}"


def test_transient_retry_cap_is_identical():
    caps = {name: module.TRANSIENT_RETRY_CAP_SECONDS for name, module in LADDER_MODULES}
    assert len(set(caps.values())) == 1, f"TRANSIENT_RETRY_CAP_SECONDS drifted: {caps}"


def test_total_throttle_sleep_budget_is_identical():
    caps = {
        name: module.MAX_TOTAL_THROTTLE_SLEEP_SECONDS for name, module in BUDGET_MODULES
    }
    assert len(set(caps.values())) == 1, (
        f"MAX_TOTAL_THROTTLE_SLEEP_SECONDS drifted: {caps}"
    )


def test_probe_token_deliberately_has_no_sleep_budget():
    """Pinned so the omission reads as a decision, not an oversight: a probe's
    handful of requests can't threaten its job timeout."""
    assert not hasattr(pt, "MAX_TOTAL_THROTTLE_SLEEP_SECONDS")
    assert not hasattr(pt, "throttle_sleep_budget_spent")


def test_sleep_budget_stops_retrying_in_every_script():
    """The ceiling that turns a job-killing pile of recovered throttles into a
    named error must hold in both copies that carry it."""
    for name, module in BUDGET_MODULES:
        module._throttle_sleep_spent = 0.0
        exc = _case(403, {"Retry-After": "60"}, b"")
        slept = 0.0
        # Each grant of 60s is charged; once the budget can't cover another, the
        # ladder declines the retry instead of sleeping.
        while True:
            delay = module.retry_delay(exc, 0)
            if delay is None:
                break
            slept += delay
            assert slept <= module.MAX_TOTAL_THROTTLE_SLEEP_SECONDS, name
        assert slept > 0, f"{name}: budget declined the very first throttle"
        assert (
            slept + module.MAX_RETRY_SLEEP_SECONDS
            > module.MAX_TOTAL_THROTTLE_SLEEP_SECONDS
        ), f"{name}: stopped well short of the budget ({slept}s)"
        module._throttle_sleep_spent = 0.0


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
