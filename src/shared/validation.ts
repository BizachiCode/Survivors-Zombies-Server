// Edge validation helpers shared by every room schema.

import { z } from "zod";

/** Trimmed string with a hard length cap. */
export const boundedString = (max: number, min = 0) => z.string().trim().min(min).max(max);

/** Opaque identifier (uids, ids, keys). */
export const id = (max = 64) => z.string().trim().min(1).max(max);

/** Device identifier sent by the client (SystemInfo.deviceUniqueIdentifier or a generated GUID). */
export const deviceId = z.string().trim().min(8).max(128);

/** Login email, normalized to lower case. */
export const email = z.string().trim().toLowerCase().email().max(255);

/** New passwords: 8+ characters (no composition rules, NIST 800-63B). */
export const newPassword = z.string().min(8).max(256);

/**
 * Strict object: unknown keys are rejected (mass-assignment guard). Identity never comes from the payload,
 * the user is always taken from the authenticated session.
 */
export function strictPayload<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).strict();
}
