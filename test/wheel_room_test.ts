// Wire protocol of the `wheel` room through a real Colyseus server and SDK client (in-memory repositories).
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { defineRoom, defineServer } from "@colyseus/core";
import { boot, type ColyseusTestServer } from "@colyseus/testing";

import { AuthRoom } from "../src/modules/auth/auth.room.js";
import { WheelRoom } from "../src/modules/wheel/wheel.room.js";
import { WheelService } from "../src/modules/wheel/wheel.service.js";
import { configureRoomAuthentication } from "../src/shared/rooms/authenticated-room.js";
import { bindRoom } from "../src/shared/rooms/base-room.js";
import { unlimited } from "../src/shared/security/rate-limiter.js";
import { MemoryWheelRepository } from "./support/memory-wheel.js";
import { createTestServices, testClock } from "./support/test-services.js";
import { catalogWithWheel } from "./support/wheel-fixtures.js";

const PORT = 2598;

describe("rooms: wheel protocol", () => {
  let colyseus: ColyseusTestServer;

  before(async () => {
    const catalog = catalogWithWheel();
    const services = createTestServices({ clock: testClock(), catalog, startingBalances: { gems: 100 } });
    configureRoomAuthentication(services.authenticator);
    // Scripted rolls: 0 (coins_100), then 9 (exp), then always 5 (gems_5).
    const rolls = [0, 9];
    const wheel = new WheelService(catalog, new MemoryWheelRepository(), services.rewards, services.wallets, services.inventory,
      services.profileRepository, services.uow, services.clock, () => rolls.shift() ?? 5);
    const server = defineServer({
      greet: false,
      rooms: {
        auth: defineRoom(bindRoom(AuthRoom, { auth: services.auth, limiter: unlimited, isMaintenanceEnabled: () => false })),
        wheel: defineRoom(bindRoom(WheelRoom, { wheel, queryLimiter: unlimited, spinLimiter: unlimited })),
      },
    });
    colyseus = await boot(server, PORT);
  });

  after(async () => colyseus.shutdown());

  async function signIn(deviceId: string): Promise<string> {
    const auth = await colyseus.sdk.joinOrCreate("auth");
    const answer: any = await auth.request("auth", { type: "device", deviceId, platform: "test" });
    await auth.leave();
    return answer.accessToken;
  }

  it("answers info, spins, charges extra spins and reports the errors", async () => {
    const room = await colyseus.sdk.joinOrCreate("wheel", { accessToken: await signIn("device-room-wheel-01") });

    const info: any = await room.request("wheel", { type: "info" });
    assert.equal(info.ok, true);
    assert.equal(info.action, "info");
    assert.deepEqual(info.segments.map((s: any) => s.id), ["coins_100", "gems_5", "seeds", "exp"]);
    assert.deepEqual([info.freeSpinsLeft, info.spinsToday, info.dailyLimit, info.enabled], [1, 0, 3, true]);
    assert.deepEqual(info.spinCost, { currency: "gems", amount: 30 });

    const free: any = await room.request("wheel", { type: "spin" });
    assert.equal(free.action, "spin");
    assert.deepEqual([free.segmentIndex, free.segmentId, free.freeSpinsLeft, free.spinsToday], [0, "coins_100", 0, 1]);
    assert.deepEqual(free.granted, { currencies: { coins: 100 }, items: {}, exp: 0 });
    assert.deepEqual([free.wallet.coins, free.wallet.gems, free.levelsGained], [100, 100, 0]);

    const paid: any = await room.request("wheel", { type: "spin" });
    assert.deepEqual([paid.segmentId, paid.wallet.gems, paid.profile.exp, paid.spinsToday], ["exp", 70, 50, 2]);

    const third: any = await room.request("wheel", { type: "spin" });
    assert.deepEqual([third.segmentId, third.wallet.gems, third.spinsToday], ["gems_5", 45, 3]);
    const limit: any = await room.request("wheel", { type: "spin" });
    assert.deepEqual([limit.action, limit.ok, limit.error, limit.extra], ["spin", false, "WHEEL_LIMIT_REACHED", { dailyLimit: 3 }]);
    assert.equal(((await room.request("wheel", { type: "info" })) as any).spinsToday, 3);

    assert.deepEqual(await room.request("wheel", { type: "spin", amount: 99 }), { action: "spin", ok: false, error: "INVALID_PAYLOAD" });
    assert.deepEqual(await room.request("wheel", { type: "wat" }), { action: "unknown", ok: false, error: "INVALID_PAYLOAD" });
    await assert.rejects(colyseus.sdk.joinOrCreate("wheel", { accessToken: "forged" }));
    await room.leave();
  });
});
