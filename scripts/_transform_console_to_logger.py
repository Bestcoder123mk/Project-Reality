#!/usr/bin/env python3
"""
One-shot transformer for backlog §20 item 470.

For each API route.ts under src/app/api/ that has a `console.error("...failed", err)`
pattern, this script:
  1. Adds `import { createLogger } from "@/lib/logger";` after the first
     existing `import` statement (idempotent — skipped if already present).
  2. Adds `const logger = createLogger("/api/<route>");` after the imports
     block (idempotent — skipped if already present).
  3. Replaces `console.error("[/api/<route>] <msg>", err);` with
     `logger.errorOf(err, "<msg>");` (preserves the trailing newline).

The audio/vo route has a different (typeof-guarded) pattern that's left
untouched — it'll be handled manually after this script runs.
"""
from __future__ import annotations
import os
import re
import sys

API_ROOT = os.path.join(os.path.dirname(__file__), "..", "src", "app", "api")
API_ROOT = os.path.normpath(API_ROOT)

# Maps file path → route path used as the logger prefix.
def route_path_for(abs_path: str) -> str:
    rel = os.path.relpath(abs_path, API_ROOT).replace(os.sep, "/")
    # Drop trailing /route.ts.
    if rel.endswith("/route.ts"):
        rel = rel[:-len("/route.ts")]
    return f"/api/{rel}"

def transform(path: str) -> tuple[int, list[str]]:
    """Returns (num_replacements, list_of_changes)."""
    with open(path, "r", encoding="utf-8") as f:
        src = f.read()

    changes: list[str] = []

    # 3. Replace console.error calls first so we know whether we need the
    #    import at all.
    route = route_path_for(path)

    # Match: console.error("[/api/<route>] <msg>", <errVar>);
    # Capture <msg> (no quotes inside) and <errVar>.
    pattern = re.compile(
        r'console\.error\(\s*"\[/api/[^]]+\]\s*([^"]*)"\s*,\s*([A-Za-z_$][A-Za-z_$0-9]*)\s*\)\s*;',
    )

    n_repl = 0
    def repl(m: re.Match) -> str:
        nonlocal n_repl
        n_repl += 1
        msg = m.group(1).strip()
        err_var = m.group(2)
        if not msg:
            return f"logger.errorOf({err_var});"
        # Escape any embedded double-quotes in msg (unlikely but defensive).
        msg_escaped = msg.replace('"', '\\"')
        return f'logger.errorOf({err_var}, "{msg_escaped}");'

    new_src, n = pattern.subn(repl, src)
    if n == 0:
        return (0, ["no console.error matches"])
    src = new_src
    changes.append(f"replaced {n} console.error call(s)")

    # 1. Add import (idempotent).
    if 'from "@/lib/logger"' not in src:
        # Insert after the first import line.
        match = re.search(r'^(import\s+.*?;$)', src, re.MULTILINE)
        if match:
            insert_at = match.end()
            src = src[:insert_at] + '\nimport { createLogger } from "@/lib/logger";' + src[insert_at:]
            changes.append("added logger import")
        else:
            # No imports — prepend at top.
            src = 'import { createLogger } from "@/lib/logger";\n' + src
            changes.append("added logger import (no prior imports)")

    # 2. Add `const logger = createLogger("/api/<route>");` after the
    #    import block (idempotent). Define "after imports" as after the
    #    last consecutive `import ...;` line at the start of the file.
    if "const logger = createLogger(" not in src:
        # Find end of the leading import block.
        lines = src.split("\n")
        last_import_idx = -1
        for i, ln in enumerate(lines):
            stripped = ln.strip()
            if stripped.startswith("import ") and (stripped.endswith(";") or stripped.endswith('from "') or "from \"" in stripped):
                # could be single-line or multi-line; for our files all are single-line.
                if stripped.endswith(";"):
                    last_import_idx = i
                else:
                    # multi-line import — keep scanning until we hit ';'
                    j = i
                    while j < len(lines) and not lines[j].rstrip().endswith(";"):
                        j += 1
                    last_import_idx = j
            elif stripped == "" and last_import_idx >= 0:
                # blank line after the import block — fine, stop searching
                # so we insert before this blank line.
                break
            elif not stripped.startswith("import ") and not stripped.startswith("//") and not stripped.startswith("/*") and not stripped.startswith("*") and stripped:
                # hit the first non-import, non-comment line — stop.
                break
        if last_import_idx >= 0:
            insert_line = last_import_idx + 1
            lines.insert(insert_line, f'const logger = createLogger("{route}");')
            src = "\n".join(lines)
            changes.append(f"added logger const ({route})")
        else:
            # Fallback: prepend at top.
            src = f'const logger = createLogger("{route}");\n' + src
            changes.append(f"added logger const at top ({route})")

    with open(path, "w", encoding="utf-8") as f:
        f.write(src)
    return (n, changes)

def main() -> int:
    if not os.path.isdir(API_ROOT):
        print(f"API root not found: {API_ROOT}", file=sys.stderr)
        return 1
    total_files = 0
    total_replacements = 0
    for dirpath, _dirnames, filenames in os.walk(API_ROOT):
        for fn in filenames:
            if fn != "route.ts":
                continue
            path = os.path.join(dirpath, fn)
            n, changes = transform(path)
            if n > 0:
                total_files += 1
                total_replacements += n
                print(f"{os.path.relpath(path, API_ROOT)}: {', '.join(changes)}")
    print(f"\nDone. {total_files} files, {total_replacements} console.error→logger.errorOf replacements.")
    # Special-case note for audio/vo
    vo = os.path.join(API_ROOT, "audio", "vo", "route.ts")
    if os.path.exists(vo):
        print(f"\nNote: {os.path.relpath(vo, API_ROOT)} uses a typeof-guarded console.error pattern")
        print("      that this script intentionally doesn't touch — left for manual review.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
