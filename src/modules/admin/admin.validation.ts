// Strict zod schemas of every admin API payload.

import { z } from "zod";

import { CURRENCY_IDS } from "../../config/game-config.js";
import { localizedText } from "../../shared/content/localized-text.js";
import { RewardBundleSchema } from "../economy/reward-granter.js";

const amount = z.number().int().min(1).max(1_000_000_000);

export const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const userIdParam = z.string().toLowerCase().regex(USER_ID_PATTERN);

const note = z.string().trim().max(200).default("");

/** Grant or remove currencies and items of one player. */
export const AdjustSchema = z.strictObject({
  mode: z.enum(["grant", "remove"]),
  currencies: z.partialRecord(z.enum(CURRENCY_IDS), amount).default({}),
  items: z.record(z.string().min(1).max(64), amount).default({}),
  note,
}).refine((value) => Object.keys(value.currencies).length + Object.keys(value.items).length > 0, { message: "nothing to grant or remove" });
export type AdjustInput = z.infer<typeof AdjustSchema>;

/** A message to one player, optionally with attachments. */
export const SendMailSchema = z.strictObject({
  sender: z.string().trim().min(1).max(64).default("Pirate Cove"),
  title: localizedText(120),
  body: localizedText(4000),
  attachments: RewardBundleSchema.prefault({}),
  /** 0 = never. */
  expiresInDays: z.number().int().min(0).max(3650).default(0),
});
export type SendMailInput = z.infer<typeof SendMailSchema>;

export const BanSchema = z.strictObject({
  reason: z.string().trim().min(1).max(255),
  /** Ban end (ISO 8601); absent = permanent. */
  until: z.iso.datetime({ offset: true }).optional(),
  /** Alternative to `until`: a ban of this many hours from now. */
  durationHours: z.number().int().min(1).max(24 * 365 * 10).optional(),
}).refine((value) => value.until === undefined || value.durationHours === undefined, { message: "use either until or durationHours" });
export type BanInput = z.infer<typeof BanSchema>;

export const MaintenanceSchema = z.strictObject({ enabled: z.boolean() });

export const RefundSchema = z.strictObject({
  store: z.enum(["google", "apple", "fake"]),
  transactionId: z.string().min(1).max(512),
  reason: z.string().trim().min(1).max(200),
});
export type RefundInput = z.infer<typeof RefundSchema>;

export const SearchQuerySchema = z.strictObject({ q: z.string().trim().min(1).max(100) });
export const AuditQuerySchema = z.strictObject({
  target: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Content ids in the URL (`/news/:id`). */
export const contentIdParam = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
