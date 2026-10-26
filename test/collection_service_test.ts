// Card collection rules on in-memory repositories: automatic grants (starter, stage, level), unlocks with seeds (wild
// seeds cover the rest) or a purchase, upgrades paid in currencies + items (all or nothing), the team, and battles
// running with the team at its collection levels.
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { BattleOutcome } from "../src/modules/battle/battle-rules.js";
import { BattleCatalog } from "../src/modules/battle/content/battle-content.js";
import { BattleContentError } from "../src/modules/battle/sim/definitions.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { createTestServices, TEST_CONTENT_PATH } from "./support/test-services.js";

const content = () => JSON.parse(readFileSync(TEST_CONTENT_PATH, "utf8"));

async function guest(services: ReturnType<typeof createTestServices>, deviceId = "device-collection-0001") {
  return (await services.auth.deviceLogin({ deviceId, platform: "test" })).userId;
}

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof AppError && error.errorCode === code);
}

const victory: BattleOutcome = { kind: "VICTORY", seconds: 20, ticks: 400, baseHealth: 1, maxBaseHealth: 1, kills: 3 };

describe("collection content", () => {
  it("rejects unknown cards, curves, items, stages and gaps in a curve", () => {
    const broken = (change: (c: any) => void) => { const c = content(); change(c); return () => BattleCatalog.fromJson(c); };
    assert.throws(broken((c) => { c.collection.cards[0].card = "ghost"; }), BattleContentError);
    assert.throws(broken((c) => { c.collection.cards[0].curve = "nope"; }), BattleContentError);
    assert.throws(broken((c) => { c.collection.cards[2].unlock[0].item = "seeds.nope"; }), BattleContentError);
    assert.throws(broken((c) => { c.collection.cards[3].unlock[0].stage = "nowhere"; }), BattleContentError);
    assert.throws(broken((c) => { c.collection.curves[0].levels[1].level = 4; }), /levels must run/);
    assert.throws(broken((c) => { c.collection.curves[0].levels[0].cost[0].id = "diamonds"; }), BattleContentError);
    assert.throws(broken((c) => { c.collection.cards.forEach((card: any) => { card.unlock = [{ method: "level", level: 2 }]; }); }), /starter/);
    assert.throws(broken((c) => { c.stages[0].victoryReward.items = { "mystery": 1 }; }), BattleContentError);
  });
});

describe("collection service", () => {
  it("starts a player with the starter cards, the starting items and a first team", async () => {
    const services = createTestServices();
    const userId = await guest(services);
    const info = await services.collection.info(userId);
    assert.equal(info.enabled, true);
    assert.equal(info.deckSize, 3);
    assert.deepEqual(info.cards.filter((c) => c.owned).map((c) => c.id), ["shooter", "generator"]);
    assert.deepEqual(info.deck, ["shooter", "generator"]);
    assert.deepEqual(info.items, { plant_xp: 30 });
    const bomber = info.cards.find((c) => c.id === "bomber");
    assert.deepEqual(bomber.unlock, [{ method: "seeds", item: "seeds.bomber", amount: 10, wildItem: "seeds.wild", have: 0, wildHave: 0, ready: false }]);
    const shooter = info.cards.find((c) => c.id === "shooter");
    assert.deepEqual([shooter.level, shooter.maxLevel, shooter.health, shooter.damage], [1, 3, 100, 20]);
    assert.deepEqual(shooter.next, {
      level: 2, cost: [{ id: "coins", amount: 50 }, { id: "plant_xp", amount: 25 }], health: 120, damage: 24, production: 0, interval: 1, ability: "", affordable: false,
    });
    // A second call grants nothing twice.
    await services.collection.info(userId);
    assert.deepEqual((await services.collection.info(userId)).items, { plant_xp: 30 });
  });

  it("unlocks with seeds, wild seeds covering what is missing, and with a purchase", async () => {
    const services = createTestServices();
    const userId = await guest(services);
    await rejects(services.collection.unlock(userId, "bomber", "seeds"), "ITEM_INSUFFICIENT");
    await rejects(services.collection.unlock(userId, "bomber", "purchase"), "CARD_UNLOCK_UNAVAILABLE");
    await rejects(services.collection.unlock(userId, "guard", "purchase"), "WALLET_INSUFFICIENT_FUNDS");

    // First clear of test_1: 6 bomber seeds + the guard card (stage method); test_siege victory: 4 wild seeds.
    const first = await services.battles.finish(await services.battles.prepare(userId, "test_1"), victory, "hash");
    assert.deepEqual(first.unlockedCards, ["guard"]);
    assert.deepEqual(first.items, { plant_xp: 70, "seeds.bomber": 6 });
    await services.battles.finish(await services.battles.prepare(userId, "test_siege"), victory, "hash");

    const unlocked = await services.collection.unlock(userId, "bomber", "seeds");
    assert.equal(unlocked.cards.find((c) => c.id === "bomber").owned, true);
    assert.equal(unlocked.items["seeds.bomber"], undefined);
    assert.equal(unlocked.items["seeds.wild"], undefined, "the 4 wild seeds covered the missing 4");
    assert.deepEqual(unlocked.deck, ["shooter", "generator", "guard"], "a full team keeps its cards");
    await rejects(services.collection.unlock(userId, "bomber", "seeds"), "CARD_OWNED");
    const spent = services.store.itemLedger.filter((e) => e.userId === userId && e.reason === "CARD_UNLOCK").map((e) => [e.itemId, e.delta]);
    assert.deepEqual(spent, [["seeds.bomber", -6], ["seeds.wild", -4]]);

    const buyer = await guest(services, "device-collection-0002");
    await services.collection.info(buyer);
    await services.uow.transaction((s) => services.wallets.credit(s, buyer, { coins: 600 }, "ADMIN"));
    const bought = await services.collection.unlock(buyer, "guard", "purchase");
    assert.equal(bought.wallet.coins, 100);
    assert.deepEqual(bought.deck, ["shooter", "generator", "guard"], "a free team slot takes the new card");
  });

  it("levels a card up with coins and items, all or nothing, up to the curve's top", async () => {
    const services = createTestServices();
    const userId = await guest(services);
    await services.collection.info(userId);
    await rejects(services.collection.upgrade(userId, "shooter"), "WALLET_INSUFFICIENT_FUNDS");
    await rejects(services.collection.upgrade(userId, "bomber"), "CARD_NOT_OWNED");
    await services.uow.transaction((s) => services.wallets.credit(s, userId, { coins: 1000 }, "ADMIN"));

    const level2 = await services.collection.upgrade(userId, "shooter");
    const shooter = level2.cards.find((c) => c.id === "shooter");
    assert.deepEqual([shooter.level, shooter.health, shooter.damage], [2, 120, 24]);
    assert.deepEqual([level2.wallet.coins, level2.items.plant_xp], [950, 5]);

    // Level 3 needs 75 XP and 5 shards: refused without touching the coins.
    await rejects(services.collection.upgrade(userId, "shooter"), "ITEM_INSUFFICIENT");
    assert.equal((await services.wallets.snapshot(userId)).coins, 950);
    await services.uow.transaction((s) => services.inventory.credit(s, userId, { plant_xp: 100, meteor_shard: 5 }, "ADMIN"));
    const level3 = await services.collection.upgrade(userId, "shooter");
    assert.equal(level3.cards.find((c) => c.id === "shooter").next, null);
    await rejects(services.collection.upgrade(userId, "shooter"), "CARD_MAX_LEVEL");
  });

  it("validates the team and runs battles with it at its collection levels", async () => {
    const services = createTestServices();
    const userId = await guest(services);
    await services.collection.info(userId);
    await rejects(services.collection.setDeck(userId, ["shooter", "bomber"]), "DECK_INVALID");
    await rejects(services.collection.setDeck(userId, ["shooter", "shooter"]), "DECK_INVALID");
    await rejects(services.collection.setDeck(userId, ["shooter", "generator", "shooter", "generator"]), "DECK_INVALID");
    assert.deepEqual((await services.collection.setDeck(userId, ["generator"])).deck, ["generator"]);
    await services.collection.setDeck(userId, ["generator", "shooter"]);
    await services.uow.transaction((s) => services.wallets.credit(s, userId, { coins: 100 }, "ADMIN"));
    await services.collection.upgrade(userId, "shooter");

    const battle = await services.battles.prepare(userId, "test_siege");
    assert.deepEqual(battle.spec.cards.map((c) => c.id), ["generator", "shooter"]);
    assert.deepEqual([battle.spec.cards[1].levels[0].health, battle.spec.cards[1].levels[0].damage], [120, 24]);
    assert.deepEqual([battle.spec.cards[1].levels[1].health, battle.spec.cards[1].levels[1].damage], [150 * 1.2, 30 * 1.2], "every in-battle level is scaled");
  });

  it("grants level-gated cards when the player reaches the level", async () => {
    const services = createTestServices();
    const userId = await guest(services);
    await services.collection.info(userId);
    // One experience point short of level 3: the battle's defeat reward (5 XP) levels the player up.
    Object.assign(services.store.profiles.get(userId), { level: 2, exp: 149 });
    const prepared = await services.battles.prepare(userId, "test_siege");
    assert.equal((await services.collection.info(userId)).cards.find((c) => c.id === "bard").owned, false);
    const result = await services.battles.finish(prepared,
      { kind: "DEFEAT", seconds: 5, ticks: 100, baseHealth: 0, maxBaseHealth: 3, kills: 0 }, "hash");
    assert.deepEqual(result.unlockedCards, ["bard"]);
    assert.ok((await services.collection.info(userId)).cards.find((c) => c.id === "bard").owned);
  });

  it("applies a card's abilities from their level on: in battles, in the card list, and validated at boot", async () => {
    const raw = content();
    const shooter = raw.collection.cards.find((c: any) => c.card === "shooter");
    shooter.abilities = [
      { level: 3, name: "Piercing Shots", description: "Hits two enemies.", modifiers: [{ stat: "pierceCount", op: "add", value: 1 }] },
      { level: 2, name: "Quick Hands", modifiers: [{ stat: "interval", op: "multiply", value: 0.8 }, { stat: "cost", op: "add", value: -10 }] },
    ];
    const services = createTestServices({ catalog: BattleCatalog.fromJson(raw) });
    const userId = await guest(services);
    let info = await services.collection.info(userId);
    let card = info.cards.find((c) => c.id === "shooter");
    assert.deepEqual(card.abilities, [
      { level: 2, name: "Quick Hands", description: "", unlocked: false },
      { level: 3, name: "Piercing Shots", description: "Hits two enemies.", unlocked: false },
    ]);
    assert.deepEqual([card.cost, card.interval, card.next.ability, card.next.interval], [50, 1, "Quick Hands", 0.8]);

    await services.uow.transaction((s) => services.wallets.credit(s, userId, { coins: 50 }, "ADMIN"));
    info = await services.collection.upgrade(userId, "shooter");
    card = info.cards.find((c) => c.id === "shooter");
    assert.deepEqual([card.level, card.cost, card.interval, card.abilities[0].unlocked, card.abilities[1].unlocked], [2, 40, 0.8, true, false]);
    const battle = await services.battles.prepare(userId, "test_siege");
    const spec = battle.spec.cards.find((c) => c.id === "shooter");
    const base = raw.defenders.find((d: any) => d.id === "shooter");
    assert.equal(spec.cost, 40);
    assert.deepEqual(spec.levels.map((l) => l.interval), base.levels.map((l: any) => l.interval * 0.8), "every in-battle level");
    assert.deepEqual(spec.levels.map((l) => l.pierceCount), [1, 1], "level 3's ability is not reached yet");

    const above = content();
    above.collection.cards[0].abilities = [{ level: 9, name: "Too late", modifiers: [] }];
    assert.throws(() => BattleCatalog.fromJson(above), /above the top level/);
    const invalid = content();
    invalid.collection.cards[0].abilities = [{ level: 2, name: "Blast", modifiers: [{ stat: "splashRadius", op: "add", value: 1 }, { stat: "pierceCount", op: "add", value: 2 }] }];
    assert.throws(() => BattleCatalog.fromJson(invalid), /at level 2/);
  });

  it("keeps encounter decks when the content has no collection", async () => {
    const raw = content();
    delete raw.collection;
    const services = createTestServices({ catalog: BattleCatalog.fromJson(raw) });
    const userId = await guest(services);
    assert.equal((await services.collection.info(userId)).enabled, false);
    await rejects(services.collection.upgrade(userId, "shooter"), "COLLECTION_DISABLED");
    const battle = await services.battles.prepare(userId, "test_siege");
    assert.deepEqual(battle.spec.cards.map((c) => c.id), ["shooter", "generator"]);
  });
});


