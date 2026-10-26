// Wire protocol of the `news` and `mail` rooms through a real Colyseus server and SDK client (in-memory repositories).
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { join } from "node:path";
import { defineRoom, defineServer } from "@colyseus/core";
import { boot, type ColyseusTestServer } from "@colyseus/testing";

import { AuthRoom } from "../src/modules/auth/auth.room.js";
import { MailRoom } from "../src/modules/mail/mail.room.js";
import { MailService } from "../src/modules/mail/mail.service.js";
import { NewsRoom } from "../src/modules/news/news.room.js";
import { NewsService } from "../src/modules/news/news.service.js";
import { configureRoomAuthentication } from "../src/shared/rooms/authenticated-room.js";
import { bindRoom } from "../src/shared/rooms/base-room.js";
import { unlimited } from "../src/shared/security/rate-limiter.js";
import { MemoryMailRepository } from "./support/memory-mail.js";
import { createTestServices, testClock } from "./support/test-services.js";

const PORT = 2597;

describe("rooms: news + mail protocol", () => {
  let colyseus: ColyseusTestServer;

  before(async () => {
    const services = createTestServices({ clock: testClock() });
    configureRoomAuthentication(services.authenticator);
    const news = new NewsService(join(__dirname, "fixtures", "news.test.json"), services.clock);
    const mail = new MailService(join(__dirname, "fixtures", "mail.test.json"), new MemoryMailRepository(), services.rewards, services.wallets,
      services.inventory, services.profileRepository, services.uow, services.clock, (itemId) => services.catalog.items.has(itemId));
    const server = defineServer({
      greet: false,
      rooms: {
        auth: defineRoom(bindRoom(AuthRoom, { auth: services.auth, limiter: unlimited, isMaintenanceEnabled: () => false })),
        news: defineRoom(bindRoom(NewsRoom, { news, queryLimiter: unlimited })),
        mail: defineRoom(bindRoom(MailRoom, { mail, queryLimiter: unlimited, changeLimiter: unlimited })),
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

  it("serves the news in the requested language and rejects bad payloads", async () => {
    const accessToken = await signIn("device-room-news-01");
    const room = await colyseus.sdk.joinOrCreate("news", { accessToken });
    const info: any = await room.request("news", { type: "info", lang: "pt" });
    assert.equal(info.ok, true);
    assert.equal(info.action, "info");
    assert.deepEqual(info.items.map((n: any) => n.id), ["pinned", "recent", "ends_soon", "old"]);
    assert.equal(info.items.find((n: any) => n.id === "recent").title, "Recente");
    assert.deepEqual(await room.request("news", { type: "info", extra: 1 }), { action: "info", ok: false, error: "INVALID_PAYLOAD" });
    assert.deepEqual(await room.request("news", { type: "nope" }), { action: "info", ok: false, error: "INVALID_PAYLOAD" });
    await assert.rejects(colyseus.sdk.joinOrCreate("news", { accessToken: "forged" }));
    await room.leave();
  });

  it("lists the inbox, reads, claims, claims all and deletes", async () => {
    const accessToken = await signIn("device-room-mail-01");
    const room = await colyseus.sdk.joinOrCreate("mail", { accessToken });
    const info: any = await room.request("mail", { type: "info", lang: "en" });
    assert.equal(info.ok, true);
    assert.deepEqual([info.mails.length, info.unread, info.claimable], [3, 3, 2]);
    const welcome = info.mails.find((m: any) => m.sender === "Test Cove");
    const notice = info.mails.find((m: any) => m.title === "Notice");

    const read: any = await room.request("mail", { type: "read", mailId: notice.id });
    assert.deepEqual([read.action, read.unread], ["read", 2]);

    const claim: any = await room.request("mail", { type: "claim", mailId: welcome.id });
    assert.equal(claim.action, "claim");
    assert.deepEqual(claim.granted, { currencies: { coins: 500, gems: 20 }, items: { "seeds.wild": 3 }, exp: 40 });
    assert.deepEqual([claim.wallet.coins, claim.items["seeds.wild"], claim.profile.exp, claim.levelsGained], [500, 3, 40, 0]);
    assert.deepEqual(await room.request("mail", { type: "claim", mailId: welcome.id }), { action: "claim", ok: false, error: "MAIL_ALREADY_CLAIMED" });
    assert.deepEqual(await room.request("mail", { type: "claim", mailId: notice.id }), { action: "claim", ok: false, error: "MAIL_NO_ATTACHMENTS" });
    assert.deepEqual(await room.request("mail", { type: "claim", mailId: "nope" }), { action: "claim", ok: false, error: "MAIL_UNKNOWN" });

    const all: any = await room.request("mail", { type: "claim_all" });
    assert.deepEqual([all.action, all.granted.items.plant_xp, all.claimable], ["claim_all", 100, 0]);
    assert.deepEqual(await room.request("mail", { type: "claim_all" }), { action: "claim_all", ok: false, error: "MAIL_NO_ATTACHMENTS" });

    const deleted: any = await room.request("mail", { type: "delete", mailId: welcome.id });
    assert.deepEqual([deleted.action, deleted.mails.length], ["delete", 2]);
    assert.deepEqual(await room.request("mail", { type: "claim", mailId: 5 }), { action: "claim", ok: false, error: "INVALID_PAYLOAD" });
    assert.deepEqual(await room.request("mail", { type: "wat" }), { action: "unknown", ok: false, error: "INVALID_PAYLOAD" });
    await room.leave();
  });
});
