/**
 * Project Reality — Firebase Cloud Functions (2nd gen).
 *
 * Section I (Firebase & Backend).
 *
 * Server-side authoritative logic that runs in the Firebase Functions
 * runtime (Node 20). These functions are the trust boundary for any
 * state the player can't be allowed to mutate directly:
 *
 *   - Currency / XP awards (computed from validated match results)
 *   - Battle pass progression (tier-ups, claims)
 *   - Shop receipt verification (Google Play / App Store)
 *   - Seasonal rollover cron (weekly battle pass refresh)
 *   - Player create trigger (default profile + starter inventory)
 *
 * The Admin SDK bypasses Firestore Security Rules — these functions are
 * the only path that writes to the protected fields (credits, xp, tier).
 *
 * Deploy:
 *   cd functions && npm install
 *   firebase deploy --only functions
 *
 * Local emulation:
 *   firebase emulators:start
 *   (the firebase.json `emulators` block configures the ports)
 */

import { setGlobalOptions } from "firebase-functions/v2";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";

import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

// ─── Init ──────────────────────────────────────────────────────────────────

setGlobalOptions({
  region: "us-central1",
  runtime: "nodejs20",
  maxInstances: 100,
});

initializeApp();
const db = getFirestore();
const auth = getAuth();

// ─── Constants ─────────────────────────────────────────────────────────────

const STARTER_CREDITS = 500;
const STARTER_WEAPONS = ["ak74", "mp7", "usp"];
const BATTLEPASS_TIER_SIZE = 1000;
const BATTLEPASS_MAX_TIER = 50;

// ─── onPlayerCreate ────────────────────────────────────────────────────────
//
// Triggered when a new `players/{uid}` document is created (either by the
// client on first sign-in or by this function). Seeds the starter
// inventory + the current season's battle pass row.

export const onPlayerCreate = onDocumentCreated(
  "players/{uid}",
  async (event) => {
    const uid = event.params.uid;
    const snapshot = event.data;
    if (!snapshot) {
      logger.warn(`[onPlayerCreate] no data for ${uid}`);
      return;
    }

    logger.info(`[onPlayerCreate] seeding starter state for ${uid}`);

    // Set the Auth user's display name (so it shows up in the leaderboard).
    try {
      const user = await auth.getUser(uid);
      const desiredName = user.displayName ?? "Operator";
      if (!user.displayName) {
        await auth.updateUser(uid, { displayName: desiredName });
      }
    } catch (err) {
      logger.warn(`[onPlayerCreate] could not read Auth user ${uid}:`, err);
    }

    // Seed starter inventory (weapons) — idempotent (uses set with merge).
    const batch = db.batch();
    for (const slug of STARTER_WEAPONS) {
      const ref = db.doc(`players/${uid}/inventory/${slug}`);
      batch.set(
        ref,
        {
          slug,
          type: "WEAPON",
          acquiredAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
    // Seed current-season battle pass row.
    const season = 1;
    const bpRef = db.doc(`battlepass/${uid}_${season}`);
    batch.set(
      bpRef,
      {
        uid,
        season,
        tier: 0,
        xp: 0,
        premium: false,
        claimedTiers: [],
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    await batch.commit();
    logger.info(`[onPlayerCreate] seeded starter state for ${uid}`);
  },
);

// ─── processMatchResult ───────────────────────────────────────────────────
//
// HTTPS callable. The client posts a match summary (kills, deaths, map,
// mode). The function validates the inputs, computes XP + credits, and
// atomically updates the player's profile + battle pass + match history.
//
// The signature is the canonical "server-authoritative spend" pattern —
// the client never writes to `credits`, `xp`, or `tier` directly.

interface MatchResultPayload {
  uid: string;
  map: string;
  mode: string;
  result: "VICTORY" | "DEFEAT" | "DRAW" | "INCOMPLETE";
  kills: number;
  deaths: number;
  assists: number;
  startedAt: number;
  endedAt: number;
  weaponStats?: Record<string, { kills: number; shots: number; hits: number }>;
}

interface MatchResultResponse {
  ok: boolean;
  xpEarned: number;
  creditsEarned: number;
  newLevel?: number;
  newTier?: number;
  error?: string;
}

export const processMatchResult = onRequest(
  { cors: true, maxInstances: 50 },
  async (req, res) => {
    // Auth check — caller must be signed-in (App Check token verified
    // separately by Firebase when `enforceAppCheck` is on).
    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
    let callerUid: string;
    try {
      const decoded = await auth.verifyIdToken(token);
      callerUid = decoded.uid;
    } catch {
      res.status(401).json({ ok: false, error: "Invalid token" });
      return;
    }

    const payload = req.body as MatchResultPayload;
    if (!payload || payload.uid !== callerUid) {
      res.status(403).json({ ok: false, error: "uid mismatch" });
      return;
    }

    // Validate + clamp inputs (defense-in-depth — never trust the client).
    const kills = clampInt(payload.kills, 0, 200);
    const deaths = clampInt(payload.deaths, 0, 200);
    const assists = clampInt(payload.assists, 0, 200);
    const map = String(payload.map ?? "").slice(0, 64);
    const mode = String(payload.mode ?? "").slice(0, 32);
    const result = (
      ["VICTORY", "DEFEAT", "DRAW", "INCOMPLETE"].includes(payload.result)
        ? payload.result
        : "INCOMPLETE"
    ) as MatchResultPayload["result"];

    // ─── Award formula ───────────────────────────────────────────────
    //   XP      = kills*100 + assists*50 + result_bonus
    //   Credits = kills*25 + assists*10 + result_bonus/2
    //   result_bonus: VICTORY=500, DEFEAT=100, DRAW=250, INCOMPLETE=0
    const resultBonus = {
      VICTORY: 500,
      DEFEAT: 100,
      DRAW: 250,
      INCOMPLETE: 0,
    }[result];
    const xpEarned = kills * 100 + assists * 50 + resultBonus;
    const creditsEarned = Math.floor(
      kills * 25 + assists * 10 + resultBonus / 2,
    );

    // Atomic transaction: update profile + battle pass + write match doc.
    const playerRef = db.doc(`players/${callerUid}`);
    const bpRef = db.doc(`battlepass/${callerUid}_1`);
    const matchRef = db.collection("matches").doc();

    try {
      const result_data = await db.runTransaction(async (tx) => {
        const playerSnap = await tx.get(playerRef);
        if (!playerSnap.exists) {
          throw new Error("player doc missing");
        }
        const player = playerSnap.data() as {
          credits: number;
          level: number;
          xp: number;
        };

        const newCredits = (player.credits ?? 0) + creditsEarned;
        const newXp = (player.xp ?? 0) + xpEarned;
        // Level = floor(xp / 1000) + 1, capped at 100.
        const newLevel = Math.min(100, Math.floor(newXp / 1000) + 1);

        tx.update(playerRef, {
          credits: newCredits,
          xp: newXp,
          level: newLevel,
          updatedAt: FieldValue.serverTimestamp(),
        });

        // Battle pass — same XP pool, capped at maxTier.
        const bpSnap = await tx.get(bpRef);
        const bp = bpSnap.exists
          ? (bpSnap.data() as { xp: number; tier: number })
          : { xp: 0, tier: 0 };
        const newBpXp = (bp.xp ?? 0) + xpEarned;
        const newTier = Math.min(
          BATTLEPASS_MAX_TIER,
          Math.floor(newBpXp / BATTLEPASS_TIER_SIZE),
        );
        tx.set(
          bpRef,
          {
            uid: callerUid,
            season: 1,
            xp: newBpXp,
            tier: newTier,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        // Write-once match doc.
        tx.create(matchRef, {
          matchId: matchRef.id,
          uid: callerUid,
          map,
          mode,
          result,
          kills,
          deaths,
          assists,
          xpEarned,
          creditsEarned,
          startedAt: payload.startedAt,
          endedAt: payload.endedAt ?? Date.now(),
          weaponStats: payload.weaponStats ?? {},
          endedAtServer: FieldValue.serverTimestamp(),
        });

        return { newLevel, newTier };
      });

      const response: MatchResultResponse = {
        ok: true,
        xpEarned,
        creditsEarned,
        newLevel: result_data.newLevel,
        newTier: result_data.newTier,
      };
      res.json(response);
      logger.info(
        `[processMatchResult] uid=${callerUid} xp=+${xpEarned} credits=+${creditsEarned}`,
      );
    } catch (err) {
      logger.error(`[processMatchResult] failed for ${callerUid}:`, err);
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : "transaction failed",
      });
    }
  },
);

// ─── weeklyRollover ────────────────────────────────────────────────────────
//
// Scheduled function — runs every Monday at 09:00 UTC. Rolls the battle
// pass season forward (increments `currentSeason` in the `config` doc)
// and resets every player's battle pass row for the new season.
//
// In production this would also archive the previous season's leaderboard
// + send push notifications. The skeleton here covers the data layer.

export const weeklyRollover = onSchedule(
  {
    schedule: "0 9 * * 1", // Mon 09:00 UTC
    timeZone: "UTC",
    maxInstances: 1,
  },
  async () => {
    logger.info("[weeklyRollover] starting");

    // Read current season from the config doc (singleton).
    const configRef = db.doc("config/battlepass");
    const configSnap = await configRef.get();
    const config = configSnap.exists
      ? (configSnap.data() as { currentSeason: number })
      : { currentSeason: 1 };
    const newSeason = (config.currentSeason ?? 1) + 1;

    // Update the config doc.
    await configRef.set(
      {
        currentSeason: newSeason,
        lastRolloverAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // Iterate all players + seed the new season's battle pass row.
    // For very large player counts this would be a sharded Batch write;
    // here we use a simple paginated batch.
    const batchSize = 400;
    let lastUid: string | null = null;
    let totalSeeded = 0;

    while (true) {
      let q = db.collection("players").orderBy("uid").limit(batchSize);
      if (lastUid) q = q.startAfter(lastUid);
      const snap = await q.get();
      if (snap.empty) break;

      const batch = db.batch();
      snap.docs.forEach((d) => {
        const uid = d.id;
        const bpRef = db.doc(`battlepass/${uid}_${newSeason}`);
        batch.set(bpRef, {
          uid,
          season: newSeason,
          tier: 0,
          xp: 0,
          premium: false,
          claimedTiers: [],
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
      await batch.commit();
      totalSeeded += snap.size;
      lastUid = snap.docs[snap.docs.length - 1].id;
      if (snap.size < batchSize) break;
    }

    logger.info(
      `[weeklyRollover] season ${newSeason} seeded for ${totalSeeded} players`,
    );
  },
);

// ─── verifyReceipt ─────────────────────────────────────────────────────────
//
// HTTPS callable. The client posts a Google Play / App Store receipt.
// The function verifies it server-side (via the platform's API) and
// grants the purchased credits/premium battle pass.
//
// The actual verification HTTP call is stubbed here (the platform API
// requires service-account credentials not present in this repo). The
// structure is in place; replace the stubbed section with the real
// Google Play Developer API / App Store Server API call.

interface ReceiptPayload {
  uid: string;
  platform: "google_play" | "app_store";
  productId: string;
  receipt: string; // base64-encoded receipt / purchase token
}

interface ReceiptResponse {
  ok: boolean;
  granted?: {
    credits?: number;
    premiumBattlePass?: boolean;
  };
  error?: string;
}

const PRODUCT_CATALOG: Record<
  string,
  { credits?: number; premiumBattlePass?: boolean }
> = {
  "credits_starter": { credits: 1000 },
  "credits_pro": { credits: 5000 },
  "credits_mega": { credits: 15000 },
  "battlepass_premium": { premiumBattlePass: true },
};

export const verifyReceipt = onRequest(
  { cors: true, maxInstances: 20 },
  async (req, res) => {
    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
    let callerUid: string;
    try {
      const decoded = await auth.verifyIdToken(token);
      callerUid = decoded.uid;
    } catch {
      res.status(401).json({ ok: false, error: "Invalid token" });
      return;
    }

    const payload = req.body as ReceiptPayload;
    if (!payload || payload.uid !== callerUid) {
      res.status(403).json({ ok: false, error: "uid mismatch" });
      return;
    }

    const product = PRODUCT_CATALOG[payload.productId];
    if (!product) {
      res.status(400).json({ ok: false, error: "unknown product" });
      return;
    }

    // ─── Receipt verification stub ───────────────────────────────────
    //
    // Replace this block with a real call to:
    //   - Google Play Developer API: purchases.products.get
    //   - App Store Server API: verifyReceipt
    //
    // The stub records the receipt in a `receipts` collection (idempotent
    // on the receipt hash) so duplicate submissions are dedup'd.
    const receiptHash = await hashReceipt(payload.receipt);
    const receiptRef = db.doc(`receipts/${receiptHash}`);
    const receiptSnap = await receiptRef.get();
    if (receiptSnap.exists) {
      res.json({
        ok: true,
        granted: product,
        error: "duplicate (already granted)",
      });
      return;
    }

    try {
      // Grant the purchased item atomically.
      const playerRef = db.doc(`players/${callerUid}`);
      const batch = db.batch();
      batch.set(receiptRef, {
        uid: callerUid,
        platform: payload.platform,
        productId: payload.productId,
        verifiedAt: FieldValue.serverTimestamp(),
      });
      if (product.credits) {
        batch.update(playerRef, {
          credits: FieldValue.increment(product.credits),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      if (product.premiumBattlePass) {
        const bpRef = db.doc(`battlepass/${callerUid}_1`);
        batch.set(
          bpRef,
          {
            uid: callerUid,
            season: 1,
            premium: true,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }
      await batch.commit();

      const response: ReceiptResponse = { ok: true, granted: product };
      res.json(response);
      logger.info(
        `[verifyReceipt] uid=${callerUid} product=${payload.productId} granted`,
      );
    } catch (err) {
      logger.error(`[verifyReceipt] failed for ${callerUid}:`, err);
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : "verification failed",
      });
    }
  },
);

// ─── helpers ───────────────────────────────────────────────────────────────

function clampInt(v: unknown, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function hashReceipt(receipt: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(receipt).digest("hex").slice(0, 64);
}
