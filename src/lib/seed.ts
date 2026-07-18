import { db } from "@/lib/db";
import { OPERATORS, STARTER_OPERATOR_SLUG } from "@/lib/game/operators";
import {
  generateDailyChallenges,
  generateWeeklyChallenge,
  persistChallenges,
} from "@/lib/game/Challenges";

/**
 * Fixed deterministic IDs used across the Project Reality data layer.
 * - Player is always the same single tenant (no auth).
 * - BattlePassSeason 1 has a fixed id so tier rows reference it deterministically.
 */
export const PLAYER_ID = "00000000-0000-0000-0000-000000000001";
export const SEASON_1_ID = "00000000-0000-0000-0000-0000000000a1";

export const STARTER_WEAPON_SLUGS = ["ak74", "mp7", "usp"] as const;
export const DEFAULT_SKIN_SLUG = "default";
export { STARTER_OPERATOR_SLUG };

// In-process cache so we only run the idempotent seed once per server lifetime.
let seedPromise: Promise<void> | null = null;

/**
 * Idempotently seeds the entire reference + catalog + player data.
 * Safe to call repeatedly. Uses upserts keyed on business keys (slugs /
 * composite unique selectors) so re-runs are no-ops on existing rows.
 *
 * Returns a memoised promise so concurrent requests share a single seed run.
 */
export function ensureSeed(): Promise<void> {
  if (!seedPromise) {
    seedPromise = runSeed().catch((err) => {
      // Reset on failure so a subsequent call can retry.
      seedPromise = null;
      throw err;
    });
  }
  return seedPromise;
}

async function runSeed(): Promise<void> {
  await seedCatalog();
  await seedOperators();
  await seedBattlePass();
  await seedPlayerAndStarterState();
  // AAA prompt 8 — run forward-only profile migrations now that the
  // player row exists. Idempotent: no-ops when already at LATEST_SCHEMA_VERSION.
  const { migratePlayerProfile } = await import("@/lib/profileMigration");
  await migratePlayerProfile(PLAYER_ID);
}

// ---------------------------------------------------------------------------
// V3 — Operators (discrete character skins)
// ---------------------------------------------------------------------------

async function seedOperators(): Promise<void> {
  for (const op of OPERATORS) {
    await db.operator.upsert({
      where: { slug: op.slug },
      update: {
        name: op.name,
        callsign: op.callsign,
        faction: op.faction,
        rarity: op.rarity,
        price: op.price,
        visualConfig: JSON.stringify(op.visual),
      },
      create: {
        slug: op.slug,
        name: op.name,
        callsign: op.callsign,
        faction: op.faction,
        rarity: op.rarity,
        price: op.price,
        visualConfig: JSON.stringify(op.visual),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Catalog: weapons, attachments, skins
// ---------------------------------------------------------------------------

type WeaponSeed = {
  slug: string;
  name: string;
  category:
    | "RIFLE"
    | "SMG"
    | "PISTOL"
    | "SNIPER"
    | "SHOTGUN"
    | "LMG";
  price: number;
  damage: number;
  fireRate: number;
  magSize: number;
  reloadTime: number;
  spread: number;
  recoil: number;
  range: number;
  automatic: boolean;
  zoom: number;
  rarity: "COMMON" | "RARE" | "EPIC" | "LEGENDARY";
};

const WEAPONS: WeaponSeed[] = [
  { slug: "ak74", name: "AK-74", category: "RIFLE", price: 0, damage: 28, fireRate: 100, magSize: 30, reloadTime: 2200, spread: 0.012, recoil: 0.025, range: 200, automatic: true, zoom: 1.1, rarity: "COMMON" },
  { slug: "m4", name: "M4 Carbine", category: "RIFLE", price: 2500, damage: 26, fireRate: 90, magSize: 30, reloadTime: 2100, spread: 0.010, recoil: 0.020, range: 200, automatic: true, zoom: 1.12, rarity: "RARE" },
  { slug: "mp7", name: "MP-7", category: "SMG", price: 0, damage: 18, fireRate: 70, magSize: 40, reloadTime: 1800, spread: 0.020, recoil: 0.018, range: 120, automatic: true, zoom: 1.05, rarity: "COMMON" },
  { slug: "p90", name: "P90", category: "SMG", price: 1800, damage: 16, fireRate: 60, magSize: 50, reloadTime: 2000, spread: 0.022, recoil: 0.016, range: 110, automatic: true, zoom: 1.05, rarity: "RARE" },
  { slug: "usp", name: "USP-S", category: "PISTOL", price: 0, damage: 24, fireRate: 180, magSize: 12, reloadTime: 1500, spread: 0.008, recoil: 0.020, range: 100, automatic: false, zoom: 1.08, rarity: "COMMON" },
  { slug: "deagle", name: "Desert Eagle", category: "PISTOL", price: 1200, damage: 45, fireRate: 300, magSize: 7, reloadTime: 2000, spread: 0.012, recoil: 0.045, range: 120, automatic: false, zoom: 1.1, rarity: "RARE" },
  { slug: "awp", name: "AWP-X", category: "SNIPER", price: 4500, damage: 110, fireRate: 900, magSize: 5, reloadTime: 3000, spread: 0.001, recoil: 0.06, range: 400, automatic: false, zoom: 2.4, rarity: "LEGENDARY" },
  { slug: "scout", name: "Scout", category: "SNIPER", price: 2000, damage: 75, fireRate: 700, magSize: 10, reloadTime: 2500, spread: 0.002, recoil: 0.04, range: 350, automatic: false, zoom: 2.2, rarity: "RARE" },
  { slug: "nova", name: "Nova", category: "SHOTGUN", price: 1500, damage: 22, fireRate: 800, magSize: 8, reloadTime: 2600, spread: 0.05, recoil: 0.05, range: 60, automatic: false, zoom: 1.0, rarity: "RARE" },
  { slug: "m249", name: "M249 SAW", category: "LMG", price: 3500, damage: 24, fireRate: 80, magSize: 100, reloadTime: 4500, spread: 0.018, recoil: 0.035, range: 220, automatic: true, zoom: 1.05, rarity: "EPIC" },
];

type AttachmentSeed = {
  slug: string;
  name: string;
  type: "MUZZLE" | "SIGHT" | "GRIP" | "MAGAZINE";
  price: number;
  damageMod: number;
  recoilMod: number;
  spreadMod: number;
  rangeMod: number;
  zoomMod: number;
  magSizeMod: number;
  reloadMod: number;
  rarity: "COMMON" | "RARE" | "EPIC" | "LEGENDARY";
};

const ATTACHMENTS: AttachmentSeed[] = [
  { slug: "suppressor", name: "Suppressor", type: "MUZZLE", price: 800, damageMod: 0.9, recoilMod: 0.8, spreadMod: 1.0, rangeMod: 0.85, zoomMod: 1.0, magSizeMod: 1.0, reloadMod: 1.0, rarity: "RARE" },
  { slug: "compensator", name: "Compensator", type: "MUZZLE", price: 600, damageMod: 1.0, recoilMod: 0.7, spreadMod: 1.0, rangeMod: 1.0, zoomMod: 1.0, magSizeMod: 1.0, reloadMod: 1.0, rarity: "COMMON" },
  { slug: "red_dot", name: "Red Dot Sight", type: "SIGHT", price: 500, damageMod: 1.0, recoilMod: 1.0, spreadMod: 0.9, rangeMod: 1.0, zoomMod: 1.2, magSizeMod: 1.0, reloadMod: 1.0, rarity: "COMMON" },
  { slug: "holo", name: "Holographic Sight", type: "SIGHT", price: 700, damageMod: 1.0, recoilMod: 1.0, spreadMod: 0.85, rangeMod: 1.0, zoomMod: 1.15, magSizeMod: 1.0, reloadMod: 1.0, rarity: "COMMON" },
  { slug: "acog", name: "ACOG 4x", type: "SIGHT", price: 1200, damageMod: 1.0, recoilMod: 0.95, spreadMod: 0.8, rangeMod: 1.1, zoomMod: 1.8, magSizeMod: 1.0, reloadMod: 1.0, rarity: "RARE" },
  { slug: "scope8x", name: "8x Sniper Scope", type: "SIGHT", price: 2000, damageMod: 1.0, recoilMod: 0.9, spreadMod: 0.5, rangeMod: 1.2, zoomMod: 3.0, magSizeMod: 1.0, reloadMod: 1.0, rarity: "LEGENDARY" },
  { slug: "foregrip", name: "Vertical Foregrip", type: "GRIP", price: 500, damageMod: 1.0, recoilMod: 0.75, spreadMod: 0.9, rangeMod: 1.0, zoomMod: 1.0, magSizeMod: 1.0, reloadMod: 1.0, rarity: "COMMON" },
  { slug: "angled_grip", name: "Angled Grip", type: "GRIP", price: 500, damageMod: 1.0, recoilMod: 0.85, spreadMod: 0.95, rangeMod: 1.0, zoomMod: 1.0, magSizeMod: 1.0, reloadMod: 0.9, rarity: "COMMON" },
  { slug: "ext_mag", name: "Extended Magazine", type: "MAGAZINE", price: 900, damageMod: 1.0, recoilMod: 1.0, spreadMod: 1.0, rangeMod: 1.0, zoomMod: 1.0, magSizeMod: 1.5, reloadMod: 1.1, rarity: "RARE" },
  { slug: "quick_mag", name: "Quickdraw Magazine", type: "MAGAZINE", price: 700, damageMod: 1.0, recoilMod: 1.0, spreadMod: 1.0, rangeMod: 1.0, zoomMod: 1.0, magSizeMod: 1.0, reloadMod: 0.6, rarity: "COMMON" },
];

type SkinSeed = {
  slug: string;
  name: string;
  rarity: "COMMON" | "RARE" | "EPIC" | "LEGENDARY";
  price: number;
  colorHex: string;
};

const SKINS: SkinSeed[] = [
  { slug: "default", name: "Standard Stock", rarity: "COMMON", price: 0, colorHex: "#3a3a3e" },
  { slug: "gold", name: "Gold Plated", rarity: "LEGENDARY", price: 3000, colorHex: "#d4af37" },
  { slug: "carbon", name: "Carbon Fiber", rarity: "RARE", price: 1200, colorHex: "#1a1a1e" },
  { slug: "tiger", name: "Tiger Stripe", rarity: "EPIC", price: 1800, colorHex: "#c87f2a" },
  { slug: "neon", name: "Neon Pulse", rarity: "EPIC", price: 2000, colorHex: "#2af0c8" },
  { slug: "arctic", name: "Arctic Camo", rarity: "RARE", price: 1000, colorHex: "#e8eef2" },
];

async function seedCatalog(): Promise<void> {
  await Promise.all(
    WEAPONS.map((w) =>
      db.weapon.upsert({
        where: { slug: w.slug },
        update: {
          name: w.name,
          category: w.category,
          price: w.price,
          damage: w.damage,
          fireRate: w.fireRate,
          magSize: w.magSize,
          reloadTime: w.reloadTime,
          spread: w.spread,
          recoil: w.recoil,
          range: w.range,
          automatic: w.automatic,
          zoom: w.zoom,
          rarity: w.rarity,
        },
        create: {
          slug: w.slug,
          name: w.name,
          category: w.category,
          price: w.price,
          damage: w.damage,
          fireRate: w.fireRate,
          magSize: w.magSize,
          reloadTime: w.reloadTime,
          spread: w.spread,
          recoil: w.recoil,
          range: w.range,
          automatic: w.automatic,
          zoom: w.zoom,
          rarity: w.rarity,
        },
      }),
    ),
  );

  await Promise.all(
    ATTACHMENTS.map((a) =>
      db.attachment.upsert({
        where: { slug: a.slug },
        update: {
          name: a.name,
          type: a.type,
          price: a.price,
          damageMod: a.damageMod,
          recoilMod: a.recoilMod,
          spreadMod: a.spreadMod,
          rangeMod: a.rangeMod,
          zoomMod: a.zoomMod,
          magSizeMod: a.magSizeMod,
          reloadMod: a.reloadMod,
          rarity: a.rarity,
        },
        create: {
          slug: a.slug,
          name: a.name,
          type: a.type,
          price: a.price,
          damageMod: a.damageMod,
          recoilMod: a.recoilMod,
          spreadMod: a.spreadMod,
          rangeMod: a.rangeMod,
          zoomMod: a.zoomMod,
          magSizeMod: a.magSizeMod,
          reloadMod: a.reloadMod,
          rarity: a.rarity,
        },
      }),
    ),
  );

  await Promise.all(
    SKINS.map((s) =>
      db.skin.upsert({
        where: { slug: s.slug },
        update: {
          name: s.name,
          rarity: s.rarity,
          price: s.price,
          colorHex: s.colorHex,
        },
        create: {
          slug: s.slug,
          name: s.name,
          rarity: s.rarity,
          price: s.price,
          colorHex: s.colorHex,
        },
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Battle pass: season 1 + 50 tiers (free + premium)
// ---------------------------------------------------------------------------

async function seedBattlePass(): Promise<void> {
  await db.battlePassSeason.upsert({
    where: { id: SEASON_1_ID },
    update: {
      season: 1,
      name: "Operation Vanguard",
      startXp: 0,
      tierSize: 1000,
      maxTier: 50,
      premiumPrice: 950,
      active: true,
    },
    create: {
      id: SEASON_1_ID,
      season: 1,
      name: "Operation Vanguard",
      startXp: 0,
      tierSize: 1000,
      maxTier: 50,
      premiumPrice: 950,
      active: true,
    },
  });

  // Build deterministic reward plan for tiers 1..50.
  // Free track: every 5th tier -> CREDITS 200; tier 25 -> foregrip; tier 50 -> p90; else CREDITS 50.
  // Premium track: every tier CREDITS 100; tier 10 -> carbon skin; tier 20 -> acog;
  //                tier 30 -> tiger skin; tier 40 -> scope8x; tier 50 -> gold skin.
  const freeRewards: { type: "CREDITS" | "WEAPON" | "SKIN" | "ATTACHMENT"; slug: string; amount: number }[] = [];
  const premiumRewards: { type: "CREDITS" | "WEAPON" | "SKIN" | "ATTACHMENT"; slug: string; amount: number }[] = [];

  for (let t = 1; t <= 50; t++) {
    // Free
    if (t === 25) freeRewards.push({ type: "ATTACHMENT", slug: "foregrip", amount: 1 });
    else if (t === 50) freeRewards.push({ type: "WEAPON", slug: "p90", amount: 1 });
    else if (t % 5 === 0) freeRewards.push({ type: "CREDITS", slug: "credits", amount: 200 });
    else freeRewards.push({ type: "CREDITS", slug: "credits", amount: 50 });

    // Premium
    if (t === 10) premiumRewards.push({ type: "SKIN", slug: "carbon", amount: 1 });
    else if (t === 20) premiumRewards.push({ type: "ATTACHMENT", slug: "acog", amount: 1 });
    else if (t === 30) premiumRewards.push({ type: "SKIN", slug: "tiger", amount: 1 });
    else if (t === 40) premiumRewards.push({ type: "ATTACHMENT", slug: "scope8x", amount: 1 });
    else if (t === 50) premiumRewards.push({ type: "SKIN", slug: "gold", amount: 1 });
    else premiumRewards.push({ type: "CREDITS", slug: "credits", amount: 100 });
  }

  await db.$transaction(
    freeRewards.flatMap((reward, i) => {
      const tier = i + 1;
      return [
        db.battlePassTier.upsert({
          where: { seasonId_tier_isPremium: { seasonId: SEASON_1_ID, tier, isPremium: false } },
          update: {
            rewardType: reward.type,
            rewardSlug: reward.slug,
            rewardAmount: reward.amount,
            isPremium: false,
          },
          create: {
            seasonId: SEASON_1_ID,
            tier,
            rewardType: reward.type,
            rewardSlug: reward.slug,
            rewardAmount: reward.amount,
            isPremium: false,
          },
        }),
      ];
    }),
  );

  await db.$transaction(
    premiumRewards.map((reward, i) => {
      const tier = i + 1;
      return db.battlePassTier.upsert({
        where: { seasonId_tier_isPremium: { seasonId: SEASON_1_ID, tier, isPremium: true } },
        update: {
          rewardType: reward.type,
          rewardSlug: reward.slug,
          rewardAmount: reward.amount,
          isPremium: true,
        },
        create: {
          seasonId: SEASON_1_ID,
          tier,
          rewardType: reward.type,
          rewardSlug: reward.slug,
          rewardAmount: reward.amount,
          isPremium: true,
        },
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// Player + starter inventory/loadouts/battle pass
// ---------------------------------------------------------------------------

async function seedPlayerAndStarterState(): Promise<void> {
  // 1. Upsert the player.
  await db.player.upsert({
    where: { id: PLAYER_ID },
    update: {},
    create: {
      id: PLAYER_ID,
      displayName: "Operator",
      credits: 500,
      level: 1,
      xp: 0,
    },
  });

  // 2. Ensure starter weapons are owned (idempotent: check before insert).
  const existingInv = await db.playerInventory.findMany({
    where: { playerId: PLAYER_ID, OR: [{ weaponSlug: { in: [...STARTER_WEAPON_SLUGS] } }, { skinSlug: DEFAULT_SKIN_SLUG }] },
    select: { weaponSlug: true, skinSlug: true },
  });
  const ownedWeapons = new Set(existingInv.map((r) => r.weaponSlug).filter(Boolean) as string[]);
  const ownsDefaultSkin = existingInv.some((r) => r.skinSlug === DEFAULT_SKIN_SLUG);

  await db.$transaction([
    ...STARTER_WEAPON_SLUGS.filter((slug) => !ownedWeapons.has(slug)).map((slug) =>
      db.playerInventory.create({
        data: { playerId: PLAYER_ID, weaponSlug: slug },
      }),
    ),
    ...(ownsDefaultSkin
      ? []
      : [db.playerInventory.create({ data: { playerId: PLAYER_ID, skinSlug: DEFAULT_SKIN_SLUG } })]),
  ]);

  // 3. Ensure one PlayerLoadout per starter weapon. AK-74 is the equipped one.
  await db.$transaction(
    STARTER_WEAPON_SLUGS.map((slug) =>
      db.playerLoadout.upsert({
        where: { playerId_weaponSlug: { playerId: PLAYER_ID, weaponSlug: slug } },
        update: {},
        create: {
          playerId: PLAYER_ID,
          weaponSlug: slug,
          skinSlug: DEFAULT_SKIN_SLUG,
          isEquipped: slug === "ak74",
        },
      }),
    ),
  );

  // Make sure exactly one starter loadout is equipped (idempotent: if all were
  // reset to false somehow, pick ak74). Cheap to do conditionally.
  const equippedCount = await db.playerLoadout.count({
    where: { playerId: PLAYER_ID, isEquipped: true },
  });
  if (equippedCount === 0) {
    await db.playerLoadout.updateMany({
      where: { playerId: PLAYER_ID, weaponSlug: "ak74" },
      data: { isEquipped: true },
    });
  }

  // 4. Ensure PlayerBattlePass row for season 1.
  await db.playerBattlePass.upsert({
    where: { playerId_seasonId: { playerId: PLAYER_ID, seasonId: SEASON_1_ID } },
    update: {},
    create: {
      playerId: PLAYER_ID,
      seasonId: SEASON_1_ID,
      xp: 0,
      premium: false,
      claimedTiers: "[]",
      status: "ACTIVE",
    },
  });

  // V3 — Ensure the player owns the starter operator (warden) and that the
  // equipped loadout references it. Idempotent.
  await db.playerInventoryOperator.upsert({
    where: { playerId_operatorSlug: { playerId: PLAYER_ID, operatorSlug: STARTER_OPERATOR_SLUG } },
    update: {},
    create: { playerId: PLAYER_ID, operatorSlug: STARTER_OPERATOR_SLUG },
  });
  await db.playerLoadout.updateMany({
    where: { playerId: PLAYER_ID, isEquipped: true, operatorSlug: null },
    data: { operatorSlug: STARTER_OPERATOR_SLUG },
  });

  // 5. Realism features: ballistics materials, medical items, medical state.
  await seedBallisticsMaterials();
  await seedMedicalItems();
  await seedMedicalState();

  // 6. P5.4 — Daily & weekly challenges. Seed 3 daily + 1 weekly on first
  // player access (idempotent: only create if the player has none yet, so
  // re-seeding doesn't blow away in-progress challenge progress).
  await seedPlayerChallenges();
}

async function seedPlayerChallenges(): Promise<void> {
  const existing = await db.playerChallenge.count({
    where: { playerId: PLAYER_ID, resetsAt: { gt: new Date() } },
  });
  if (existing > 0) return;

  // Generate + persist the canonical set. persistChallenges assigns the
  // proper resetsAt per cadence (midnight UTC for daily, next Monday 00:00
  // UTC for weekly) via getDailyResetTimestamp() / getWeeklyResetTimestamp().
  await persistChallenges(PLAYER_ID, [
    ...generateDailyChallenges(),
    ...generateWeeklyChallenge(),
  ]);
}

async function seedBallisticsMaterials() {
  const materials = [
    { slug: "drywall", name: "Drywall", density: 600, thickness: 0.10, penetration: 0.15, bulletStop: false, color: "#d8d4c8" },
    { slug: "wood", name: "Wood", density: 700, thickness: 0.12, penetration: 0.25, bulletStop: false, color: "#8a5a2b" },
    { slug: "sheet_metal", name: "Sheet Metal", density: 7850, thickness: 0.03, penetration: 0.45, bulletStop: false, color: "#b0b0b8" },
    { slug: "brick", name: "Brick", density: 1900, thickness: 0.15, penetration: 0.55, bulletStop: false, color: "#7a4a3a" },
    { slug: "sandbag", name: "Sandbag", density: 1600, thickness: 0.30, penetration: 0.35, bulletStop: false, color: "#c9b08a" },
    { slug: "glass", name: "Glass", density: 2500, thickness: 0.02, penetration: 0.05, bulletStop: false, color: "#b8d4e8" },
    { slug: "foliage", name: "Foliage", density: 300, thickness: 0.50, penetration: 0.02, bulletStop: false, color: "#4a7a3a" },
    { slug: "earth", name: "Earth", density: 1800, thickness: 0.50, penetration: 0.70, bulletStop: false, color: "#6a5a3a" },
    { slug: "concrete", name: "Concrete", density: 2400, thickness: 0.20, penetration: 0.85, bulletStop: false, color: "#6b6b6b" },
    { slug: "steel_plate", name: "Steel Plate", density: 7850, thickness: 0.10, penetration: 0.98, bulletStop: true, color: "#3a3a3e" },
  ];
  for (const m of materials) {
    await db.ballisticsMaterial.upsert({
      where: { slug: m.slug },
      update: { density: m.density, thickness: m.thickness, penetration: m.penetration, bulletStop: m.bulletStop, color: m.color },
      create: m,
    });
  }
}

async function seedMedicalItems() {
  const items = [
    { slug: "bandage", name: "Bandage", type: "BANDAGE" as const, price: 50, healAmount: 0, useTime: 4000, description: "Stops bleeding. Channelled 4s." },
    { slug: "splint", name: "Splint", type: "SPLINT" as const, price: 100, healAmount: 0, useTime: 6000, description: "Repairs fracture. Channelled 6s." },
    { slug: "epi", name: "Epinephrine", type: "EPINEPHRINE" as const, price: 200, healAmount: 0, useTime: 3000, description: "Revives from unconsciousness." },
    { slug: "medkit", name: "Field Medkit", type: "MEDKIT" as const, price: 400, healAmount: 50, useTime: 8000, description: "Restores 50 HP. Channelled 8s." },
  ];
  for (const it of items) {
    await db.medicalItem.upsert({
      where: { slug: it.slug },
      update: { price: it.price, healAmount: it.healAmount, useTime: it.useTime, description: it.description },
      create: it,
    });
  }
  // Starter inventory: bandage x3, splint x1, medkit x1, epi x1
  const starterQty: Record<string, number> = { bandage: 3, splint: 1, medkit: 1, epi: 1 };
  for (const [slug, qty] of Object.entries(starterQty)) {
    await db.playerMedicalInventory.upsert({
      where: { playerId_itemSlug: { playerId: PLAYER_ID, itemSlug: slug } },
      update: {},
      create: { playerId: PLAYER_ID, itemSlug: slug, quantity: qty },
    });
  }
}

async function seedMedicalState() {
  // Task-1 (SEC) item 12 — seed an encrypted PII-adjacent notes field so
  // the encryption wrapper is exercised on every fresh seed. The value
  // is a placeholder ("no known conditions"); a real player would have
  // their disclosed accessibility / medical accommodations here.
  const { encryptField } = await import("@/lib/security/encryption");
  const notesEncrypted = encryptField("no known conditions");
  await db.playerMedicalState.upsert({
    where: { playerId: PLAYER_ID },
    update: {},
    create: {
      playerId: PLAYER_ID,
      state: "ACTIVE",
      bleedRate: 0,
      fractureLimb: "",
      notesEncrypted,
    },
  });
}
