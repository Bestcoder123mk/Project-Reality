/**
 * Task-1 (SEC) item 6 — Request body size limit.
 *
 * Next.js does not enforce a body-size limit by default. A malicious
 * client can POST a 10GB JSON body to `/api/support/bug-report` and OOM
 * the server before Zod even sees the parsed value. This module reads
 * the request body as a bounded ArrayBuffer (capped at `maxBytes`) and
 * returns the parsed JSON.
 *
 * Public API:
 *
 *   const { json, error } = await readBoundedJson(req, { maxBytes: 16_000 });
 *   if (error) return error; // 413 or 400 already formatted
 *   // ... use `json` ...
 *
 * Default cap is 64KB — enough for any legitimate payload in this app
 * (the largest is the bug-report `replaySnippet`, truncated to 16KB by
 * the existing support route's Zod schema). Per-route overrides set a
 * tighter cap where appropriate.
 */

import { NextResponse, type NextRequest } from "next/server";

export interface BoundedJsonOptions {
  /** Hard cap on the body size in bytes. Default 64KB. */
  maxBytes?: number;
}

export interface BoundedJsonResult<T = unknown> {
  json: T | null;
  error: NextResponse | null;
}

/**
 * Read the request body as JSON with a hard size cap. Returns either the
 * parsed JSON or a pre-formatted error response the caller returns
 * immediately.
 *
 *   const { json, error } = await readBoundedJson<MySchema>(req, { maxBytes: 16_000 });
 *   if (error) return error;
 *   // json is T (not null) here.
 */
export async function readBoundedJson<T = unknown>(
  req: NextRequest,
  opts: BoundedJsonOptions = {},
): Promise<BoundedJsonResult<T>> {
  const maxBytes = opts.maxBytes ?? 65_536;

  // The Next.js Web `Request.body` is a ReadableStream. We read it
  // chunk-by-chunk, accumulating into a single Buffer up to maxBytes.
  // If the running total exceeds maxBytes, abort + return 413.
  const reader = req.body?.getReader();
  if (!reader) {
    // No body — caller should treat as null.
    return { json: null, error: null };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* best-effort */
        }
        return {
          json: null,
          error: NextResponse.json(
            {
              error: `Request body exceeds ${maxBytes} byte limit`,
              limit: maxBytes,
            },
            { status: 413 },
          ),
        };
      }
      chunks.push(value);
    }
  }

  // Concatenate + parse.
  const buf = Buffer.concat(chunks);
  if (buf.length === 0) {
    return { json: null, error: null };
  }
  try {
    const json = JSON.parse(buf.toString("utf8")) as T;
    return { json, error: null };
  } catch {
    return {
      json: null,
      error: NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 },
      ),
    };
  }
}

/**
 * Read the request body as text with a hard size cap. Used by routes
 * that want to inspect the raw text before parsing (rare; usually
 * `readBoundedJson` is what you want).
 */
export async function readBoundedText(
  req: NextRequest,
  opts: BoundedJsonOptions = {},
): Promise<{ text: string | null; error: NextResponse | null }> {
  const maxBytes = opts.maxBytes ?? 65_536;
  const reader = req.body?.getReader();
  if (!reader) return { text: null, error: null };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* best-effort */
        }
        return {
          text: null,
          error: NextResponse.json(
            { error: `Request body exceeds ${maxBytes} byte limit` },
            { status: 413 },
          ),
        };
      }
      chunks.push(value);
    }
  }
  return { text: Buffer.concat(chunks).toString("utf8"), error: null };
}
