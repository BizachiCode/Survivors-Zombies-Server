// News on the fixture file: publication window, ordering (pinned first, then newest), localization with English
// fallback, and hot reload (a changed file is picked up, a broken one keeps the last good content).
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NewsService } from "../src/modules/news/news.service.js";
import { testClock } from "./support/test-services.js";

const FIXTURE = join(__dirname, "fixtures", "news.test.json");

describe("news", () => {
  it("lists published, non-expired items: pinned first, then newest", () => {
    const news = new NewsService(FIXTURE, testClock());
    // clock: 2026-10-21 12:00 UTC; "future" is not published, "expired" ended on the 15th
    assert.deepEqual(news.info("en").map((n) => n.id), ["pinned", "recent", "ends_soon", "old"]);
    const recent = news.info("en").find((n) => n.id === "recent")!;
    assert.deepEqual(recent, {
      id: "recent", title: "Recent", body: "Recent body", image: "shop", url: "https://example.com/recent",
      publishedAtUnix: Date.UTC(2026, 9, 20, 9) / 1000, pinned: false,
    });
  });

  it("resolves texts to the player's language with English fallback", () => {
    const news = new NewsService(FIXTURE, testClock());
    const pick = (lang: string | undefined) => news.info(lang).find((n) => n.id === "recent")!;
    assert.equal(pick("pt").title, "Recente");
    assert.equal(pick("pt-BR").body, "Corpo recente");
    assert.equal(pick("es").title, "Recent", "no Spanish title: English");
    assert.equal(pick("es").body, "Cuerpo reciente");
    assert.equal(pick("fr").title, "Recent");
    assert.equal(pick(undefined).title, "Recent");
    assert.equal(news.info("pt").find((n) => n.id === "old")!.title, "Old news", "plain strings serve every language");
  });

  it("follows the clock: items appear when published and disappear when they expire", () => {
    const clock = testClock();
    const news = new NewsService(FIXTURE, clock);
    clock.set(Date.UTC(2026, 9, 22, 0, 0, 1));
    assert.ok(!news.info("en").some((n) => n.id === "ends_soon"));
    clock.set(Date.UTC(2026, 10, 1));
    assert.ok(news.info("en").some((n) => n.id === "future"));
  });

  describe("hot reload", () => {
    let dir: string;
    let file: string;
    let tick = 0;
    const write = (content: unknown) => {
      writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
      const at = new Date(Date.UTC(2026, 0, 1) + ++tick * 60_000);
      utimesSync(file, at, at); // distinct mtimes even when two writes land in the same millisecond
    };
    const item = (id: string, publishedAt = "2026-10-01T00:00:00Z") => ({ id, title: id, body: id, publishedAt });

    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ctd-news-")); file = join(dir, "news.json"); tick = 0; });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("serves nothing until the file exists, then picks it up and every later change", () => {
      const news = new NewsService(file, testClock());
      assert.deepEqual(news.info("en"), []);
      write({ items: [item("a")] });
      assert.deepEqual(news.info("en").map((n) => n.id), ["a"]);
      write({ items: [item("a"), item("b", "2026-10-10T00:00:00Z")] });
      assert.deepEqual(news.info("en").map((n) => n.id), ["b", "a"]);
    });

    it("keeps the last good content when the file is broken, and recovers when it is fixed", () => {
      write({ items: [item("a")] });
      const news = new NewsService(file, testClock());
      assert.equal(news.info("en").length, 1);
      write("{ not json");
      assert.deepEqual(news.info("en").map((n) => n.id), ["a"]);
      write({ items: [{ id: "x", title: "no body", publishedAt: "2026-10-01T00:00:00Z" }] });
      assert.deepEqual(news.info("en").map((n) => n.id), ["a"], "schema violations are rejected too");
      write({ items: [item("dup"), item("dup")] });
      assert.deepEqual(news.info("en").map((n) => n.id), ["a"], "duplicate ids are rejected");
      write({ items: [item("c")] });
      assert.deepEqual(news.info("en").map((n) => n.id), ["c"]);
    });

    it("rejects links that are not http(s)", () => {
      write({ items: [item("a")] });
      const news = new NewsService(file, testClock());
      assert.equal(news.info("en").length, 1);
      write({ items: [{ ...item("evil"), url: "javascript:alert(1)" }] });
      assert.deepEqual(news.info("en").map((n) => n.id), ["a"]);
    });
  });
});
