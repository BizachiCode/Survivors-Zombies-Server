// News content (content/news.json, written by Unity's "Export Live Content" or by hand; hot-reloaded): announcements
// shown in the client's inbox. Texts are a string or `{ en, pt?, es? }`.

import { z } from "zod";

import { localizedText } from "../../shared/content/localized-text.js";

const id = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const isoDate = z.iso.datetime({ offset: true });

export const NewsItemSchema = z.strictObject({
  id,
  title: localizedText(120),
  body: localizedText(4000),
  /** Art key the client maps to a sprite. */
  image: z.string().max(64).default(""),
  /** Optional link opened in the browser. */
  url: z.string().max(512).refine((value) => value === "" || /^https?:\/\//i.test(value), "url must be empty or http(s)").default(""),
  publishedAt: isoDate,
  /** Hidden from this moment on; absent = never. */
  expiresAt: isoDate.optional(),
  /** Pinned items are listed first. */
  pinned: z.boolean().default(false),
});

export const NewsContentSchema = z.strictObject({
  items: z.array(NewsItemSchema).max(200),
}).superRefine((content, ctx) => {
  const seen = new Set<string>();
  for (const item of content.items) {
    if (seen.has(item.id)) ctx.addIssue({ code: "custom", message: `Duplicate news id: ${item.id}.` });
    seen.add(item.id);
  }
});

export type NewsItemContent = z.infer<typeof NewsItemSchema>;
export type NewsContent = z.infer<typeof NewsContentSchema>;
