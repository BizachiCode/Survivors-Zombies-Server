// Mail content (content/mail.json, hot-reloaded): broadcasts every player receives once in the inbox (welcome gift,
// event rewards). Per-player mail (compensation, rewards from other features) is sent in code with MailService.send.

import { z } from "zod";

import { localizedText } from "../../shared/content/localized-text.js";
import { RewardBundleSchema } from "../economy/reward-granter.js";

const id = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const isoDate = z.iso.datetime({ offset: true });

export const MailBroadcastSchema = z.strictObject({
  id,
  sender: z.string().min(1).max(64).default("Pirate Cove"),
  title: localizedText(120),
  body: localizedText(4000),
  attachments: RewardBundleSchema.prefault({}),
  /** Delivered to players who open their inbox from this moment on; absent = always. */
  startsAt: isoDate.optional(),
  /** ... until this moment (the mail itself then lives for `expiresAfterDays`). */
  endsAt: isoDate.optional(),
  /** Days the mail stays in an inbox after delivery; 0 = never expires. */
  expiresAfterDays: z.number().int().min(0).max(3650).default(30),
});

export const MailContentSchema = z.strictObject({
  broadcasts: z.array(MailBroadcastSchema).max(200),
}).superRefine((content, ctx) => {
  const seen = new Set<string>();
  for (const broadcast of content.broadcasts) {
    if (seen.has(broadcast.id)) ctx.addIssue({ code: "custom", message: `Duplicate mail broadcast id: ${broadcast.id}.` });
    seen.add(broadcast.id);
  }
});

export type MailBroadcast = z.infer<typeof MailBroadcastSchema>;
export type MailContent = z.infer<typeof MailContentSchema>;
