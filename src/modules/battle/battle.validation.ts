// Zod schemas of the `battle` and `campaign` rooms.

import { z } from "zod";
import { LanguageSchema } from "../../shared/localized.js";

import { id, strictPayload } from "../../shared/validation.js";

/**
 * Join options of `battle` (the access token is read by the authenticated room): a battle `mode` (default campaign)
 * and its `target` (campaign: the stage id, also accepted as `stageId`).
 */
export const BattleJoinOptionsSchema = z.object({
  mode: id(16).optional(),
  target: z.string().trim().max(64).optional(),
  stageId: id(64).optional(),
  /** Language of texts such as the title (en, pt, es). */
  lang: z.string().max(8).optional(),
}).transform((o) => ({ mode: o.mode ?? "campaign", target: o.target ?? o.stageId ?? "", lang: o.lang }));

const lane = z.number().int().min(-1).max(64);

/** `cmd`: one player intent, applied at the battle's current tick. */
export const BattleCommandSchema = z.discriminatedUnion("kind", [
  strictPayload({ kind: z.literal("place"), id: id(64), lane, column: lane }),
  strictPayload({ kind: z.literal("upgrade"), lane, column: lane }),
  strictPayload({ kind: z.literal("remove"), lane, column: lane }),
  strictPayload({ kind: z.literal("cast"), id: id(64), lane }),
  strictPayload({ kind: z.literal("pause") }),
  strictPayload({ kind: z.literal("resume") }),
]);

export type BattleCommandMessage = z.infer<typeof BattleCommandSchema>;

/** `speed`: battle time per real second (x1 or x2). */
export const BattleSpeedSchema = strictPayload({ speed: z.union([z.literal(1), z.literal(2)]) });
export type BattleSpeedMessage = z.infer<typeof BattleSpeedSchema>;

/** `sync`: the full state, to resynchronize the client's replica. */
export const BattleSyncSchema = strictPayload({});
export type BattleSyncMessage = z.infer<typeof BattleSyncSchema>;

export const CampaignMessageSchema = z.discriminatedUnion("type", [
  strictPayload({ type: z.literal("info"), lang: LanguageSchema }),
]);

export type CampaignMessage = z.infer<typeof CampaignMessageSchema>;
