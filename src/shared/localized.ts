// Texts of live content in the template's languages: a plain string, or { en, pt?, es?, zh?, ja?, ko? } resolved per
// request (zh = Simplified Chinese).

import { z } from "zod";

export const LANGUAGES = ["en", "pt", "es", "zh", "ja", "ko"] as const;
export type Language = (typeof LANGUAGES)[number];

const optionalText = z.string().max(2000).optional();

export const LocalizedTextSchema = z.union([
  z.string().max(2000),
  z.strictObject({ en: z.string().max(2000), pt: optionalText, es: optionalText, zh: optionalText, ja: optionalText, ko: optionalText }),
]);

export type LocalizedText = z.infer<typeof LocalizedTextSchema>;

/** Optional `lang` of a request payload (unknown languages fall back to English). */
export const LanguageSchema = z.string().max(8).optional();

/** The text in `lang`, else English. */
export function localize(text: LocalizedText | undefined, lang: string | undefined): string {
  if (text === undefined) return "";
  if (typeof text === "string") return text;
  const value = lang && lang !== "en" && (LANGUAGES as readonly string[]).includes(lang) ? text[lang as Exclude<Language, "en">] : text.en;
  return value && value.length > 0 ? value : text.en;
}
