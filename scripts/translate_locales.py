#!/usr/bin/env python3
"""Patch a target-language pack from the base en.json using AWS Bedrock.

Every pack shares en.json's key structure, so its diff maps 1:1 onto each
language. Instead of regenerating the whole file, this applies the en.json diff
onto the published pack:

  * added / modified keys -> translate ONLY those values and write them in,
  * removed keys          -> delete them,
  * every other key       -> left byte-for-byte as published.

So keys the diff doesn't touch are never sent to the model — community edits
survive across runs, and it's cheap. Diff keys come from the caller (see
locale_diff.py). With no diff (or no current pack to patch), it falls back to a
full section-by-section translation so new languages still work.

Chunking (a section per call, or the changed subset in one call) keeps each
response small enough to avoid truncation and never splits a fragment/plural
sibling group; the full English file rides along as terminology context.

Usage (patch mode — CI): --changed-keys / --removed-keys are JSON lists of
dotted keys added/modified / removed in en.json.
    python translate_locales.py --code ja \
        --base web/src/locales/en.json \
        --prompt web/src/locales/TRANSLATION_PROMPT.md \
        --current langrepo/ja.json \
        --changed-keys changed.json --removed-keys removed.json \
        --out out/ja.json

Usage (full mode — first-time / recovery): --current is optional.
    python translate_locales.py --code ja \
        --base web/src/locales/en.json \
        --prompt web/src/locales/TRANSLATION_PROMPT.md \
        --current langrepo/ja.json --full --out out/ja.json

Auth: Amazon Bedrock API key in AWS_BEARER_TOKEN_BEDROCK (boto3 auto-detects it),
or the standard AWS credential chain. Exit 0 on success, non-zero so CI can gate.
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


# i18next plural suffixes, mirroring verify_locale.py. When a base plural key is
# removed, the gate rejects any leftover sibling variant (e.g. a pack's extra
# `_few`), so removals must sweep the whole plural group, not just the exact key.
PLURAL_SUFFIXES = ("_zero", "_one", "_two", "_few", "_many", "_other")


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


def get_nested(obj: dict, dotted: str) -> object:
    """Read a value at a dotted key path; raise KeyError if any segment is missing."""
    cur: object = obj
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            raise KeyError(dotted)
        cur = cur[part]
    return cur


def set_nested(obj: dict, dotted: str, value: object) -> None:
    """Write a value at a dotted key path, creating intermediate dicts as needed."""
    parts = dotted.split(".")
    cur = obj
    for part in parts[:-1]:
        nxt = cur.get(part)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[part] = nxt
        cur = nxt
    cur[parts[-1]] = value


def delete_nested(obj: dict, dotted: str) -> None:
    """Delete a dotted key path, pruning now-empty parent dicts. No-op if absent."""
    parts = dotted.split(".")
    stack: list[tuple[dict, str]] = []
    cur: object = obj
    for part in parts[:-1]:
        if not isinstance(cur, dict) or part not in cur:
            return
        stack.append((cur, part))
        cur = cur[part]
    if not isinstance(cur, dict) or parts[-1] not in cur:
        return
    del cur[parts[-1]]
    # Prune empty ancestors so a removed leaf doesn't leave dangling {} sections.
    for parent, key in reversed(stack):
        child = parent.get(key)
        if isinstance(child, dict) and not child:
            del parent[key]
        else:
            break


def plural_group_keys(removed_key: str, pack_keys: set[str], base_keys: set[str]) -> list[str]:
    """Pack keys to delete when `removed_key` is dropped from en.json.

    Mirrors verify_locale.py's `is_allowed_plural_variant`: the gate tolerates a
    pack's extra plural sibling (e.g. an added `_few`) only while a base
    `_one`/`_other` for the stem exists. So we sweep the whole plural group only
    once that base group is entirely gone — otherwise those siblings are still
    gate-allowed and deleting them would drop community edits. A key with no base
    `_one`/`_other` isn't a plural form (it just looks like one, e.g. `step_two`),
    so only itself is removed.
    """
    if not any(removed_key.endswith(suffix) for suffix in PLURAL_SUFFIXES):
        return [removed_key]
    stem = removed_key.rsplit("_", 1)[0]
    base_group_survives = any(f"{stem}_{p}" in base_keys for p in ("one", "other"))
    if base_group_survives:
        return [removed_key]
    siblings = {f"{stem}{suffix}" for suffix in PLURAL_SUFFIXES}
    return sorted(siblings & pack_keys)


def compute_diff(previous: dict, current: dict) -> tuple[list[str], list[str]]:
    """Dotted keys changed between two en.json revisions.

    Returns (changed, removed): added/modified keys (need translation) and keys
    dropped from en.json (delete from the pack). Sorted for stable diffs.
    """
    prev_flat = flatten(previous)
    cur_flat = flatten(current)
    changed = [
        key
        for key, value in cur_flat.items()
        if key not in prev_flat or prev_flat[key] != value
    ]
    removed = [key for key in prev_flat if key not in cur_flat]
    return sorted(changed), sorted(removed)


def load_key_list(path: Path | None, code: str, label: str) -> list[str]:
    """Load a JSON list of dotted keys from `path`; [] if unset/missing/empty."""
    if path is None:
        return []
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        eprint(f"[{code}] no {label} file at {path} — treating as empty")
        return []
    data = json.loads(raw)
    if not isinstance(data, list) or not all(isinstance(k, str) for k in data):
        raise ValueError(f"{label} file must be a JSON list of strings: {path}")
    return data


def build_nested_from_keys(base: dict, keys: list[str]) -> dict:
    """Build a nested dict holding only `keys` (dotted) taken from `base`."""
    out: dict = {}
    for key in keys:
        set_nested(out, key, get_nested(base, key))
    return out


def build_keys_message(
    code: str,
    base_full_raw: str,
    subset_raw: str,
) -> str:
    """Build the user turn for translating a specific subset of changed keys.

    Only the changed/added keys are translated and returned; the full English
    file rides along as read-only context so terminology stays consistent with
    the untouched (already-published) parts of the pack.
    """
    return "\n".join(
        [
            f"Target locale code: {code}",
            "",
            "FULL ENGLISH FILE (en.json) — CONTEXT ONLY, for terminology "
            "consistency with the rest of the already-translated pack. Do NOT "
            "translate or return this whole file:",
            "```json",
            base_full_raw.strip(),
            "```",
            "",
            "KEYS TO TRANSLATE — a subset of the file above whose English was just "
            "added or changed. Translate their VALUES into the target locale:",
            "```json",
            subset_raw.strip(),
            "```",
            "",
            "Return ONLY these keys as a single JSON object with EXACTLY the same "
            "keys and nesting as shown (same dotted paths, same structure). Do not "
            "add, drop, rename, or reorder keys. Return only the JSON — no markdown "
            "fences, no commentary.",
        ]
    )


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


def check_key_parity(base: dict, translated: dict, base_keys: set[str] | None = None) -> list[str]:
    """Return base keys the translation dropped.

    Pass `base_keys` (a precomputed `set(flatten(base))`) to skip re-flattening a
    large base that the caller already flattened.
    """
    if base_keys is None:
        base_keys = set(flatten(base))
    trans_keys = set(flatten(translated))
    return sorted(base_keys - trans_keys)


def translate_full(
    client,
    model_id: str,
    system_prompt: str,
    code: str,
    base: dict,
    base_raw: str,
    current: dict,
) -> dict | None:
    """Translate the whole file, one top-level section per call.

    Preserves good existing values, retranslates changed English, fills missing
    keys. Used for first-time generation and recovery. Returns the translated
    dict, or None if any section failed (caller turns that into a non-zero exit).
    """
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
            code, section, base_raw, section_base_raw, section_current_raw
        )

        eprint(f"[{code}] invoking {model_id} for section '{section}' ...")
        try:
            text = invoke_model(client, model_id, system_prompt, message)
            section_result = parse_model_json(text)
        except json.JSONDecodeError as err:
            eprint(f"[{code}] section '{section}' returned invalid JSON: {err}")
            return None
        except Exception as err:  # noqa: BLE001 - surface any Bedrock failure per-language
            eprint(f"[{code}] section '{section}' failed: {err}")
            return None

        # Accept either { "<section>": {...} } or the bare section object.
        if list(section_result.keys()) == [section]:
            section_result = section_result[section]

        # Fail on the offending section rather than after the whole file.
        section_missing = check_key_parity(section_base_obj, {section: section_result})
        if section_missing:
            eprint(
                f"[{code}] section '{section}' is missing "
                f"{len(section_missing)} key(s); first few: {section_missing[:5]}"
            )
            return None

        translated[section] = section_result

    return translated


def translate_keys(
    client,
    model_id: str,
    system_prompt: str,
    code: str,
    base: dict,
    base_raw: str,
    changed_keys: list[str],
) -> dict | None:
    """Translate only `changed_keys` (dotted) and return them as a nested dict.

    One call for the whole subset — it's just the changed English, which stays
    well under the token budget. Returns None on failure or if the model dropped
    any requested key (caller turns that into a non-zero exit).
    """
    subset = build_nested_from_keys(base, changed_keys)
    subset_raw = json.dumps(subset, ensure_ascii=False, indent=2)
    message = build_keys_message(code, base_raw, subset_raw)

    eprint(f"[{code}] invoking {model_id} for {len(changed_keys)} changed key(s) ...")
    try:
        text = invoke_model(client, model_id, system_prompt, message)
        result = parse_model_json(text)
    except json.JSONDecodeError as err:
        eprint(f"[{code}] changed-keys response was invalid JSON: {err}")
        return None
    except Exception as err:  # noqa: BLE001 - surface any Bedrock failure per-language
        eprint(f"[{code}] changed-keys translation failed: {err}")
        return None

    result_flat = flatten(result)
    dropped = sorted(set(changed_keys) - set(result_flat))
    if dropped:
        eprint(
            f"[{code}] changed-keys response dropped {len(dropped)} key(s); "
            f"first few: {dropped[:5]}"
        )
        return None
    return result


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
    parser.add_argument(
        "--changed-keys",
        type=Path,
        default=None,
        help="JSON file: list of dotted keys added/modified in en.json. In patch "
        "mode only these are (re)translated; everything else in --current is kept.",
    )
    parser.add_argument(
        "--removed-keys",
        type=Path,
        default=None,
        help="JSON file: list of dotted keys removed from en.json; they are "
        "deleted from --current in patch mode.",
    )
    parser.add_argument(
        "--full",
        action="store_true",
        help="Force a full retranslation of every section instead of patching "
        "(recovery / first-time). Implied when there is no --current to patch.",
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
    base_keys = set(flatten(base))
    current_raw: str | None = None
    if args.current:
        try:
            current_raw = args.current.read_text(encoding="utf-8")
            eprint(f"[{args.code}] read-back baseline: {args.current}")
        except FileNotFoundError:
            eprint(f"[{args.code}] no existing translation — first-time generation")
    else:
        eprint(f"[{args.code}] no existing translation — first-time generation")

    current: dict = {}
    if current_raw is not None:
        try:
            current = json.loads(current_raw)
        except json.JSONDecodeError as err:
            eprint(f"[{args.code}] existing translation is not valid JSON: {err}")
            return 1

    try:
        changed_keys = load_key_list(args.changed_keys, args.code, "changed-keys")
        removed_keys = load_key_list(args.removed_keys, args.code, "removed-keys")
    except (ValueError, json.JSONDecodeError) as err:
        eprint(f"[{args.code}] bad diff input: {err}")
        return 2

    # Patch needs both a pack to patch and a diff to apply; otherwise (or with
    # --full) do a full retranslation.
    have_current = bool(current)
    diff_provided = args.changed_keys is not None or args.removed_keys is not None
    patch_mode = have_current and diff_provided and not args.full

    client = boto3.client(
        "bedrock-runtime",
        region_name=args.region,
        config=Config(retries={"max_attempts": 0}, read_timeout=300),
    )

    if patch_mode:
        # Start from the published pack; touch only diffed keys, so every other
        # key (hand edits, extra plural variants) carries through untouched.
        translated = current

        # Delete removed keys; skip any still in en.json (stale list). For a
        # retired plural group, plural_group_keys also returns its orphan siblings.
        pack_keys = set(flatten(translated))
        for key in removed_keys:
            if key in base_keys:
                continue
            for member in plural_group_keys(key, pack_keys, base_keys):
                # Guard against dropping a swept member en.json still defines.
                if member not in base_keys:
                    delete_nested(translated, member)

        # Translate only changed keys still present in en.json.
        to_translate = [k for k in changed_keys if k in base_keys]
        if to_translate:
            patch = translate_keys(
                client, args.model_id, system_prompt, args.code,
                base, base_raw, to_translate,
            )
            if patch is None:
                return 1
            patch_flat = flatten(patch)
            for key in to_translate:
                set_nested(translated, key, patch_flat[key])

        eprint(
            f"[{args.code}] patched: {len(to_translate)} (re)translated, "
            f"{len(removed_keys)} removed"
        )
    else:
        reason = "--full" if args.full else (
            "no existing pack" if not have_current else "no diff provided"
        )
        eprint(f"[{args.code}] full translation ({reason})")
        translated = translate_full(
            client, args.model_id, system_prompt, args.code, base, base_raw, current
        )
        if translated is None:
            return 1

    missing = check_key_parity(base, translated, base_keys)
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
