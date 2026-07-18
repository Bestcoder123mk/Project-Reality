import { NextResponse, type NextRequest } from "next/server";
import { createLogger } from "@/lib/logger";
import { ensureSeed } from "@/lib/api";
const logger = createLogger("/api/shop/weekly-deals");
import { applyShopRotation, tickForPlayerRoute } from "@/lib/game/meta/calendar";
import { TUNED_WEAPON_PRICES, TUNED_ATTACHMENT_PRICES, TUNED_SKIN_PRICES, applyPriceBalance } from "@/lib/game/Economy";

/**
 * GET /api/shop/weekly-deals — return the current weekly-deals / rotating-
 * shop slot configuration. The client uses this to render the weekly
 * deals section of the shop (separate from the always-available catalog).
 *
 * I-5000 #3839 — Weekly-deals / rotating shop. The active
 * `shop_rotation` scheduled event (managed via /api/admin/calendar)
 * drives which items are on sale this week. When no event is active,
 * the route returns the default weekly deals (a curated subset of the
 * catalog with a 10% discount). When an event is active, the route
 * returns only the items listed in the event's payload, each with the
 * event's implicit discount (handled client-side via the rotation slug).
 *
 * I-5000 #3829 — player-route auto-tick. The route calls
 * `tickForPlayerRoute` before reading so scheduled→active + active→ended
 * transitions happen on player requests (not just admin requests).
 */
export async function GET(_req: NextRequest) {
  try {
    await ensureSeed();
    // Auto-tick the calendar so the rotation flips at the scheduled time.
    await tickForPlayerRoute();

    const rotation = await applyShopRotation();
    if (rotation) {
      // Active rotation event — return its slots.
      return NextResponse.json({
        rotationSlug: rotation.rotationSlug,
        slots: rotation.slots,
        discounted: true,
        source: "scheduled_event",
      });
    }

    // No active rotation — return the default weekly deals.
    // Curated subset: 3 weapons + 2 attachments + 2 skins, each with a
    // 10% discount applied via `applyPriceBalance` (the global price
    // multiplier can further adjust this via ECONOMY_TUNING).
    const defaultDeals = [
      { kind: "WEAPON", slug: "m4", name: "M4 Carbine", basePrice: TUNED_WEAPON_PRICES.m4 ?? 2500 },
      { kind: "WEAPON", slug: "p90", name: "P90 SMG", basePrice: TUNED_WEAPON_PRICES.p90 ?? 1800 },
      { kind: "WEAPON", slug: "scout", name: "Scout Sniper", basePrice: TUNED_WEAPON_PRICES.scout ?? 2000 },
      { kind: "ATTACHMENT", slug: "suppressor", name: "Suppressor", basePrice: TUNED_ATTACHMENT_PRICES.suppressor ?? 1200 },
      { kind: "ATTACHMENT", slug: "acog", name: "ACOG Scope", basePrice: TUNED_ATTACHMENT_PRICES.acog ?? 1500 },
      { kind: "SKIN", slug: "tiger", name: "Tiger Stripe", basePrice: TUNED_SKIN_PRICES.tiger ?? 1800 },
      { kind: "SKIN", slug: "carbon", name: "Carbon Fiber", basePrice: TUNED_SKIN_PRICES.carbon ?? 1200 },
    ].map((d) => ({
      ...d,
      // 10% discount via the price-balance pipeline.
      discountedPrice: applyPriceBalance(Math.round(d.basePrice * 0.9)),
    }));

    return NextResponse.json({
      rotationSlug: "default_weekly",
      slots: defaultDeals.map((d) => d.slug),
      deals: defaultDeals,
      discounted: true,
      source: "default",
    });
  } catch (err) {
    logger.errorOf(err, "failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "weekly-deals failed" },
      { status: 500 },
    );
  }
}
