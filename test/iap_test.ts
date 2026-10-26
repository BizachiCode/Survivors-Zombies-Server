// Real-money purchases: receipt validators (Google signature + API state, Apple JWS chain, fake store) and the service
// rules (product from the receipt, account binding, one grant per transaction, first purchase bonus, quantity, limits).
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { env } from "../src/config/env.js";
import { BattleCatalog } from "../src/modules/battle/content/battle-content.js";
import { BattleContentError } from "../src/modules/battle/sim/definitions.js";
import { createReceiptValidators } from "../src/modules/iap/iap-validators.js";
import { accountTokenFor, IapService } from "../src/modules/iap/iap.service.js";
import { AppleAppStoreValidator } from "../src/modules/iap/validators/apple-app-store.validator.js";
import { FakeStoreValidator } from "../src/modules/iap/validators/fake-store.validator.js";
import type { GooglePlayApi, ProductPurchaseState } from "../src/modules/iap/validators/google-play-api.js";
import { GooglePlayValidator } from "../src/modules/iap/validators/google-play.validator.js";
import type { ReceiptValidator } from "../src/modules/iap/validators/receipt.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { MemoryIapRepository } from "./support/memory-iap.js";
import { createTestServices, testClock, TEST_CONTENT_PATH } from "./support/test-services.js";

const PACKAGE = "com.example.ctd";
const BUNDLE = "com.example.ctd.ios";
const FIXTURES = join(__dirname, "fixtures", "iap");
const pem = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const der = (name: string) => Buffer.from(pem(name).replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");

function content(products?: unknown[]) {
  const c = JSON.parse(readFileSync(TEST_CONTENT_PATH, "utf8"));
  c.shop.products = products ?? [
    { id: "gems_small", name: "Pouch of Gems", storeIds: { google: "gems_small", apple: "com.example.ctd.gems_small" },
      grants: { currencies: { gems: 80 } }, firstPurchaseBonus: { currencies: { gems: 80 } }, referencePrice: "$0.99" },
    { id: "starter", name: "Starter Pack", grants: { currencies: { gems: 200, coins: 1000 }, items: { plant_xp: 100 } }, limit: 1 },
    { id: "vip", name: "VIP", kind: "non_consumable", grants: { currencies: { coins: 5000 } }, requiredLevel: 3 },
  ];
  return c;
}

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof AppError && error.errorCode === code);
}

// ---------------------------------------------------------------- receipts
const googleKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const licenseKey = googleKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64");

function googleReceipt(purchase: Record<string, unknown>, options: { forge?: boolean } = {}) {
  const json = JSON.stringify({ packageName: PACKAGE, purchaseState: 0, purchaseTime: 1_790_000_000_000, quantity: 1, ...purchase });
  const signature = sign("sha1", Buffer.from(options.forge ? json + " " : json), googleKeys.privateKey).toString("base64");
  return JSON.stringify({ Store: "GooglePlay", TransactionID: purchase.purchaseToken, Payload: JSON.stringify({ json, signature, skuDetails: [] }) });
}

const leafKey = createPrivateKey(pem("leaf.pk8.pem"));
const chain = [der("leaf.pem"), der("intermediate.pem"), der("root.pem")].map((d) => d.toString("base64"));

function appleJws(payload: Record<string, unknown>, options: { x5c?: string[]; tamper?: boolean } = {}) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", x5c: options.x5c ?? chain });
  const body = encode({
    bundleId: BUNDLE, environment: "Production", purchaseDate: Date.now(), signedDate: Date.now(), quantity: 1, type: "Consumable",
    ...payload,
  });
  const signature = sign("sha256", Buffer.from(`${header}.${body}`), { key: leafKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${header}.${options.tamper ? encode({ ...payload, bundleId: BUNDLE, productId: "other" }) : body}.${signature}`;
}

const fakeReceipt = (transactionId: string) => JSON.stringify({ Store: "fake", TransactionID: transactionId, Payload: "ThisIsFakeReceiptData" });

// ---------------------------------------------------------------- setup
function setup(options: { validators?: ReceiptValidator[]; products?: unknown[]; requireAccountBinding?: boolean; testMode?: boolean } = {}) {
  const catalog = BattleCatalog.fromJson(content(options.products));
  const services = createTestServices({ clock: testClock(), catalog });
  const repository = new MemoryIapRepository();
  const validators = options.validators ?? [
    new FakeStoreValidator(),
    new GooglePlayValidator({ packageName: PACKAGE, licenseKey }),
    new AppleAppStoreValidator({ bundleId: BUNDLE, allowSandbox: false, trustedRoots: [der("root.pem")] }),
  ];
  const iap = new IapService(catalog, repository, validators, services.rewards, services.wallets, services.inventory, services.profileRepository,
    services.uow, services.clock, { requireAccountBinding: options.requireAccountBinding ?? true, testMode: options.testMode });
  return { ...services, iap, repository };
}

async function player(services: ReturnType<typeof setup>, device = "device-iap-0001") {
  return (await services.auth.deviceLogin({ deviceId: device, platform: "test" })).userId;
}

describe("iap", () => {
  it("rejects broken product content", () => {
    const broken = (products: unknown[]) => () => BattleCatalog.fromJson(content(products));
    assert.throws(broken([{ id: "a", name: "A", grants: { currencies: {} } }]), /grants nothing/);
    assert.throws(broken([{ id: "a", name: "A", grants: { items: { nope: 1 } } }]), BattleContentError);
    assert.throws(broken([{ id: "a", name: "A", grants: { exp: 1 } }, { id: "a", name: "B", grants: { exp: 1 } }]), /Duplicate product/);
    assert.throws(broken([{ id: "a", name: "A", grants: { exp: 1 } }, { id: "b", name: "B", storeIds: { google: "a" }, grants: { exp: 1 } }]), /google id already used/);
    assert.equal(BattleCatalog.fromJson(content([])).shop!.products.length, 0, "products are optional");
  });

  it("lists the products with the first purchase bonus, limits and level gates", async () => {
    const services = setup();
    const userId = await player(services);
    const info = await services.iap.info(userId);
    assert.equal(info.enabled, true);
    assert.deepEqual(info.stores, ["fake", "google", "apple"]);
    assert.deepEqual(info.products.map((p) => [p.id, p.available, p.limit, p.storeIds.apple]),
      [["gems_small", true, 0, "com.example.ctd.gems_small"], ["starter", true, 1, "starter"], ["vip", false, 1, "vip"]]);
    assert.deepEqual(info.products[0].firstPurchaseBonus.currencies, { gems: 80 });
    assert.equal((await setup({ validators: [] }).iap.info(userId)).enabled, false, "no store configured = disabled");
  });

  it("grants a fake store purchase once, with the first purchase bonus, and replays grant nothing", async () => {
    const services = setup();
    const userId = await player(services);
    const first = await services.iap.verify(userId, { store: "fake", productId: "gems_small", receipt: fakeReceipt("fake-tx-000001") });
    assert.deepEqual([first.alreadyProcessed, first.granted.currencies.gems, first.wallet.gems], [false, 160, 160]);
    assert.deepEqual(first.products[0].firstPurchaseBonus.currencies, {}, "the bonus is gone after the first purchase");

    const replay = await services.iap.verify(userId, { store: "fake", productId: "gems_small", receipt: fakeReceipt("fake-tx-000001") });
    assert.deepEqual([replay.alreadyProcessed, replay.granted.currencies.gems ?? 0, replay.wallet.gems], [true, 0, 160]);

    const second = await services.iap.verify(userId, { store: "fake", productId: "gems_small", receipt: fakeReceipt("fake-tx-000002") });
    assert.deepEqual([second.granted.currencies.gems, second.wallet.gems], [80, 240]);

    const other = await player(services, "device-iap-0002");
    await rejects(services.iap.verify(other, { store: "fake", productId: "gems_small", receipt: fakeReceipt("fake-tx-000001") }), "IAP_ACCOUNT_MISMATCH");
    await rejects(services.iap.verify(userId, { store: "fake", productId: "nope", receipt: fakeReceipt("fake-tx-000003") }), "IAP_PRODUCT_UNKNOWN");
    const reasons = new Set(services.store.ledger.filter((e) => e.userId === userId).map((e) => e.reason));
    assert.deepEqual([...reasons], ["IAP_PURCHASE"]);
  });

  it("grants limited products and items; over the limit still grants (money was taken) but marks it unavailable", async () => {
    const services = setup();
    const userId = await player(services);
    const starter = await services.iap.verify(userId, { store: "fake", productId: "starter", receipt: fakeReceipt("fake-starter-1") });
    assert.deepEqual([starter.wallet.gems, starter.wallet.coins, starter.items.plant_xp], [200, 1000, 100]);
    assert.equal(starter.products.find((p) => p.id === "starter")!.available, false);
    const again = await services.iap.verify(userId, { store: "fake", productId: "starter", receipt: fakeReceipt("fake-starter-2") });
    assert.equal(again.wallet.gems, 400);
  });

  it("test mode: tells the client to skip the store and grants test purchases on a server with no store configured", async () => {
    const validators = createReceiptValidators({ ...env.iap, allowFakeStore: false, testMode: true, google: { ...env.iap.google, packageName: "" }, apple: { ...env.iap.apple, bundleId: "" } });
    assert.deepEqual(validators.map((v) => v.store), ["fake"], "IAP_TEST_MODE registers the test (fake) store on its own");
    const services = setup({ validators, testMode: true });
    const userId = await player(services);
    const info = await services.iap.info(userId);
    assert.deepEqual([info.enabled, info.testMode, info.stores], [true, true, ["fake"]]);
    const bought = await services.iap.verify(userId, { store: "fake", productId: "gems_small", receipt: fakeReceipt("test-0123456789abcdef") });
    assert.deepEqual([bought.alreadyProcessed, bought.wallet.gems, bought.testMode], [false, 160, true]);
    assert.equal((await setup().iap.info(userId)).testMode, false, "off unless IAP_TEST_MODE");
    assert.equal(createReceiptValidators({ ...env.iap, allowFakeStore: false, testMode: false, google: { ...env.iap.google, packageName: "" }, apple: { ...env.iap.apple, bundleId: "" } }).length, 0);
  });

  it("refuses stores the server is not configured for", async () => {
    const services = setup({ validators: [new FakeStoreValidator()] });
    const userId = await player(services);
    await rejects(services.iap.verify(userId, { store: "google", productId: "gems_small", receipt: "{}" }), "IAP_STORE_UNSUPPORTED");
  });

  it("verifies Google Play signatures, the package, the state and the buyer", async () => {
    const services = setup();
    const userId = await player(services);
    const account = accountTokenFor("google", userId);
    const purchase = (token: string, extra: Record<string, unknown> = {}) => ({ productId: "gems_small", purchaseToken: token, orderId: `GPA.${token}`, obfuscatedAccountId: account, ...extra });
    const verify = (receipt: string) => services.iap.verify(userId, { store: "google", productId: "ignored", receipt });

    const ok = await verify(googleReceipt(purchase("tok-1")));
    assert.deepEqual([ok.productId, ok.orderId, ok.granted.currencies.gems], ["gems_small", "GPA.tok-1", 160]);
    assert.equal((await verify(googleReceipt(purchase("tok-1")))).alreadyProcessed, true);

    await rejects(verify(googleReceipt(purchase("tok-2"), { forge: true })), "IAP_RECEIPT_INVALID");
    await rejects(verify(googleReceipt(purchase("tok-3", { packageName: "com.other" }))), "IAP_RECEIPT_INVALID");
    await rejects(verify(googleReceipt(purchase("tok-4", { purchaseState: 4 }))), "IAP_PENDING");
    await rejects(verify(googleReceipt(purchase("tok-5", { purchaseState: 1 }))), "IAP_RECEIPT_INVALID");
    await rejects(verify(googleReceipt(purchase("tok-6", { productId: "unknown_sku" }))), "IAP_PRODUCT_UNKNOWN");
    await rejects(verify(googleReceipt(purchase("tok-7", { obfuscatedAccountId: accountTokenFor("google", "someone-else") }))), "IAP_ACCOUNT_MISMATCH");
    await rejects(verify(googleReceipt(purchase("tok-8", { obfuscatedAccountId: undefined }))), "IAP_ACCOUNT_MISMATCH");
    await rejects(verify(fakeReceipt("not-google-0001")), "IAP_RECEIPT_INVALID");

    const lenient = setup({ requireAccountBinding: false });
    const lenientUser = await player(lenient);
    const unbound = await lenient.iap.verify(lenientUser, { store: "google", productId: "x", receipt: googleReceipt(purchase("tok-9", { obfuscatedAccountId: undefined })) });
    assert.equal(unbound.alreadyProcessed, false, "binding can be made optional");
  });

  it("asks the Google Play Developer API for the purchase state when configured", async () => {
    const states = new Map<string, ProductPurchaseState | null>();
    const api: GooglePlayApi = { getProductPurchase: async (_pkg, _product, token) => states.get(token) ?? null };
    const services = setup({ validators: [new GooglePlayValidator({ packageName: PACKAGE, api })] });
    const userId = await player(services);
    const account = accountTokenFor("google", userId);
    const receipt = (token: string) => googleReceipt({ productId: "gems_small", purchaseToken: token }, { forge: true });

    states.set("api-1", { purchaseState: 0, purchaseType: 0, orderId: "GPA.api-1", quantity: 2, obfuscatedExternalAccountId: account });
    const granted = await services.iap.verify(userId, { store: "google", productId: "gems_small", receipt: receipt("api-1") });
    assert.equal(granted.granted.currencies.gems, 80 * 2 + 80, "quantity multiplies the grants; the bonus is added once");
    assert.equal(services.repository.rows[0].environment, "sandbox", "test purchases are recorded as sandbox");

    states.set("api-2", { purchaseState: 2, obfuscatedExternalAccountId: account });
    await rejects(services.iap.verify(userId, { store: "google", productId: "gems_small", receipt: receipt("api-2") }), "IAP_PENDING");
    states.set("api-3", { purchaseState: 1, obfuscatedExternalAccountId: account });
    await rejects(services.iap.verify(userId, { store: "google", productId: "gems_small", receipt: receipt("api-3") }), "IAP_RECEIPT_INVALID");
    await rejects(services.iap.verify(userId, { store: "google", productId: "gems_small", receipt: receipt("api-unknown") }), "IAP_RECEIPT_INVALID");
  });

  it("verifies App Store JWS transactions against the pinned root", async () => {
    const services = setup();
    const userId = await player(services);
    const tx = (id: string, extra: Record<string, unknown> = {}) => ({
      transactionId: id, originalTransactionId: id, productId: "com.example.ctd.gems_small", appAccountToken: userId.toUpperCase(), ...extra,
    });
    const verify = (jws: string, receipt = "{}") => services.iap.verify(userId, { store: "apple", productId: "ignored", receipt, jws });

    const ok = await verify(appleJws(tx("2000000001")));
    assert.deepEqual([ok.productId, ok.granted.currencies.gems], ["gems_small", 160]);
    assert.equal((await verify(appleJws(tx("2000000001")))).alreadyProcessed, true);
    const viaReceipt = await services.iap.verify(userId, { store: "apple", productId: "x", receipt: JSON.stringify({ Store: "AppleAppStore", TransactionID: "2000000002", Payload: appleJws(tx("2000000002")) }) });
    assert.equal(viaReceipt.granted.currencies.gems, 80, "the JWS can come inside the unified receipt");

    await rejects(verify(appleJws(tx("2000000003", { bundleId: "com.other" }))), "IAP_RECEIPT_INVALID");
    await rejects(verify(appleJws(tx("2000000004", { revocationDate: 1_790_000_100_000 }))), "IAP_RECEIPT_INVALID");
    await rejects(verify(appleJws(tx("2000000005", { environment: "Sandbox" }))), "IAP_RECEIPT_INVALID");
    await rejects(verify(appleJws(tx("2000000006"), { tamper: true })), "IAP_RECEIPT_INVALID");
    const otherRoot = [chain[0], chain[1], der("other-root.pem").toString("base64")];
    await rejects(verify(appleJws(tx("2000000007"), { x5c: otherRoot })), "IAP_RECEIPT_INVALID");
    await rejects(verify(appleJws(tx("2000000008"), { x5c: [chain[1], chain[1], chain[2]] })), "IAP_RECEIPT_INVALID");
    await rejects(verify(appleJws(tx("2000000009", { appAccountToken: "6f1c8e1e-0000-4000-8000-000000000000" }))), "IAP_ACCOUNT_MISMATCH");
    await rejects(verify(appleJws(tx("2000000010", { productId: "com.example.unknown" }))), "IAP_PRODUCT_UNKNOWN");
    await rejects(verify("not.a-jws"), "IAP_RECEIPT_INVALID");

    const production = new AppleAppStoreValidator({ bundleId: BUNDLE, allowSandbox: true });
    await assert.rejects(production.verify({ receipt: "{}", jws: appleJws(tx("2000000011")) }), /untrusted root/,
      "the default trust is Apple Root CA - G3 only");
  });

  it("keeps the account token formats the client uses", () => {
    const userId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    assert.equal(accountTokenFor("apple", userId.toUpperCase()), userId);
    assert.equal(accountTokenFor("google", userId), createHash("sha256").update(userId).digest("hex"));
  });
});
