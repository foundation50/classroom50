"""Unit tests for translate_locales.py.

These cover the regression-prone parsing/validation logic without touching
Bedrock (model-JSON fence stripping, response-text extraction, key parity) plus
the `invoke_model` retry/backoff loop against a fake Bedrock client.

Run from the repo root (needs scripts/requirements.txt installed for boto3,
which translate_locales imports at module load):

    python -m pytest scripts/test_translate_locales.py
"""

from __future__ import annotations

import io
import json

import pytest
from botocore.exceptions import (
    ClientError,
    ConnectionError as BotoConnectionError,
    ConnectTimeoutError,
    EndpointConnectionError,
    ReadTimeoutError,
)

import translate_locales
from translate_locales import (
    build_nested_from_keys,
    check_key_parity,
    chunk_keys,
    compute_diff,
    delete_nested,
    extract_text,
    flatten,
    get_nested,
    invoke_model,
    parse_model_json,
    plural_group_keys,
    plural_stem,
    set_nested,
    translate_full,
    translate_keys,
)


def _ok_response(text: str = "hi"):
    """A Bedrock response whose body reads back an Anthropic Messages payload."""
    payload = json.dumps({"content": [{"text": text}]}).encode("utf-8")
    return {"body": io.BytesIO(payload)}


def _client_error(code: str) -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": "boom"}}, "InvokeModel"
    )


# One factory per transport-transient type invoke_model catches, so the tests
# below can be parametrized over the full tuple (dropping any from the except
# clause then fails a case instead of passing green).
_TRANSPORT_ERRORS = {
    "read_timeout": lambda: ReadTimeoutError(endpoint_url="https://bedrock"),
    "connect_timeout": lambda: ConnectTimeoutError(endpoint_url="https://bedrock"),
    "endpoint_connection": lambda: EndpointConnectionError(endpoint_url="https://bedrock"),
    "connection": lambda: BotoConnectionError(error="boom"),
}


class _FakeClient:
    """Bedrock stand-in whose invoke_model plays back a scripted sequence.

    Each queued item is either an Exception (raised) or a response dict
    (returned). Records the call count so tests can assert retry attempts, and
    the last call's kwargs so a test can pin the modelId=/body= call shape (a
    rename or malformed body would make real boto3 raise, not silently pass).
    """

    def __init__(self, script: list):
        self._script = list(script)
        self.calls = 0
        self.last_kwargs: dict | None = None

    # Keyword-only so a production rename away from modelId=/body= is a hard
    # TypeError here, mirroring boto3's ParamValidationError rather than passing.
    def invoke_model(self, *, modelId, body):
        self.calls += 1
        self.last_kwargs = {"modelId": modelId, "body": body}
        item = self._script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class TestInvokeModel:
    """The retry/backoff loop is the only place Bedrock errors are handled;
    every other test monkeypatches invoke_model away, so exercise it directly
    against a fake client. time.sleep is patched off so backoff adds no delay.
    """

    @pytest.fixture(autouse=True)
    def _no_sleep(self, monkeypatch):
        monkeypatch.setattr(translate_locales.time, "sleep", lambda _s: None)

    def test_returns_text_on_first_success(self):
        client = _FakeClient([_ok_response("translated")])
        assert invoke_model(client, "model-x", "sys", "msg") == "translated"
        assert client.calls == 1
        # Pin the request shape: a production rename or a malformed body would
        # make real boto3 raise, so assert the kwargs + JSON envelope here.
        assert client.last_kwargs is not None
        assert client.last_kwargs["modelId"] == "model-x"
        sent = json.loads(client.last_kwargs["body"])
        assert set(sent) >= {"anthropic_version", "max_tokens", "system", "messages"}
        assert sent["system"] == "sys"
        assert sent["messages"] == [{"role": "user", "content": "msg"}]

    @pytest.mark.parametrize("code", sorted(translate_locales.RETRYABLE_ERROR_CODES))
    def test_retries_every_retryable_client_error_then_succeeds(self, code):
        # Iterate the real set so shrinking RETRYABLE_ERROR_CODES fails a case
        # rather than silently flipping that code to immediate re-raise.
        client = _FakeClient([_client_error(code), _ok_response("ok")])
        assert invoke_model(client, "model", "sys", "msg") == "ok"
        assert client.calls == 2

    def test_reraises_non_retryable_client_error_immediately(self):
        client = _FakeClient([_client_error("AccessDeniedException")])
        with pytest.raises(ClientError) as excinfo:
            invoke_model(client, "model", "sys", "msg")
        assert excinfo.value.response["Error"]["Code"] == "AccessDeniedException"
        assert client.calls == 1

    def test_reraises_after_exhausting_attempts_on_retryable_error(self):
        script = [_client_error("ThrottlingException")] * translate_locales.MAX_ATTEMPTS
        client = _FakeClient(script)
        with pytest.raises(ClientError):
            invoke_model(client, "model", "sys", "msg")
        assert client.calls == translate_locales.MAX_ATTEMPTS

    @pytest.mark.parametrize("make_error", _TRANSPORT_ERRORS.values(), ids=_TRANSPORT_ERRORS.keys())
    def test_retries_transport_transient_then_succeeds(self, make_error):
        client = _FakeClient([make_error(), _ok_response("recovered")])
        assert invoke_model(client, "model", "sys", "msg") == "recovered"
        assert client.calls == 2

    @pytest.mark.parametrize("make_error", _TRANSPORT_ERRORS.values(), ids=_TRANSPORT_ERRORS.keys())
    def test_reraises_transport_transient_after_exhausting_attempts(self, make_error):
        client = _FakeClient([make_error() for _ in range(translate_locales.MAX_ATTEMPTS)])
        with pytest.raises(type(make_error())):
            invoke_model(client, "model", "sys", "msg")
        assert client.calls == translate_locales.MAX_ATTEMPTS

    def test_backoff_is_exponential(self, monkeypatch):
        delays: list[float] = []
        monkeypatch.setattr(
            translate_locales.time, "sleep", lambda s: delays.append(s)
        )
        client = _FakeClient(
            [_client_error("ThrottlingException")] * 2 + [_ok_response("ok")]
        )
        invoke_model(client, "model", "sys", "msg")
        base = translate_locales.BASE_BACKOFF_SECONDS
        assert delays == [base, base * 2]


class TestParseModelJson:
    def test_parses_bare_json(self):
        assert parse_model_json('{"a": 1}') == {"a": 1}

    def test_strips_json_fence(self):
        text = '```json\n{"a": 1}\n```'
        assert parse_model_json(text) == {"a": 1}

    def test_strips_bare_fence(self):
        text = '```\n{"a": 1}\n```'
        assert parse_model_json(text) == {"a": 1}

    def test_tolerates_leading_and_trailing_whitespace(self):
        assert parse_model_json('  \n{"a": 1}\n  ') == {"a": 1}

    def test_raises_on_invalid_json(self):
        with pytest.raises(ValueError):
            parse_model_json("not json at all")


class TestExtractText:
    def test_joins_text_chunks(self):
        payload = {"content": [{"text": "he"}, {"text": "llo"}]}
        assert extract_text(payload) == "hello"

    def test_ignores_non_dict_chunks(self):
        payload = {"content": [{"text": "ok"}, "stray", 3]}
        assert extract_text(payload) == "ok"

    def test_raises_when_no_text_content(self):
        with pytest.raises(ValueError):
            extract_text({"content": []})

    def test_raises_when_content_missing(self):
        with pytest.raises(ValueError):
            extract_text({})

    def test_raises_when_truncated_at_max_tokens(self):
        # A cut-off response is unterminated JSON; name the cause instead of
        # letting json.loads report an opaque "Unterminated string".
        payload = {"stop_reason": "max_tokens", "content": [{"text": '{"a": "unterm'}]}
        with pytest.raises(ValueError, match="max_tokens"):
            extract_text(payload)

    def test_accepts_end_turn_stop_reason(self):
        payload = {"stop_reason": "end_turn", "content": [{"text": "ok"}]}
        assert extract_text(payload) == "ok"


def _base_of(n: int, prefix: str = "sec", plural_every: int = 0) -> dict:
    """A flat section of `n` ~60-char leaves; every `plural_every`th is a plural pair."""
    section: dict = {}
    for i in range(n):
        if plural_every and i % plural_every == 0:
            section[f"k{i}_one"] = f"one {i} " + "x" * 40
            section[f"k{i}_other"] = f"other {i} " + "x" * 40
        else:
            section[f"k{i}"] = f"value {i} " + "x" * 40
    return {prefix: section}


class TestPluralStem:
    @pytest.mark.parametrize("suffix", translate_locales.PLURAL_SUFFIXES)
    def test_strips_each_plural_suffix(self, suffix):
        assert plural_stem(f"nav.count{suffix}") == "nav.count"

    def test_leaves_non_plural_key_alone(self):
        assert plural_stem("nav.title") == "nav.title"


class TestChunkKeys:
    def test_small_input_is_one_batch_in_order(self):
        base = _base_of(5)
        keys = list(flatten(base))
        assert chunk_keys(base, keys, max_chars=100_000) == [keys]

    def test_every_batch_fits_budget_and_covers_every_key_once(self):
        base = _base_of(200)
        keys = list(flatten(base))
        budget = 2_000
        batches = chunk_keys(base, keys, max_chars=budget)
        assert len(batches) > 1
        assert [k for b in batches for k in b] == keys
        for batch in batches:
            rendered = json.dumps(build_nested_from_keys(base, batch), ensure_ascii=False, indent=2)
            assert len(rendered) <= budget

    def test_plural_siblings_never_straddle_a_batch_boundary(self):
        base = _base_of(120, plural_every=3)
        keys = list(flatten(base))
        batches = chunk_keys(base, keys, max_chars=1_500)
        assert len(batches) > 1
        for batch in batches:
            stems = [plural_stem(k) for k in batch if k != plural_stem(k)]
            for stem in set(stems):
                assert f"{stem}_one" in batch and f"{stem}_other" in batch

    def test_lone_group_over_budget_gets_its_own_batch(self):
        # A single plural group that can't fit is still emitted whole rather
        # than split or dropped.
        base = {"s": {"a": "x", "big_one": "y" * 500, "big_other": "z" * 500, "b": "w"}}
        batches = chunk_keys(base, list(flatten(base)), max_chars=200)
        assert batches == [["s.a"], ["s.big_one", "s.big_other"], ["s.b"]]

    def test_empty_keys_yield_no_batches(self):
        assert chunk_keys({"s": {"a": "x"}}, [], max_chars=100) == []

    def test_real_en_json_sections_all_fit_default_budget(self):
        # The regression this guards: sections that outgrew one response got
        # truncated. Every batch of the real file must fit the default budget
        # and keep plural groups intact.
        from pathlib import Path

        base_path = Path(__file__).resolve().parent.parent / "web" / "src" / "locales" / "en.json"
        base = json.loads(base_path.read_text(encoding="utf-8"))
        budget = translate_locales.DEFAULT_MAX_CHUNK_CHARS
        for section, value in base.items():
            keys = list(flatten({section: value}))
            batches = chunk_keys(base, keys, budget)
            assert [k for b in batches for k in b] == keys
            for batch in batches:
                rendered = json.dumps(build_nested_from_keys(base, batch), ensure_ascii=False, indent=2)
                # A lone oversized plural group may exceed; none exist in en.json.
                assert len(rendered) <= budget, f"{section}: batch of {len(batch)} keys is {len(rendered)} chars"
                stems = {plural_stem(k) for k in batch if k != plural_stem(k)}
                for stem in stems:
                    siblings = [k for k in keys if plural_stem(k) == stem]
                    assert all(s in batch for s in siblings), f"{stem} split across batches"


class TestFlatten:
    def test_flattens_nested_dicts_to_dotted_keys(self):
        assert flatten({"nav": {"a": "x", "b": "y"}}) == {
            "nav.a": "x",
            "nav.b": "y",
        }

    def test_keeps_top_level_leaves(self):
        assert flatten({"a": "x"}) == {"a": "x"}


class TestCheckKeyParity:
    def test_reports_dropped_keys(self):
        base = {"nav": {"a": "x", "b": "y"}}
        translated = {"nav": {"a": "x"}}
        assert check_key_parity(base, translated) == ["nav.b"]

    def test_no_missing_when_all_present(self):
        base = {"nav": {"a": "x"}}
        translated = {"nav": {"a": "翻訳"}}
        assert check_key_parity(base, translated) == []

    def test_extra_keys_do_not_count_as_missing(self):
        base = {"nav": {"a": "x"}}
        translated = {"nav": {"a": "x", "extra": "z"}}
        assert check_key_parity(base, translated) == []

    def test_precomputed_base_keys_matches_recompute(self):
        base = {"nav": {"a": "x", "b": "y"}}
        translated = {"nav": {"a": "x"}}
        base_keys = set(flatten(base))
        assert check_key_parity(base, translated, base_keys) == ["nav.b"]
        assert check_key_parity(base, translated, base_keys) == check_key_parity(base, translated)


class TestComputeDiff:
    def test_added_and_nested_keys_are_changed(self):
        previous = {"a": "x"}
        current = {"a": "x", "b": "y", "nav": {"c": "z"}}
        changed, removed = compute_diff(previous, current)
        assert changed == ["b", "nav.c"]
        assert removed == []

    def test_modified_value_is_changed(self):
        changed, removed = compute_diff({"a": "x"}, {"a": "different"})
        assert changed == ["a"]
        assert removed == []

    def test_removed_key_is_reported(self):
        changed, removed = compute_diff({"a": "x", "b": "y"}, {"a": "x"})
        assert changed == []
        assert removed == ["b"]

    def test_unchanged_key_is_neither(self):
        changed, removed = compute_diff({"a": "x"}, {"a": "x"})
        assert changed == []
        assert removed == []

    def test_outputs_are_sorted(self):
        previous = {"z": "1", "a": "1"}
        current = {"z": "2", "a": "2", "m": "new"}
        changed, _ = compute_diff(previous, current)
        assert changed == sorted(changed)


class TestNestedHelpers:
    def test_get_nested_reads_value(self):
        assert get_nested({"nav": {"a": "x"}}, "nav.a") == "x"

    def test_get_nested_raises_keyerror_on_missing_segment(self):
        with pytest.raises(KeyError):
            get_nested({"nav": {"a": "x"}}, "nav.missing")

    def test_set_nested_creates_intermediate_dicts(self):
        obj: dict = {}
        set_nested(obj, "nav.a", "x")
        assert obj == {"nav": {"a": "x"}}

    def test_set_nested_preserves_siblings(self):
        obj = {"nav": {"a": "x"}}
        set_nested(obj, "nav.b", "y")
        assert obj == {"nav": {"a": "x", "b": "y"}}

    def test_build_nested_from_keys_round_trip(self):
        base = {"nav": {"a": "x", "b": "y"}, "c": "z"}
        assert build_nested_from_keys(base, ["nav.b", "c"]) == {"nav": {"b": "y"}, "c": "z"}


class TestDeleteNested:
    def test_deletes_leaf(self):
        obj = {"nav": {"a": "x", "b": "y"}}
        delete_nested(obj, "nav.a")
        assert obj == {"nav": {"b": "y"}}

    def test_prunes_empty_ancestors(self):
        obj = {"nav": {"a": "x"}}
        delete_nested(obj, "nav.a")
        assert obj == {}

    def test_stops_pruning_at_non_empty_ancestor(self):
        obj = {"nav": {"sub": {"a": "x"}, "keep": "y"}}
        delete_nested(obj, "nav.sub.a")
        assert obj == {"nav": {"keep": "y"}}

    def test_no_op_when_key_absent(self):
        obj = {"nav": {"a": "x"}}
        delete_nested(obj, "nav.missing")
        assert obj == {"nav": {"a": "x"}}


class TestPluralGroupKeys:
    def test_non_plural_key_returns_itself(self):
        base_keys = {"foo.title"}
        assert plural_group_keys("foo.title", {"foo.title"}, base_keys) == ["foo.title"]

    def test_ordinary_key_with_plural_suffix_is_not_treated_as_plural(self):
        # `step_two` looks like a plural form but has no base _one/_other, so it is
        # an ordinary key: only itself is deleted, a stem-sharing key is untouched.
        base_keys = {"onboarding.step_other"}  # unrelated key still in base
        pack_keys = {"onboarding.step_two", "onboarding.step_other"}
        assert plural_group_keys("onboarding.step_two", pack_keys, base_keys) == [
            "onboarding.step_two"
        ]

    def test_partial_group_removal_keeps_gate_allowed_sibling(self):
        # en.json removed foo.msg_one but kept foo.msg_other, so the group still
        # exists; a community-added foo.msg_few is gate-allowed and must NOT be swept.
        base_keys = {"foo.msg_other"}
        pack_keys = {"foo.msg_one", "foo.msg_other", "foo.msg_few"}
        assert plural_group_keys("foo.msg_one", pack_keys, base_keys) == ["foo.msg_one"]

    def test_full_group_removal_sweeps_orphan_siblings(self):
        # The whole base group is gone, so leftover pack siblings are true orphans
        # that would trip verify_locale.py — sweep every one the pack has.
        base_keys: set = set()
        pack_keys = {"foo.msg_one", "foo.msg_other", "foo.msg_few"}
        assert plural_group_keys("foo.msg_one", pack_keys, base_keys) == [
            "foo.msg_few",
            "foo.msg_one",
            "foo.msg_other",
        ]


class TestTranslateKeys:
    def test_returns_none_when_model_drops_a_requested_key(self, monkeypatch):
        base = {"nav": {"a": "x", "b": "y"}}
        base_raw = json.dumps(base)
        # Model returns only nav.a, dropping the requested nav.b.
        monkeypatch.setattr(
            translate_locales, "invoke_model", lambda *a, **k: '{"nav": {"a": "translated"}}'
        )
        result = translate_keys(None, "model", "prompt", "ja", base, base_raw, ["nav.a", "nav.b"])
        assert result is None

    def test_returns_translation_when_all_keys_present(self, monkeypatch):
        base = {"nav": {"a": "x", "b": "y"}}
        base_raw = json.dumps(base)
        monkeypatch.setattr(
            translate_locales,
            "invoke_model",
            lambda *a, **k: '{"nav": {"a": "翻訳a", "b": "翻訳b"}}',
        )
        result = translate_keys(None, "model", "prompt", "ja", base, base_raw, ["nav.a", "nav.b"])
        assert flatten(result) == {"nav.a": "翻訳a", "nav.b": "翻訳b"}

    def test_batches_a_large_backlog_and_merges_every_batch(self, monkeypatch):
        # The regression: 900+ changed keys in one call truncated at max_tokens.
        base = _base_of(150)
        keys = list(flatten(base))
        monkeypatch.setattr(translate_locales, "DEFAULT_MAX_CHUNK_CHARS", 2_000)
        calls: list[int] = []

        def fake_invoke(_client, _model, _system, message):
            requested = _requested_block(message)
            calls.append(len(flatten(requested)))
            return json.dumps(_echo_translate(requested))

        monkeypatch.setattr(translate_locales, "invoke_model", fake_invoke)
        result = translate_keys(None, "model", "prompt", "de", base, json.dumps(base), keys)
        assert len(calls) > 1
        assert sum(calls) == len(keys)
        assert flatten(result) == {k: f"[de] {v}" for k, v in flatten(base).items()}

    def test_fails_fast_on_the_first_bad_batch(self, monkeypatch):
        base = _base_of(150)
        keys = list(flatten(base))
        monkeypatch.setattr(translate_locales, "DEFAULT_MAX_CHUNK_CHARS", 2_000)
        calls = 0

        def fake_invoke(_client, _model, _system, message):
            nonlocal calls
            calls += 1
            return "{}"  # drops every requested key

        monkeypatch.setattr(translate_locales, "invoke_model", fake_invoke)
        assert translate_keys(None, "model", "prompt", "de", base, json.dumps(base), keys) is None
        assert calls == 1


def _requested_block(message: str) -> dict:
    """The JSON the prompt asks to translate: the second fenced block (the first
    is the full-file context)."""
    blocks = message.split("```json\n")
    return json.loads(blocks[2].split("\n```", 1)[0])


def _echo_translate(obj: dict, code: str = "de") -> dict:
    """Fake translation: prefix every leaf so tests can tell output from input."""
    out: dict = {}
    for key, value in flatten(obj).items():
        set_nested(out, key, f"[{code}] {value}")
    return out


class TestTranslateFull:
    @pytest.fixture(autouse=True)
    def _small_budget(self, monkeypatch):
        monkeypatch.setattr(translate_locales, "DEFAULT_MAX_CHUNK_CHARS", 2_000)

    def _install_echo(self, monkeypatch, messages: list[str]):
        def fake_invoke(_client, _model, _system, message):
            messages.append(message)
            return json.dumps(_echo_translate(_requested_block(message)))

        monkeypatch.setattr(translate_locales, "invoke_model", fake_invoke)

    def test_splits_a_large_section_into_parts_and_reassembles_it(self, monkeypatch):
        base = {**_base_of(3, "small"), **_base_of(150, "big", plural_every=5)}
        messages: list[str] = []
        self._install_echo(monkeypatch, messages)

        result = translate_full(None, "model", "prompt", "de", base, json.dumps(base), {})

        assert flatten(result) == {k: f"[de] {v}" for k, v in flatten(base).items()}
        assert list(result) == ["small", "big"]
        # `small` fits one call with no part label; `big` is split and labelled.
        small_msgs = [m for m in messages if '"small" subtree' in m]
        big_msgs = [m for m in messages if '"big" subtree' in m]
        assert len(small_msgs) == 1 and "part 1 of" not in small_msgs[0]
        assert len(big_msgs) > 1
        assert all(f"part {i} of {len(big_msgs)}" in m for i, m in enumerate(big_msgs, start=1))

    def test_existing_translation_is_scoped_to_the_part_and_keeps_extra_plurals(self, monkeypatch):
        base = _base_of(150, "big", plural_every=5)
        current = _echo_translate(base, "pl")
        # A community-added Polish form on one plural group; en.json has no _few.
        set_nested(current, "big.k0_few", "[pl] few")
        messages: list[str] = []
        self._install_echo(monkeypatch, messages)

        translate_full(None, "model", "prompt", "pl", base, json.dumps(base), current)

        for message in messages:
            requested = set(flatten(_requested_block(message)))
            existing_block = message.split("```json\n")[3].split("\n```", 1)[0]
            existing = set(flatten(json.loads(existing_block)))
            # Every existing key shown is either requested or a plural sibling of one.
            assert all(k in requested or plural_stem(k) in {plural_stem(r) for r in requested} for k in existing)
            if "big.k0_one" in requested:
                assert "big.k0_few" in existing
            else:
                assert "big.k0_few" not in existing

    def test_first_time_generation_has_no_existing_block(self, monkeypatch):
        base = _base_of(3)
        messages: list[str] = []
        self._install_echo(monkeypatch, messages)
        translate_full(None, "model", "prompt", "de", base, json.dumps(base), {})
        assert len(messages) == 1
        assert "There is no existing translation" in messages[0]
        assert messages[0].count("```json\n") == 2

    def test_accepts_bare_section_object(self, monkeypatch):
        base = {"nav": {"a": "x"}}
        monkeypatch.setattr(translate_locales, "invoke_model", lambda *a, **k: '{"a": "übersetzt"}')
        assert translate_full(None, "model", "prompt", "de", base, json.dumps(base), {}) == {
            "nav": {"a": "übersetzt"}
        }

    def test_returns_none_when_a_part_drops_a_key(self, monkeypatch):
        base = _base_of(150)

        def fake_invoke(_client, _model, _system, message):
            requested = _requested_block(message)
            translated = _echo_translate(requested)
            first = next(iter(translated["sec"]))
            del translated["sec"][first]
            return json.dumps(translated)

        monkeypatch.setattr(translate_locales, "invoke_model", fake_invoke)
        assert translate_full(None, "model", "prompt", "de", base, json.dumps(base), {}) is None

    def test_returns_none_and_names_truncation(self, monkeypatch, capsys):
        base = _base_of(3)
        monkeypatch.setattr(
            translate_locales,
            "invoke_model",
            lambda *a, **k: (_ for _ in ()).throw(ValueError("truncated at max_tokens=32000")),
        )
        assert translate_full(None, "model", "prompt", "de", base, json.dumps(base), {}) is None
        assert "max_tokens" in capsys.readouterr().err


class TestMainPatchMode:
    """End-to-end patch-mode selection + removed-key application via main().

    Uses only removed keys so no Bedrock call is needed (to_translate is empty),
    exercising patch_mode selection, delete_nested, and the plural sweep together.
    """

    def _run(self, tmp_path, monkeypatch, base, current, removed_keys):
        monkeypatch.setattr(translate_locales.boto3, "client", lambda *a, **k: None)
        base_path = tmp_path / "en.json"
        base_path.write_text(json.dumps(base), encoding="utf-8")
        (tmp_path / "TRANSLATION_PROMPT.md").write_text("prompt", encoding="utf-8")
        current_path = tmp_path / "ja.json"
        current_path.write_text(json.dumps(current), encoding="utf-8")
        changed_path = tmp_path / "changed.json"
        changed_path.write_text("[]", encoding="utf-8")
        removed_path = tmp_path / "removed.json"
        removed_path.write_text(json.dumps(removed_keys), encoding="utf-8")
        out_path = tmp_path / "out.json"
        argv = [
            "translate_locales.py", "--code", "ja",
            "--base", str(base_path), "--prompt", str(tmp_path / "TRANSLATION_PROMPT.md"),
            "--current", str(current_path),
            "--changed-keys", str(changed_path), "--removed-keys", str(removed_path),
            "--model-id", "test-model", "--out", str(out_path),
        ]
        monkeypatch.setattr(translate_locales.sys, "argv", argv)
        rc = translate_locales.main()
        result = json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() else None
        return rc, result

    def test_partial_plural_group_removal_keeps_community_sibling(self, tmp_path, monkeypatch):
        base = {"foo": {"msg_other": "other"}}  # msg_one removed, msg_other kept
        current = {"foo": {"msg_one": "1", "msg_other": "o", "msg_few": "community"}}
        rc, result = self._run(tmp_path, monkeypatch, base, current, ["foo.msg_one"])
        assert rc == 0
        # msg_one deleted (removed); msg_few kept (gate still allows it); msg_other kept.
        assert result == {"foo": {"msg_other": "o", "msg_few": "community"}}

    def test_full_plural_group_removal_sweeps_orphans(self, tmp_path, monkeypatch):
        base = {"other": {"key": "v"}}  # whole foo.msg group gone from en.json
        current = {
            "foo": {"msg_one": "1", "msg_other": "o", "msg_few": "orphan"},
            "other": {"key": "v"},
        }
        rc, result = self._run(tmp_path, monkeypatch, base, current, ["foo.msg_one"])
        assert rc == 0
        # Entire orphan group swept; empty foo dict pruned.
        assert result == {"other": {"key": "v"}}


class TestFlattenParityWithVerifyLocale:
    """`flatten()` is duplicated in verify_locale.py (which ships standalone next
    to en.json) and here. The duplication is intentional for portability, so
    guard the two copies against silent drift with a behavioral parity test
    rather than merging them. If either implementation changes shape, this fails.
    """

    @staticmethod
    def _load_verify_locale():
        import importlib.util
        from pathlib import Path

        verify_path = (
            Path(__file__).resolve().parent.parent
            / "web"
            / "src"
            / "locales"
            / "verify_locale.py"
        )
        spec = importlib.util.spec_from_file_location("verify_locale", verify_path)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    @pytest.mark.parametrize(
        "obj",
        [
            {},
            {"a": "1"},
            {"a": {"b": "2", "c": {"d": "3"}}},
            {"nav": {"appName": "x"}, "accept": {"title": "t", "body": "b"}},
            {"a": {"b": {"c": {"deep": "leaf"}}}, "top": "value"},
            {"count_one": "one", "count_other": "many"},
        ],
    )
    def test_flatten_matches_verify_locale(self, obj):
        verify_locale = self._load_verify_locale()
        assert flatten(obj) == verify_locale.flatten(obj)

    def test_flatten_matches_on_real_base_locale(self):
        from pathlib import Path

        verify_locale = self._load_verify_locale()
        base_path = (
            Path(__file__).resolve().parent.parent
            / "web"
            / "src"
            / "locales"
            / "en.json"
        )
        base = json.loads(base_path.read_text(encoding="utf-8"))
        assert flatten(base) == verify_locale.flatten(base)
