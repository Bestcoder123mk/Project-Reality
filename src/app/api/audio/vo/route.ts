/**
 * SEC8-AUDIO (prompt 68) — TTS endpoint for voice-over lines.
 *
 * POST /api/audio/vo  { text: string, voice?: VoVoice, context?: VoCombatContext }
 *   → 200 audio/wav  (binary WAV, 24 kHz)
 *   → 400 on bad input
 *   → 500 on TTS failure
 *
 * Results are cached in-memory by `${voice}:${text}` so repeated callouts
 * (announcer lines, kill confirmations) are instant and free. The cache is
 * per-process (no disk persistence) — fine for a single-instance dev server.
 *
 * Section G (#821): if `context` is supplied (one of
 * "calm" | "engaged" | "suppressed" | "wounded"), the line text is mapped
 * through the context-variant table before TTS so the same line id
 * ("reload", "out_of_ammo", "need_medic") produces a contextually-appropriate
 * phrasing. The TTS speed is also nudged: suppressed/wounded lines are 0.9×
 * (slower, more deliberate), engaged lines are 1.05× (faster, urgent).
 *
 * The z-ai-web-dev-sdk MUST stay server-side (per the TTS skill); we dynamic-
 * import it so the bundle stays light if the endpoint is never called.
 *
 * ─── G-5000 prompt mapping ────────────────────────────────────────────────
 *   #3444 → G #821 — VO line context (server side)   [POST body `context` field → context-variant table + speed nudge; client-side VoLineContextG (SectionG.ts) rewrites text before fetch]
 *   #3534 → G #821 — (cross-ref to #3444)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/lib/logger";
const logger = createLogger("/api/audio/vo");
import { audioVoSchema } from "@/lib/security/validation";
import { readBoundedJson } from "@/lib/security/body-size";
import { requireSameOrigin } from "@/lib/security/csrf";
import { sanitizeFreeText } from "@/lib/security/sanitize";
import { rateLimit, playerRateKey } from "@/lib/security/rate-limit";
import { PLAYER_ID } from "@/lib/seed";

export const runtime = "nodejs";
// VO callouts are dynamic — never cache at the CDN layer (cache lives in-process).
export const dynamic = "force-dynamic";

type VoVoice =
  | "tongtong"
  | "chuichui"
  | "xiaochen"
  | "jam"
  | "kazi"
  | "douji"
  | "luodo";

const MAX_TEXT_LEN = 1024;
const MAX_CACHE_ENTRIES = 256;

/** Task-1 (SEC) item 3 — rate limit TTS (it's an LLM call, expensive). */
const VO_RATE_LIMIT = { max: 30, windowMs: 60_000, label: "audio-vo" };

// LRU-ish cache: Map preserves insertion order, so we evict the oldest entry
// when the cap is hit.
const cache = new Map<string, Buffer>();
// Concurrent-fetch dedupe: in-flight promises per key.
const inflight = new Map<string, Promise<Buffer>>();

function cacheGet(key: string): Buffer | undefined {
  const v = cache.get(key);
  if (v) {
    // Refresh LRU position.
    cache.delete(key);
    cache.set(key, v);
  }
  return v;
}

function cacheSet(key: string, value: Buffer): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    // Evict oldest entry.
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, value);
}

async function synthesize(text: string, voice: VoVoice, speed: number = 1.0): Promise<Buffer> {
  const ZAI = (await import("z-ai-web-dev-sdk")).default;
  const zai = await ZAI.create();
  const response = await zai.audio.tts.create({
    input: text,
    voice,
    speed,
    response_format: "wav",
    stream: false,
  });
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(new Uint8Array(arrayBuffer));
}

/**
 * Section G (#821) — line-context variants. Mirrors the client-side
 * `contextForLine` table from `audio/SectionG.ts`. When a VO request
 * supplies a `context` field, the line id is mapped through this table to
 * produce a context-appropriate phrasing before TTS.
 */
const LINE_CONTEXT_VARIANTS: Record<string, Record<"calm" | "engaged" | "suppressed" | "wounded", string>> = {
  reload: {
    calm: "Reloading. Cover me.",
    engaged: "Reloading!",
    suppressed: "RELOADING! COVER!",
    wounded: "Reloading. I'm hit.",
  },
  out_of_ammo: {
    calm: "Out of ammo.",
    engaged: "I'm dry!",
    suppressed: "I'M OUT! HELP!",
    wounded: "Out. I'm hurt.",
  },
  need_medic: {
    calm: "I could use a medic.",
    engaged: "Need a medic!",
    suppressed: "MEDIC! NOW!",
    wounded: "Medic. Please.",
  },
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // Task-1 (SEC) items 3, 5, 6, 8, 23 — CSRF + rate-limit + body-size +
    // Zod + sanitize free-text.
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return csrf.response;
    const rl = rateLimit(playerRateKey(PLAYER_ID, "audio-vo"), VO_RATE_LIMIT);
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many TTS requests", retryAfterMs: rl.retryAfterMs },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
        },
      );
    }
    const { json, error: bodyError } = await readBoundedJson(req, { maxBytes: 2048 });
    if (bodyError) return bodyError;
    const parsed = audioVoSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid body. Expected { text: non-empty string (≤1024), voice? }.", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    // Sanitize the TTS input — the text is fed to the LLM, so prompt-
    // injection control chars / zero-width chars / HTML tags must be stripped.
    const trimmed = (sanitizeFreeText(parsed.data.text, { maxLength: MAX_TEXT_LEN, stripTags: true }) ?? "").trim();
    if (trimmed.length === 0) {
      return NextResponse.json({ error: "text (non-empty string) is required" }, { status: 400 });
    }
    const v: VoVoice = parsed.data.voice ?? "xiaochen";

    // Section G (#821) — line context. If the caller supplied a `context`
    // field ("calm" | "engaged" | "suppressed" | "wounded"), re-map a known
    // line id ("reload" / "out_of_ammo" / "need_medic") through the variant
    // table. Unknown ids pass through unchanged. The TTS speed is also
    // nudged per context (engaged = 1.05×, suppressed/wounded = 0.9×).
    const contextRaw = (json as { context?: unknown } | null)?.context;
    const context =
      typeof contextRaw === "string" &&
      ["calm", "engaged", "suppressed", "wounded"].includes(contextRaw)
        ? (contextRaw as "calm" | "engaged" | "suppressed" | "wounded")
        : null;
    let finalText = trimmed;
    let speed = 1.0;
    if (context) {
      const mapped = LINE_CONTEXT_VARIANTS[trimmed.toLowerCase()];
      if (mapped) finalText = mapped[context] ?? trimmed;
      speed = context === "engaged" ? 1.05 : context === "calm" ? 1.0 : 0.9;
    }

    const key = `${v}:${finalText}:${speed.toFixed(2)}`;

    // 1. In-process cache hit.
    const cached = cacheGet(key);
    if (cached) {
      // Copy Node Buffer → fresh Uint8Array<ArrayBuffer> so it satisfies
      // the DOM BodyInit union (Buffer<ArrayBufferLike> doesn't).
      const bytes = new Uint8Array(cached);
      return new NextResponse(bytes, {
        status: 200,
        headers: {
          "Content-Type": "audio/wav",
          "Content-Length": cached.length.toString(),
          "Cache-Control": "private, max-age=86400",
          "X-VO-Cache": "HIT",
        },
      });
    }

    // 2. Dedupe concurrent identical requests.
    let promise = inflight.get(key);
    if (!promise) {
      promise = synthesize(finalText, v, speed).then((buf) => {
        cacheSet(key, buf);
        inflight.delete(key);
        return buf;
      }).catch((err) => {
        inflight.delete(key);
        throw err;
      });
      inflight.set(key, promise);
    }

    const buf = await promise;
    const missBytes = new Uint8Array(buf);
    return new NextResponse(missBytes, {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": buf.length.toString(),
        "Cache-Control": "private, max-age=86400",
        "X-VO-Cache": "MISS",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "TTS synthesis failed";
    logger.errorOf(err, "TTS synthesis failed", { msg });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** GET → 405 (only POST is supported). */
export function GET(): NextResponse {
  return NextResponse.json(
    { error: "Method Not Allowed — POST { text, voice? } instead." },
    { status: 405 },
  );
}
