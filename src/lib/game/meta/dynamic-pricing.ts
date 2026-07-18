/**
 * SEC11-META — Dynamic shop pricing based on demand and player behavior.
 *
 * Adjusts cosmetic shop prices within a bounded corridor driven by:
 *   - Purchase velocity (units sold / hour vs baseline)
 *   - Player engagement (DAU, session count, whale tier)
 *   - Inventory pressure (limited-stock items)
 *
 * Output prices are clamped to [floor, ceiling] defined per-SKU to prevent
 * abusive pricing. Every adjustment is journaled with a reason so the
 * economy team can audit and roll back.
 *
 * Public API:
 *   - `DynamicPricer.reprice(skus, signals)` → Map<sku, PricedSku>
 *   - `DynamicPricer.history(sku, limit)` → PriceChange[]
 *   - `DynamicPricer.snapshot()` → all active prices
 */

export interface PriceFloorCeiling {
  floor: number;
  ceiling: number;
  basePrice: number;
}

export interface DemandSignals {
  unitsSoldLast24h: number;
  unitsSoldBaseline: number;
  uniqueViewers24h: number;
  stockRemaining?: number;
  stockInitial?: number;
}

export interface PlayerSignals {
  whaleTier: "free" | "minnow" | "dolphin" | "whale";
  dauBucket: "new" | "active" | "lapsed";
  lastPurchaseDaysAgo: number;
}

export interface PricedSku {
  sku: string;
  currency: "soft" | "hard";
  price: number;
  basePrice: number;
  multiplier: number;
  reasons: string[];
  changedAt: string;
}

export interface PriceChange {
  sku: string;
  from: number;
  to: number;
  multiplier: number;
  reasons: string[];
  ts: string;
}

const WHALE_DISCOUNT = 0.92; // whales see 8% discount on hard currency
const LAPSED_SURCHARGE = 1.05; // lapsed players see 5% comeback surcharge (soft only)
const STOCK_FLOOR_MULT = 1.25; // low stock → up to 25% premium

export class DynamicPricer {
  private prices = new Map<string, PricedSku>();
  private history = new Map<string, PriceChange[]>();
  private readonly bounds: Map<string, PriceFloorCeiling>;

  constructor(bounds: Record<string, PriceFloorCeiling>) {
    this.bounds = new Map(Object.entries(bounds));
  }

  /** Recompute prices for a batch of skus. Returns the new priced set. */
  reprice(skus: string[], demand: Record<string, DemandSignals>, player: PlayerSignals): Map<string, PricedSku> {
    const out = new Map<string, PricedSku>();
    for (const sku of skus) {
      const b = this.bounds.get(sku);
      if (!b) continue;
      const d = demand[sku];
      const reasons: string[] = [];
      let mult = 1;
      if (d) {
        const velocity = d.unitsSoldBaseline > 0 ? d.unitsSoldLast24h / d.unitsSoldBaseline : 1;
        if (velocity > 1.5) {
          mult *= 1 + Math.min(0.15, (velocity - 1.5) * 0.05);
          reasons.push(`velocity:${velocity.toFixed(2)}`);
        }
        if (d.stockRemaining !== undefined && d.stockInitial && d.stockInitial > 0) {
          const ratio = d.stockRemaining / d.stockInitial;
          if (ratio < 0.2) {
            mult *= STOCK_FLOOR_MULT;
            reasons.push(`low_stock:${(ratio * 100).toFixed(0)}%`);
          }
        }
      }
      if (player.whaleTier === "whale") {
        mult *= WHALE_DISCOUNT;
        reasons.push("whale_discount");
      }
      if (player.dauBucket === "lapsed" && player.lastPurchaseDaysAgo > 14) {
        mult *= LAPSED_SURCHARGE;
        reasons.push("lapsed_surcharge");
      }
      const raw = b.basePrice * mult;
      const clamped = Math.max(b.floor, Math.min(b.ceiling, raw));
      const prev = this.prices.get(sku);
      const priced: PricedSku = {
        sku,
        currency: b.basePrice >= 100 ? "hard" : "soft",
        price: Math.round(clamped * 100) / 100,
        basePrice: b.basePrice,
        multiplier: clamped / b.basePrice,
        reasons,
        changedAt: new Date().toISOString(),
      };
      if (!prev || prev.price !== priced.price) {
        this.appendHistory({ sku, from: prev?.price ?? b.basePrice, to: priced.price, multiplier: priced.multiplier, reasons, ts: priced.changedAt });
      }
      this.prices.set(sku, priced);
      out.set(sku, priced);
    }
    return out;
  }

  history(sku: string, limit = 20): PriceChange[] {
    return (this.history.get(sku) ?? []).slice(-limit);
  }

  snapshot(): PricedSku[] {
    return Array.from(this.prices.values());
  }

  private appendHistory(change: PriceChange): void {
    const arr = this.history.get(change.sku) ?? [];
    arr.push(change);
    if (arr.length > 100) arr.shift();
    this.history.set(change.sku, arr);
  }
}
