import { NextResponse, type NextRequest } from "next/server";
import { createLogger } from "@/lib/logger";
import { db, ensureSeed, errorResponse, PLAYER_ID } from "@/lib/api";
const logger = createLogger("/api/loadout/equip-operator");
import { loadoutEquipOperatorSchema } from "@/lib/security/validation";
import { readBoundedJson } from "@/lib/security/body-size";
import { requireSameOrigin } from "@/lib/security/csrf";

/**
 * V3 — Equip an operator (discrete character skin).
 *
 * Parallel route to /api/loadout/equip — keeps the existing equip route's
 * contract intact for current callers while adding operator support.
 *
 * Body: { operatorSlug: string }
 *  - Verifies the operator exists + is owned.
 *  - Sets operatorSlug on the currently-equipped PlayerLoadout.
 *  - Returns the updated equipped view.
 *
 * Task-1 (SEC) additions (items 5, 6, 8):
 *   - Same-origin CSRF check.
 *   - Body-size limit (1KB).
 *   - Zod validation via `loadoutEquipOperatorSchema`.
 */
export async function POST(req: NextRequest) {
  try {
    // Task-1 (SEC) items 5, 6, 8.
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return csrf.response;
    const { json, error: bodyError } = await readBoundedJson(req, { maxBytes: 1024 });
    if (bodyError) return bodyError;
    const parsed = loadoutEquipOperatorSchema.safeParse(json);
    if (!parsed.success) {
      return errorResponse("Invalid body. Expected { operatorSlug: string }.", 400, {
        issues: parsed.error.issues,
      });
    }
    const operatorSlug = parsed.data.operatorSlug;

    await ensureSeed();

    // Verify the operator exists in the catalog.
    const op = await db.operator.findUnique({ where: { slug: operatorSlug } });
    if (!op) return errorResponse(`Unknown operator '${operatorSlug}'`, 404);

    // Verify ownership.
    const owns = await db.playerInventoryOperator.findUnique({
      where: { playerId_operatorSlug: { playerId: PLAYER_ID, operatorSlug } },
    });
    if (!owns) return errorResponse(`You do not own operator '${operatorSlug}'`, 400);

    // Set operatorSlug on the currently-equipped loadout (transactional).
    const updated = await db.$transaction(async (tx) => {
      let equipped = await tx.playerLoadout.findFirst({
        where: { playerId: PLAYER_ID, isEquipped: true },
      });
      if (!equipped) {
        // No equipped loadout yet — pick the ak74 starter loadout.
        await tx.playerLoadout.updateMany({
          where: { playerId: PLAYER_ID, weaponSlug: "ak74" },
          data: { isEquipped: true },
        });
        equipped = await tx.playerLoadout.findFirst({
          where: { playerId: PLAYER_ID, isEquipped: true },
        });
      }
      if (!equipped) throw new Error("No loadout to attach operator to");
      return tx.playerLoadout.update({
        where: { id: equipped.id },
        data: { operatorSlug },
      });
    });

    return NextResponse.json({
      operatorSlug,
      equippedLoadoutId: updated.id,
    });
  } catch (err) {
    logger.errorOf(err, "failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Equip operator failed" },
      { status: 500 },
    );
  }
}
