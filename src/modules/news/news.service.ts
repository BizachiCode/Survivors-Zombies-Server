// News: the published, non-expired announcements in the player's language. The content file is hot-reloaded.

import { HotJsonFile } from "../../shared/content/hot-json-file.js";
import { normalizeLanguage, resolveText } from "../../shared/content/localized-text.js";
import type { Clock } from "../../shared/kernel/clock.js";
import { createLogger } from "../../shared/logger.js";
import { NewsContentSchema, type NewsContent } from "./news-content.js";

export type NewsItemDto = {
  id: string;
  title: string;
  body: string;
  image: string;
  url: string;
  publishedAtUnix: number;
  pinned: boolean;
};

export class NewsService {
  private readonly file: HotJsonFile<NewsContent>;

  constructor(contentPath: string, private readonly clock: Clock) {
    this.file = new HotJsonFile(contentPath, NewsContentSchema, { items: [] }, createLogger("News"));
  }

  /** Published and not expired items, pinned first then newest, texts in `lang` (English fallback). */
  info(lang?: string): NewsItemDto[] {
    const language = normalizeLanguage(lang);
    const now = this.clock.nowMs();
    return this.file.get().items
      .map((item) => ({ item, publishedAt: Date.parse(item.publishedAt), expiresAt: item.expiresAt ? Date.parse(item.expiresAt) : Infinity }))
      .filter((entry) => entry.publishedAt <= now && entry.expiresAt > now)
      .sort((a, b) => Number(b.item.pinned) - Number(a.item.pinned) || b.publishedAt - a.publishedAt || a.item.id.localeCompare(b.item.id))
      .map(({ item, publishedAt }): NewsItemDto => ({
        id: item.id,
        title: resolveText(item.title, language),
        body: resolveText(item.body, language),
        image: item.image,
        url: item.url,
        publishedAtUnix: Math.floor(publishedAt / 1000),
        pinned: item.pinned,
      }));
  }
}
