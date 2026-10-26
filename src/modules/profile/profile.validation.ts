// Zod schemas for the `profile` request (multiplexed by `type`). Nickname rules are checked by the service so each
// broken rule answers its own error code.

import { z } from "zod";

import { id, strictPayload } from "../../shared/validation.js";

export const ProfileMessageSchema = z.discriminatedUnion("type", [
  strictPayload({ type: z.literal("info") }),
  strictPayload({ type: z.literal("set_nickname"), nickname: z.string().max(64) }),
  strictPayload({ type: z.literal("set_avatar"), avatarId: id(64) }),
]);

export type ProfileMessage = z.infer<typeof ProfileMessageSchema>;

export const PROFILE_ACTIONS = new Set(["info", "set_nickname", "set_avatar"]);
