"""Unit tests for the pure helpers in translate_locales.py.

These cover the regression-prone parsing/validation logic without touching
Bedrock: model-JSON fence stripping, response-text extraction, and key parity.

Run from the repo root (needs scripts/requirements.txt installed for boto3,
which translate_locales imports at module load):

    python -m pytest scripts/test_translate_locales.py
"""

from __future__ import annotations

import pytest

from translate_locales import (
    check_key_parity,
    extract_text,
    flatten,
    parse_model_json,
)


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
