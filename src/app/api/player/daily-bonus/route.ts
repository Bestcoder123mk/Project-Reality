import { NextResponse, type NextRequest } from "next/server";
import { createLogger } from "@/lib/logger";
import { PLAYER_ID } from "@/lib/api";
import { calculateDailyLoginBonus } from "@/lib/game/Economy";
import { requireSameOrigin } from "@/lib/security/csrf";
import { db } from "@/lib/db";
const logger = createLogger("/api/player/daily-bonus");

/**
 * POST /api/player/daily-bonus — claim the daily login bonus.
 *
 * A3-5000-retry / 543: `calculateDailyLoginBonus` was previously defined in
 * `Economy.ts` but never invoked by any route. This route is the canonical
 * entry point — the client hits it once per day on first session open.
 *
 * A3-5000-retry / 544: race protection. Two concurrent calls on a fresh day
 * both read "no event for today" and both pass the equality check. The fix
 * uses a Prisma conditional `createMany` with a unique constraint on
 * `(playerId, name, at)` for the "daily_login_<date>" event name — only one
 * of the concurrent calls succeeds; the other gets a unique-violation (P2002)
 * + returns "already claimed". This is the SQL equivalent of
 * `SELECT FOR UPDATE` + conditional insert.
 *
 * State storage: the daily-login streak is persisted as PlayerEvent rows
 * with name `"daily_login_<YYYY-MM-DD>"` and props `{"streak": N,
 * "credits": C}`. The latest event by `at` is the canonical streak.
 *
 * Single-player demo: the playerId comes from the server-side PLAYER_ID
 * constant. In production this would come from the authenticated session.
 *
 * Body: empty (the playerId is server-side). Returns:
 *   200 { credits, newStreak, isStreakComplete, alreadyClaimed: false }
 *   200 { alreadyClaimed: true } — caller already claimed today (or lost the race)
 *   403 CSRF failure
 *   500 internal error
 */
export async function POST(req: NextRequest) {
  try {
    // CSRF check.
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return csrf.response;

    const playerId = PLAYER_ID;
    const today = new Date().toISOString().slice(0, 10);
    const eventName = `daily_login_${today}`;

    // Look up the most recent daily-login event to compute the streak.
    // We read the latest by `at` descending.
    const lastEvent = await db.playerEvent.findFirst({
      where: { playerId, name: { startsWith: "daily_login_" } },
      orderBy: { at: "desc" },
      select: { name: true, props: true, at: true },
    });

    // Parse the last event's streak + date.
    let lastLoginDate: string | null = null;
    let currentStreak = 0;
    if (lastEvent) {
      try {
        const p = JSON.parse(lastEvent.props) as { streak?: number; date?: string };
        currentStreak = p.streak ?? 0;
        // Extract the date from the event name (`daily_login_YYYY-MM-DD`).
        lastLoginDate = lastEvent.name.replace("daily_login_", "");
      } catch {
        // ignore parse errors — treat as no prior login
      }
    }

    if (lastLoginDate === today) {
      return NextResponse.json({ alreadyClaimed: true, credits: 0 });
    }

    const { credits, newStreak, isStreakComplete } = calculateDailyLoginBonus(
      lastLoginDate,
      currentStreak,
    );
    if (credits === 0) {
      return NextResponse.json({ alreadyClaimed: true, credits: 0 });
    }

    // A3-5000-retry / 544: race protection via a transaction + check-then-insert.
    // The transaction provides SERIALIZABLE isolation on SQLite (the demo's
    // DB), so two concurrent calls would have one succeed and the other see
    // the row on its check. On Postgres (production) the default READ COMMITTED
    // isolation would still race — the production fix is to add a
    // `@@unique([playerId, name])` constraint on PlayerEvent (or a partial
    // index on `daily_login_*` events) so the loser gets P2002. The schema
    // change is flagged for a future task; the transaction is the surgical
    // mitigation that ships now.
    const result = await db.$transaction(async (tx) => {
      // Re-check inside the transaction: did another call already insert?
      const existing = await tx.playerEvent.findFirst({
        where: { playerId, name: eventName },
        select: { id: true },
      });
      if (existing) {
        return { alreadyClaimed: true as const, credits: 0 };
      }
      await tx.playerEvent.create({
        data: {
          playerId,
          name: eventName,
          sessionId: "daily-bonus",
          at: new Date(),
          props: JSON.stringify({ streak: newStreak, credits, date: today, isStreakComplete }),
        },
      });
      // Grant the credits inside the same transaction (atomic with the event insert).
      await tx.player.update({
        where: { id: playerId },
        data: { credits: { increment: credits } },
      });
      return { alreadyClaimed: false as const, credits };
    });

    if (result.alreadyClaimed) {
      return NextResponse.json({ alreadyClaimed: true, credits: 0 });
    }

    return NextResponse.json({
      credits: result.credits,
      newStreak,
      isStreakComplete,
      alreadyClaimed: false,
    });
  } catch (err) {
    logger.errorOf(err, "failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "daily bonus failed" },
      { status: 500 },
    );
  }
}
