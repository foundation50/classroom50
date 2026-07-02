#!/usr/bin/env python3
"""Regenerate a target-language pack from the base en.json using AWS Bedrock.

Reads en.json and the language repo's current translation (if any), then asks a
Bedrock model to reproduce each top-level section: existing good translations
are preserved, changed English is retranslated, missing keys are filled.
Translating one section per call (with the full English file as context) keeps
each response small enough to avoid truncation while honoring
TRANSLATION_PROMPT.md's fragment/plural/terminology rules — fragment and plural
sibling groups never span two top-level sections.

Usage:
    python translate_locales.py \
        --code ja \
        --base web/src/locales/en.json \
        --prompt web/src/locales/TRANSLATION_PROMPT.md \
        --current langrepo/ja.json \
        --out langrepo/ja.json

Auth: set an Amazon Bedrock API key in AWS_BEARER_TOKEN_BEDROCK (boto3 picks it
up automatically); the standard AWS credential chain works too if it's unset.

Exit codes: 0 on success, non-zero on failure so CI can gate a language.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import (
    ClientError,
    ConnectionError as BotoConnectionError,
    ConnectTimeoutError,
    EndpointConnectionError,
    ReadTimeoutError,
)

# Anthropic Messages API version on Bedrock; the payload below assumes that
# schema. Overridable via BEDROCK_ANTHROPIC_VERSION.
ANTHROPIC_VERSION = os.environ.get("BEDROCK_ANTHROPIC_VERSION", "bedrock-2023-05-31")

# Bounds one response. We translate a single section per call, so this only
# needs to fit the largest section; kept generous. Overridable.
DEFAULT_MAX_TOKENS = int(os.environ.get("BEDROCK_MAX_TOKENS", "20000"))

MAX_ATTEMPTS = 5
BASE_BACKOFF_SECONDS = 2.0

# Throttling / transient Bedrock errors worth retrying with backoff.
RETRYABLE_ERROR_CODES = {
    "ThrottlingException",
    "TooManyRequestsException",
    "ServiceUnavailableException",
    "ModelTimeoutException",
    "InternalServerException",
}


def eprint(*args: object) -> None:
    print(*args, file=sys.stderr, flush=True)


def flatten(obj: dict, prefix: str = "") -> dict[str, object]:
    """Flatten nested dicts to dotted keys, matching verify_locale.py / the app."""
    out: dict[str, object] = {}
    for key, value in obj.items():
        dotted = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            out.update(flatten(value, dotted))
        else:
            out[dotted] = value
    return out


def build_section_message(
    code: str,
    section: str,
    base_full_raw: str,
    section_base_raw: str,
    section_current_raw: str | None,
) -> str:
    """Build the user turn for translating one top-level section.

    The full English file rides along as read-only context for terminology
    consistency, but only the current section is translated and returned.
    Chunking by top-level section never splits a fragment/plural sibling group.
    """
    parts = [
        f"Target locale code: {code}",
        "",
        "FULL ENGLISH FILE (en.json) — CONTEXT ONLY, for terminology consistency. "
        "Do NOT translate or return this whole file:",
        "```json",
        base_full_raw.strip(),
        "```",
        "",
        f'SECTION TO TRANSLATE — the "{section}" subtree of the file above. '
        "Translate its VALUES into the target locale:",
        "```json",
        section_base_raw.strip(),
        "```",
    ]
    if section_current_raw is not None:
        parts += [
            "",
            f'EXISTING TRANSLATION of the "{section}" section — may contain human '
            "corrections. Preserve values that are still correct for the current "
            "English; only change values whose English source changed, and add any "
            "keys missing here:",
            "```json",
            section_current_raw.strip(),
            "```",
        ]
    else:
        parts += [
            "",
            f'There is no existing translation for the "{section}" section — '
            "produce a complete first translation of every value in it.",
        ]
    parts += [
        "",
        f'Return ONLY the translated "{section}" object as a single JSON object '
        f'whose top-level key is "{section}", with exactly the same keys and '
        "nesting as the section shown. Return only the JSON — no markdown fences, "
        "no commentary.",
    ]
    return "\n".join(parts)


def invoke_model(client, model_id: str, system_prompt: str, user_message: str) -> str:
    """Call Bedrock InvokeModel with retry/backoff; return the raw text response."""
    body = json.dumps(
        {
            "anthropic_version": ANTHROPIC_VERSION,
            "max_tokens": DEFAULT_MAX_TOKENS,
            "system": system_prompt,
            "messages": [{"role": "user", "content": user_message}],
        }
    )

    last_err: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            response = client.invoke_model(modelId=model_id, body=body)
            payload = json.loads(response["body"].read())
            return extract_text(payload)
        except ClientError as err:
            code = err.response.get("Error", {}).get("Code", "")
            if code not in RETRYABLE_ERROR_CODES or attempt == MAX_ATTEMPTS:
                raise
            last_err = err
            sleep_for = BASE_BACKOFF_SECONDS * (2 ** (attempt - 1))
            eprint(f"  bedrock {code}, retry {attempt}/{MAX_ATTEMPTS} in {sleep_for:.0f}s")
            time.sleep(sleep_for)
        except (
            ReadTimeoutError,
            ConnectTimeoutError,
            EndpointConnectionError,
            BotoConnectionError,
        ) as err:
            # Transport transients aren't ClientError, so they'd otherwise skip
            # backoff and fail the language on a single blip (boto's own retries
            # are disabled via Config(max_attempts=0)). Retry them the same way.
            if attempt == MAX_ATTEMPTS:
                raise
            last_err = err
            sleep_for = BASE_BACKOFF_SECONDS * (2 ** (attempt - 1))
            eprint(
                f"  bedrock transport error ({type(err).__name__}), "
                f"retry {attempt}/{MAX_ATTEMPTS} in {sleep_for:.0f}s"
            )
            time.sleep(sleep_for)

    # Unreachable in practice (the final attempt either returns or raises).
    raise RuntimeError(f"Bedrock invocation failed after retries: {last_err}")


def extract_text(payload: dict) -> str:
    """Pull the assistant text out of an Anthropic Messages response payload."""
    content = payload.get("content")
    if isinstance(content, list):
        chunks = [c.get("text", "") for c in content if isinstance(c, dict)]
        text = "".join(chunks).strip()
        if text:
            return text
    raise ValueError("Bedrock response contained no text content")


def parse_model_json(text: str) -> dict:
    """Parse the model's JSON, tolerating stray markdown fences."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        # Drop the opening fence (optionally ```json) and the closing fence.
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned
        if cleaned.rstrip().endswith("```"):
            cleaned = cleaned.rstrip()[: -len("```")]
    return json.loads(cleaned)


def check_key_parity(base: dict, translated: dict) -> list[str]:
    """Return base keys the translation dropped."""
    base_keys = set(flatten(base))
    trans_keys = set(flatten(translated))
    return sorted(base_keys - trans_keys)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--code", required=True, help="BCP-47 target locale code, e.g. ja")
    parser.add_argument("--base", required=True, type=Path, help="Path to en.json")
    parser.add_argument(
        "--prompt",
        type=Path,
        default=None,
        help="Path to TRANSLATION_PROMPT.md (defaults next to --base)",
    )
    parser.add_argument(
        "--current",
        type=Path,
        default=None,
        help="Path to the existing translation (omit or point at a missing file "
        "for a first-time generation)",
    )
    parser.add_argument("--out", required=True, type=Path, help="Where to write <code>.json")
    parser.add_argument(
        "--model-id",
        default=os.environ.get("BEDROCK_MODEL_ID"),
        help="Bedrock model id (defaults to $BEDROCK_MODEL_ID)",
    )
    parser.add_argument(
        "--region",
        default=os.environ.get("AWS_REGION"),
        help="AWS region (defaults to $AWS_REGION)",
    )
    args = parser.parse_args()

    if not args.model_id:
        eprint("error: --model-id or $BEDROCK_MODEL_ID is required")
        return 2

    prompt_path = args.prompt or (args.base.parent / "TRANSLATION_PROMPT.md")
    try:
        base_raw = args.base.read_text(encoding="utf-8")
    except FileNotFoundError:
        eprint(f"error: base file not found: {args.base}")
        return 2
    try:
        system_prompt = prompt_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        eprint(f"error: prompt file not found: {prompt_path}")
        return 2
    base = json.loads(base_raw)

    current_raw: str | None = None
    if args.current:
        try:
            current_raw = args.current.read_text(encoding="utf-8")
            eprint(f"[{args.code}] read-back baseline: {args.current}")
        except FileNotFoundError:
            eprint(f"[{args.code}] no existing translation — first-time generation")
    else:
        eprint(f"[{args.code}] no existing translation — first-time generation")

    client = boto3.client(
        "bedrock-runtime",
        region_name=args.region,
        config=Config(retries={"max_attempts": 0}, read_timeout=300),
    )

    current: dict = {}
    if current_raw is not None:
        try:
            current = json.loads(current_raw)
        except json.JSONDecodeError as err:
            eprint(f"[{args.code}] existing translation is not valid JSON: {err}")
            return 1

    # Translate one section per call: small enough to avoid truncation, and no
    # fragment/plural group spans two sections. Full English rides along as
    # context for terminology consistency.
    translated: dict = {}
    for section, section_value in base.items():
        section_base_obj: dict = {section: section_value}

        section_base_raw = json.dumps(section_base_obj, ensure_ascii=False, indent=2)
        section_current_raw: str | None = None
        if section in current:
            section_current_raw = json.dumps(
                {section: current[section]}, ensure_ascii=False, indent=2
            )

        message = build_section_message(
            args.code, section, base_raw, section_base_raw, section_current_raw
        )

        eprint(f"[{args.code}] invoking {args.model_id} for section '{section}' ...")
        try:
            text = invoke_model(client, args.model_id, system_prompt, message)
            section_result = parse_model_json(text)
        except json.JSONDecodeError as err:
            eprint(f"[{args.code}] section '{section}' returned invalid JSON: {err}")
            return 1
        except Exception as err:  # noqa: BLE001 - surface any Bedrock failure per-language
            eprint(f"[{args.code}] section '{section}' failed: {err}")
            return 1

        # Accept either { "<section>": {...} } or the bare section object.
        if list(section_result.keys()) == [section]:
            section_result = section_result[section]

        # Fail on the offending section rather than after the whole file.
        section_missing = check_key_parity(section_base_obj, {section: section_result})
        if section_missing:
            eprint(
                f"[{args.code}] section '{section}' is missing "
                f"{len(section_missing)} key(s); first few: {section_missing[:5]}"
            )
            return 1

        translated[section] = section_result

    missing = check_key_parity(base, translated)
    if missing:
        eprint(
            f"[{args.code}] translation is missing {len(missing)} base key(s); "
            f"first few: {missing[:5]}"
        )
        return 1

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(translated, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    eprint(f"[{args.code}] wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
