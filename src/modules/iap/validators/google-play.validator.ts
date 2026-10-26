// Google Play receipts. Two checks, used together when both are configured:
// - offline: the purchase JSON is signed with the app's licensing key (RSA/SHA1) — proves Google issued it for this app;
// - online: the Google Play Developer API (service account) returns the purchase's current state — also catches
//   cancelled / refunded / pending purchases and test purchases.

import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";

import { AppError } from "../../../shared/errors/app-error.js";
import { ErrorCode } from "../../../shared/errors/error-codes.js";
import type { GooglePlayApi } from "./google-play-api.js";
import { invalidReceipt, parseUnifiedReceipt, type ReceiptInput, type ReceiptValidator, type VerifiedPurchase } from "./receipt.js";

/** Purchase JSON fields used (Play Billing "originalJson"). */
type PurchaseJson = {
  orderId?: string;
  packageName?: string;
  productId?: string;
  purchaseTime?: number;
  /** 0 purchased, 4 pending (Play Billing's original JSON). */
  purchaseState?: number;
  purchaseToken?: string;
  quantity?: number;
  obfuscatedAccountId?: string;
};

export type GooglePlayOptions = {
  packageName: string;
  /** Base64 RSA public key of the app (Play Console licensing key); empty = no offline check. */
  licenseKey?: string;
  /** Developer API client; null = no online check. */
  api?: GooglePlayApi | null;
};

export class GooglePlayValidator implements ReceiptValidator {
  readonly store = "google" as const;
  private readonly publicKey: KeyObject | null;

  constructor(private readonly options: GooglePlayOptions) {
    if (!options.packageName) throw new Error("[iap] GOOGLE_PLAY_PACKAGE_NAME is required for Google Play purchases.");
    if (!options.licenseKey && !options.api) throw new Error("[iap] Google Play needs GOOGLE_PLAY_LICENSE_KEY and/or GOOGLE_PLAY_SERVICE_ACCOUNT_FILE.");
    this.publicKey = options.licenseKey
      ? createPublicKey({ key: Buffer.from(options.licenseKey.replace(/\s+/g, ""), "base64"), format: "der", type: "spki" })
      : null;
  }

  async verify(input: ReceiptInput): Promise<VerifiedPurchase> {
    const receipt = parseUnifiedReceipt(input.receipt);
    if (receipt.store !== "GooglePlay") throw invalidReceipt("not a Google Play receipt");
    let payload: { json?: unknown; signature?: unknown };
    try {
      payload = JSON.parse(receipt.payload) as { json?: unknown; signature?: unknown };
    } catch {
      throw invalidReceipt("payload is not JSON");
    }
    if (typeof payload.json !== "string" || typeof payload.signature !== "string") throw invalidReceipt("payload without json/signature");

    if (this.publicKey) {
      const signed = verifySignature("sha1", Buffer.from(payload.json, "utf8"), this.publicKey, Buffer.from(payload.signature, "base64"));
      if (!signed) throw invalidReceipt("bad signature");
    }

    let purchase: PurchaseJson;
    try {
      purchase = JSON.parse(payload.json) as PurchaseJson;
    } catch {
      throw invalidReceipt("purchase is not JSON");
    }
    if (purchase.packageName !== this.options.packageName) throw invalidReceipt("other package");
    if (typeof purchase.productId !== "string" || typeof purchase.purchaseToken !== "string" || purchase.purchaseToken.length === 0) {
      throw invalidReceipt("purchase without product/token");
    }
    if (purchase.purchaseState === 4) throw new AppError(ErrorCode.IAP_PENDING);
    if (purchase.purchaseState !== undefined && purchase.purchaseState !== 0) throw invalidReceipt("purchase not completed");

    let environment: VerifiedPurchase["environment"] = "production";
    let accountToken = purchase.obfuscatedAccountId || null;
    let orderId = purchase.orderId ?? "";
    let purchasedAtMs = typeof purchase.purchaseTime === "number" ? purchase.purchaseTime : 0;
    let quantity = Math.max(1, Math.floor(purchase.quantity ?? 1));

    if (this.options.api) {
      const state = await this.options.api.getProductPurchase(this.options.packageName, purchase.productId, purchase.purchaseToken);
      if (!state) throw invalidReceipt("unknown to Google Play");
      if (state.purchaseState === 2) throw new AppError(ErrorCode.IAP_PENDING);
      if (state.purchaseState !== 0) throw invalidReceipt("cancelled");
      if (state.purchaseType === 0) environment = "sandbox";
      accountToken = state.obfuscatedExternalAccountId || accountToken;
      orderId = state.orderId || orderId;
      purchasedAtMs = state.purchaseTimeMillis || purchasedAtMs;
      quantity = Math.max(1, state.quantity ?? quantity);
    }

    return {
      store: "google",
      transactionId: purchase.purchaseToken,
      orderId,
      storeProductId: purchase.productId,
      purchasedAtMs,
      environment,
      accountToken,
      quantity,
    };
  }
}
