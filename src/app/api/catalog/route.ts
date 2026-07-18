import { NextResponse } from "next/server";
import { createLogger } from "@/lib/logger";
import { db, ensureSeed } from "@/lib/api";
const logger = createLogger("/api/catalog");

export async function GET() {
  try {
    await ensureSeed();
    const [weapons, attachments, skins, operators] = await Promise.all([
      db.weapon.findMany({ orderBy: [{ category: "asc" }, { price: "asc" }] }),
      db.attachment.findMany({ orderBy: [{ type: "asc" }, { price: "asc" }] }),
      db.skin.findMany({ orderBy: [{ price: "asc" }] }),
      db.operator.findMany({ orderBy: [{ rarity: "asc" }, { price: "asc" }] }),
    ]);
    return NextResponse.json({ weapons, attachments, skins, operators });
  } catch (err) {
    logger.errorOf(err, "failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load catalog" },
      { status: 500 },
    );
  }
}
