// Shop rules on in-memory repositories: prices through the wallet, grants (currencies and items), daily limits that
// reset at UTC midnight, level gates, and the content checks.
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { BattleCatalog } from "../src/modules/battle/content/battle-content.js";
import { BattleContentError } from "../src/modules/battle/sim/definitions.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { createTestServices, testClock, TEST_CONTENT_PATH } from "./support/test-services.js";

const content = () => JSON.parse(readFileSync(TEST_CONTENT_PATH, "utf8"));

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof AppError && error.errorCode === code);
}

describe("shop", () => {
  it("rejects offers with unknown items or that grant nothing", () => {
    const broken = (change: (c: any) => void) => { const c = content(); change(c); return () => BattleCatalog.fromJson(c); };
    assert.throws(broken((c) => { c.shop.offers[0].grants.items = { nope: 1 }; }), BattleContentError);
    assert.throws(broken((c) => { c.shop.offers[0].grants = { currencies: {}, items: {} }; }), /grants nothing/);
    assert.throws(broken((c) => { c.shop.offers[1].id = c.shop.offers[0].id; }), /Duplicate shop offer/);
  });

  it("sells offers for their price, grants them and counts the daily limit until UTC midnight", async () => {
    const services = createTestServices({ clock: testClock() });
    const { userId } = await services.auth.deviceLogin({ deviceId: "device-shop-0001", platform: "test" });
    const info = await services.shop.info(userId);
    assert.equal(info.enabled, true);
    assert.equal(info.resetsAtUnix, Date.UTC(2026, 9, 22) / 1000);
    assert.deepEqual(info.offers.map((o) => [o.id, o.remaining, o.available]), [["xp_pack", 2, true], ["gem_coins", null, true], ["wild_seeds", 1, false]]);

    await rejects(services.shop.buy(userId, "xp_pack"), "WALLET_INSUFFICIENT_FUNDS");
    await services.uow.transaction((s) => services.wallets.credit(s, userId, { coins: 250, gems: 10 }, "ADMIN"));
    const first = await services.shop.buy(userId, "xp_pack");
    assert.deepEqual([first.wallet.coins, first.items.plant_xp, first.offers[0].remaining], [150, 50, 1]);
    await services.shop.buy(userId, "xp_pack");
    await rejects(services.shop.buy(userId, "xp_pack"), "SHOP_LIMIT_REACHED");
    assert.equal((await services.wallets.snapshot(userId)).coins, 50, "a refused purchase costs nothing");

    const pouch = await services.shop.buy(userId, "gem_coins");
    assert.deepEqual([pouch.wallet.gems, pouch.wallet.coins], [0, 550]);
    await rejects(services.shop.buy(userId, "wild_seeds"), "SHOP_LOCKED");
    await rejects(services.shop.buy(userId, "nope"), "SHOP_OFFER_UNKNOWN");

    services.clock.set(Date.UTC(2026, 9, 22, 0, 0, 1));
    assert.equal((await services.shop.info(userId)).offers[0].remaining, 2, "a new UTC day resets the limits");
    const reasons = services.store.itemLedger.filter((e) => e.userId === userId).map((e) => e.reason);
    assert.deepEqual(reasons, ["SHOP_PURCHASE", "SHOP_PURCHASE"]);
  });

  it("is disabled without shop content", async () => {
    const raw = content();
    delete raw.shop;
    const services = createTestServices({ catalog: BattleCatalog.fromJson(raw) });
    const { userId } = await services.auth.deviceLogin({ deviceId: "device-shop-0002", platform: "test" });
    assert.equal((await services.shop.info(userId)).enabled, false);
    await rejects(services.shop.buy(userId, "xp_pack"), "SHOP_DISABLED");
  });
});
