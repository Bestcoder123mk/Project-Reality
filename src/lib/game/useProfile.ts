"use client";

import { useCallback } from "react";
import { useGameStore, type WeaponType, type AttachmentSlug, type SkinSlug, type LoadoutConfig } from "./store";
import type { OperatorCustomization, OperatorCustomizationOverrides } from "./OperatorCustom";

export interface ApiPlayer {
  player: { id: string; displayName: string; credits: number; level: number; xp: number };
  inventory: { weapons: string[]; attachments: string[]; skins: string[]; operators: string[] };
  loadouts: Array<{
    weaponSlug: string; muzzleSlug: string | null; sightSlug: string | null;
    gripSlug: string | null; magazineSlug: string | null; skinSlug: string | null;
    operatorSlug: string | null; isEquipped: boolean;
  }>;
  equipped: {
    weaponSlug: string; muzzleSlug: string | null; sightSlug: string | null;
    gripSlug: string | null; magazineSlug: string | null; skinSlug: string | null;
    operatorSlug: string | null;
  } | null;
  battlePass: {
    season: number; tier: number; xp: number; tierSize: number; maxTier: number;
    premium: boolean; claimedTiers: Array<{ tier: number; isPremium: boolean }>;
    nextTierXp: number; status: string;
  };
}

export function useProfile() {
  const setProfile = useGameStore((s) => s.setProfile);
  const setLoadout = useGameStore((s) => s.setLoadout);
  const setProfileLoading = useGameStore((s) => s.setProfileLoading);
  const setEquippedOperator = useGameStore((s) => s.setEquippedOperator);
  const setOwnedOperators = useGameStore((s) => s.setOwnedOperators);
  const setEquippedCustomization = useGameStore((s) => s.setEquippedCustomization);

  const applyPlayer = useCallback((data: ApiPlayer) => {
    const equipped = data.equipped;
    // The equipped view (serializeLoadouts) doesn't yet carry secondary/melee/
    // utility slugs — those slots fall back to defaults. We type the optional
    // fields explicitly instead of `as any` so a future schema addition lights
    // up the type checker rather than silently staying undefined.
    const e = (equipped ?? {}) as Partial<{
      weaponSlug: string;
      secondarySlug: string;
      meleeSlug: string;
      utilitySlug: string;
      muzzleSlug: string | null;
      sightSlug: string | null;
      gripSlug: string | null;
      magazineSlug: string | null;
      skinSlug: string | null;
    }>;
    const loadout: LoadoutConfig = equipped
      ? {
          weapon: (e.weaponSlug as WeaponType) || "ak74",
          secondary: (e.secondarySlug as WeaponType) || "usp",
          melee: e.meleeSlug || "knife",
          utility: e.utilitySlug || "bandage",
          muzzle: (e.muzzleSlug as AttachmentSlug) || "none",
          sight: (e.sightSlug as AttachmentSlug) || "none",
          grip: (e.gripSlug as AttachmentSlug) || "none",
          magazine: (e.magazineSlug as AttachmentSlug) || "none",
          skin: (e.skinSlug as SkinSlug) || "default",
        }
      : { weapon: "ak74", secondary: "usp", melee: "knife", utility: "bandage", muzzle: "none", sight: "none", grip: "none", magazine: "none", skin: "default" };

    setProfile({
      credits: data.player.credits,
      level: data.player.level,
      xp: data.player.xp,
      ownedWeapons: data.inventory.weapons as WeaponType[],
      ownedAttachments: data.inventory.attachments as AttachmentSlug[],
      ownedSkins: data.inventory.skins as SkinSlug[],
      loadout,
      battlePassTier: data.battlePass.tier,
      battlePassXp: data.battlePass.xp,
      battlePassPremium: data.battlePass.premium,
    });
    setLoadout(loadout);
    // V3 — sync operator ownership + equipped operator slug.
    setOwnedOperators(data.inventory.operators ?? []);
    setEquippedOperator(equipped?.operatorSlug ?? "warden");
  }, [setProfile, setLoadout, setOwnedOperators, setEquippedOperator]);

  const refresh = useCallback(async () => {
    setProfileLoading(true);
    try {
      // Auto-seed on first load (no need for manual curl step).
      await fetch("/api/seed").catch(() => {});
      const res = await fetch("/api/player");
      if (res.ok) {
        const data = (await res.json()) as ApiPlayer;
        applyPlayer(data);
      }
      // V3.1 — Task 29: fetch persisted operator customization in parallel
      // with the profile. Non-blocking — a failure leaves the default
      // customization in place (Warden, no overrides).
      fetch("/api/player/operator-customization")
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { baseSlug?: string; overrides?: OperatorCustomizationOverrides } | null) => {
          if (d && typeof d.baseSlug === "string") {
            setEquippedCustomization({
              baseSlug: d.baseSlug,
              overrides: d.overrides ?? {},
            });
          }
        })
        .catch(() => {});
    } catch {
      // ignore
    } finally {
      setProfileLoading(false);
    }
  }, [applyPlayer, setProfileLoading, setEquippedCustomization]);

  const buy = useCallback(async (itemType: "WEAPON" | "ATTACHMENT" | "SKIN" | "OPERATOR", slug: string) => {
    const res = await fetch("/api/shop/buy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemType, slug }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Purchase failed" }));
      throw new Error(err.error || "Purchase failed");
    }
    await refresh();
  }, [refresh]);

  const equip = useCallback(async (loadout: LoadoutConfig) => {
    const res = await fetch("/api/loadout/equip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        weaponSlug: loadout.weapon,
        secondarySlug: loadout.secondary,
        meleeSlug: loadout.melee,
        utilitySlug: loadout.utility,
        muzzleSlug: loadout.muzzle === "none" ? null : loadout.muzzle,
        sightSlug: loadout.sight === "none" ? null : loadout.sight,
        gripSlug: loadout.grip === "none" ? null : loadout.grip,
        magazineSlug: loadout.magazine === "none" ? null : loadout.magazine,
        skinSlug: loadout.skin,
      }),
    });
    if (!res.ok) throw new Error("Equip failed");
    await refresh();
  }, [refresh]);

  const claimBattlePass = useCallback(async (tier: number, isPremium: boolean) => {
    const res = await fetch("/api/battlepass/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier, isPremium }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Claim failed" }));
      throw new Error(err.error || "Claim failed");
    }
    await refresh();
  }, [refresh]);

  const unlockPremium = useCallback(async () => {
    const res = await fetch("/api/battlepass/premium", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      throw new Error(err.error || "Failed");
    }
    await refresh();
  }, [refresh]);

  /** V3 — Equip an operator (discrete skin). Sets it on the equipped loadout. */
  const equipOperator = useCallback(async (operatorSlug: string) => {
    const res = await fetch("/api/loadout/equip-operator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operatorSlug }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Equip operator failed" }));
      throw new Error(err.error || "Equip operator failed");
    }
    setEquippedOperator(operatorSlug);
    await refresh();
  }, [refresh, setEquippedOperator]);

  return { refresh, buy, equip, equipOperator, claimBattlePass, unlockPremium };
}

/**
 * V3.1 — Task 29: persist the player's operator customization to the DB.
 * Used by the SAVE button in the OperatorScreen customization studio.
 */
export async function saveOperatorCustomization(
  c: OperatorCustomization,
): Promise<OperatorCustomization> {
  const res = await fetch("/api/player/operator-customization", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseSlug: c.baseSlug, overrides: c.overrides }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Save failed" }));
    throw new Error(err.error || "Save failed");
  }
  const data = (await res.json()) as { baseSlug: string; overrides: OperatorCustomizationOverrides };
  return { baseSlug: data.baseSlug, overrides: data.overrides };
}
