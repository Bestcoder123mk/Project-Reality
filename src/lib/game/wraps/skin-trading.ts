/**
 * Section E — Skin trading system between players.
 *
 * Players can trade owned skins with each other. This module is the
 * authoritative logic layer for a trade session: it validates ownership,
 * computes trade-value modifiers (wear, rarity, demand), enforces the
 * per-player daily trade limit + trade-cooldown, and produces a
 * deterministic trade receipt that the backend (Firestore transaction)
 * commits atomically.
 *
 * Trade flow:
 *   1. Player A creates a `TradeOffer` with the skins they're offering +
 *      optionally the skins they want from Player B (or a credit ask).
 *   2. Player B reviews, optionally counter-offers, accepts or declines.
 *   3. On accept, the system calls `executeTrade()` which validates the
 *      final offer, computes the value differential (for fee + tax
 *      computation), and returns a `TradeReceipt` for the backend to commit.
 *   4. The backend (Firestore transaction) reads the receipt, performs the
 *      atomic inventory swap, and records the trade in the trade history.
 *
 * Anti-abuse:
 *   - Per-player daily trade limit (default 10).
 *   - Per-player trade cooldown (default 60s between trades).
 *   - Trade-tax on high-value skins (legendary+ / mythic) — 5% / 10%.
 *   - New-account trade lock (accounts < 7 days old can't trade).
 *   - Trade-hold (24h) on mythic skins (high-value, can't be reversed).
 */
import type { SkinCatalogEntry, SkinRarity } from "./skin-catalog";
import { wearTradeValueMult, type SkinWearState } from "./wear-system";

// ─── Public types ───────────────────────────────────────────────────────────

export interface OwnedSkin {
  /** Inventory item ID (unique per owned instance). */
  itemId: string;
  /** Catalog slug. */
  skinSlug: string;
  /** Catalog entry (denormalized for offline validation). */
  entry: SkinCatalogEntry;
  /** Wear state for this owned instance. */
  wear: SkinWearState;
  /** Whether the skin is currently equipped (equipped skins can't be traded). */
  equipped: boolean;
  /** Whether the skin is trade-locked (recently acquired). */
  tradeLockedUntil: number; // epoch ms
  /** Acquisition timestamp (epoch ms). */
  acquiredAt: number;
}

export type TradeStatus =
  | "pending"     // offer sent, awaiting response
  | "accepted"    // accepted by recipient, ready to execute
  | "declined"    // declined by recipient
  | "cancelled"   // cancelled by sender
  | "expired"     // offer expired (no response in 24h)
  | "executed"    // trade completed successfully
  | "failed";     // execution failed (validation error)

export interface TradeSide {
  playerId: string;
  /** Skins offered by this side. */
  offeredSkins: OwnedSkin[];
  /** Credits offered by this side. */
  offeredCredits: number;
  /** Skins requested from the other side (optional — for direct asks). */
  requestedSkins: string[]; // itemIds
}

export interface TradeOffer {
  id: string;
  /** ISO timestamp the offer was created. */
  createdAt: number;
  /** ISO timestamp the offer expires. */
  expiresAt: number;
  /** Sender (the player who initiated). */
  sender: TradeSide;
  /** Recipient (the player receiving the offer). */
  recipient: TradeSide;
  status: TradeStatus;
  /** Optional message from the sender. */
  message?: string;
  /** Counter-offers (negotiation history). */
  counterHistory: TradeOffer[];
}

export interface TradeReceipt {
  offerId: string;
  /** Final state — both sides' items + credits. */
  sender: TradeSide;
  recipient: TradeSide;
  /** Computed total value on each side (credits). */
  senderValue: number;
  recipientValue: number;
  /** Trade tax (credits) — deducted from the higher-value side. */
  tax: number;
  /** Net credit transfer (positive = sender pays recipient). */
  netCreditTransfer: number;
  /** Item transfers (from → to). */
  transfers: { itemId: string; fromPlayer: string; toPlayer: string }[];
  /** Computed at timestamp (epoch ms). */
  executedAt: number;
}

export interface TradeValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

// ─── Trade config ───────────────────────────────────────────────────────────

export interface TradeConfig {
  /** Per-player daily trade limit. */
  dailyLimit: number;
  /** Cooldown between trades (ms). */
  cooldownMs: number;
  /** Offer expiry (ms). */
  offerExpiryMs: number;
  /** Trade tax per rarity (fraction 0..1). */
  taxByRarity: Record<SkinRarity, number>;
  /** New-account lock (ms since account creation before trading is allowed). */
  newAccountLockMs: number;
  /** Trade-hold for mythic skins (ms). */
  mythicHoldMs: number;
  /** Max skins per side in a single trade. */
  maxSkinsPerSide: number;
  /** Max credits per side. */
  maxCreditsPerSide: number;
}

export const DEFAULT_TRADE_CONFIG: TradeConfig = {
  dailyLimit: 10,
  cooldownMs: 60_000,
  offerExpiryMs: 24 * 60 * 60 * 1000, // 24h
  taxByRarity: {
    COMMON: 0,
    RARE: 0,
    EPIC: 0.02,
    LEGENDARY: 0.05,
    MYTHIC: 0.10,
  },
  newAccountLockMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  mythicHoldMs: 24 * 60 * 60 * 1000, // 24h
  maxSkinsPerSide: 8,
  maxCreditsPerSide: 100_000,
};

// ─── Value computation ──────────────────────────────────────────────────────

/**
 * Compute the trade value of an owned skin. The base value is the catalog
 * price, modified by:
 *   - Wear tier multiplier (factory new = 100%, battle scarred = 45%).
 *   - Trade-lock discount (recently acquired skins sell for 90% — discourages
 *     flipping).
 *   - Equipped penalty (equipped skins can't be traded — value 0).
 */
export function computeSkinValue(skin: OwnedSkin, now: number = Date.now()): number {
  if (skin.equipped) return 0;
  if (now < skin.tradeLockedUntil) return 0;
  const base = skin.entry.price;
  const wearMult = wearTradeValueMult(skin.wear.wearFloat);
  // Recently acquired (within 7 days) → 90% value (anti-flip).
  const recentlyAcquired = now - skin.acquiredAt < 7 * 24 * 60 * 60 * 1000;
  const flipMult = recentlyAcquired ? 0.9 : 1.0;
  return Math.round(base * wearMult * flipMult);
}

/** Compute the total value of a trade side. */
export function computeSideValue(side: TradeSide, now: number = Date.now()): number {
  const skinsValue = side.offeredSkins.reduce((sum, s) => sum + computeSkinValue(s, now), 0);
  return skinsValue + side.offeredCredits;
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate a trade offer. Returns ok=true if the trade can proceed, or a list
 * of errors / warnings. Errors block execution; warnings surface to the UI.
 *
 * Checks:
 *   - Both sides have at least one item or credits.
 *   - No skin is equipped (equipped skins can't be traded).
 *   - No skin is trade-locked (recently acquired).
 *   - Per-side skin count ≤ maxSkinsPerSide.
 *   - Per-side credits ≤ maxCreditsPerSide.
 *   - Value differential is within reason (no obviously one-sided trades —
 *     surfaces a warning, doesn't block).
 *   - Mythic skins on either side get a 24h hold warning (post-trade).
 *   - Sender is not on cooldown.
 *   - Sender has not exceeded daily trade limit.
 */
export function validateTradeOffer(
  offer: TradeOffer,
  senderDailyCount: number,
  senderLastTradeAt: number,
  senderAccountAge: number,
  config: TradeConfig = DEFAULT_TRADE_CONFIG,
  now: number = Date.now(),
): TradeValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Account age check.
  if (senderAccountAge < config.newAccountLockMs) {
    errors.push("Account is too new to trade (7-day lock)");
  }

  // Cooldown check.
  if (now - senderLastTradeAt < config.cooldownMs) {
    errors.push(`Trade cooldown active (${Math.ceil((config.cooldownMs - (now - senderLastTradeAt)) / 1000)}s remaining)`);
  }

  // Daily limit check.
  if (senderDailyCount >= config.dailyLimit) {
    errors.push(`Daily trade limit reached (${config.dailyLimit} trades/day)`);
  }

  // Per-side skin count.
  if (offer.sender.offeredSkins.length > config.maxSkinsPerSide) {
    errors.push(`Sender offers too many skins (max ${config.maxSkinsPerSide})`);
  }
  if (offer.recipient.offeredSkins.length > config.maxSkinsPerSide) {
    errors.push(`Recipient offers too many skins (max ${config.maxSkinsPerSide})`);
  }

  // Per-side credits.
  if (offer.sender.offeredCredits > config.maxCreditsPerSide) {
    errors.push(`Sender offers too many credits (max ${config.maxCreditsPerSide})`);
  }
  if (offer.recipient.offeredCredits > config.maxCreditsPerSide) {
    errors.push(`Recipient offers too many credits (max ${config.maxCreditsPerSide})`);
  }

  // At least one side must offer something.
  const senderEmpty = offer.sender.offeredSkins.length === 0 && offer.sender.offeredCredits === 0;
  const recipientEmpty = offer.recipient.offeredSkins.length === 0 && offer.recipient.offeredCredits === 0;
  if (senderEmpty && recipientEmpty) {
    errors.push("Trade is empty (both sides have nothing to offer)");
  }

  // Equipped + trade-lock checks per skin.
  for (const skin of [...offer.sender.offeredSkins, ...offer.recipient.offeredSkins]) {
    if (skin.equipped) {
      errors.push(`Skin ${skin.entry.name} is currently equipped (can't trade)`);
    }
    if (now < skin.tradeLockedUntil) {
      errors.push(`Skin ${skin.entry.name} is trade-locked`);
    }
    if (!skin.entry.tradeable) {
      errors.push(`Skin ${skin.entry.name} is not tradeable (bound to account)`);
    }
  }

  // Value differential warning — surface lopsided trades.
  const senderVal = computeSideValue(offer.sender, now);
  const recipientVal = computeSideValue(offer.recipient, now);
  const diff = Math.abs(senderVal - recipientVal);
  const maxVal = Math.max(senderVal, recipientVal);
  if (maxVal > 0 && diff / maxVal > 0.5) {
    warnings.push(`Trade value is lopsided (sender ${senderVal}cr vs recipient ${recipientVal}cr)`);
  }

  // Mythic hold warning.
  const hasMythic = [...offer.sender.offeredSkins, ...offer.recipient.offeredSkins]
    .some((s) => s.entry.rarity === "MYTHIC");
  if (hasMythic) {
    warnings.push(`Mythic skins are subject to a 24h trade-hold after this trade`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ─── Trade execution ────────────────────────────────────────────────────────

/**
 * Execute a validated trade. Produces a `TradeReceipt` that the backend
 * commits atomically (Firestore transaction). The receipt includes the
 * final item transfers, the credit transfer, and the tax.
 *
 * The tax is computed on the higher-value side (the "buyer") — deducted
 * from their offered credits before transfer.
 */
export function executeTrade(
  offer: TradeOffer,
  config: TradeConfig = DEFAULT_TRADE_CONFIG,
  now: number = Date.now(),
): { receipt: TradeReceipt | null; error?: string } {
  // Final ownership check — the offer's skins must still be valid.
  for (const skin of [...offer.sender.offeredSkins, ...offer.recipient.offeredSkins]) {
    if (skin.equipped) return { receipt: null, error: `Skin ${skin.entry.name} is equipped` };
    if (now < skin.tradeLockedUntil) return { receipt: null, error: `Skin ${skin.entry.name} is locked` };
  }

  const senderVal = computeSideValue(offer.sender, now);
  const recipientVal = computeSideValue(offer.recipient, now);

  // Compute tax — sum of per-skin tax for each side.
  const senderTax = offer.sender.offeredSkins.reduce(
    (sum, s) => sum + s.entry.price * config.taxByRarity[s.entry.rarity],
    0,
  );
  const recipientTax = offer.recipient.offeredSkins.reduce(
    (sum, s) => sum + s.entry.price * config.taxByRarity[s.entry.rarity],
    0,
  );
  const totalTax = Math.round(senderTax + recipientTax);

  // Net credit transfer — the higher-value side pays the lower-value side.
  // The tax is deducted from the higher-value side's credits first.
  let netCreditTransfer = 0;
  if (senderVal > recipientVal) {
    netCreditTransfer = -(senderVal - recipientVal); // sender pays recipient
  } else if (recipientVal > senderVal) {
    netCreditTransfer = recipientVal - senderVal; // recipient pays sender
  }

  // Build the transfer list.
  const transfers: { itemId: string; fromPlayer: string; toPlayer: string }[] = [];
  for (const skin of offer.sender.offeredSkins) {
    transfers.push({ itemId: skin.itemId, fromPlayer: offer.sender.playerId, toPlayer: offer.recipient.playerId });
  }
  for (const skin of offer.recipient.offeredSkins) {
    transfers.push({ itemId: skin.itemId, fromPlayer: offer.recipient.playerId, toPlayer: offer.sender.playerId });
  }

  const receipt: TradeReceipt = {
    offerId: offer.id,
    sender: offer.sender,
    recipient: offer.recipient,
    senderValue: senderVal,
    recipientValue: recipientVal,
    tax: totalTax,
    netCreditTransfer,
    transfers,
    executedAt: now,
  };
  return { receipt };
}

// ─── Offer creation + lifecycle ─────────────────────────────────────────────

let _offerCounter = 0;

/** Generate a stable offer ID. */
export function generateTradeOfferId(): string {
  _offerCounter += 1;
  return `trade_${Date.now().toString(36)}_${_offerCounter.toString(36)}`;
}

/** Create a new trade offer from sender to recipient. */
export function createTradeOffer(
  sender: TradeSide,
  recipient: TradeSide,
  message?: string,
  config: TradeConfig = DEFAULT_TRADE_CONFIG,
  now: number = Date.now(),
): TradeOffer {
  return {
    id: generateTradeOfferId(),
    createdAt: now,
    expiresAt: now + config.offerExpiryMs,
    sender,
    recipient,
    status: "pending",
    message,
    counterHistory: [],
  };
}

/** Accept a pending offer (recipient accepts). */
export function acceptTradeOffer(offer: TradeOffer): TradeOffer {
  if (offer.status !== "pending") return offer;
  return { ...offer, status: "accepted" };
}

/** Decline a pending offer (recipient declines). */
export function declineTradeOffer(offer: TradeOffer): TradeOffer {
  if (offer.status !== "pending") return offer;
  return { ...offer, status: "declined" };
}

/** Cancel a pending offer (sender cancels). */
export function cancelTradeOffer(offer: TradeOffer): TradeOffer {
  if (offer.status !== "pending") return offer;
  return { ...offer, status: "cancelled" };
}

/** Counter-offer — the recipient proposes a new offer; the old one is archived. */
export function counterTradeOffer(
  offer: TradeOffer,
  newRecipient: TradeSide,
  message?: string,
  config: TradeConfig = DEFAULT_TRADE_CONFIG,
  now: number = Date.now(),
): TradeOffer {
  if (offer.status !== "pending") return offer;
  const counter = createTradeOffer(offer.recipient, offer.sender, message, config, now);
  return {
    ...counter,
    counterHistory: [...offer.counterHistory, offer],
  };
}

/** Expire offers past their expiry time. */
export function expireStaleOffer(offer: TradeOffer, now: number = Date.now()): TradeOffer {
  if (offer.status !== "pending") return offer;
  if (now < offer.expiresAt) return offer;
  return { ...offer, status: "expired" };
}

// ─── Trade history ──────────────────────────────────────────────────────────

export interface TradeHistoryEntry {
  receipt: TradeReceipt;
  /** Players involved (for filtering). */
  playerIds: string[];
}

/** In-memory trade history (the backend persists to Firestore). */
const _tradeHistory: TradeHistoryEntry[] = [];

/** Record a completed trade in the history. */
export function recordTrade(receipt: TradeReceipt): void {
  _tradeHistory.push({
    receipt,
    playerIds: [receipt.sender.playerId, receipt.recipient.playerId],
  });
  // Cap history at 1000 entries (FIFO).
  if (_tradeHistory.length > 1000) _tradeHistory.shift();
}

/** Get a player's trade history (most recent first). */
export function getPlayerTradeHistory(playerId: string, limit = 50): TradeHistoryEntry[] {
  return _tradeHistory
    .filter((e) => e.playerIds.includes(playerId))
    .slice(-limit)
    .reverse();
}

/** Get a player's trade count for the current day (for daily-limit validation). */
export function getPlayerDailyTradeCount(playerId: string, now: number = Date.now()): number {
  const dayStart = now - 24 * 60 * 60 * 1000;
  return _tradeHistory.filter(
    (e) => e.playerIds.includes(playerId) && e.receipt.executedAt >= dayStart,
  ).length;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build an OwnedSkin from a catalog entry (for testing / seed data). */
export function makeOwnedSkin(
  itemId: string,
  entry: SkinCatalogEntry,
  wearFloat: number,
  now: number = Date.now(),
): OwnedSkin {
  return {
    itemId,
    skinSlug: entry.slug,
    entry,
    wear: { skinSlug: entry.slug, wearFloat, wearXP: 0 },
    equipped: false,
    tradeLockedUntil: now + 3 * 24 * 60 * 60 * 1000, // 3-day default lock
    acquiredAt: now,
  };
}
