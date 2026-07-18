import { NextResponse, type NextRequest } from "next/server";
import { createLogger } from "@/lib/logger";
import { db, ensureSeed, errorResponse, PLAYER_ID } from "@/lib/api";
const logger = createLogger("/api/loadout/equip");
import { loadoutEquipSchema } from "@/lib/security/validation";
import { readBoundedJson } from "@/lib/security/body-size";
import { requireSameOrigin } from "@/lib/security/csrf";

/**
 * POST /api/loadout/equip
 *
 * Task-1 (SEC) additions (items 5, 6, 8):
 *   - Same-origin CSRF check.
 *   - Body-size limit (1KB).
 *   - Zod validation via `loadoutEquipSchema` — every slug is enforced
 *     to `[a-z0-9_]+` shape so a path-traversal payload can't reach the
 *     DB query. The previous manual `asOptionalString` is replaced.
 */
export async function POST(req: NextRequest) {
  try {
    // Task-1 (SEC) items 5, 6, 8.
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return csrf.response;
    const { json, error: bodyError } = await readBoundedJson(req, { maxBytes: 1024 });
    if (bodyError) return bodyError;
    const parsed = loadoutEquipSchema.safeParse(json);
    if (!parsed.success) {
      return errorResponse("Invalid body. Expected { weaponSlug, muzzleSlug?, sightSlug?, gripSlug?, magazineSlug?, skinSlug? }.", 400, {
        issues: parsed.error.issues,
      });
    }

    await ensureSeed();

    const weaponSlug = parsed.data.weaponSlug;
    const muzzleSlug = parsed.data.muzzleSlug;
    const sightSlug = parsed.data.sightSlug;
    const gripSlug = parsed.data.gripSlug;
    const magazineSlug = parsed.data.magazineSlug;
    const skinSlug = parsed.data.skinSlug ?? "default";

    // Verify the weapon is owned.
    const ownsWeapon = await db.playerInventory.findFirst({
      where: { playerId: PLAYER_ID, weaponSlug },
    });
    if (!ownsWeapon) {
      return errorResponse(`You do not own weapon '${weaponSlug}'`, 400);
    }

    // Verify attachments are owned.
    const attachmentSlots: { slug: string; slot: string }[] = [];
    if (muzzleSlug) attachmentSlots.push({ slug: muzzleSlug, slot: "muzzle" });
    if (sightSlug) attachmentSlots.push({ slug: sightSlug, slot: "sight" });
    if (gripSlug) attachmentSlots.push({ slug: gripSlug, slot: "grip" });
    if (magazineSlug) attachmentSlots.push({ slug: magazineSlug, slot: "magazine" });

    if (attachmentSlots.length > 0) {
      const owned = await db.playerInventoryAttachment.findMany({
        where: {
          playerId: PLAYER_ID,
          attachmentSlug: { in: attachmentSlots.map((s) => s.slug) },
        },
        select: { attachmentSlug: true },
      });
      const ownedSet = new Set(owned.map((r) => r.attachmentSlug));
      for (const slot of attachmentSlots) {
        if (!ownedSet.has(slot.slug)) {
          return errorResponse(
            `You do not own attachment '${slot.slug}' (${slot.slot})`,
            400,
          );
        }
      }
    }

    // Verify skin is owned (default skin is always available).
    if (skinSlug !== "default") {
      const ownsSkin = await db.playerInventory.findFirst({
        where: { playerId: PLAYER_ID, skinSlug },
      });
      if (!ownsSkin) {
        return errorResponse(`You do not own skin '${skinSlug}'`, 400);
      }
    }

    // Transaction: unset other equipped loadouts + upsert this one as equipped.
    const updated = await db.$transaction(async (tx) => {
      await tx.playerLoadout.updateMany({
        where: { playerId: PLAYER_ID, isEquipped: true },
        data: { isEquipped: false },
      });

      const loadout = await tx.playerLoadout.upsert({
        where: { playerId_weaponSlug: { playerId: PLAYER_ID, weaponSlug } },
        update: {
          muzzleSlug: muzzleSlug ?? null,
          sightSlug: sightSlug ?? null,
          gripSlug: gripSlug ?? null,
          magazineSlug: magazineSlug ?? null,
          skinSlug,
          isEquipped: true,
        },
        create: {
          playerId: PLAYER_ID,
          weaponSlug,
          muzzleSlug: muzzleSlug ?? null,
          sightSlug: sightSlug ?? null,
          gripSlug: gripSlug ?? null,
          magazineSlug: magazineSlug ?? null,
          skinSlug,
          isEquipped: true,
        },
      });
      return loadout;
    });

    return NextResponse.json({
      loadout: updated,
      equipped: {
        weaponSlug: updated.weaponSlug,
        muzzleSlug: updated.muzzleSlug,
        sightSlug: updated.sightSlug,
        gripSlug: updated.gripSlug,
        magazineSlug: updated.magazineSlug,
        skinSlug: updated.skinSlug,
      },
    });
  } catch (err) {
    logger.errorOf(err, "failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Equip failed" },
      { status: 500 },
    );
  }
}
