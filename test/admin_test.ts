// Admin API: access control (token, rate limit, allow-list, off without a token), player support actions (grant / remove,
// mail, ban / unban, refund), search, dashboard, maintenance, the news and mail broadcast editors, and the audit trail.
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";

import { createAdminModule, type AdminModule } from "../src/modules/admin/admin.module.js";
import { MaintenanceFlag } from "../src/modules/admin/maintenance.js";
import { BattleCatalog } from "../src/modules/battle/content/battle-content.js";
import { FakeStoreValidator } from "../src/modules/iap/validators/fake-store.validator.js";
import { IapRefundService } from "../src/modules/iap/iap-refund.service.js";
import { IapService } from "../src/modules/iap/iap.service.js";
import { MailService } from "../src/modules/mail/mail.service.js";
import { NewsService } from "../src/modules/news/news.service.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { MemoryAdminRepository } from "./support/memory-admin.js";
import { MemoryIapRepository } from "./support/memory-iap.js";
import { MemoryMailRepository } from "./support/memory-mail.js";
import { createTestServices, testClock, TEST_CONTENT_PATH } from "./support/test-services.js";

const TOKEN = "t".repeat(16) + "0123456789abcdef";
const STATIC_DIR = join(__dirname, "..", "admin");

type Json = Record<string, any>;

function shopContent() {
  const c = JSON.parse(readFileSync(TEST_CONTENT_PATH, "utf8"));
  c.shop.products = [
    { id: "gems_small", name: "Pouch of Gems", grants: { currencies: { gems: 80 } } },
    { id: "starter", name: "Starter Pack", grants: { currencies: { gems: 200, coins: 1000 }, items: { plant_xp: 100 } } },
  ];
  return c;
}

const newsItem = (id: string, extra: Json = {}) => ({ id, title: { en: `Title ${id}`, pt: `Titulo ${id}` }, body: `Body ${id}`, publishedAt: "2026-10-01T00:00:00Z", ...extra });

async function setup(options: { token?: string; allowedIps?: string[]; news?: unknown; mail?: unknown; gateNow?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ctd-admin-"));
  const newsPath = join(dir, "news.json");
  const mailPath = join(dir, "mail.json");
  if (options.news !== null) writeFileSync(newsPath, typeof options.news === "string" ? options.news : JSON.stringify(options.news ?? { items: [newsItem("first")] }));
  if (options.mail !== null) writeFileSync(mailPath, JSON.stringify(options.mail ?? { broadcasts: [] }));

  const catalog = BattleCatalog.fromJson(shopContent());
  const clock = testClock();
  const s = createTestServices({ clock, catalog });
  const iapRepository = new MemoryIapRepository();
  const repo = new MemoryAdminRepository(s.store, iapRepository, clock.nowMs);
  const mailRepository = new MemoryMailRepository();
  const knownItem = (itemId: string) => catalog.items.has(itemId);
  const mail = new MailService(mailPath, mailRepository, s.rewards, s.wallets, s.inventory, s.profileRepository, s.uow, clock, knownItem);
  const iap = new IapService(catalog, iapRepository, [new FakeStoreValidator()], s.rewards, s.wallets, s.inventory, s.profileRepository, s.uow, clock, { requireAccountBinding: false });
  const refunds = new IapRefundService(catalog, iapRepository, s.wallets, s.inventory, mail, s.uow, clock);
  const maintenance = new MaintenanceFlag(false);
  const admin: AdminModule = createAdminModule({
    config: { nodeEnv: "test", newsContentPath: newsPath, mailContentPath: mailPath, admin: { token: options.token ?? TOKEN, allowedIps: options.allowedIps ?? [] } },
    repo, users: s.users, profiles: s.profileRepository, wallets: s.wallets, inventory: s.inventory, mail, purchases: iapRepository, refunds,
    sessions: s.sessions, uow: s.uow, clock, maintenance, knownItem, itemIds: () => [...catalog.items.keys()], staticDir: STATIC_DIR, gateNow: options.gateNow,
  });

  const app = express();
  if (admin.router) app.use("/admin", admin.router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<{ status: number; body: Json; headers: Headers }> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: Json = {};
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    return { status: response.status, body: parsed, headers: response.headers };
  }
  const api = {
    get: (path: string) => call("GET", `/admin/api${path}`),
    post: (path: string, body?: unknown) => call("POST", `/admin/api${path}`, body ?? {}),
    put: (path: string, body: unknown) => call("PUT", `/admin/api${path}`, body),
    delete: (path: string) => call("DELETE", `/admin/api${path}`),
  };
  const buyFor = (userId: string) => iap.verify(userId, { store: "fake", productId: "gems_small", receipt: JSON.stringify({ Store: "fake", TransactionID: "fake-admin-0001", Payload: "x" }) });
  const newPlayer = async (n = 1) => (await s.auth.deviceLogin({ deviceId: `device-admin-${String(n).padStart(4, "0")}`, platform: "test" })).userId;
  const close = () => { server.close(); rmSync(dir, { recursive: true, force: true }); };
  return { ...s, admin, repo, mail, mailRepository, iap, maintenance, call, api, newPlayer, buyFor, close, dir, newsPath, mailPath, clock, catalog, base };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function withAdmin(test: (ctx: Ctx) => Promise<void>, options: Parameters<typeof setup>[0] = {}) {
  const ctx = await setup(options);
  try {
    await test(ctx);
  } finally {
    ctx.close();
  }
}

describe("admin", () => {
  describe("access", () => {
    it("is off without ADMIN_TOKEN: no router at all", async () => {
      await withAdmin(async (ctx) => {
        assert.equal(ctx.admin.router, null);
        assert.equal((await ctx.call("GET", "/admin/api/dashboard")).status, 404);
        assert.equal((await ctx.call("GET", "/admin")).status, 404);
      }, { token: "" });
    });

    it("answers 401 to a missing or wrong token and 200 to the right one", async () => {
      await withAdmin(async (ctx) => {
        assert.equal((await ctx.call("GET", "/admin/api/dashboard", undefined, null)).status, 401);
        assert.equal((await ctx.call("GET", "/admin/api/dashboard", undefined, "wrong-token")).status, 401);
        assert.equal((await ctx.call("GET", "/admin/api/dashboard", undefined, TOKEN.slice(0, -1))).status, 401);
        assert.equal((await ctx.call("GET", "/admin/api/dashboard", undefined, `${TOKEN}x`)).status, 401);
        const ok = await ctx.api.get("/dashboard");
        assert.equal(ok.status, 200);
        assert.equal(ok.body.ok, true);
        assert.equal(ok.headers.get("cache-control"), "no-store");
        const basic = await fetch(`${ctx.base}/admin/api/dashboard`, { headers: { authorization: `Basic ${TOKEN}` } });
        assert.equal(basic.status, 401, "only the Bearer scheme is accepted");
        assert.equal((await ctx.api.get("/nope")).status, 404);
      });
    });

    it("locks an address out after repeated failures, even for the right token, until the window passes", async () => {
      let now = 1_000_000;
      await withAdmin(async (ctx) => {
        for (let i = 0; i < 10; i++) assert.equal((await ctx.call("GET", "/admin/api/dashboard", undefined, `bad-${i}`)).status, 401);
        const locked = await ctx.api.get("/dashboard");
        assert.equal(locked.status, 429);
        assert.equal(locked.body.error, "ADMIN_RATE_LIMIT");
        assert.ok(Number(locked.headers.get("retry-after")) > 0);
        assert.equal((await ctx.call("GET", "/admin/api/dashboard", undefined, "bad-again")).status, 429);

        now += 15 * 60_000 + 1;
        assert.equal((await ctx.api.get("/dashboard")).status, 200, "the lockout ends with the window");
      }, { gateNow: () => now });
    });

    it("hides the panel from addresses outside ADMIN_ALLOWED_IPS", async () => {
      await withAdmin(async (ctx) => {
        assert.equal((await ctx.api.get("/dashboard")).status, 404);
        assert.equal((await ctx.call("GET", "/admin")).status, 404);
      }, { allowedIps: ["203.0.113.9"] });
      await withAdmin(async (ctx) => {
        assert.equal((await ctx.api.get("/dashboard")).status, 200);
        assert.equal((await ctx.call("GET", "/admin")).status, 200);
      }, { allowedIps: ["203.0.113.9", "::ffff:127.0.0.1"] });
    });

    it("serves the static panel without a token and nothing outside its folder", async () => {
      await withAdmin(async (ctx) => {
        const page = await fetch(`${ctx.base}/admin`);
        assert.equal(page.status, 200);
        assert.match(page.headers.get("content-type") ?? "", /text\/html/);
        assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
        assert.equal((await fetch(`${ctx.base}/admin/app.js`)).status, 200);
        assert.equal((await fetch(`${ctx.base}/admin/style.css`)).status, 200);
        assert.equal((await fetch(`${ctx.base}/admin/missing.js`)).status, 404);
        assert.equal((await fetch(`${ctx.base}/admin/..%2fpackage.json`)).status, 404);
        assert.ok(!(await page.text()).includes(TOKEN));
      });
    });

    it("rejects malformed and oversized bodies", async () => {
      await withAdmin(async (ctx) => {
        const userId = await ctx.newPlayer();
        assert.equal((await ctx.call("POST", `/admin/api/players/${userId}/adjust`, "{ not json")).status, 400);
        const huge = await ctx.call("POST", `/admin/api/players/${userId}/mail`, { title: "x".repeat(400_000), body: "x" });
        assert.equal(huge.status, 413);
      });
    });
  });

  describe("players", () => {
    it("grants currencies and items through the ledgers with reason ADMIN and audits it", async () => {
      await withAdmin(async (ctx) => {
        const userId = await ctx.newPlayer();
        const response = await ctx.api.post(`/players/${userId}/adjust`, { mode: "grant", currencies: { coins: 500, gems: 20 }, items: { plant_xp: 7 }, note: "compensation" });
        assert.equal(response.status, 200);
        assert.deepEqual([response.body.wallet.coins, response.body.wallet.gems, response.body.items.plant_xp], [500, 20, 7]);
        assert.ok(ctx.store.ledger.some((e) => e.userId === userId && e.reason === "ADMIN" && e.currencyId === "coins" && e.delta === 500));
        assert.ok(ctx.store.itemLedger.some((e) => e.userId === userId && e.reason === "ADMIN" && e.itemId === "plant_xp" && e.delta === 7));

        const [row] = ctx.repo.audit;
        assert.deepEqual([row.action, row.target, row.ip], ["player.grant", userId, "127.0.0.1"]);
        assert.equal((row.payload as Json).note, "compensation");
        assert.ok(!JSON.stringify(ctx.repo.audit).includes(TOKEN), "the token never reaches the audit trail");
      });
    });

    it("removes only what the player has: never below zero, shortfall reported", async () => {
      await withAdmin(async (ctx) => {
        const userId = await ctx.newPlayer();
        await ctx.api.post(`/players/${userId}/adjust`, { mode: "grant", currencies: { coins: 100 }, items: { plant_xp: 5 } });
        const response = await ctx.api.post(`/players/${userId}/adjust`, { mode: "remove", currencies: { coins: 250, gems: 10 }, items: { plant_xp: 9 } });
        assert.equal(response.status, 200);
        assert.deepEqual(response.body.applied, { currencies: { coins: 100 }, items: { plant_xp: 5 } });
        assert.deepEqual(response.body.shortfall, { currencies: { coins: 150, gems: 10 }, items: { plant_xp: 4 } });
        assert.deepEqual([response.body.wallet.coins, response.body.wallet.gems, response.body.items.plant_xp ?? 0], [0, 0, 0]);
        assert.ok(ctx.store.ledger.filter((e) => e.userId === userId).every((e) => e.balanceAfter >= 0));
        assert.equal(ctx.repo.audit[ctx.repo.audit.length - 1].action, "player.remove");
      });
    });

    it("validates every payload and refuses unknown players and items", async () => {
      await withAdmin(async (ctx) => {
        const userId = await ctx.newPlayer();
        const adjust = (body: unknown, id = userId) => ctx.api.post(`/players/${id}/adjust`, body);
        for (const body of [
          {}, { mode: "give", currencies: { coins: 1 } }, { mode: "grant" }, { mode: "grant", currencies: { coins: 0 } }, { mode: "grant", currencies: { coins: -5 } },
          { mode: "grant", currencies: { coins: 1.5 } }, { mode: "grant", currencies: { diamonds: 5 } }, { mode: "grant", currencies: { coins: 1 }, extra: true },
          { mode: "grant", currencies: { coins: 2_000_000_000 } }, { mode: "grant", items: { plant_xp: "5" } },
        ]) {
          const response = await adjust(body);
          assert.equal(response.status, 400, JSON.stringify(body));
          assert.equal(response.body.error, "ADMIN_INVALID_PAYLOAD");
        }
        assert.equal((await adjust({ mode: "grant", items: { not_an_item: 1 } })).body.error, "ADMIN_UNKNOWN_ITEM");
        assert.equal((await adjust({ mode: "grant", currencies: { coins: 1 } }, "0f8fad5b-d9cb-469f-a165-70867728950e")).status, 404);
        assert.equal((await adjust({ mode: "grant", currencies: { coins: 1 } }, "not-a-uuid")).status, 400);
        assert.equal((await ctx.wallets.snapshot(userId)).coins, 0, "nothing was granted");
        assert.equal(ctx.repo.audit.length, 0, "failed requests leave no audit rows");
      });
    });

    it("sends mail with attachments to one player", async () => {
      await withAdmin(async (ctx) => {
        const userId = await ctx.newPlayer();
        const sent = await ctx.api.post(`/players/${userId}/mail`, {
          title: { en: "Sorry", pt: "Desculpe" }, body: "Here is a gift", sender: "Support", attachments: { currencies: { gems: 50 }, items: { plant_xp: 3 } }, expiresInDays: 7,
        });
        assert.equal(sent.status, 200);
        const inbox = await ctx.mail.info(userId, "pt");
        const mail = inbox.mails.find((m) => m.id === sent.body.mailId)!;
        assert.deepEqual([mail.title, mail.sender, mail.attachments.currencies, mail.attachments.items], ["Desculpe", "Support", { gems: 50 }, { plant_xp: 3 }]);
        assert.ok(mail.expiresAtUnix > 0);
        const claimed = await ctx.mail.claim(userId, mail.id);
        assert.equal(claimed.wallet.gems, 50);
        assert.equal(ctx.repo.audit[0].action, "player.mail");

        assert.equal((await ctx.api.post(`/players/${userId}/mail`, { title: "x", body: "y", attachments: { items: { nope: 1 } } })).body.error, "ADMIN_UNKNOWN_ITEM");
        assert.equal((await ctx.api.post(`/players/${userId}/mail`, { title: "", body: "y" })).status, 400);
        assert.equal((await ctx.api.post(`/players/${userId}/mail`, { title: "x", body: "y", attachments: { currencies: { gems: 0 } } })).status, 400);
      });
    });

    it("bans with a reason and an end, kicks the sessions, and unbans", async () => {
      await withAdmin(async (ctx) => {
        const device = { deviceId: "device-admin-ban-1", platform: "test" };
        const login = await ctx.auth.deviceLogin(device);
        const userId = login.userId;
        const deviceKey = ctx.auth.deviceKey(device.deviceId);
        assert.ok(await ctx.sessions.getSession(userId, deviceKey), "the device has a live session");

        const until = new Date(ctx.clock.nowMs() + 3 * 3_600_000).toISOString();
        const banned = await ctx.api.post(`/players/${userId}/ban`, { reason: "cheating", until });
        assert.equal(banned.status, 200);
        assert.equal(banned.body.reason, "cheating");
        assert.equal(await ctx.sessions.getSession(userId, deviceKey), null, "the session was ended");
        await assert.rejects(ctx.auth.deviceLogin(device), (error: unknown) => error instanceof AppError && error.errorCode === "AUTH_BANNED"
          && (error.extra as Json).reason === "cheating" && (error.extra as Json).until === Math.floor(Date.parse(until) / 1000));
        await assert.rejects(ctx.auth.refresh(userId, login.refreshToken, device), (error: unknown) => error instanceof AppError && error.errorCode === "AUTH_BANNED");

        const detail = await ctx.api.get(`/players/${userId}`);
        assert.deepEqual([detail.body.ban.banned, detail.body.ban.reason, detail.body.player.isBanned], [true, "cheating", true]);

        const unbanned = await ctx.api.post(`/players/${userId}/unban`);
        assert.equal(unbanned.status, 200);
        assert.equal((await ctx.auth.deviceLogin(device)).userId, userId, "the player can sign in again");
        assert.equal((await ctx.api.get(`/players/${userId}`)).body.ban.banned, false);

        assert.deepEqual(ctx.repo.audit.map((a) => a.action), ["player.ban", "player.unban"]);
        assert.deepEqual(ctx.store.audit.filter((a) => a.kind === "BAN" || a.kind === "UNBAN").map((a) => a.kind), ["BAN", "UNBAN"], "the auth trail has them too");
      });
    });

    it("bans for a number of hours or forever, and refuses bad bans", async () => {
      await withAdmin(async (ctx) => {
        const userId = await ctx.newPlayer();
        const hours = await ctx.api.post(`/players/${userId}/ban`, { reason: "spam", durationHours: 24 });
        assert.equal(hours.body.untilUnix, Math.floor(ctx.clock.nowMs() / 1000) + 24 * 3600);
        const forever = await ctx.api.post(`/players/${userId}/ban`, { reason: "worse" });
        assert.equal(forever.body.untilUnix, null);
        assert.equal((await ctx.api.post(`/players/${userId}/ban`, { reason: "" })).status, 400);
        assert.equal((await ctx.api.post(`/players/${userId}/ban`, { reason: "x", until: "2020-01-01T00:00:00Z" })).status, 400, "must end in the future");
        assert.equal((await ctx.api.post(`/players/${userId}/ban`, { reason: "x", until: "later" })).status, 400);
        assert.equal((await ctx.api.post(`/players/${userId}/ban`, { reason: "x", durationHours: 1, until: "2030-01-01T00:00:00Z" })).status, 400);
        assert.equal((await ctx.api.post("/players/0f8fad5b-d9cb-469f-a165-70867728950e/ban", { reason: "x" })).status, 404);
      });
    });

    it("finds players by public code, nickname prefix, email and user id, and shows their details", async () => {
      await withAdmin(async (ctx) => {
        const a = await ctx.newPlayer(1);
        const b = await ctx.newPlayer(2);
        ctx.store.profiles.get(a)!.nickname = "CaptainHook";
        ctx.store.profiles.get(b)!.nickname = "Smee";
        ctx.store.users.get(a)!.email = "hook@example.com";
        const code = a.replace(/-/g, "").slice(0, 8);

        const find = async (q: string) => (await ctx.api.get(`/players?q=${encodeURIComponent(q)}`)).body.players.map((p: Json) => p.userId);
        assert.deepEqual(await find(code), [a]);
        assert.deepEqual(await find(code.toUpperCase()), [a]);
        assert.deepEqual(await find("captain"), [a]);
        assert.deepEqual(await find("sm"), [b]);
        assert.deepEqual(await find("HOOK@example.com"), [a]);
        assert.deepEqual(await find(a), [a]);
        assert.deepEqual(await find("nobody"), []);
        assert.equal((await ctx.api.get("/players")).status, 400);

        await ctx.buyFor(a);
        ctx.repo.friends.set(a, 3);
        const detail = (await ctx.api.get(`/players/${a}`)).body;
        assert.deepEqual([detail.player.nickname, detail.player.publicCode, detail.player.email, detail.friends], ["CaptainHook", code.toUpperCase(), "hook@example.com", 3]);
        assert.equal(detail.wallet.gems, 80);
        assert.deepEqual([detail.purchases.length, detail.purchases[0].productId, detail.purchases[0].status], [1, "gems_small", "granted"]);
        assert.ok(Array.isArray(detail.battles) && Array.isArray(detail.audit));
        assert.equal((await ctx.api.get("/players/0f8fad5b-d9cb-469f-a165-70867728950e")).status, 404);
      });
    });

    it("refunds a purchase by hand and records it", async () => {
      await withAdmin(async (ctx) => {
        const userId = await ctx.newPlayer();
        await ctx.buyFor(userId);
        const refund = await ctx.api.post("/refunds", { store: "fake", transactionId: "fake-admin-0001", reason: "customer asked" });
        assert.equal(refund.status, 200);
        assert.equal(refund.body.refund.status, "refunded");
        assert.equal((await ctx.wallets.snapshot(userId)).gems, 0);
        const detail = (await ctx.api.get(`/players/${userId}`)).body;
        assert.deepEqual([detail.purchases[0].status, detail.purchases[0].refundReason], ["refunded", "admin:customer asked"]);
        assert.equal(detail.audit[0].action, "iap.refund");

        assert.equal((await ctx.api.post("/refunds", { store: "fake", transactionId: "fake-admin-0001", reason: "again" })).body.refund.status, "already_refunded");
        assert.equal((await ctx.api.post("/refunds", { store: "fake", transactionId: "never", reason: "x" })).status, 404);
        assert.equal((await ctx.api.post("/refunds", { store: "steam", transactionId: "x", reason: "x" })).status, 400);
      });
    });
  });

  describe("server", () => {
    it("reports the dashboard", async () => {
      await withAdmin(async (ctx) => {
        const a = await ctx.newPlayer(1);
        await ctx.newPlayer(2);
        ctx.repo.lastLogin.set(a, new Date(ctx.clock.nowMs() - 3_600_000));
        await ctx.buyFor(a);
        const { body } = await ctx.api.get("/dashboard");
        assert.deepEqual(body.players, { total: 2, activeToday: 1, activeWeek: 1, newToday: 2 });
        assert.deepEqual(body.purchasesToday, { total: 1, refunded: 0, byProduct: [{ productId: "gems_small", count: 1, refunded: 0 }] });
        assert.equal(typeof body.server.version, "string");
        assert.equal(body.server.maintenance, false);
        assert.equal(Number.isInteger(body.server.uptimeSec), true);
        const meta = (await ctx.api.get("/meta")).body;
        assert.deepEqual(meta.currencies, ["coins", "gems"]);
        assert.ok(meta.items.includes("plant_xp"));
      });
    });

    it("switches maintenance at runtime and audits it", async () => {
      await withAdmin(async (ctx) => {
        assert.deepEqual((await ctx.api.get("/maintenance")).body.enabled, false);
        assert.equal((await ctx.api.post("/maintenance", { enabled: true })).body.enabled, true);
        assert.equal(ctx.maintenance.isEnabled(), true, "the flag the auth room reads changed");
        assert.equal((await ctx.api.get("/dashboard")).body.server.maintenance, true);
        assert.equal((await ctx.api.post("/maintenance", { enabled: "yes" })).status, 400);
        await ctx.api.post("/maintenance", { enabled: false });
        assert.equal(ctx.maintenance.isEnabled(), false);
        assert.deepEqual(ctx.repo.audit.map((a) => [a.action, (a.payload as Json).enabled]), [["maintenance", true], ["maintenance", false]]);
      });
    });

    it("lists the audit trail, filtered by target", async () => {
      await withAdmin(async (ctx) => {
        const a = await ctx.newPlayer(1);
        const b = await ctx.newPlayer(2);
        await ctx.api.post(`/players/${a}/adjust`, { mode: "grant", currencies: { coins: 1 } });
        await ctx.api.post(`/players/${b}/adjust`, { mode: "grant", currencies: { coins: 2 } });
        const all = (await ctx.api.get("/audit")).body.entries;
        assert.deepEqual(all.map((e: Json) => e.target), [b, a], "newest first");
        assert.deepEqual((await ctx.api.get(`/audit?target=${a}`)).body.entries.map((e: Json) => e.target), [a]);
        assert.equal((await ctx.api.get("/audit?limit=0")).status, 400);
      });
    });
  });

  describe("news editor", () => {
    it("lists, creates, edits and deletes entries; the news service sees every change", async () => {
      await withAdmin(async (ctx) => {
        const news = new NewsService(ctx.newsPath, ctx.clock);
        assert.deepEqual(news.info("en").map((n) => n.id), ["first"]);

        const listed = await ctx.api.get("/news");
        assert.deepEqual(listed.body.items.map((i: Json) => i.id), ["first"]);

        const created = await ctx.api.post("/news", newsItem("second", { pinned: true }));
        assert.equal(created.status, 200);
        assert.deepEqual(created.body.items.map((i: Json) => i.id), ["first", "second"]);
        assert.deepEqual(news.info("en").map((n) => n.id), ["second", "first"], "hot reload: pinned item first");
        const onDisk = JSON.parse(readFileSync(ctx.newsPath, "utf8"));
        assert.equal(onDisk.items[1].image, "", "defaults are filled in");

        const edited = await ctx.api.put("/news/second", newsItem("second", { title: "Edited", pinned: false }));
        assert.equal(edited.status, 200);
        assert.equal(news.info("en").find((n) => n.id === "second")!.title, "Edited");

        assert.equal((await ctx.api.delete("/news/first")).status, 200);
        assert.deepEqual(news.info("en").map((n) => n.id), ["second"]);
        assert.deepEqual(readdirSync(ctx.dir).filter((f) => f.endsWith(".tmp")), [], "no temporary files are left behind");
        assert.deepEqual(ctx.repo.audit.map((a) => [a.action, a.target]), [["news.create", "news:second"], ["news.update", "news:second"], ["news.delete", "news:first"]]);
      });
    });

    it("validates with the news schema and leaves the file untouched on any refusal", async () => {
      await withAdmin(async (ctx) => {
        const before = readFileSync(ctx.newsPath, "utf8");
        const refused = async (response: Promise<{ status: number; body: Json }>, status: number, error: string) => {
          const r = await response;
          assert.deepEqual([r.status, r.body.error], [status, error]);
        };
        await refused(ctx.api.post("/news", { id: "x", title: "t", publishedAt: "2026-10-01T00:00:00Z" }), 400, "ADMIN_INVALID_PAYLOAD");
        await refused(ctx.api.post("/news", newsItem("bad id!")), 400, "ADMIN_INVALID_PAYLOAD");
        await refused(ctx.api.post("/news", newsItem("x", { url: "javascript:alert(1)" })), 400, "ADMIN_INVALID_PAYLOAD");
        await refused(ctx.api.post("/news", newsItem("x", { publishedAt: "yesterday" })), 400, "ADMIN_INVALID_PAYLOAD");
        await refused(ctx.api.post("/news", newsItem("x", { unknownField: 1 })), 400, "ADMIN_INVALID_PAYLOAD");
        await refused(ctx.api.post("/news", newsItem("x", { title: { pt: "so pt" } })), 400, "ADMIN_INVALID_PAYLOAD");
        await refused(ctx.api.post("/news", newsItem("x", { body: "b".repeat(4001) })), 400, "ADMIN_INVALID_PAYLOAD");
        await refused(ctx.api.post("/news", newsItem("first")), 409, "ADMIN_CONTENT_DUPLICATE_ID");
        await refused(ctx.api.put("/news/first", newsItem("other")), 400, "ADMIN_INVALID_PAYLOAD");
        await refused(ctx.api.put("/news/ghost", newsItem("ghost")), 404, "ADMIN_CONTENT_NOT_FOUND");
        await refused(ctx.api.delete("/news/ghost"), 404, "ADMIN_CONTENT_NOT_FOUND");
        await refused(ctx.api.delete("/news/bad%20id"), 400, "ADMIN_INVALID_PAYLOAD");
        assert.equal(readFileSync(ctx.newsPath, "utf8"), before);
        assert.equal(ctx.repo.audit.length, 0);
        const issues = (await ctx.api.post("/news", { id: "x" })).body.issues as Array<{ path: string }>;
        assert.ok(issues.some((i) => i.path === "title"), "the answer says which fields are wrong");
      });
    });

    it("refuses to edit a file that is already broken, and creates a missing one", async () => {
      await withAdmin(async (ctx) => {
        const response = await ctx.api.post("/news", newsItem("x"));
        assert.deepEqual([response.status, response.body.error], [409, "ADMIN_CONTENT_INVALID"]);
        assert.equal(readFileSync(ctx.newsPath, "utf8"), "{ broken");
      }, { news: "{ broken" });
      await withAdmin(async (ctx) => {
        assert.deepEqual((await ctx.api.get("/news")).body.items, []);
        assert.equal((await ctx.api.post("/news", newsItem("x"))).status, 200);
        assert.ok(existsSync(ctx.newsPath));
      }, { news: null });
    });

    it("serializes concurrent edits", async () => {
      await withAdmin(async (ctx) => {
        const results = await Promise.all(["a", "b", "c", "d", "e"].map((id) => ctx.api.post("/news", newsItem(id))));
        assert.ok(results.every((r) => r.status === 200));
        assert.equal(JSON.parse(readFileSync(ctx.newsPath, "utf8")).items.length, 6, "no edit was lost");
      });
    });
  });

  describe("mail broadcast editor", () => {
    const broadcast = (id: string, extra: Json = {}) => ({ id, title: { en: "Hello", pt: "Ola" }, body: "Body", attachments: { currencies: { gems: 5 } }, ...extra });

    it("creates, edits and deletes broadcasts that the mail service delivers", async () => {
      await withAdmin(async (ctx) => {
        const userId = await ctx.newPlayer();
        assert.deepEqual((await ctx.api.get("/mail-broadcasts")).body.broadcasts, []);
        const created = await ctx.api.post("/mail-broadcasts", broadcast("event_a"));
        assert.equal(created.status, 200);
        const inbox = await ctx.mail.info(userId, "pt");
        assert.deepEqual(inbox.mails.map((m) => [m.title, m.attachments.currencies]), [["Ola", { gems: 5 }]]);

        const edited = await ctx.api.put("/mail-broadcasts/event_a", broadcast("event_a", { expiresAfterDays: 3 }));
        assert.equal(edited.body.broadcasts[0].expiresAfterDays, 3);
        assert.equal((await ctx.api.delete("/mail-broadcasts/event_a")).status, 200);
        assert.deepEqual((await ctx.api.get("/mail-broadcasts")).body.broadcasts, []);
        assert.deepEqual(ctx.repo.audit.map((a) => a.action), ["mail_broadcast.create", "mail_broadcast.update", "mail_broadcast.delete"]);
      });
    });

    it("rejects invalid broadcasts and unknown attachment items", async () => {
      await withAdmin(async (ctx) => {
        const before = readFileSync(ctx.mailPath, "utf8");
        for (const body of [
          broadcast("x", { attachments: { items: { nope: 1 } } }), broadcast("x", { attachments: { currencies: { gems: 0 } } }), broadcast("x", { startsAt: "soon" }),
          broadcast("x", { expiresAfterDays: -1 }), { id: "x", title: "t" }, broadcast("bad id"), broadcast("x", { extra: 1 }),
        ]) {
          const r = await ctx.api.post("/mail-broadcasts", body);
          assert.deepEqual([r.status, r.body.error], [400, "ADMIN_INVALID_PAYLOAD"], JSON.stringify(body));
        }
        assert.equal(readFileSync(ctx.mailPath, "utf8"), before);
        await ctx.api.post("/mail-broadcasts", broadcast("dup"));
        assert.equal((await ctx.api.post("/mail-broadcasts", broadcast("dup"))).status, 409);
      });
    });
  });
});
