// Mail on in-memory repositories: broadcast delivery (once, within its window), listing, localization, claiming
// (exactly once, ledger rows, level ups), claim-all, deleting, expiry, errors, and server-side `send`.
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppError } from "../src/shared/errors/app-error.js";
import { MailService, MAIL_UNCLAIMED, mergeRewards } from "../src/modules/mail/mail.service.js";
import { MemoryMailRepository } from "./support/memory-mail.js";
import { createTestServices, testClock } from "./support/test-services.js";

const FIXTURE = join(__dirname, "fixtures", "mail.test.json");

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof AppError && error.errorCode === code);
}

/** Services on in-memory repositories; `knownItem` defaults to the test catalog's items. */
function setup(contentPath = FIXTURE, knownItem?: (itemId: string) => boolean) {
  const services = createTestServices({ clock: testClock() });
  const repository = new MemoryMailRepository();
  const mail = new MailService(contentPath, repository, services.rewards, services.wallets, services.inventory, services.profileRepository,
    services.uow, services.clock, knownItem ?? ((itemId) => services.catalog.items.has(itemId)));
  const newPlayer = async (n = 1) => (await services.auth.deviceLogin({ deviceId: `device-mail-${String(n).padStart(4, "0")}`, platform: "test" })).userId;
  return { ...services, repository, mail, newPlayer };
}

const ids = (mailbox: { mails: Array<{ id: string }> }) => mailbox.mails.map((m) => m.id);

describe("mail", () => {
  it("delivers each active broadcast once, within its window, and lists the inbox", async () => {
    const { mail, newPlayer, repository } = setup();
    const userId = await newPlayer();
    const first = await mail.info(userId, "en");
    // welcome, gift and notice are active; "later" has not started, "ended" is over
    assert.deepEqual(first.mails.map((m) => m.title).sort(), ["Gift", "Notice", "Welcome"]);
    assert.deepEqual([first.unread, first.claimable], [3, 2]);
    assert.equal(repository.rows.size, 3);

    const again = await mail.info(userId, "en");
    assert.equal(again.mails.length, 3, "opening the inbox again delivers nothing new");
    assert.equal(repository.rows.size, 3);

    const other = await newPlayer(2);
    assert.equal((await mail.info(other, "en")).mails.length, 3, "every player gets their own copy");
    assert.equal(repository.rows.size, 6);
  });

  it("lists newest first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctd-mail-"));
    try {
      const file = join(dir, "mail.json");
      writeFileSync(file, JSON.stringify({ broadcasts: [{ id: "a", title: "A", body: "A" }] }));
      const { mail, newPlayer, clock } = setup(file);
      const userId = await newPlayer();
      await mail.info(userId, "en");
      clock.set(clock.nowMs() + 60_000);
      writeFileSync(file, JSON.stringify({ broadcasts: [{ id: "a", title: "A", body: "A" }, { id: "b", title: "B", body: "B" }] }));
      utimesSync(file, new Date(clock.nowMs()), new Date(clock.nowMs()));
      assert.deepEqual((await mail.info(userId, "en")).mails.map((m) => m.title), ["B", "A"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never redelivers a deleted broadcast, and delivers one once its start date has passed", async () => {
    const { mail, newPlayer, repository, clock } = setup();
    const userId = await newPlayer();
    const notice = (await mail.info(userId, "en")).mails.find((m) => m.title === "Notice")!;
    await mail.delete(userId, notice.id, "en");
    assert.ok(!ids(await mail.info(userId, "en")).includes(notice.id));
    assert.equal(repository.rows.size, 3, "deleted rows are kept, so the broadcast does not come back");

    clock.set(Date.UTC(2026, 10, 2));
    const later = await mail.info(userId, "en");
    assert.ok(later.mails.some((m) => m.title === "Later"));
    assert.ok(!later.mails.some((m) => m.title === "Notice"));
  });

  it("serves texts in the player's language with English fallback and exposes the mail fields", async () => {
    const { mail, newPlayer, clock } = setup();
    const userId = await newPlayer();
    const welcome = (await mail.info(userId, "pt-BR")).mails.find((m) => m.sender === "Test Cove")!;
    assert.equal(welcome.title, "Bem-vindo");
    assert.equal(welcome.body, "Hello captain", "plain strings serve every language");
    assert.deepEqual(welcome.attachments, { currencies: { coins: 500, gems: 20 }, items: { "seeds.wild": 3 }, exp: 40 });
    assert.deepEqual([welcome.sentAtUnix, welcome.expiresAtUnix, welcome.read, welcome.claimed], [clock.nowUnix(), 0, false, false]);
    assert.equal((await mail.info(userId, "es")).mails.find((m) => m.sender === "Test Cove")!.title, "Welcome");
    const gift = (await mail.info(userId, "en")).mails.find((m) => m.title === "Gift")!;
    assert.equal(gift.sender, "Pirate Cove", "default sender");
    assert.equal(gift.expiresAtUnix, clock.nowUnix() + 2 * 86400);
  });

  it("marks mail read and counts unread", async () => {
    const { mail, newPlayer } = setup();
    const userId = await newPlayer();
    const [first] = (await mail.info(userId, "en")).mails;
    const after = await mail.read(userId, first.id, "en");
    assert.equal(after.unread, 2);
    assert.equal(after.mails.find((m) => m.id === first.id)!.read, true);
    assert.equal((await mail.read(userId, first.id, "en")).unread, 2, "reading twice is harmless");
    await rejects(mail.read(userId, "nope", "en"), "MAIL_UNKNOWN");
  });

  it("claims attachments exactly once through the ledgers and answers the new HUD state", async () => {
    const { mail, newPlayer, store, wallets, inventory } = setup();
    const userId = await newPlayer();
    const welcome = (await mail.info(userId, "en")).mails.find((m) => m.sender === "Test Cove")!;

    const claimed = await mail.claim(userId, welcome.id, "en");
    assert.deepEqual(claimed.granted, { currencies: { coins: 500, gems: 20 }, items: { "seeds.wild": 3 }, exp: 40 });
    assert.deepEqual([claimed.wallet.coins, claimed.wallet.gems, claimed.items["seeds.wild"]], [500, 20, 3]);
    assert.deepEqual([claimed.profile.level, claimed.profile.exp], [1, 40]);
    assert.equal(claimed.levelsGained, 0);
    const row = claimed.mails.find((m) => m.id === welcome.id)!;
    assert.deepEqual([row.claimed, row.read], [true, true], "claiming reads the mail too");
    assert.deepEqual([claimed.claimable, claimed.unread], [1, 2]);

    await rejects(mail.claim(userId, welcome.id, "en"), "MAIL_ALREADY_CLAIMED");
    assert.deepEqual(await wallets.snapshot(userId), { coins: 500, gems: 20 }, "a second claim grants nothing");
    assert.equal((await inventory.snapshot(userId))["seeds.wild"], 3);
    assert.deepEqual(store.ledger.filter((e) => e.userId === userId).map((e) => e.reason), ["MAIL_ATTACHMENT", "MAIL_ATTACHMENT"]);
    assert.deepEqual(store.itemLedger.filter((e) => e.userId === userId).map((e) => [e.itemId, e.delta, e.reason]), [["seeds.wild", 3, "MAIL_ATTACHMENT"]]);
  });

  it("levels the player up when the attachment carries enough experience", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctd-mail-"));
    try {
      const file = join(dir, "mail.json");
      writeFileSync(file, JSON.stringify({ broadcasts: [{ id: "xp", title: "XP", body: "XP", attachments: { exp: 260 } }] }));
      const { mail, newPlayer } = setup(file);
      const userId = await newPlayer();
      const [xp] = (await mail.info(userId, "en")).mails;
      const result = await mail.claim(userId, xp.id, "en");
      // level 1 needs 100, level 2 needs 150: 260 = 100 + 150 + 10
      assert.deepEqual([result.levelsGained, result.profile.level, result.profile.exp], [2, 3, 10]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("claims everything claimable in one go and refuses when nothing is left", async () => {
    const { mail, newPlayer, store } = setup();
    const userId = await newPlayer();
    await mail.info(userId, "en");
    const all = await mail.claimAll(userId, "en");
    assert.deepEqual(all.granted, { currencies: { coins: 500, gems: 20 }, items: { "seeds.wild": 3, plant_xp: 100, meteor_shard: 10 }, exp: 40 });
    assert.deepEqual([all.wallet.coins, all.items.plant_xp, all.items.meteor_shard, all.claimable], [500, 100, 10, 0]);
    assert.deepEqual(all.mails.map((m) => [m.title, m.claimed]).sort(), [["Gift", true], ["Notice", false], ["Welcome", true]]);
    assert.equal(store.ledger.filter((e) => e.userId === userId && e.reason === "MAIL_ATTACHMENT").length, 2, "one combined grant");
    await rejects(mail.claimAll(userId, "en"), "MAIL_NO_ATTACHMENTS");
  });

  it("refuses unknown, attachment-less and expired mail", async () => {
    const { mail, newPlayer, clock, wallets } = setup();
    const userId = await newPlayer();
    const box = await mail.info(userId, "en");
    const notice = box.mails.find((m) => m.title === "Notice")!;
    const gift = box.mails.find((m) => m.title === "Gift")!;
    await rejects(mail.claim(userId, "nope", "en"), "MAIL_UNKNOWN");
    await rejects(mail.claim(userId, notice.id, "en"), "MAIL_NO_ATTACHMENTS");

    clock.set(clock.nowMs() + 3 * 86_400_000); // the gift lives 2 days
    await rejects(mail.claim(userId, gift.id, "en"), "MAIL_EXPIRED");
    await rejects(mail.read(userId, gift.id, "en"), "MAIL_EXPIRED");
    assert.ok(!ids(await mail.info(userId, "en")).includes(gift.id), "expired mail leaves the list");
    assert.equal((await wallets.snapshot(userId)).coins, 0);
  });

  it("cannot read, claim or delete someone else's mail", async () => {
    const { mail, newPlayer } = setup();
    const owner = await newPlayer(1);
    const thief = await newPlayer(2);
    const [first] = (await mail.info(owner, "en")).mails;
    await mail.info(thief, "en");
    await rejects(mail.claim(thief, first.id, "en"), "MAIL_UNKNOWN");
    await rejects(mail.read(thief, first.id, "en"), "MAIL_UNKNOWN");
    await rejects(mail.delete(thief, first.id, "en"), "MAIL_UNKNOWN");
  });

  it("deletes mail only without pending attachments", async () => {
    const { mail, newPlayer } = setup();
    const userId = await newPlayer();
    const box = await mail.info(userId, "en");
    const welcome = box.mails.find((m) => m.sender === "Test Cove")!;
    const notice = box.mails.find((m) => m.title === "Notice")!;
    await rejects(mail.delete(userId, welcome.id, "en"), MAIL_UNCLAIMED);
    assert.ok(ids(await mail.info(userId, "en")).includes(welcome.id));

    assert.ok(!ids(await mail.delete(userId, notice.id, "en")).includes(notice.id));
    await rejects(mail.delete(userId, notice.id, "en"), "MAIL_UNKNOWN");
    await mail.claim(userId, welcome.id, "en");
    assert.ok(!ids(await mail.delete(userId, welcome.id, "en")).includes(welcome.id));
    await rejects(mail.claim(userId, welcome.id, "en"), "MAIL_UNKNOWN");
  });

  it("rolls a claim back completely when the grant fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctd-mail-"));
    try {
      const file = join(dir, "mail.json");
      // "ghost" is not an item of the catalog: delivery (which trusts the content) accepts it, the ledger refuses it
      writeFileSync(file, JSON.stringify({ broadcasts: [{ id: "g", title: "G", body: "G", attachments: { currencies: { coins: 50 }, items: { ghost: 1 } } }] }));
      const { mail, newPlayer, wallets, store } = setup(file, () => true);
      const userId = await newPlayer();
      const [gift] = (await mail.info(userId, "en")).mails;
      await assert.rejects(mail.claim(userId, gift.id, "en"), /Unknown item/);
      assert.equal((await wallets.snapshot(userId)).coins, 0, "the coins credited before the failure were rolled back");
      assert.equal(store.ledger.filter((e) => e.userId === userId).length, 0);
      assert.equal((await mail.info(userId, "en")).claimable, 1, "the mail stays claimable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends a message from server code, inside the caller's transaction", async () => {
    const { mail, newPlayer, uow } = setup();
    const userId = await newPlayer();
    const sentId = await uow.transaction((session) => mail.send(session, userId, {
      sender: "Support", title: { en: "Sorry!", pt: "Desculpe!" }, body: "Compensation.",
      attachments: { currencies: { gems: 15 }, items: {}, exp: 0 },
    }));
    const sent = (await mail.info(userId, "pt")).mails.find((m) => m.id === sentId)!;
    assert.deepEqual([sent.title, sent.sender, sent.attachments.currencies], ["Desculpe!", "Support", { gems: 15 }]);
    assert.equal((await mail.claim(userId, sentId, "en")).wallet.gems, 15);

    await assert.rejects(uow.transaction((session) => mail.send(session, userId, {
      sender: "Support", title: "x", body: "x", attachments: { currencies: {}, items: { nope: 1 }, exp: 0 },
    })), /unknown item nope/);
  });

  it("merges reward bundles", () => {
    assert.deepEqual(
      mergeRewards([{ currencies: { coins: 1 }, items: { a: 1 }, exp: 1 }, { currencies: { coins: 2, gems: 3 }, items: { a: 2, b: 1 }, exp: 0 }]),
      { currencies: { coins: 3, gems: 3 }, items: { a: 3, b: 1 }, exp: 1 },
    );
  });

  describe("broadcast content", () => {
    let dir: string;
    let file: string;
    let tick = 0;
    const write = (content: unknown) => {
      writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
      const at = new Date(Date.UTC(2026, 0, 1) + ++tick * 60_000);
      utimesSync(file, at, at); // distinct mtimes even when two writes land in the same millisecond
    };
    const broadcast = (id: string, extra: object = {}) => ({ id, title: id, body: id, ...extra });

    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ctd-mail-")); file = join(dir, "mail.json"); tick = 0; });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("hot-reloads: a new broadcast reaches players who open their inbox afterwards; a broken file changes nothing", async () => {
      write({ broadcasts: [broadcast("one")] });
      const { mail, newPlayer } = setup(file);
      const userId = await newPlayer();
      assert.deepEqual((await mail.info(userId, "en")).mails.map((m) => m.title), ["one"]);
      write({ broadcasts: [broadcast("one"), broadcast("two")] });
      assert.deepEqual((await mail.info(userId, "en")).mails.map((m) => m.title).sort(), ["one", "two"]);
      write("{ broken");
      write({ broadcasts: [broadcast("three", { attachments: { items: { ghost: 1 } } })] });
      assert.equal((await mail.info(userId, "en")).mails.length, 2, "unknown item ids reject the whole file");
      write({ broadcasts: [broadcast("one"), broadcast("two"), broadcast("three")] });
      assert.equal((await mail.info(userId, "en")).mails.length, 3);
    });

    it("never expires mail when expiresAfterDays is 0 and defaults to 30 days", async () => {
      write({ broadcasts: [broadcast("forever", { expiresAfterDays: 0 }), broadcast("monthly")] });
      const { mail, newPlayer, clock } = setup(file);
      const userId = await newPlayer();
      const box = await mail.info(userId, "en");
      assert.equal(box.mails.find((m) => m.title === "forever")!.expiresAtUnix, 0);
      assert.equal(box.mails.find((m) => m.title === "monthly")!.expiresAtUnix, clock.nowUnix() + 30 * 86400);
    });
  });
});
