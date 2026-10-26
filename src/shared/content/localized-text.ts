// Text in live content (news, mail): a plain string or `{ en, pt?, es?, zh?, ja?, ko? }`; the server resolves it to the
// player's language (English fallback) so clients receive one string.

import { z } from "zod";

export const LANGUAGES = ["en", "pt", "es", "zh", "ja", "ko"] as const;
export type Language = (typeof LANGUAGES)[number];

export const localizedText = (max: number) => z.union([
  z.string().min(1).max(max),
  z.strictObject({
    en: z.string().min(1).max(max),
    pt: z.string().min(1).max(max).optional(),
    es: z.string().min(1).max(max).optional(),
    zh: z.string().min(1).max(max).optional(),
    ja: z.string().min(1).max(max).optional(),
    ko: z.string().min(1).max(max).optional(),
  }),
]);

export type LocalizedText = string | { en: string; pt?: string; es?: string; zh?: string; ja?: string; ko?: string };

/** `pt-BR`, `PT`, `es_MX`, `zh-Hans`, `ja-JP`, `ko_KR` ... -> `pt` / `es` / `zh` / `ja` / `ko`; anything unknown is English. */
export function normalizeLanguage(raw: string | undefined | null): Language {
  const prefix = (raw ?? "").trim().toLowerCase().slice(0, 2);
  return (LANGUAGES as readonly string[]).includes(prefix) ? (prefix as Language) : "en";
}

/** The text in `lang`, falling back to English. */
export function resolveText(text: LocalizedText, lang: Language): string {
  if (typeof text === "string") return text;
  return text[lang] ?? text.en;
}

/** MariaDB hands `json()` columns back as text: parses it when needed. */
export function parseJsonColumn<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}
