/**
 * Task-1 (SEC) item 12 — AES-256-GCM field-level encryption.
 *
 * PII-adjacent fields (medical notes, session IPs) are encrypted at
 * rest with AES-256-GCM using a key from `FIELD_ENC_KEY` (32-byte hex
 * string from env). The DB stores the ciphertext as a single
 * base64-string blob containing `iv || tag || ciphertext` — the iv is
 * 12 bytes, the tag is 16 bytes, the ciphertext is the same length as
 * the plaintext.
 *
 * Public API:
 *
 *   const enc = encryptField("player has photosensitivity"); // → base64 string
 *   const dec = decryptField(enc);                            // → original string
 *
 *   await db.playerMedicalState.update({
 *     where: { playerId },
 *     data: { notesEncrypted: encryptField(notes) },
 *   });
 *
 * Why AES-256-GCM (not AES-CBC)?
 *
 *   - GCM provides authenticity (the tag) — a tampered ciphertext is
 *     rejected on decrypt. CBC is malleable — a 1-bit flip in the
 *     ciphertext flips a predictable bit in the plaintext, which is a
 *     real attack when the attacker has DB write access.
 *   - GCM is hardware-accelerated on every modern CPU (AES-NI + CLMUL).
 *
 * Key management: `FIELD_ENC_KEY` is read from env at boot. In dev it
 * falls back to a fixed insecure key (logged once). In production the
 * env var MUST be set — `getFieldEncKey()` throws if it's missing.
 *
 * Key rotation: not implemented (out of scope for the single-player
 * demo). When needed, add a `keyVersion` byte to the blob + a
 * `decryptFieldV1`/`decryptFieldV2` switch — see security.md.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // 96-bit IV — standard for GCM.
const TAG_LEN = 16; // 128-bit auth tag.

/** Encryption key (32 bytes). Throws in production if env var is missing. */
export function getFieldEncKey(): Buffer {
  const env = process.env.FIELD_ENC_KEY;
  if (env) {
    const buf = Buffer.from(env, "hex");
    if (buf.length !== 32) {
      throw new Error(
        `FIELD_ENC_KEY must be 32 bytes (64 hex chars), got ${buf.length} bytes`,
      );
    }
    return buf;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "FIELD_ENC_KEY must be set in production (use the platform secret manager). Generate with: openssl rand -hex 32",
    );
  }
  if (!devKeyWarned) {
    devKeyWarned = true;
    console.warn(
      "[encryption] FIELD_ENC_KEY not set — using insecure dev fallback. Generate one with: openssl rand -hex 32",
    );
  }
  // Fixed dev key — deterministic so the dev DB is consistent across restarts.
  // 32 zero bytes — clearly insecure, easy to spot in a config audit.
  return Buffer.alloc(32, 0);
}
let devKeyWarned = false;

/**
 * Encrypt a UTF-8 string. Returns a base64 string containing
 * `iv || tag || ciphertext`. Returns null when the input is null
 * (so callers can `encryptField(row.notes) ?? null` cleanly).
 */
export function encryptField(plaintext: string | null | undefined): string | null {
  if (plaintext == null) return null;
  const key = getFieldEncKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Pack: iv (12) || tag (16) || ciphertext. Total = 28 + plaintext.length.
  const blob = Buffer.concat([iv, tag, ct]);
  return blob.toString("base64");
}

/**
 * Decrypt a base64 blob produced by `encryptField`. Returns the original
 * UTF-8 string, or null when the input is null. Throws on tamper (the
 * GCM auth tag fails to verify) — caller should catch + treat as "the
 * field is unreadable, fall back to default".
 */
export function decryptField(blob: string | null | undefined): string | null {
  if (blob == null) return null;
  const key = getFieldEncKey();
  const buf = Buffer.from(blob, "base64");
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error("Encrypted blob too short — corrupt or wrong format");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/**
 * Safe decrypt — returns null on any error (tamper, wrong key, corrupt
 * blob). Use this in read paths where a single bad row shouldn't break
 * the whole response.
 */
export function decryptFieldSafe(blob: string | null | undefined): string | null {
  try {
    return decryptField(blob);
  } catch {
    return null;
  }
}
