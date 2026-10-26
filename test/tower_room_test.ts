// Wire protocol of the `tower` room through a real Colyseus server and SDK client (in-memory repositories).
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { defineRoom, defineServer } from "@colyseus/core";
import { boot, type ColyseusTestServer } from "@colyseus/testing";

import { BattleCatalog } from "../src/modules/battle/content/battle-content.js";
import { AuthRoom } from "../src/modules/auth/auth.room.js";
import { TowerRoom } from "../src/modules/tower/tower.room.js";
import { TowerService } from "../src/modules/tower/tower.service.js";
import { configureRoomAuthentication } from "../src/shared/rooms/authenticated-room.js";
import { bindRoom } from "../src/shared/rooms/base-room.js";
import { unlimited } from "../src/shared/security/rate-limiter.js";
import { MemoryTowerRepository } from "./support/memory-tower.js";
import { createTestServices, testClock } from "./support/test-services.js";
import { towerContent } from "./support/tower-fixtures.js";

const PORT = 2600;

describe("rooms: tower protocol", () => {
  let colyseus: ColyseusTestServer;

  before(async () => {
    const catalog = BattleCatalog.fromJson(towerContent());
    const services = createTestServices({ clock: testClock(), catalog });
    configureRoomAuthentication(services.authenticator);
    const tower = new TowerService(catalog, new MemoryTowerRepository(), services.clock);
    const server = defineServer({
      greet: false,
      rooms: {
        auth: defineRoom(bindRoom(AuthRoom, { auth: services.auth, limiter: unlimited, isMaintenanceEnabled: () => false })),
        tower: defineRoom(bindRoom(TowerRoom, { tower, queryLimiter: unlimited })),
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

  it("answers info in the requested language and rejects bad payloads", async () => {
    const room = await colyseus.sdk.joinOrCreate("tower", { accessToken: await signIn("device-room-tower-01") });

    const info: any = await room.request("tower", { type: "info", lang: "pt" });
    assert.deepEqual([info.action, info.ok], ["info", true]);
    assert.deepEqual(info.towers.map((t: any) => [t.id, t.title, t.running, t.highestCleared]), [["old", "Old Tower", false, 0], ["kraken", "Torre do Kraken", true, 0]]);
    const kraken = info.towers[1];
    assert.equal(kraken.banner, "kraken");
    assert.equal(kraken.floors.length, 3);
    assert.deepEqual(kraken.floors[0], { floor: 1, title: "", reward: { currencies: { coins: 100 }, items: {}, exp: 0 }, cleared: false, current: true, locked: false });

    const english: any = await room.request("tower", { type: "info" });
    assert.equal(english.towers[1].title, "Kraken's Tower");

    assert.deepEqual(await room.request("tower", { type: "info", towerId: "kraken" }), { action: "info", ok: false, error: "INVALID_PAYLOAD" });
    assert.deepEqual(await room.request("tower", { type: "wat" }), { action: "unknown", ok: false, error: "INVALID_PAYLOAD" });
    await assert.rejects(colyseus.sdk.joinOrCreate("tower", { accessToken: "forged" }));
    await room.leave();
  });
});
