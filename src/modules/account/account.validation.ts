// Zod schemas for the `account` request (multiplexed by `type`).

import { z } from "zod";

import { email, newPassword, strictPayload } from "../../shared/validation.js";

export const AccountMessageSchema = z.discriminatedUnion("type", [
  strictPayload({ type: z.literal("info") }),
  strictPayload({ type: z.literal("link_email"), email, password: newPassword }),
  strictPayload({ type: z.literal("change_password"), currentPassword: z.string().min(1).max(256), newPassword }),
]);

export type AccountMessage = z.infer<typeof AccountMessageSchema>;

export const ACCOUNT_ACTIONS = new Set(["info", "link_email", "change_password"]);
