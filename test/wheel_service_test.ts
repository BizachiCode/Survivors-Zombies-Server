// Lucky wheel on in-memory repositories: weighted draw with an injected RNG, free spins, paid spins, daily limit, UTC
// reset, atomicity (a failed payment burns nothing), content validation and the disabled wheel.
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";

import { AppError } from "../src/shared/errors/app-error.js";
import { WheelService, type WheelRng } from "../src/modules/wheel/wheel.service.js";
import { MemoryWheelRepository } from "./support/memory-wheel.js";
import { createTestServices, testClock } from "./support/test-services.js";
import { WHEEL, catalogWithWheel } from "./support/wheel-fixtures.js";

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof AppError && error.errorCode === code);
}

/** Services with a wheel whose rolls are scripted (`rolls.shift()`, 0 when empty). */
function setup(options: { wheel?: unknown; gems?: number } = {}) {
  const catalog = catalogWithWheel("wheel" in options ? options.wheel : WHEEL);
  const services = createTestServices({ clock: testClock(), catalog, startingBalances: { coins: 0, gems: options.gems ?? 0 } });
  const repository = new MemoryWheelRepository();
  const rolls: number[] = [];
  const rng: WheelRng = () => rolls.shift() ?? 0;
  const wheel = new WheelService(catalog, repository, services.rewards, services.wallets, services.inventory, services.profileRepository,
    services.uow, services.clock, rng);
  const newPlayer = async (n = 1) => (await services.auth.deviceLogin({ deviceId: `device-wheel-${String(n).padStart(4, "0")}`, platform: "test" })).userId;
  return { ...services, wheel, repository, rolls, newPlayer };
}

describe("wheel", () => {
  it("lists the segments without weights, with one free spin, the price and the reset time", async () => {
    const { wheel, newPlayer, clock } = setup();
    const info = await wheel.info(await newPlayer());
    assert.equal(info.enabled, true);
    assert.deepEqual(info.segments.map((s) => s.id), ["coins_100", "gems_5", "seeds", "exp"]);
    assert.ok(info.segments.every((s) => !("weight" in s)));
    assert.deepEqual([info.freeSpinsLeft, info.spinsToday, info.dailyLimit], [1, 0, 3]);
    assert.deepEqual(info.spinCost, { currency: "gems", amount: 30 });
    assert.equal(info.resetsAtUnix, Math.floor(Date.UTC(2026, 9, 22) / 1000));
    assert.ok(info.resetsAtUnix > clock.nowUnix());
  });

  it("maps rolls to segments by weight", () => {
    const wheel = catalogWithWheel().wheel!;
    assert.equal(wheel.totalWeight, 10);
    // weights 5,3,1,1 -> [0..4]=0, [5..7]=1, [8]=2, [9]=3
    assert.deepEqual([0, 4, 5, 7, 8, 9].map((roll) => wheel.segmentAt(roll)), [0, 0, 1, 1, 2, 3]);
  });

  it("grants the drawn segment on a free spin and a failed payment burns nothing", async () => {
    const { wheel, newPlayer, rolls, inventory, repository } = setup();
    const userId = await newPlayer();
    rolls.push(5); // gems_5
    const spin = await wheel.spin(userId);
    assert.deepEqual([spin.segmentIndex, spin.segmentId], [1, "gems_5"]);
    assert.deepEqual(spin.granted, { currencies: { gems: 5 }, items: {}, exp: 0 });
    assert.equal(spin.wallet.gems, 5, "a free spin costs nothing");
    assert.deepEqual([spin.freeSpinsLeft, spin.spinsToday], [0, 1]);
    assert.equal(repository.rows.size, 1);

    rolls.push(8); // seeds (paid: 30 gems needed, only 5)
    await rejects(wheel.spin(userId), "WALLET_INSUFFICIENT_FUNDS");
    assert.equal((await wheel.info(userId)).spinsToday, 1, "a failed payment burns no spin");
    assert.equal((await inventory.snapshot(userId))["seeds.wild"] ?? 0, 0, "and grants nothing");
  });

  it("charges extra spins through the ledger, grants items and exp, and stops at the daily limit", async () => {
    const { wheel, newPlayer, rolls, store, clock } = setup({ gems: 100 });
    const userId = await newPlayer();
    rolls.push(0, 8, 9);
    const first = await wheel.spin(userId);
    assert.equal(first.wallet.coins, 100);
    const second = await wheel.spin(userId); // paid, seeds
    assert.deepEqual([second.segmentId, second.wallet.gems, second.items["seeds.wild"]], ["seeds", 70, 2]);
    assert.equal(second.freeSpinsLeft, 0);
    const third = await wheel.spin(userId); // paid, exp 50
    assert.deepEqual([third.segmentId, third.wallet.gems, third.profile.exp, third.spinsToday], ["exp", 40, 50, 3]);
    await rejects(wheel.spin(userId), "WHEEL_LIMIT_REACHED");
    assert.equal((await wheel.info(userId)).freeSpinsLeft, 0);

    const reasons = store.ledger.filter((e) => e.reason === "WHEEL_SPIN").map((e) => [e.currencyId, e.delta]);
    assert.deepEqual(reasons, [["coins", 100], ["gems", -30], ["gems", -30]]);
    assert.ok(store.itemLedger.some((e) => e.reason === "WHEEL_SPIN"));

    clock.set(clock.nowMs() + 86_400_000);
    const next = await wheel.info(userId);
    assert.deepEqual([next.freeSpinsLeft, next.spinsToday], [1, 0], "a new UTC day brings the free spin back");
    rolls.push(0);
    assert.equal((await wheel.spin(userId)).segmentId, "coins_100");
  });

  it("counts per player", async () => {
    const { wheel, newPlayer, rolls } = setup();
    const a = await newPlayer(1);
    const b = await newPlayer(2);
    rolls.push(0, 0);
    await wheel.spin(a);
    assert.equal((await wheel.info(b)).freeSpinsLeft, 1);
    await wheel.spin(b);
    await rejects(wheel.spin(a), "WALLET_INSUFFICIENT_FUNDS");
  });

  it("refuses with WHEEL_NO_SPINS when spins cannot be bought", async () => {
    const { wheel, newPlayer } = setup({ wheel: { ...WHEEL, spinCost: { currency: "gems", amount: 0 }, dailyLimit: 0 }, gems: 1000 });
    const userId = await newPlayer();
    await wheel.spin(userId);
    await rejects(wheel.spin(userId), "WHEEL_NO_SPINS");
  });

  it("a limit of 0 is unlimited", async () => {
    const { wheel, newPlayer } = setup({ wheel: { ...WHEEL, dailyLimit: 0 }, gems: 1000 });
    const userId = await newPlayer();
    for (let i = 0; i < 6; i++) await wheel.spin(userId);
    const info = await wheel.info(userId);
    assert.deepEqual([info.spinsToday, info.dailyLimit], [6, 0]);
  });

  it("the daily limit also caps the free spins shown", async () => {
    const { wheel, newPlayer } = setup({ wheel: { ...WHEEL, freeSpinsPerDay: 3, dailyLimit: 2 } });
    const userId = await newPlayer();
    assert.equal((await wheel.info(userId)).freeSpinsLeft, 2);
    await wheel.spin(userId);
    await wheel.spin(userId);
    assert.equal((await wheel.info(userId)).freeSpinsLeft, 0);
    await rejects(wheel.spin(userId), "WHEEL_LIMIT_REACHED");
  });

  it("is disabled when the content has no wheel", async () => {
    const { wheel, newPlayer } = setup({ wheel: undefined });
    const userId = await newPlayer();
    const info = await wheel.info(userId);
    assert.deepEqual([info.enabled, info.segments.length], [false, 0]);
    await rejects(wheel.spin(userId), "WHEEL_DISABLED");
  });

  it("rejects invalid content", () => {
    const bad = (patch: object) => assert.throws(() => catalogWithWheel({ ...WHEEL, ...patch }));
    bad({ segments: [WHEEL.segments[0]] });
    bad({ segments: [WHEEL.segments[0], { ...WHEEL.segments[1], id: "coins_100" }] });
    bad({ segments: [WHEEL.segments[0], { id: "x", weight: 0, reward: { exp: 1 } }] });
    bad({ segments: [WHEEL.segments[0], { id: "x", weight: 1, reward: { items: { "no.such.item": 1 } } }] });
    bad({ segments: [WHEEL.segments[0], { id: "x", weight: 1, reward: {} }] });
    bad({ spinCost: { currency: "rubies", amount: 1 } });
  });

  it("the default RNG draws segment indexes in range", async () => {
    const catalog = catalogWithWheel();
    const services = createTestServices({ clock: testClock(), catalog, startingBalances: { gems: 100_000 } });
    const wheel = new WheelService(catalog, new MemoryWheelRepository(), services.rewards, services.wallets, services.inventory,
      services.profileRepository, services.uow, services.clock);
    const userId = (await services.auth.deviceLogin({ deviceId: "device-wheel-rng-01", platform: "test" })).userId;
    for (let i = 0; i < 3; i++) {
      const index = (await wheel.spin(userId)).segmentIndex;
      assert.ok(index >= 0 && index < 4);
    }
  });
});
