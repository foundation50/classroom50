#!/usr/bin/env python3
"""Emit the key-level diff between two revisions of en.json.

Every pack shares en.json's key structure, so this diff maps 1:1 onto every
language. Reads the previous en.json from stdin and the current one from a path,
then writes:

  * <out-dir>/changed.json — dotted keys added/modified
  * <out-dir>/removed.json — dotted keys removed

In CI the "previous" en.json is the language's marker (markers/<code>.json — a
copy of en.json at that language's last publish):

    python scripts/locale_diff.py \
        --current web/src/locales/en.json \
        --out-dir diff < langrepo/markers/ja.json

Empty stdin (no baseline) => every key is "changed", driving a full first-time
translation downstream. Exit 0 on success.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Reuse the flatten/diff logic so the diff matches the patcher exactly.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from translate_locales import compute_diff, flatten  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--current", required=True, type=Path, help="Path to current en.json")
    parser.add_argument("--out-dir", required=True, type=Path, help="Where to write changed/removed json")
    args = parser.parse_args()

    current = json.loads(args.current.read_text(encoding="utf-8"))

    prev_raw = sys.stdin.read().strip()
    if prev_raw:
        previous = json.loads(prev_raw)
        changed, removed = compute_diff(previous, current)
    else:
        # No previous revision: treat every key as new so downstream does a full
        # first-time translation.
        changed, removed = sorted(flatten(current)), []

    args.out_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / "changed.json").write_text(
        json.dumps(changed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (args.out_dir / "removed.json").write_text(
        json.dumps(removed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print(f"changed keys: {len(changed)} | removed keys: {len(removed)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
