// What every store validator produces, and the Unity IAP receipt envelope the client sends.

import { AppError } from "../../../shared/errors/app-error.js";
import { ErrorCode } from "../../../shared/errors/error-codes.js";

export const IAP_STORES = ["google", "apple", "fake"] as const;
export type IapStore = (typeof IAP_STORES)[number];

/** A purchase the store vouched for. */
export type VerifiedPurchase = {
  store: IapStore;
  /** Unique per purchase in its store (Google purchase token, Apple transactionId, fake store id): the replay key. */
  transactionId: string;
  /** Reference for support (Google orderId, Apple originalTransactionId). */
  orderId: string;
  /** Store product id; empty for the fake store (its receipt doesn't name the product). */
  storeProductId: string;
  purchasedAtMs: number;
  environment: "production" | "sandbox" | "fake";
  /** Buyer account found in the receipt (Apple appAccountToken, Google obfuscatedAccountId); null when absent. */
  accountToken: string | null;
  quantity: number;
};

/** What the client sends: Unity IAP's unified receipt, plus the StoreKit 2 JWS on Apple platforms. */
export type ReceiptInput = { receipt: string; jws?: string };

export interface ReceiptValidator {
  readonly store: IapStore;
  /** Throws IAP_RECEIPT_INVALID (forged, wrong app, refunded), IAP_PENDING (not paid yet) or SERVER_ERROR (store unreachable). */
  verify(input: ReceiptInput): Promise<VerifiedPurchase>;
}

/** Unity IAP's receipt envelope: `{ Store, TransactionID, Payload }`. */
export type UnifiedReceipt = { store: string; transactionId: string; payload: string };

export function parseUnifiedReceipt(receipt: string): UnifiedReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(receipt);
  } catch {
    throw invalidReceipt("receipt is not JSON");
  }
  const value = parsed as { Store?: unknown; TransactionID?: unknown; Payload?: unknown };
  if (typeof value?.Store !== "string" || typeof value.Payload !== "string") throw invalidReceipt("receipt envelope");
  return { store: value.Store, transactionId: typeof value.TransactionID === "string" ? value.TransactionID : "", payload: value.Payload };
}

/** The store of a Unity IAP store name ("GooglePlay", "AppleAppStore", "MacAppStore", "fake"). */
export function storeOf(unityStoreName: string): IapStore | null {
  switch (unityStoreName) {
    case "GooglePlay": return "google";
    case "AppleAppStore":
    case "MacAppStore": return "apple";
    case "fake": return "fake";
    default: return null;
  }
}

export function invalidReceipt(reason: string): AppError {
  return new AppError(ErrorCode.IAP_RECEIPT_INVALID, { message: `invalid receipt: ${reason}` });
}
