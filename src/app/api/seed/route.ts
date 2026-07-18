import { NextResponse } from "next/server";
import { createLogger } from "@/lib/logger";
import { ensureSeed } from "@/lib/api";
const logger = createLogger("/api/seed");

export async function GET() {
  try {
    await ensureSeed();
    return NextResponse.json({ ok: true, message: "Seed complete" });
  } catch (err) {
    logger.errorOf(err, "failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Seed failed" },
      { status: 500 },
    );
  }
}
