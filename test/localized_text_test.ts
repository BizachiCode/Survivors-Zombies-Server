// Live-content languages: every template language (en, pt, es, zh, ja, ko) resolves, unknown or missing ones fall back
// to English, and client language tags normalize to the template ids.
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";

import { localizedText, normalizeLanguage, resolveText } from "../src/shared/content/localized-text.js";
import { LocalizedTextSchema, localize } from "../src/shared/localized.js";

describe("localized texts", () => {
  const text = { en: "Victory", pt: "Vitória", es: "Victoria", zh: "胜利", ja: "勝利", ko: "승리" };

  it("resolves every template language and falls back to English", () => {
    for (const lang of ["en", "pt", "es", "zh", "ja", "ko"] as const) assert.equal(localize(text, lang), text[lang]);
    assert.equal(localize(text, "fr"), "Victory");
    assert.equal(localize(text, undefined), "Victory");
    assert.equal(localize({ en: "Only English" }, "ja"), "Only English");
    assert.equal(localize({ en: "Empty", ko: "" }, "ko"), "Empty");
  });

  it("normalizes client language tags", () => {
    assert.equal(normalizeLanguage("zh-Hans"), "zh");
    assert.equal(normalizeLanguage("ja-JP"), "ja");
    assert.equal(normalizeLanguage("ko_KR"), "ko");
    assert.equal(normalizeLanguage("PT-br"), "pt");
    assert.equal(normalizeLanguage("de"), "en");
    assert.equal(resolveText(text, normalizeLanguage("zh-CN")), "胜利");
  });

  it("accepts the six languages in content and rejects unknown keys", () => {
    assert.ok(LocalizedTextSchema.safeParse(text).success);
    assert.ok(localizedText(40).safeParse(text).success);
    assert.equal(LocalizedTextSchema.safeParse({ en: "Hi", fr: "Salut" }).success, false);
  });
});
