// App Store purchases (StoreKit 2). The client sends the transaction's JWS (`jwsRepresentation`); it is verified
// offline like Apple's App Store Server Library does: the x5c chain must end at Apple Root CA - G3 (pinned), each
// certificate must be signed by the next and valid at the signing date, the leaf and intermediate must carry Apple's
// receipt-signing OIDs, and the ES256 signature must match (apple-jws.ts). Then the transaction must be for this app, not revoked.

import type { X509Certificate } from "node:crypto";

import { appleTrustedRoots, verifyAppleJws } from "./apple-jws.js";
import { invalidReceipt, parseUnifiedReceipt, type ReceiptInput, type ReceiptValidator, type VerifiedPurchase } from "./receipt.js";

/** JWSTransactionDecodedPayload (fields used). */
type TransactionPayload = {
  transactionId?: string;
  originalTransactionId?: string;
  bundleId?: string;
  productId?: string;
  purchaseDate?: number;
  quantity?: number;
  appAccountToken?: string;
  environment?: string;
  revocationDate?: number;
  signedDate?: number;
};

export type AppleOptions = {
  bundleId: string;
  allowSandbox: boolean;
  /** DER roots to trust (tests use their own); default Apple Root CA - G3. */
  trustedRoots?: Buffer[];
};

export class AppleAppStoreValidator implements ReceiptValidator {
  readonly store = "apple" as const;
  private readonly roots: X509Certificate[];

  constructor(private readonly options: AppleOptions) {
    if (!options.bundleId) throw new Error("[iap] APPLE_BUNDLE_ID is required for App Store purchases.");
    this.roots = appleTrustedRoots(options.trustedRoots);
  }

  async verify(input: ReceiptInput): Promise<VerifiedPurchase> {
    const jws = input.jws || jwsFromReceipt(input.receipt);
    if (!jws) throw invalidReceipt("no signed transaction");
    const payload = verifyAppleJws<TransactionPayload>(jws, this.roots);

    if (payload.bundleId !== this.options.bundleId) throw invalidReceipt("other app");
    if (payload.revocationDate) throw invalidReceipt("refunded");
    const environment = payload.environment === "Production" ? "production" : payload.environment === "Sandbox" ? "sandbox" : null;
    if (!environment || (environment === "sandbox" && !this.options.allowSandbox)) throw invalidReceipt(`environment ${payload.environment}`);
    if (!payload.transactionId || !payload.productId) throw invalidReceipt("transaction without id/product");

    return {
      store: "apple",
      transactionId: payload.transactionId,
      orderId: payload.originalTransactionId ?? payload.transactionId,
      storeProductId: payload.productId,
      purchasedAtMs: payload.purchaseDate ?? 0,
      environment,
      accountToken: payload.appAccountToken ? payload.appAccountToken.toLowerCase() : null,
      quantity: Math.max(1, Math.floor(payload.quantity ?? 1)),
    };
  }
}

/** Unity IAP's Apple receipt carries the JWS as its payload on StoreKit 2. */
function jwsFromReceipt(receipt: string): string | null {
  try {
    const payload = parseUnifiedReceipt(receipt).payload;
    return payload.split(".").length === 3 ? payload : null;
  } catch {
    return null;
  }
}
