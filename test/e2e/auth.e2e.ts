// End-to-end: the real server (app.config.ts) against MySQL/MariaDB and Redis, database `ctd_e2e` (E2E_MYSQL_DATABASE).
// Skips itself when MySQL is unreachable. Run with `npm run test:e2e` (the dev database helper: `npm run devdb:start`).

import assert from "node:assert/strict";
// Static import: a dynamic import() would load the ESM build, whose @colyseus/core differs from the server's CJS one.
import { boot, type ColyseusTestServer } from "@colyseus/testing";

process.env.MYSQL_DATABASE = process.env.E2E_MYSQL_DATABASE || "ctd_e2e";
process.env.REDIS_KEY_PREFIX = "ctd-e2e:";
process.env.DEV_TOOLS = "false";

const PORT = Number(process.env.E2E_PORT || 2580);

describe("e2e: accounts, profile, wallet and collection over the real stack", function () {
  let colyseus: ColyseusTestServer;
  let available = true;

  before(async function () {
    const { env } = await import("../../src/config/env.js");
    const { db, pool } = await import("../../src/infrastructure/database/drizzle.js");
    const { prepareDatabase } = await import("../../src/infrastructure/database/migrate.js");
    try {
      await prepareDatabase(db, env.mysql, () => undefined);
    } catch (error) {
      available = false;
      console.warn(`  (skipped: ${(error as Error).message.split("\n")[0]})`);
      await pool.end().catch((): void => undefined);
      this.skip();
    }
    // Fresh tables for every run (children first: foreign keys).
    for (const table of ["shop_purchases", "item_ledger", "user_items", "user_decks", "user_cards", "battle_results", "user_stage_progress", "currency_ledger",
      "user_currencies", "audit_events", "user_refresh_tokens", "user_devices", "user_profile", "users"]) {
      await pool.query(`DELETE FROM \`${table}\``);
    }
    // Named export: under CommonJS a dynamic import's `default` is the whole module.exports object.
    const { server } = await import("../../src/app.config.js");
    colyseus = await boot(server, PORT);
  });

  after(async () => {
    if (!available) return;
    await colyseus?.shutdown();
    const { redis } = await import("../../src/app.config.js");
    await redis?.quit().catch((): void => undefined);
    const { pool } = await import("../../src/infrastructure/database/drizzle.js");
    await pool.end().catch((): void => undefined);
  });

  it("keeps one guest per device, links an email and signs in with it elsewhere", async () => {
    const auth = await colyseus.sdk.joinOrCreate("auth");
    const first: any = await auth.request("auth", { type: "device", deviceId: "e2e-device-aaaa", platform: "Android" });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.created, true);
    const second: any = await auth.request("auth", { type: "device", deviceId: "e2e-device-aaaa" });
    assert.equal(second.userId, first.userId);
    assert.equal(second.created, false);

    const account = await colyseus.sdk.joinOrCreate("account", { accessToken: second.accessToken });
    const linked: any = await account.request("account", { type: "link_email", email: "e2e@example.com", password: "e2e-password" });
    assert.equal(linked.ok, true, JSON.stringify(linked));
    assert.equal(linked.account.isGuest, false);

    const otherDevice: any = await auth.request("auth", { type: "login", email: "e2e@example.com", password: "e2e-password", deviceId: "e2e-device-bbbb" });
    assert.equal(otherDevice.userId, first.userId);

    const fresh: any = await auth.request("auth", { type: "device", deviceId: "e2e-device-aaaa" });
    assert.equal(fresh.created, true);
    assert.notEqual(fresh.userId, first.userId);

    const refreshed: any = await auth.request("auth", { type: "refresh", userId: otherDevice.userId, refreshToken: otherDevice.refreshToken, deviceId: "e2e-device-bbbb" });
    assert.equal(refreshed.ok, true);
    const stale: any = await auth.request("auth", { type: "refresh", userId: otherDevice.userId, refreshToken: otherDevice.refreshToken, deviceId: "e2e-device-bbbb" });
    assert.equal(stale.error, "AUTH_INVALID_REFRESH");
  });

  it("keeps the profile and the wallet in the database", async () => {
    const { env } = await import("../../src/config/env.js");
    const { container } = await import("../../src/app.config.js");
    const { db, pool } = await import("../../src/infrastructure/database/drizzle.js");
    const { DrizzleUnitOfWork } = await import("../../src/infrastructure/database/drizzle-unit-of-work.js");
    const uow = new DrizzleUnitOfWork(db);
    const wallets = container.services.wallets;

    const auth = await colyseus.sdk.joinOrCreate("auth");
    const guest: any = await auth.request("auth", { type: "device", deviceId: "e2e-device-cccc" });
    assert.deepEqual(guest.wallet, env.startingBalances);

    const profile = await colyseus.sdk.joinOrCreate("profile", { accessToken: guest.accessToken });
    const renamed: any = await profile.request("profile", { type: "set_nickname", nickname: "E2E Sprout" });
    assert.equal(renamed.profile.nickname, "E2E Sprout", JSON.stringify(renamed));
    const avatar: any = await profile.request("profile", { type: "set_avatar", avatarId: "avatar_vampire" });
    assert.equal(avatar.profile.avatarId, "avatar_vampire");

    await uow.transaction((session) => wallets.credit(session, guest.userId, { coins: 300, gems: 7 }, "ADMIN"));
    await assert.rejects(uow.transaction((session) => wallets.debit(session, guest.userId, { coins: 100, gems: 99_999 }, "SHOP_PURCHASE")));
    await uow.transaction((session) => wallets.debit(session, guest.userId, { coins: 100 }, "SHOP_PURCHASE"));

    const info: any = await profile.request("profile", { type: "info" });
    assert.deepEqual(info.wallet, { coins: env.startingBalances.coins + 200, gems: env.startingBalances.gems + 7 });
    assert.deepEqual({ nickname: info.profile.nickname, avatarId: info.profile.avatarId }, { nickname: "E2E Sprout", avatarId: "avatar_vampire" });

    const [ledger] = (await pool.query("SELECT currency_id, delta, reason FROM currency_ledger WHERE user_id = ? AND reason <> 'STARTING_BALANCE' ORDER BY id", [guest.userId])) as any;
    assert.deepEqual(ledger.map((row: any) => [row.currency_id, Number(row.delta), row.reason]), [
      ["coins", 300, "ADMIN"], ["gems", 7, "ADMIN"], ["coins", -100, "SHOP_PURCHASE"],
    ]);
  });

  it("keeps the collection, its items and the team in the database", async function () {
    const { container } = await import("../../src/app.config.js");
    if (!container.services.battles["collection"]) this.skip();
    const { db, pool } = await import("../../src/infrastructure/database/drizzle.js");
    const { DrizzleUnitOfWork } = await import("../../src/infrastructure/database/drizzle-unit-of-work.js");
    const uow = new DrizzleUnitOfWork(db);

    const auth = await colyseus.sdk.joinOrCreate("auth");
    const guest: any = await auth.request("auth", { type: "device", deviceId: "e2e-device-dddd" });
    const room = await colyseus.sdk.joinOrCreate("collection", { accessToken: guest.accessToken });
    const info: any = await room.request("collection", { type: "info" });
    assert.equal(info.ok, true, JSON.stringify(info));
    const owned = info.cards.filter((card: any) => card.owned).map((card: any) => card.id);
    assert.ok(owned.length > 0);
    assert.deepEqual(info.deck, owned.slice(0, info.deckSize));

    // The team is a JSON column: it must read back as a list (MariaDB hands JSON back as text).
    const reversed = [...info.deck].reverse();
    assert.deepEqual(((await room.request("collection", { type: "set_deck", cards: reversed })) as any).deck, reversed);
    assert.deepEqual(((await room.request("collection", { type: "info" })) as any).deck, reversed);

    // A level up paid in currencies and items, recorded in both ledgers.
    const card = info.cards.find((c: any) => c.owned && c.next);
    const items = Object.fromEntries(card.next.cost.filter((c: any) => c.id !== "coins" && c.id !== "gems").map((c: any) => [c.id, c.amount]));
    const coins = card.next.cost.find((c: any) => c.id === "coins")?.amount ?? 0;
    await uow.transaction(async (session) => {
      if (coins > 0) await container.services.wallets.credit(session, guest.userId, { coins }, "ADMIN");
      if (Object.keys(items).length > 0) await container.services.inventory.credit(session, guest.userId, items, "ADMIN");
    });
    const upgraded: any = await room.request("collection", { type: "upgrade", cardId: card.id });
    assert.equal(upgraded.ok, true, JSON.stringify(upgraded));
    assert.equal(upgraded.cards.find((c: any) => c.id === card.id).level, 2);
    const [spent] = (await pool.query("SELECT item_id, delta FROM item_ledger WHERE user_id = ? AND reason = 'CARD_UPGRADE'", [guest.userId])) as any;
    assert.deepEqual(Object.fromEntries(spent.map((row: any) => [row.item_id, -Number(row.delta)])), items);
    await room.leave();
  });
});
