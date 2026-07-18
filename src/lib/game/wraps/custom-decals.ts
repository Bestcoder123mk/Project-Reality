/**
 * Section E — Player custom decals on weapons.
 *
 * Players can stamp custom decals on their weapons — clan logos, callsigns,
 * kill counters, custom artwork. Each decal is a 2D image (uploaded PNG or a
 * catalog preset) positioned on a specific weapon socket (receiver side,
 * stock, handguard, scope side). The decal is composited onto the wrap's
 * albedo texture as an overlay layer so it inherits the wrap's lighting.
 *
 * Decals support:
 *   - Catalog presets (curated stickers — clan logos, flags, symbols).
 *   - Player-uploaded images (validated: max 256×256, PNG/JPG, <50KB, content
 *     moderation hook).
 *   - Per-decal transforms (position, scale, rotation, opacity).
 *   - Stack limit per weapon (default 4 — balance performance + readability).
 *   - Optional "kill counter" decals that auto-increment from gameplay stats.
 *
 * The compositing happens lazily on the wrap material's canvas — we redraw
 * the wrap texture with the decals overlaid, then mark the THREE texture for
 * GPU re-upload. The composited texture is cached per (wrapSlug + decalSet
 * hash) so re-equipping the same setup is free.
 */
import * as THREE from "three";

// ─── Public types ───────────────────────────────────────────────────────────

export type DecalSocket =
  | "receiver_left"
  | "receiver_right"
  | "receiver_top"
  | "stock_left"
  | "stock_right"
  | "handguard_left"
  | "handguard_right"
  | "scope_left"
  | "scope_right"
  | "magazine_front";

export type DecalSource =
  | { kind: "preset"; presetId: string }
  | { kind: "uploaded"; uploadId: string }
  | { kind: "kill_counter"; counterKind: "kills" | "headshots" | "melee" | "wins" };

export interface CustomDecal {
  /** Stable ID — used for edit/delete. */
  id: string;
  /** Source — preset, uploaded image, or dynamic counter. */
  source: DecalSource;
  /** Socket on the weapon where the decal is stamped. */
  socket: DecalSocket;
  /** Position on the socket's 2D UV footprint (0..1, 0,0 = top-left). */
  position: [number, number];
  /** Scale (1.0 = native, 0.5 = half size). */
  scale: number;
  /** Rotation (radians, clockwise). */
  rotation: number;
  /** Opacity 0..1. */
  opacity: number;
  /** Tint color (hex) — multiplied with the decal image. "#ffffff" = no tint. */
  tint: string;
}

export interface WeaponDecalSet {
  /** Weapon slug this decal set applies to. */
  weaponSlug: string;
  /** Wraps slug the decals are layered on top of. */
  wrapSlug: string;
  /** Decals — max 4 (MAX_DECALS_PER_WEAPON). */
  decals: CustomDecal[];
}

// ─── Limits + validation ────────────────────────────────────────────────────

export const MAX_DECALS_PER_WEAPON = 4;
export const DECAL_IMAGE_MAX_SIZE = 256;
export const DECAL_IMAGE_MAX_BYTES = 50 * 1024; // 50KB

export interface DecalValidationResult {
  ok: boolean;
  error?: string;
}

/** Validate an uploaded decal image (size + dimensions). */
export function validateDecalImage(image: {
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
}): DecalValidationResult {
  if (image.width > DECAL_IMAGE_MAX_SIZE || image.height > DECAL_IMAGE_MAX_SIZE) {
    return { ok: false, error: `Decal image must be ≤ ${DECAL_IMAGE_MAX_SIZE}×${DECAL_IMAGE_MAX_SIZE}px` };
  }
  if (image.bytes > DECAL_IMAGE_MAX_BYTES) {
    return { ok: false, error: `Decal image must be ≤ ${DECAL_IMAGE_MAX_BYTES / 1024}KB` };
  }
  if (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg") {
    return { ok: false, error: "Decal image must be PNG or JPEG" };
  }
  return { ok: true };
}

// ─── Preset decal catalog ───────────────────────────────────────────────────

export interface DecalPreset {
  id: string;
  name: string;
  /** SVG path or canvas-drawable symbol — rendered to a canvas at stamp time. */
  draw: (ctx: CanvasRenderingContext2D, size: number) => void;
  /** Category for the picker UI. */
  category: "clan" | "flag" | "symbol" | "tactical" | "zodiac";
}

/** Draw a star symbol — used by several presets. */
function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, points = 5): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const rr = i % 2 === 0 ? r : r * 0.5;
    const a = (Math.PI / points) * i - Math.PI / 2;
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

/** Draw a skull — tactical preset. */
function drawSkull(ctx: CanvasRenderingContext2D, size: number): void {
  const cx = size / 2, cy = size / 2;
  ctx.fillStyle = "#eae6dc";
  ctx.beginPath();
  ctx.arc(cx, cy - size * 0.05, size * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(cx - size * 0.18, cy + size * 0.05, size * 0.36, size * 0.18);
  ctx.fillStyle = "#1a1a1a";
  ctx.beginPath();
  ctx.arc(cx - size * 0.1, cy - size * 0.05, size * 0.07, 0, Math.PI * 2);
  ctx.arc(cx + size * 0.1, cy - size * 0.05, size * 0.07, 0, Math.PI * 2);
  ctx.fill();
}

/** Draw a Spartan helmet — tactical preset. */
function drawSpartan(ctx: CanvasRenderingContext2D, size: number): void {
  const cx = size / 2;
  ctx.fillStyle = "#c81428";
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.2, size * 0.2);
  ctx.lineTo(cx - size * 0.25, size * 0.6);
  ctx.lineTo(cx + size * 0.25, size * 0.6);
  ctx.lineTo(cx + size * 0.2, size * 0.2);
  ctx.lineTo(cx + size * 0.3, size * 0.4);
  ctx.lineTo(cx + size * 0.3, size * 0.7);
  ctx.lineTo(cx - size * 0.3, size * 0.7);
  ctx.lineTo(cx - size * 0.3, size * 0.4);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(cx - size * 0.08, size * 0.35, size * 0.16, size * 0.04);
}

export const DECAL_PRESETS: DecalPreset[] = [
  {
    id: "star_red",
    name: "Red Star",
    category: "symbol",
    draw: (ctx, size) => {
      ctx.fillStyle = "#c81428";
      drawStar(ctx, size / 2, size / 2, size * 0.4, 5);
    },
  },
  {
    id: "star_gold",
    name: "Gold Star",
    category: "symbol",
    draw: (ctx, size) => {
      ctx.fillStyle = "#ffd040";
      drawStar(ctx, size / 2, size / 2, size * 0.4, 5);
    },
  },
  {
    id: "skull_white",
    name: "Skull",
    category: "tactical",
    draw: (ctx, size) => drawSkull(ctx, size),
  },
  {
    id: "spartan_red",
    name: "Spartan",
    category: "tactical",
    draw: (ctx, size) => drawSpartan(ctx, size),
  },
  {
    id: "spade_black",
    name: "Spade",
    category: "symbol",
    draw: (ctx, size) => {
      const cx = size / 2, cy = size / 2;
      ctx.fillStyle = "#1a1a1a";
      ctx.beginPath();
      ctx.moveTo(cx, cy - size * 0.35);
      ctx.bezierCurveTo(cx + size * 0.4, cy - size * 0.05, cx + size * 0.3, cy + size * 0.25, cx, cy + size * 0.15);
      ctx.bezierCurveTo(cx - size * 0.3, cy + size * 0.25, cx - size * 0.4, cy - size * 0.05, cx, cy - size * 0.35);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(cx - size * 0.08, cy + size * 0.15, size * 0.16, size * 0.12);
    },
  },
  {
    id: "lightning_yellow",
    name: "Lightning",
    category: "symbol",
    draw: (ctx, size) => {
      const cx = size / 2;
      ctx.fillStyle = "#ffd040";
      ctx.beginPath();
      ctx.moveTo(cx + size * 0.1, 0);
      ctx.lineTo(cx - size * 0.2, size * 0.5);
      ctx.lineTo(cx, size * 0.5);
      ctx.lineTo(cx - size * 0.1, size);
      ctx.lineTo(cx + size * 0.2, size * 0.45);
      ctx.lineTo(cx, size * 0.45);
      ctx.closePath();
      ctx.fill();
    },
  },
  {
    id: "clan_alpha",
    name: "Clan Alpha",
    category: "clan",
    draw: (ctx, size) => {
      ctx.fillStyle = "#3a5a8a";
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size * 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffd040";
      ctx.font = `bold ${size * 0.45}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("α", size / 2, size / 2 + size * 0.02);
    },
  },
  {
    id: "clan_bravo",
    name: "Clan Bravo",
    category: "clan",
    draw: (ctx, size) => {
      ctx.fillStyle = "#7a1a1a";
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size * 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#eae6dc";
      ctx.font = `bold ${size * 0.45}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("β", size / 2, size / 2 + size * 0.02);
    },
  },
  {
    id: "flag_tricolor",
    name: "Tricolor",
    category: "flag",
    draw: (ctx, size) => {
      ctx.fillStyle = "#1a3a6a";
      ctx.fillRect(0, 0, size / 3, size);
      ctx.fillStyle = "#eae6dc";
      ctx.fillRect(size / 3, 0, size / 3, size);
      ctx.fillStyle = "#c81428";
      ctx.fillRect((size / 3) * 2, 0, size / 3, size);
    },
  },
  {
    id: "zodiac_aries",
    name: "Aries",
    category: "zodiac",
    draw: (ctx, size) => {
      ctx.strokeStyle = "#c81428";
      ctx.lineWidth = size * 0.06;
      ctx.beginPath();
      ctx.moveTo(size * 0.3, size * 0.3);
      ctx.lineTo(size * 0.5, size * 0.5);
      ctx.lineTo(size * 0.7, size * 0.3);
      ctx.moveTo(size * 0.5, size * 0.5);
      ctx.lineTo(size * 0.5, size * 0.8);
      ctx.stroke();
    },
  },
];

const _presetById = new Map(DECAL_PRESETS.map((p) => [p.id, p]));

export function getPreset(id: string): DecalPreset | undefined {
  return _presetById.get(id);
}

// ─── Kill-counter rendering ─────────────────────────────────────────────────

export interface KillCounterState {
  kills: number;
  headshots: number;
  melee: number;
  wins: number;
}

/** Draw a kill-counter decal — a stamp with the count, red tallies like CS:GO. */
export function drawKillCounter(
  ctx: CanvasRenderingContext2D,
  size: number,
  count: number,
  tint: string = "#c81428",
): void {
  // Background stamp.
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.fillRect(0, 0, size, size * 0.6);
  // Tally marks — groups of 5 (4 vertical + 1 diagonal).
  ctx.strokeStyle = tint;
  ctx.lineWidth = size * 0.04;
  const markH = size * 0.3;
  const markSpacing = size * 0.08;
  const marksPerRow = Math.floor(size / markSpacing) - 2;
  let drawn = 0;
  let row = 0;
  outer: while (drawn < count) {
    for (let i = 0; i < marksPerRow && drawn < count; i++) {
      const x = size * 0.1 + i * markSpacing + (drawn % 5 === 4 ? -markSpacing * 0.2 : 0);
      const y = size * 0.1 + row * (markH + size * 0.05);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + markH);
      ctx.stroke();
      drawn++;
      if (drawn % 5 === 0 && drawn > 0) {
        // Diagonal slash across the last 4 marks.
        ctx.beginPath();
        ctx.moveTo(x - markSpacing * 3.5, y - size * 0.05);
        ctx.lineTo(x + markSpacing * 0.3, y + markH + size * 0.05);
        ctx.stroke();
        if (drawn >= count) break outer;
      }
    }
    row++;
    if (row > 4) break; // safety — don't draw forever
  }
}

// ─── Compositing: stamp decals onto a wrap texture canvas ───────────────────

const _compositeCache = new Map<string, THREE.CanvasTexture>();

/**
 * Composite a set of decals onto a base wrap texture. Returns a new
 * CanvasTexture with the decals overlaid. The composite is cached per
 * (wrapSlug + decalSetHash) — repeated calls with the same set are free.
 *
 * For preset decals, we render the preset's draw() to a small offscreen
 * canvas, then composite it onto the wrap at the decal's position/scale/
 * rotation/opacity. For uploaded images, the caller passes a pre-decoded
 * HTMLImageElement; for kill counters, we render the current count.
 */
export function compositeDecals(
  wrapTexture: THREE.Texture,
  wrapSlug: string,
  decalSet: WeaponDecalSet,
  opts?: {
    uploadedImages?: Map<string, HTMLImageElement>;
    killCounters?: KillCounterState;
  },
): THREE.CanvasTexture {
  // Cache key — hash the wrap + decal set.
  const decalHash = decalSet.decals
    .map((d) => `${d.id}:${d.socket}:${d.position[0]},${d.position[1]}:${d.scale}:${d.rotation}:${d.opacity}:${d.tint}`)
    .join("|");
  const counterHash = opts?.killCounters ? `:${opts.killCounters.kills}:${opts.killCounters.headshots}:${opts.killCounters.melee}:${opts.killCounters.wins}` : "";
  const cacheKey = `${wrapSlug}:${decalHash}${counterHash}`;
  const cached = _compositeCache.get(cacheKey);
  if (cached) return cached;

  // Get the base image — wrapTexture's image (HTMLCanvasElement or HTMLImageElement).
  const baseImg = (wrapTexture as THREE.Texture).image as CanvasImageSource | undefined;
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  // Draw the base wrap texture as the background.
  if (baseImg) {
    ctx.drawImage(baseImg, 0, 0, size, size);
  } else {
    ctx.fillStyle = "#3a3a3e";
    ctx.fillRect(0, 0, size, size);
  }
  // Stamp each decal.
  for (const decal of decalSet.decals) {
    ctx.save();
    const px = decal.position[0] * size;
    const py = decal.position[1] * size;
    ctx.translate(px, py);
    ctx.rotate(decal.rotation);
    ctx.scale(decal.scale, decal.scale);
    ctx.globalAlpha = decal.opacity;
    // Draw the decal to a temporary canvas first (so we can tint it).
    const dSize = size * 0.2; // base decal footprint is 20% of wrap texture
    const tmp = document.createElement("canvas");
    tmp.width = tmp.height = dSize;
    const tctx = tmp.getContext("2d")!;
    if (decal.source.kind === "preset") {
      const preset = getPreset(decal.source.presetId);
      if (preset) preset.draw(tctx, dSize);
    } else if (decal.source.kind === "uploaded") {
      const img = opts?.uploadedImages?.get(decal.source.uploadId);
      if (img) tctx.drawImage(img, 0, 0, dSize, dSize);
    } else if (decal.source.kind === "kill_counter" && opts?.killCounters) {
      const count = opts.killCounters[decal.source.counterKind];
      drawKillCounter(tctx, dSize, count, decal.tint);
    }
    // Apply tint via multiply blend (skip for kill counters — already tinted).
    if (decal.source.kind !== "kill_counter" && decal.tint !== "#ffffff") {
      tctx.globalCompositeOperation = "source-atop";
      tctx.fillStyle = decal.tint;
      tctx.fillRect(0, 0, dSize, dSize);
      tctx.globalCompositeOperation = "source-over";
    }
    // Draw the decal centered on its position.
    ctx.drawImage(tmp, -dSize / 2, -dSize / 2);
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  _compositeCache.set(cacheKey, tex);
  return tex;
}

// ─── Add / remove decals ────────────────────────────────────────────────────

/** Add a decal to a weapon's decal set. Returns the updated set (or null if at limit). */
export function addDecalToSet(
  set: WeaponDecalSet,
  decal: CustomDecal,
): WeaponDecalSet | null {
  if (set.decals.length >= MAX_DECALS_PER_WEAPON) return null;
  return { ...set, decals: [...set.decals, decal] };
}

/** Remove a decal by ID. */
export function removeDecalFromSet(set: WeaponDecalSet, decalId: string): WeaponDecalSet {
  return { ...set, decals: set.decals.filter((d) => d.id !== decalId) };
}

/** Update a decal by ID with a partial patch. */
export function updateDecalInSet(
  set: WeaponDecalSet,
  decalId: string,
  patch: Partial<CustomDecal>,
): WeaponDecalSet {
  return {
    ...set,
    decals: set.decals.map((d) => (d.id === decalId ? { ...d, ...patch } : d)),
  };
}

/** Create an empty decal set for a weapon + wrap. */
export function createEmptyDecalSet(weaponSlug: string, wrapSlug: string): WeaponDecalSet {
  return { weaponSlug, wrapSlug, decals: [] };
}

/** Generate a stable decal ID. */
export function generateDecalId(): string {
  return `decal_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// ─── Content moderation hook ────────────────────────────────────────────────

/**
 * Content-moderation hook — call before stamping an uploaded decal. Returns
 * `approved: true` if the image is safe to display, or `approved: false`
 * with a reason. The actual moderation service is injected via the
 * `moderate` callback (the production wiring uses a Cloud Function that
 * calls the Perspective API / similar).
 */
export async function moderateDecalImage(
  imageBytes: Uint8Array,
  moderate: (bytes: Uint8Array) => Promise<{ approved: boolean; reason?: string }>,
): Promise<DecalValidationResult> {
  try {
    const result = await moderate(imageBytes);
    if (!result.approved) {
      return { ok: false, error: result.reason ?? "Image rejected by moderation" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Moderation service error: ${(e as Error).message}` };
  }
}
