// Refunds: the refund service (idempotent, never below zero, shortfall, mail), App Store Server Notifications V2
// (REFUND / REVOKE, signature checks, HTTP route) and the Google voided-purchases poller and API client.
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import express from "express";

import { VOIDED_CURSOR_KEY, GoogleVoidedPurchasesPoller } from "../src/modules/iap/google-voided.poller.js";
import { AppleNotificationHandler, createAppleNotificationRouter } from "../src/modules/iap/apple-notifications.js";
import { IapRefundService } from "../src/modules/iap/iap-refund.service.js";
import { IapService } from "../src/modules/iap/iap.service.js";
import { BattleCatalog } from "../src/modules/battle/content/battle-content.js";
import { MailService } from "../src/modules/mail/mail.service.js";
import { GooglePlayApiClient, type GooglePlayVoidedApi, type VoidedPurchase, type VoidedPurchasesPage } from "../src/modules/iap/validators/google-play-api.js";
import { FakeStoreValidator } from "../src/modules/iap/validators/fake-store.validator.js";
import { AppleAppStoreValidator } from "../src/modules/iap/validators/apple-app-store.validator.js";
import { MemorySettingsRepository } from "./support/memory-admin.js";
import { MemoryIapRepository } from "./support/memory-iap.js";
import { MemoryMailRepository } from "./support/memory-mail.js";
import { createTestServices, testClock, TEST_CONTENT_PATH } from "./support/test-services.js";

const BUNDLE = "com.example.ctd.ios";
const FIXTURES = join(__dirname, "fixtures", "iap");
const pem = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const der = (name: string) => Buffer.from(pem(name).replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
const leafKey = createPrivateKey(pem("leaf.pk8.pem"));
const chain = [der("leaf.pem"), der("intermediate.pem"), der("root.pem")].map((d) => d.toString("base64"));

/** Signs a JWS like Apple does (ES256, x5c chain of the openssl test CA). */
function appleJws(payload: Record<string, unknown>, options: { x5c?: string[]; tamper?: boolean } = {}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", x5c: options.x5c ?? chain });
  const body = encode({ signedDate: Date.now(), ...payload });
  const signature = sign("sha256", Buffer.from(`${header}.${body}`), { key: leafKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${header}.${options.tamper ? encode({ ...payload, tampered: true }) : body}.${signature}`;
}

function content() {
  const c = JSON.parse(readFileSync(TEST_CONTENT_PATH, "utf8"));
  c.shop.products = [
    { id: "gems_small", name: "Pouch of Gems", storeIds: { google: "gems_small", apple: "com.example.ctd.gems_small" }, grants: { currencies: { gems: 80 } } },
    { id: "starter", name: "Starter Pack", grants: { currencies: { gems: 200, coins: 1000 }, items: { plant_xp: 100 }, exp: 50 } },
  ];
  return c;
}

const fakeReceipt = (transactionId: string) => JSON.stringify({ Store: "fake", TransactionID: transactionId, Payload: "ThisIsFakeReceiptData" });

function setup() {
  const catalog = BattleCatalog.fromJson(content());
  const services = createTestServices({ clock: testClock(), catalog });
  const purchases = new MemoryIapRepository();
  const mailRepository = new MemoryMailRepository();
  const mail = new MailService(join(__dirname, "fixtures", "mail.test.json"), mailRepository, services.rewards, services.wallets, services.inventory,
    services.profileRepository, services.uow, services.clock, (itemId) => catalog.items.has(itemId));
  const iap = new IapService(catalog, purchases, [new FakeStoreValidator(), new AppleAppStoreValidator({ bundleId: BUNDLE, allowSandbox: true, trustedRoots: [der("root.pem")] })],
    services.rewards, services.wallets, services.inventory, services.profileRepository, services.uow, services.clock, { requireAccountBinding: false });
  const refunds = new IapRefundService(catalog, purchases, services.wallets, services.inventory, mail, services.uow, services.clock);
  const newPlayer = async (n = 1) => (await services.auth.deviceLogin({ deviceId: `device-refund-${String(n).padStart(4, "0")}`, platform: "test" })).userId;
  const buy = (userId: string, productId: string, transactionId: string) =>
    iap.verify(userId, { store: "fake", productId, receipt: fakeReceipt(transactionId) });
  const wallet = (userId: string) => services.wallets.snapshot(userId);
  const items = (userId: string) => services.inventory.snapshot(userId);
  return { ...services, purchases, mail, mailRepository, iap, refunds, newPlayer, buy, wallet, items };
}

describe("iap refunds", () => {
  describe("IapRefundService", () => {
    it("takes back everything the purchase granted, records it, logs it in the ledger and mails the player", async () => {
      const s = setup();
      const userId = await s.newPlayer();
      await s.buy(userId, "starter", "fake-refund-0001");
      assert.deepEqual([(await s.wallet(userId)).gems, (await s.wallet(userId)).coins, (await s.items(userId)).plant_xp], [200, 1000, 100]);

      const outcome = await s.refunds.refund("fake", "fake-refund-0001", "test");
      assert.equal(outcome.status, "refunded");
      assert.deepEqual([(await s.wallet(userId)).gems, (await s.wallet(userId)).coins, (await s.items(userId)).plant_xp ?? 0], [0, 0, 0]);
      if (outcome.status !== "refunded") return;
      assert.deepEqual(outcome.taken.currencies, { gems: 200, coins: 1000 });
      assert.deepEqual(outcome.shortfall, { currencies: {}, items: {}, exp: 50 }, "experience is never revoked");

      const row = s.purchases.rows[0];
      assert.equal(row.status, "refunded");
      assert.equal(row.refundReason, "test");
      assert.ok(row.refundedAt);
      assert.ok(s.store.ledger.some((e) => e.userId === userId && e.reason === "IAP_REFUND" && e.delta === -200));
      assert.ok(s.store.itemLedger.some((e) => e.userId === userId && e.reason === "IAP_REFUND" && e.itemId === "plant_xp"));

      const inbox = await s.mail.info(userId, "pt");
      const refundMail = inbox.mails.find((m) => m.title === "Compra reembolsada");
      assert.ok(refundMail, "the player is told in their language");
      assert.ok(refundMail!.body.includes("Starter Pack"));
      assert.deepEqual([refundMail!.attachments.currencies, refundMail!.attachments.items], [{}, {}], "the mail has no attachments");
    });

    it("is idempotent: a second refund changes nothing", async () => {
      const s = setup();
      const userId = await s.newPlayer();
      await s.buy(userId, "gems_small", "fake-refund-0002");
      await s.refunds.refund("fake", "fake-refund-0002", "first");
      await s.buy(userId, "gems_small", "fake-refund-0003");
      assert.equal((await s.wallet(userId)).gems, 80);

      const again = await s.refunds.refund("fake", "fake-refund-0002", "second");
      assert.equal(again.status, "already_refunded");
      assert.equal((await s.wallet(userId)).gems, 80, "the other purchase is untouched");
      assert.equal(s.purchases.rows[0].refundReason, "first");
      const mails = (await s.mail.info(userId, "en")).mails.filter((m) => m.title === "Purchase refunded");
      assert.equal(mails.length, 1, "one mail per refund");
    });

    it("takes only what the player still has, never goes below zero and records the shortfall", async () => {
      const s = setup();
      const userId = await s.newPlayer();
      await s.buy(userId, "starter", "fake-refund-0004");
      await s.uow.transaction(async (session) => {
        await s.wallets.debit(session, userId, { gems: 150, coins: 1000 }, "SHOP_PURCHASE");
        await s.inventory.debit(session, userId, { plant_xp: 70 }, "CARD_UPGRADE");
      });

      const outcome = await s.refunds.refund("fake", "fake-refund-0004", "partial");
      assert.equal(outcome.status, "refunded");
      if (outcome.status !== "refunded") return;
      assert.deepEqual(outcome.taken.currencies, { gems: 50 });
      assert.deepEqual(outcome.taken.items, { plant_xp: 30 });
      assert.deepEqual(outcome.shortfall, { currencies: { gems: 150, coins: 1000 }, items: { plant_xp: 70 }, exp: 50 });
      assert.deepEqual([(await s.wallet(userId)).gems, (await s.wallet(userId)).coins, (await s.items(userId)).plant_xp ?? 0], [0, 0, 0]);
      assert.deepEqual(s.purchases.rows[0].refundShortfall, outcome.shortfall);
    });

    it("knows nothing about transactions it never recorded", async () => {
      const s = setup();
      assert.deepEqual(await s.refunds.refund("fake", "never-seen", "x"), { status: "unknown" });
    });
  });

  describe("App Store Server Notifications V2", () => {
    const transaction = (id: string, extra: Record<string, unknown> = {}) => ({
      transactionId: id, originalTransactionId: id, productId: "com.example.ctd.gems_small", bundleId: BUNDLE, environment: "Production", ...extra,
    });
    const notification = (type: string, signedTransactionInfo: string | undefined, extra: Record<string, unknown> = {}, data: Record<string, unknown> = {}) =>
      appleJws({ notificationType: type, notificationUUID: "uuid-1", data: { bundleId: BUNDLE, environment: "Production", signedTransactionInfo, ...data }, ...extra });

    async function bought(s: ReturnType<typeof setup>, transactionId: string) {
      const userId = await s.newPlayer();
      const purchase = await s.iap.verify(userId, {
        store: "apple", productId: "x", receipt: "{}",
        jws: appleJws({ ...transaction(transactionId), purchaseDate: Date.now(), quantity: 1 }),
      });
      assert.equal(purchase.wallet.gems, 80);
      return userId;
    }

    const handler = (s: ReturnType<typeof setup>, allowSandbox = true) =>
      new AppleNotificationHandler({ bundleId: BUNDLE, allowSandbox, trustedRoots: [der("root.pem")] }, s.refunds);

    it("refunds on REFUND and on REVOKE and acknowledges with 200", async () => {
      const s = setup();
      const a = await bought(s, "3000000001");
      const h = handler(s);
      assert.deepEqual(await h.handle({ signedPayload: notification("REFUND", appleJws(transaction("3000000001"))) }), { status: 200 });
      assert.equal((await s.wallet(a)).gems, 0);
      assert.equal(s.purchases.rows[0].refundReason, "apple_refund");

      const b = await bought(s, "3000000002");
      assert.equal((await h.handle({ signedPayload: notification("REVOKE", appleJws(transaction("3000000002"))) })).status, 200);
      assert.equal((await s.wallet(b)).gems, 0);
      assert.equal(s.purchases.rows[1].refundReason, "apple_revoke");

      // Apple retries: the same notification again is acknowledged and changes nothing.
      assert.equal((await h.handle({ signedPayload: notification("REFUND", appleJws(transaction("3000000001"))) })).status, 200);
    });

    it("acknowledges and ignores other valid notifications, other apps and unknown transactions", async () => {
      const s = setup();
      const userId = await bought(s, "3000000003");
      const h = handler(s);
      for (const type of ["TEST", "DID_RENEW", "CONSUMPTION_REQUEST", "REFUND_DECLINED", "REFUND_REVERSED"]) {
        assert.equal((await h.handle({ signedPayload: notification(type, appleJws(transaction("3000000003"))) })).status, 200, type);
      }
      assert.equal((await h.handle({ signedPayload: notification("REFUND", appleJws(transaction("3000000003")), {}, { bundleId: "com.other" }) })).status, 200);
      assert.equal((await h.handle({ signedPayload: notification("REFUND", appleJws(transaction("3000000003", { bundleId: "com.other" }))) })).status, 200);
      assert.equal((await h.handle({ signedPayload: notification("REFUND", appleJws(transaction("never-bought"))) })).status, 200);
      assert.equal((await s.wallet(userId)).gems, 80, "nothing was taken back");
      assert.equal(s.purchases.rows[0].status, "granted");

      const production = handler(s, false);
      assert.equal((await production.handle({ signedPayload: notification("REFUND", appleJws(transaction("3000000003", { environment: "Sandbox" })), {}, { environment: "Sandbox" }) })).status, 200);
      assert.equal(s.purchases.rows[0].status, "granted", "sandbox refunds are ignored when sandbox is not accepted");
    });

    it("answers 400 to bodies and signatures that do not verify", async () => {
      const s = setup();
      const userId = await bought(s, "3000000004");
      const h = handler(s);
      const signed = notification("REFUND", appleJws(transaction("3000000004")));
      const otherRoot = [chain[0], chain[1], der("other-root.pem").toString("base64")];
      const bad: unknown[] = [
        undefined, null, {}, { signedPayload: 5 }, { signedPayload: "" }, { signedPayload: "not.a-jws" },
        { signedPayload: `${signed.slice(0, -4)}AAAA` },
        { signedPayload: appleJws({ notificationType: "REFUND", data: { bundleId: BUNDLE } }, { tamper: true }) },
        { signedPayload: notification("REFUND", appleJws(transaction("3000000004"), { x5c: otherRoot })) },
        { signedPayload: appleJws({ notificationType: "REFUND", data: { bundleId: BUNDLE } }, { x5c: otherRoot }) },
        { signedPayload: notification("REFUND", appleJws(transaction("3000000004"), { tamper: true })) },
        { signedPayload: notification("REFUND", undefined) },
      ];
      for (const body of bad) assert.equal((await h.handle(body)).status, 400, JSON.stringify(body)?.slice(0, 60));
      assert.equal((await s.wallet(userId)).gems, 80, "a forged notification refunds nothing");
      const production = new AppleNotificationHandler({ bundleId: BUNDLE, allowSandbox: true }, s.refunds);
      assert.equal((await production.handle({ signedPayload: signed })).status, 400, "the default trust is Apple Root CA - G3 only");
    });

    it("answers 500 when processing fails, so Apple retries", async () => {
      const s = setup();
      await bought(s, "3000000005");
      const failing = new AppleNotificationHandler({ bundleId: BUNDLE, allowSandbox: true, trustedRoots: [der("root.pem")] },
        { refund: async () => { throw new Error("db down"); } } as unknown as IapRefundService);
      assert.equal((await failing.handle({ signedPayload: notification("REFUND", appleJws(transaction("3000000005"))) })).status, 500);
    });

    it("serves the notification URL over HTTP", async () => {
      const s = setup();
      const userId = await bought(s, "3000000006");
      const app = express();
      app.use("/iap/apple/notifications", createAppleNotificationRouter(handler(s)));
      const server = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      try {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/iap/apple/notifications`;
        const post = (body: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
        const ok = await post(JSON.stringify({ signedPayload: notification("REFUND", appleJws(transaction("3000000006"))) }));
        assert.equal(ok.status, 200);
        assert.equal((await s.wallet(userId)).gems, 0);
        assert.equal((await post(JSON.stringify({ signedPayload: "x.y.z" }))).status, 400);
        assert.equal((await post("{ not json")).status, 400);
        assert.equal((await fetch(url)).status, 404, "POST only");
      } finally {
        server.close();
      }
    });
  });

  describe("Google voided purchases", () => {
    const voided = (token: string, extra: Partial<VoidedPurchase> = {}): VoidedPurchase =>
      ({ purchaseToken: token, orderId: `GPA.${token}`, purchaseTimeMillis: 0, voidedTimeMillis: 0, voidedSource: 0, voidedReason: 1, ...extra });

    async function boughtOnGoogle(s: ReturnType<typeof setup>, userId: string, token: string) {
      // Recorded like the Google validator does (the receipt flow is covered by iap_test.ts).
      const inserted = await s.purchases.insert({
        id: `p-${token}`, userId, store: "google", transactionKey: (await import("node:crypto")).createHash("sha256").update(token).digest("hex"),
        transactionId: token, orderId: `GPA.${token}`, productId: "gems_small", storeProductId: "gems_small", environment: "production", quantity: 1,
        granted: { currencies: { gems: 80 }, items: {}, exp: 0 }, purchasedAt: new Date(), status: "granted", refundedAt: null, refundReason: null, refundShortfall: null,
      });
      assert.ok(inserted);
      await s.uow.transaction(async (session) => { await s.wallets.credit(session, userId, { gems: 80 }, "IAP_PURCHASE"); });
    }

    it("refunds every voided purchase token it finds and moves the cursor only after a clean run", async () => {
      const s = setup();
      const userId = await s.newPlayer();
      await boughtOnGoogle(s, userId, "token-a");
      await boughtOnGoogle(s, userId, "token-b");
      assert.equal((await s.wallet(userId)).gems, 160);

      const calls: Array<{ start: number; page: string | null }> = [];
      const pages = new Map<string | null, VoidedPurchasesPage>([
        [null, { items: [voided("token-a"), voided("token-unknown")], nextPageToken: "p2" }],
        ["p2", { items: [voided("token-b", { voidedSource: 2, voidedReason: 7 })], nextPageToken: null }],
      ]);
      const api: GooglePlayVoidedApi = {
        listVoidedPurchases: async (pkg, start, page) => {
          assert.equal(pkg, "com.example.ctd");
          calls.push({ start, page: page ?? null });
          return pages.get(page ?? null)!;
        },
      };
      const settings = new MemorySettingsRepository();
      const poller = new GoogleVoidedPurchasesPoller("com.example.ctd", api, s.refunds, settings, s.clock, 900_000);

      const first = await poller.runOnce();
      assert.deepEqual(first, { checked: 3, refunded: 2, failed: 0 });
      assert.equal((await s.wallet(userId)).gems, 0);
      assert.equal(s.purchases.rows[1].refundReason, "google_voided_src2_r7");
      assert.equal(calls[0].start, s.clock.nowMs() - 7 * 86_400_000, "first run looks back a week");
      assert.deepEqual(calls.map((c) => c.page), [null, "p2"]);

      const cursor = Number(settings.values.get(VOIDED_CURSOR_KEY));
      assert.equal(cursor, s.clock.nowMs() - 3_600_000, "the cursor keeps an hour of overlap");

      s.clock.set(s.clock.nowMs() + 900_000);
      calls.length = 0;
      const second = await poller.runOnce();
      assert.deepEqual(second, { checked: 3, refunded: 0, failed: 0 }, "re-reading the overlap refunds nothing twice");
      assert.equal(calls[0].start, cursor, "the next run starts at the stored cursor");
    });

    it("keeps the cursor when a refund fails and survives API errors", async () => {
      const s = setup();
      const settings = new MemorySettingsRepository();
      const failingRefunds = { refund: async () => { throw new Error("db down"); } } as unknown as IapRefundService;
      const ok: GooglePlayVoidedApi = { listVoidedPurchases: async () => ({ items: [voided("t")], nextPageToken: null }) };
      const failed = await new GoogleVoidedPurchasesPoller("pkg", ok, failingRefunds, settings, s.clock, 1000).runOnce();
      assert.equal(failed.failed, 1);
      assert.equal(settings.values.has(VOIDED_CURSOR_KEY), false);

      const broken: GooglePlayVoidedApi = { listVoidedPurchases: async () => { throw new Error("503"); } };
      await assert.rejects(new GoogleVoidedPurchasesPoller("pkg", broken, s.refunds, settings, s.clock, 1000).runOnce(), /503/);
      assert.equal(settings.values.has(VOIDED_CURSOR_KEY), false);

      settings.values.set(VOIDED_CURSOR_KEY, String(s.clock.nowMs() - 90 * 86_400_000));
      let start = 0;
      const spy: GooglePlayVoidedApi = { listVoidedPurchases: async (_p, from) => { start = from; return { items: [], nextPageToken: null }; } };
      await new GoogleVoidedPurchasesPoller("pkg", spy, s.refunds, settings, s.clock, 1000).runOnce();
      assert.equal(start, s.clock.nowMs() - 29 * 86_400_000, "never asks further back than Google allows");
    });

    it("calls the voidedpurchases endpoint with the service account token", async () => {
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const account = { client_email: "svc@example.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
      const requests: Array<{ url: string; auth: string | null }> = [];
      const http = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, auth: new Headers(init?.headers).get("authorization") });
        if (url.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
        return new Response(JSON.stringify({
          voidedPurchases: [
            { kind: "androidpublisher#voidedPurchase", purchaseToken: "abc", orderId: "GPA.1", purchaseTimeMillis: "100", voidedTimeMillis: "200", voidedSource: 2, voidedReason: 7 },
            { kind: "androidpublisher#voidedPurchase", orderId: "no-token" },
          ],
          tokenPagination: { nextPageToken: "next" },
        }), { status: 200 });
      }) as typeof fetch;
      const client = new GooglePlayApiClient(account, http);
      const page = await client.listVoidedPurchases("com.example.ctd", 1234, "prev");
      assert.deepEqual(page, { items: [{ purchaseToken: "abc", orderId: "GPA.1", purchaseTimeMillis: 100, voidedTimeMillis: 200, voidedSource: 2, voidedReason: 7 }], nextPageToken: "next" });
      const call = requests[requests.length - 1];
      assert.ok(call.url.startsWith("https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.ctd/purchases/voidedpurchases?"));
      assert.ok(call.url.includes("startTime=1234") && call.url.includes("token=prev") && call.url.includes("type=0"));
      assert.equal(call.auth, "Bearer tok");

      const failing = new GooglePlayApiClient(account, (async (input: string | URL | Request) =>
        String(input).includes("oauth2") ? new Response(JSON.stringify({ access_token: "t" }), { status: 200 }) : new Response("no", { status: 403 })) as typeof fetch);
      await assert.rejects(failing.listVoidedPurchases("pkg", 1), /403/);
    });
  });
});
